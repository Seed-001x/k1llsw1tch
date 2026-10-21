// exec.js — swaps via Jupiter. Two modes behind ONE interface:
//   shadow : live Jupiter quotes, simulated fills, nothing is signed or sent.
//   real   : signs with WALLET_PRIVATE_KEY and broadcasts through RPC_URLS.
//
// Safety properties:
//  - The key is read from the environment only, lazily, only in real mode; never logged or returned.
//  - roundTrip() prices an immediate sell-back BEFORE any buy. If the sell-back is worth less than
//    cfg.minRoundTrip of the spend (thin pool, heavy impact, transfer tax, honeypot) the trade is refused.
//  - Exits are judged on markValue() = a live Jupiter SELL quote (what you could actually get), not screen price.
//  - Any error → throws; the caller treats that as "no trade". No partial state is recorded on failure.

import { fetchJson, SOL_MINT, LAMPORTS, sleep } from './util.js';

const toLamports = (sol) => BigInt(Math.floor(sol * LAMPORTS));

/**
 * Move between the decision price (USD/token from the scan snapshot) and the price implied
 * by a live buy quote (SOL in -> raw tokens out). Returns a fraction (+0.1 = live price 10%
 * above decision) or null when any input is unusable. The quote returns RAW token units, so
 * `decimals` must come from the token itself (RugCheck); a wrong decimals value blows the
 * move up to an absurd number, which callers treat as "abort" — the fail-safe direction.
 */
export function impliedMove({ decisionPriceUsd, solUsd, outAmountRaw, sizeSol, decimals }) {
  const dec = Number(decimals);
  if (!(decisionPriceUsd > 0) || !(solUsd > 0) || !(sizeSol > 0)) return null;
  if (!Number.isFinite(dec) || dec < 0 || dec > 18) return null;
  const out = Number(outAmountRaw);
  if (!(out > 0)) return null;
  const tokensWhole = out / 10 ** dec;
  if (!(tokensWhole > 0)) return null;
  const decisionSol = decisionPriceUsd / solUsd; // SOL per token at decision time
  if (!(decisionSol > 0)) return null;
  const freshSol = sizeSol / tokensWhole;        // SOL per token in the live quote
  return freshSol / decisionSol - 1;
}

/**
 * The pool a Jupiter quote will actually EXECUTE against for `mint`: the
 * LAST route-plan hop whose output is the mint itself. Earlier hops can be
 * intermediate tokens (SOL -> USDC -> mint routes exist); only the final
 * hop's pool holds the mint at the price the fill will print. Returns
 * { ammKey, label } or null when the quote carries no usable route plan —
 * the caller's "cannot identify" case (bot.js wrong-pool guard).
 */
export function execPoolOf(quote, mint) {
  const plan = quote && quote.routePlan;
  if (!Array.isArray(plan) || !plan.length) return null;
  for (let i = plan.length - 1; i >= 0; i--) {
    const info = plan[i] && plan[i].swapInfo;
    if (info && info.outputMint === mint && info.ammKey) return { ammKey: info.ammKey, label: info.label || null };
  }
  return null;
}

/**
 * Wrong-pool verdict (pure): judge the EXECUTION pool's own numbers
 * against the same floors the gates judged the graded view by — the live
 * minMc floor, the gate depth floor (exec liquidity as a share of exec
 * market cap, gate.js exitDepthCheck's ratio), and a price-agreement
 * tolerance against the graded view price. A leg whose measurement is
 * missing (null) never fails: this function is only reached once the
 * caller HAS priced the execution pool; a pool that cannot be priced at
 * all is the caller's separate pass-through case.
 */
export function wrongPoolVerdict({ execMc, execLiq, execPriceUsd, viewPriceUsd, minMc, minLiqToMc, priceTol }) {
  const fails = [];
  if (execMc != null && minMc > 0 && execMc < minMc) fails.push('mc');
  if (execMc != null && execMc > 0 && execLiq != null && minLiqToMc > 0 && execLiq / execMc < minLiqToMc) fails.push('depth');
  if (execPriceUsd != null && viewPriceUsd > 0 && priceTol > 0 && Math.abs(execPriceUsd - viewPriceUsd) / viewPriceUsd > priceTol) fails.push('price');
  return { abort: fails.length > 0, fails };
}

export class Executor {
  /**
   * @param cfg   config
   * @param hooks optional injection for tests: { quote, rpc, send, env }
   */
  constructor(cfg, hooks = {}) {
    this.cfg = cfg;
    this.real = !!cfg.realMode;
    this.quoteFn = hooks.quote || ((i, o, a, bps) => this.jupQuote(i, o, a, bps));
    this.rpcFn = hooks.rpc || ((m, p) => this.rpc(m, p));
    this.sendFn = hooks.send || ((b64) => this.sendRaw(b64));
    this.env = hooks.env || process.env;
    this._kp = null;
    this.shadowSol = cfg.shadowStartSol;
  }

  // ------------------------------------------------------------ wallet
  async keypair() {
    if (this._kp) return this._kp;
    const raw = (this.env.WALLET_PRIVATE_KEY || '').trim();
    if (!raw) throw new Error('WALLET_PRIVATE_KEY not set');
    const [{ Keypair }, bs58mod] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
    const bs58 = bs58mod.default || bs58mod;
    try { this._kp = Keypair.fromSecretKey(bs58.decode(raw)); }
    catch { throw new Error('WALLET_PRIVATE_KEY is not a valid base58 secret key'); }
    return this._kp;
  }
  // top-20 token accounts for a mint: { [tokenAccount]: rawAmount } (read-only RPC; works in shadow mode too)
  async largestAccounts(mint) {
    const r = await this.rpcFn('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    const out = {};
    for (const a of (r && r.value) || []) out[a.address] = Number(a.amount);
    return out;
  }

  // raw balance of `mint` held by an arbitrary owner (read-only; used for the creator wallet)
  async ownerBalance(owner, mint) {
    const r = await this.rpcFn('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let total = 0;
    for (const a of (r && r.value) || []) { const t = a.account?.data?.parsed?.info?.tokenAmount; if (t && t.amount) total += Number(t.amount); }
    return total;
  }

  async address() { return this.real ? (await this.keypair()).publicKey.toBase58() : 'shadow'; }

  async solBalance() {
    if (!this.real) return this.shadowSol;
    const pub = await this.address();
    const r = await this.rpcFn('getBalance', [pub, { commitment: 'confirmed' }]);
    return Number(r && r.value) / LAMPORTS;
  }

  async tokenBalance(mint) {
    if (!this.real) return null; // shadow positions track their own balance
    const pub = await this.address();
    const r = await this.rpcFn('getTokenAccountsByOwner', [pub, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let total = 0n;
    for (const a of (r && r.value) || []) {
      const amt = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount;
      if (amt && amt.amount) total += BigInt(amt.amount);
    }
    return total;
  }

  // ------------------------------------------------------------ Jupiter
  async jupQuote(inputMint, outputMint, amount, slippageBps) {
    const headers = this.cfg.jupApiKey ? { 'x-api-key': this.cfg.jupApiKey } : {};
    const u = `${this.cfg.jupBase}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false`;
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const q = await fetchJson(u, { timeout: 12000, headers, throwOnError: true });
        if (!q || !q.outAmount) throw new Error('no route');
        return q;
      } catch (e) { last = e; await sleep(400 * (i + 1)); }
    }
    throw new Error('jupiter quote failed: ' + (last && last.message));
  }

  async jupSwapTx(quote, userPublicKey) {
    const headers = this.cfg.jupApiKey ? { 'x-api-key': this.cfg.jupApiKey } : {};
    const j = await fetchJson(`${this.cfg.jupBase}/swap`, {
      method: 'POST', timeout: 20000, headers, throwOnError: true,
      body: { quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: this.cfg.priorityFeeLamports },
    });
    if (!j || !j.swapTransaction) throw new Error('jupiter: no swap transaction');
    return j.swapTransaction;
  }

  // ------------------------------------------------------------ RPC
  async rpc(method, params, timeout = 15000) {
    let last;
    for (const url of this.cfg.rpcUrls) {
      try {
        const j = await fetchJson(url, { method: 'POST', timeout, body: { jsonrpc: '2.0', id: 1, method, params }, throwOnError: true });
        if (j && j.error) throw new Error(j.error.message || 'rpc error');
        return j.result;
      } catch (e) { last = e; }
    }
    throw new Error(`rpc ${method} failed: ${last && last.message}`);
  }

  async sendRaw(b64) {
    return this.rpc('sendTransaction', [b64, { encoding: 'base64', skipPreflight: false, maxRetries: 3, preflightCommitment: 'confirmed' }], 30000);
  }

  async confirm(sig, timeoutMs = 45000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const r = await this.rpcFn('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
        const st = r && r.value && r.value[0];
        if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
          if (st.err) throw new Error('tx failed on-chain: ' + JSON.stringify(st.err));
          return true;
        }
      } catch (e) { if (String(e.message).startsWith('tx failed')) throw e; }
      await sleep(1500);
    }
    return false; // unknown — caller checks balances
  }

  async signAndSend(quote) {
    const kp = await this.keypair();
    const { VersionedTransaction } = await import('@solana/web3.js');
    const b64 = await this.jupSwapTx(quote, kp.publicKey.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
    tx.sign([kp]);
    const signed = Buffer.from(tx.serialize()).toString('base64');
    const sig = await this.sendFn(signed);
    const ok = await this.confirm(sig);
    return { sig, confirmed: ok };
  }

  /**
   * Close this wallet's EMPTY token accounts for `mint` and get the rent (~0.002 SOL each) back.
   * Only zero-balance accounts owned by the SPL Token / Token-2022 programs are touched. Costs one base fee.
   */
  async closeEmptyAccounts(mint) {
    if (!this.real) return null;
    const kp = await this.keypair();
    const r = await this.rpcFn('getTokenAccountsByOwner', [kp.publicKey.toBase58(), { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
    const { Transaction, TransactionInstruction, PublicKey } = await import('@solana/web3.js');
    const ixs = [];
    for (const a of (r && r.value) || []) {
      const amt = a.account?.data?.parsed?.info?.tokenAmount?.amount;
      if (amt !== '0' || !TOKEN_PROGRAMS.has(a.account.owner)) continue;
      ixs.push(new TransactionInstruction({
        programId: new PublicKey(a.account.owner),
        keys: [
          { pubkey: new PublicKey(a.pubkey), isSigner: false, isWritable: true }, // account to close
          { pubkey: kp.publicKey, isSigner: false, isWritable: true },            // rent goes back to us
          { pubkey: kp.publicKey, isSigner: true, isWritable: false },            // owner
        ],
        data: Buffer.from([9]), // CloseAccount
      }));
    }
    if (!ixs.length) return null;
    const bh = await this.rpcFn('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: bh.value.blockhash }).add(...ixs);
    tx.sign(kp);
    return this.sendFn(Buffer.from(tx.serialize()).toString('base64'));
  }

  // ------------------------------------------------------------ trading API
  /**
   * Price an immediate buy + sell-back. ratio = sell-back SOL / spent SOL.
   * Throws if either side has no route (treated as "do not trade").
   */
  async roundTrip(mint, sol) {
    const lam = toLamports(sol);
    const buy = await this.quoteFn(SOL_MINT, mint, lam.toString(), this.cfg.buyBps);
    const sell = await this.quoteFn(mint, SOL_MINT, String(buy.outAmount), this.cfg.sellBps);
    return {
      tokensOut: BigInt(buy.outAmount),
      solBack: Number(sell.outAmount) / LAMPORTS,
      ratio: Number(sell.outAmount) / Number(lam),
      impactPct: Number(buy.priceImpactPct || 0) * 100,
      buyQuote: buy,
    };
  }

  /**
   * Real proceeds of OUT-OF-BOT sells of `mint` (the user selling in their own wallet):
   * scan the wallet's recent transactions, find the ones where its balance of `mint`
   * DROPPED (excluding signatures the bot itself produced), and sum the wallet's
   * SOL-side delta (native SOL + WSOL token accounts) across them. Measuring the actual
   * sell transactions replaces the last-quote estimate for manual exits. Returns
   * { proceedsSol, txCount } or null when nothing parseable is found — callers fall
   * back to the estimate. Real mode only; any RPC trouble → null, never throws.
   */
  async sellProceeds(mint, { sinceSec = 0, excludeSigs = new Set(), limit = 40, maxTx = 20 } = {}) {
    try {
      if (!this.real) return null;
      const addr = await this.address();
      if (!addr || addr === 'shadow') return null;
      const sigs = await this.rpcFn('getSignaturesForAddress', [addr, { limit }]);
      let proceeds = 0, txCount = 0, fetched = 0;
      for (const s of sigs || []) {
        if (fetched >= maxTx) break;
        if (!s || s.err || !s.signature || excludeSigs.has(s.signature)) continue;
        if (sinceSec && s.blockTime && s.blockTime < sinceSec) continue;
        fetched++;
        // maxSupportedTransactionVersion must be 1: the user's wallet app sends v1
        // transactions, and a v0 declaration makes the RPC refuse them (-32015) —
        // with 0 here every manual sell silently fell back to the estimate (2026-10-12).
        const tx = await this.rpcFn('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null);
        if (!tx || !tx.meta || tx.meta.err) continue;
        const tokDelta = (list) => (list || []).filter(b => b.mint === mint && b.owner === addr)
          .reduce((a, b) => a + (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
        const dTok = tokDelta(tx.meta.postTokenBalances) - tokDelta(tx.meta.preTokenBalances);
        if (!(dTok < 0)) continue; // not a sell of this mint
        const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey));
        const idx = keys.indexOf(addr);
        let dSol = idx >= 0 ? (Number(tx.meta.postBalances[idx]) - Number(tx.meta.preBalances[idx])) / LAMPORTS : 0;
        const wDelta = (list) => (list || []).filter(b => b.mint === SOL_MINT && b.owner === addr)
          .reduce((a, b) => a + (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
        dSol += wDelta(tx.meta.postTokenBalances) - wDelta(tx.meta.preTokenBalances);
        proceeds += dSol;
        txCount++;
      }
      return txCount ? { proceedsSol: proceeds, txCount } : null;
    } catch { return null; }
  }

  /**
   * D1 follow-up (user 2026-10-14): the REAL fill of the user's own out-of-bot
   * sells of `mint`, read from the sell transactions themselves. Same scan as
   * sellProceeds (the wallet's recent signatures, token balance DROPPED, the
   * bot's own signatures excluded), but per transaction it also captures the
   * raw token delta and the fee the wallet paid, so a per-token fill price
   * falls out:
   *
   *   gross proceeds  = wallet SOL delta (native + WSOL) + tx fee paid
   *   fill (SOL/token) = total gross proceeds / total tokens sold (whole)
   *
   * CONVENTION: a sell tx's SOL balance delta is NET of that tx's fee (the fee
   * leaves the same account), so gross proceeds add the fee back — the fill is
   * the price the pool actually paid per token before the network took its
   * cut. proceedsNetSol keeps the after-fee truth (what actually landed in
   * the wallet), which is what P&L and the paired shadow comparison use.
   * Returns { sigs, txCount, tokensRawSold (string, positive), decimals,
   * tokensWhole, proceedsNetSol, feeSol, grossSol, fillSol } or null when no
   * parseable sell is found. Real mode only; never throws.
   */
  async sellFill(mint, { sinceSec = 0, excludeSigs = new Set(), limit = 40, maxTx = 20 } = {}) {
    try {
      if (!this.real) return null;
      const addr = await this.address();
      if (!addr || addr === 'shadow') return null;
      const sigs = await this.rpcFn('getSignaturesForAddress', [addr, { limit }]);
      let tokensRawSold = 0n, decimals = null, net = 0, feeSol = 0, txCount = 0, fetched = 0;
      const soldSigs = [];
      for (const s of sigs || []) {
        if (fetched >= maxTx) break;
        if (!s || s.err || !s.signature || excludeSigs.has(s.signature)) continue;
        if (sinceSec && s.blockTime && s.blockTime < sinceSec) continue;
        fetched++;
        // maxSupportedTransactionVersion 1 — same wallet-app v1 caveat as sellProceeds.
        const tx = await this.rpcFn('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null);
        if (!tx || !tx.meta || tx.meta.err) continue;
        const rawDelta = (list) => (list || []).filter(b => b.mint === mint && b.owner === addr)
          .reduce((a, b) => {
            if (decimals == null && b.uiTokenAmount && b.uiTokenAmount.decimals != null) decimals = Number(b.uiTokenAmount.decimals);
            return a + BigInt((b.uiTokenAmount && b.uiTokenAmount.amount) || '0');
          }, 0n);
        const dRaw = rawDelta(tx.meta.postTokenBalances) - rawDelta(tx.meta.preTokenBalances);
        if (!(dRaw < 0n)) continue; // not a sell of this mint
        const keys = (tx.transaction.message.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey));
        const idx = keys.indexOf(addr);
        let dSol = idx >= 0 ? (Number(tx.meta.postBalances[idx]) - Number(tx.meta.preBalances[idx])) / LAMPORTS : 0;
        const wDelta = (list) => (list || []).filter(b => b.mint === SOL_MINT && b.owner === addr)
          .reduce((a, b) => a + (Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0), 0);
        dSol += wDelta(tx.meta.postTokenBalances) - wDelta(tx.meta.preTokenBalances);
        // meta.fee is charged to the fee payer only — accountKeys[0]. If the
        // wallet didn't pay it, its SOL delta carries no fee to add back.
        const fee = idx === 0 && Number(tx.meta.fee) > 0 ? Number(tx.meta.fee) / LAMPORTS : 0;
        tokensRawSold += -dRaw;
        net += dSol;
        feeSol += fee;
        txCount++;
        soldSigs.push(s.signature);
      }
      if (!txCount || tokensRawSold <= 0n || decimals == null) return null;
      const tokensWhole = Number(tokensRawSold) / 10 ** decimals;
      if (!(tokensWhole > 0)) return null;
      const grossSol = net + feeSol;
      return {
        sigs: soldSigs, txCount, tokensRawSold: tokensRawSold.toString(), decimals,
        tokensWhole, proceedsNetSol: +net.toFixed(9), feeSol: +feeSol.toFixed(9),
        grossSol: +grossSol.toFixed(9), fillSol: grossSol / tokensWhole,
      };
    } catch { return null; }
  }

  /** Live realizable value (SOL) of `tokensRaw` tokens. */
  async markValue(mint, tokensRaw) {
    const amt = BigInt(tokensRaw);
    if (amt <= 0n) return 0;
    const q = await this.quoteFn(mint, SOL_MINT, amt.toString(), this.cfg.sellBps);
    return Number(q.outAmount) / LAMPORTS;
  }

  async buy(mint, sol, preQuote = null) {
    const lam = toLamports(sol);
    const quote = preQuote || await this.quoteFn(SOL_MINT, mint, lam.toString(), this.cfg.buyBps);
    if (!this.real) {
      this.shadowSol -= sol;
      return { tokensRaw: String(quote.outAmount), solSpent: sol, sig: null, simulated: true };
    }
    const before = (await this.tokenBalance(mint)) || 0n;
    const { sig, confirmed } = await this.signAndSend(quote);
    let after = before;
    let verifyErr = null;
    for (let i = 0; i < 5; i++) {
      try { after = (await this.tokenBalance(mint)) || 0n; } catch (e) { verifyErr = e; break; }
      if (after > before) break;
      await sleep(1500);
    }
    if (after <= before) {
      // LANDED-UNVERIFIED (owner order 2026-10-21, the MILK hole): the swap
      // was signed and sent — only the confirmation read failed (an RPC
      // 429, or verify reads that never showed the fill). The tokens may
      // well be in the wallet, so the sig must NEVER be discarded into a
      // generic "buy failed": this distinct error carries it to bot.js,
      // which journals an open-unverified buy for reconcile to adopt if
      // the bag is really there (or resolve as never-landed if it is not).
      const err = new Error(`buy landed but unverified (sig ${sig}, confirmed=${confirmed}) — ${verifyErr ? `verify read failed: ${verifyErr.message}` : 'no tokens received on verify reads'}`);
      err.code = 'LANDED_UNVERIFIED';
      err.sig = sig; err.confirmed = confirmed; err.mint = mint; err.solSpent = sol;
      throw err;
    }
    return { tokensRaw: (after - before).toString(), solSpent: sol, sig, simulated: false };
  }

  /** Sell up to `tokensRaw` (clamped to wallet balance in real mode). */
  async sell(mint, tokensRaw) {
    let amt = BigInt(tokensRaw);
    let before = null;
    if (this.real) {
      before = (await this.tokenBalance(mint)) || 0n;
      if (before < amt) amt = before;
    }
    if (amt <= 0n) return { tokensSold: '0', solOut: 0, sig: null, simulated: !this.real };
    const quote = await this.quoteFn(mint, SOL_MINT, amt.toString(), this.cfg.sellBps);
    const solOut = Number(quote.outAmount) / LAMPORTS;
    if (!this.real) {
      this.shadowSol += solOut;
      return { tokensSold: amt.toString(), solOut, sig: null, simulated: true };
    }
    const { sig } = await this.signAndSend(quote);
    // Confirmation = the wallet balance actually fell (mirrors buy()). The old code
    // compared the REQUESTED amount against a single immediate post-balance read,
    // which reads as "nothing sold" for almost every partial sell — the swap had
    // landed but the caller booked nothing, leaving position state desynced from
    // the chain (DOGCART 2026-10-13: an unbooked TP1 fired twice). Poll like buy().
    let after = before;
    for (let i = 0; i < 5; i++) {
      after = (await this.tokenBalance(mint)) || 0n;
      if (after < before) break;
      await sleep(1500);
    }
    const sold = before > after ? before - after : 0n; // trust chain over quote
    if (sold <= 0n) throw new Error(`sell not confirmed (sig ${sig})`);
    return { tokensSold: (sold < amt ? sold : amt).toString(), solOut, sig, simulated: false };
  }
}
