import test from 'node:test';
import assert from 'node:assert/strict';
import { Executor, impliedMove, execPoolOf, wrongPoolVerdict } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg } from './helpers.mjs';

const quote = (buyOut, sellOut) => async (i) => (i === SOL_MINT ? { outAmount: String(buyOut), priceImpactPct: '0.01' } : { outAmount: String(sellOut) });

test('shadow roundTrip prices spend vs sell-back', async () => {
  const ex = new Executor(testCfg(), { quote: quote(1_000_000, 19_000_000) });
  const rt = await ex.roundTrip('M', 0.02);
  assert.equal(rt.tokensOut, 1_000_000n); assert.ok(Math.abs(rt.ratio - 0.95) < 1e-9); assert.ok(Math.abs(rt.impactPct - 1) < 1e-9);
});
test('shadow buy/sell moves the simulated balance and never signs', async () => {
  const ex = new Executor(testCfg({ shadowStartSol: 1 }), { quote: quote(1_000_000, 30_000_000) });
  const f = await ex.buy('M', 0.02);
  assert.equal(f.simulated, true); assert.equal(f.sig, null); assert.ok(Math.abs((await ex.solBalance()) - 0.98) < 1e-9);
  const s = await ex.sell('M', f.tokensRaw);
  assert.ok(Math.abs(s.solOut - 0.03) < 1e-9); assert.ok(Math.abs((await ex.solBalance()) - 1.01) < 1e-9);
});
test('markValue is a live SELL quote; zero tokens = zero value', async () => {
  const ex = new Executor(testCfg(), { quote: quote(0, 25_000_000) });
  assert.ok(Math.abs(await ex.markValue('M', '1000') - 0.025) < 1e-9);
  assert.equal(await ex.markValue('M', '0'), 0);
});
test('no sell route → roundTrip throws (caller treats as do-not-trade)', async () => {
  const ex = new Executor(testCfg(), { quote: async (i) => { if (i === SOL_MINT) return { outAmount: '5' }; throw new Error('no route'); } });
  await assert.rejects(ex.roundTrip('M', 0.02), /no route/);
});
const hasSolana = await import('@solana/web3.js').then(() => true).catch(() => false);

test('real mode without a key fails closed', async () => {
  const ex = new Executor(testCfg({ realMode: true }), { env: {}, rpc: async () => ({ value: 0 }) });
  await assert.rejects(ex.solBalance(), /WALLET_PRIVATE_KEY not set/);
});
test('a malformed key is rejected without echoing it', { skip: !hasSolana && '@solana/web3.js not installed in this sandbox' }, async () => {
  const bad = new Executor(testCfg({ realMode: true }), { env: { WALLET_PRIVATE_KEY: 'SUPERSECRETNOTAKEY' }, rpc: async () => ({}) });
  await assert.rejects(bad.address(), (e) => /not a valid/.test(e.message) && !/SUPERSECRET/.test(e.message));
});

test('impliedMove: live quote at the decision price = no move', () => {
  // decision: $0.05/token, SOL at $200 -> 0.00025 SOL/token. 0.1 SOL buys 400 tokens (6 dp).
  const mv = impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '400000000', sizeSol: 0.1, decimals: 6 });
  assert.ok(Math.abs(mv) < 1e-9);
});
test('impliedMove: NEVER case — quote 95% below decision price reads as a dump', () => {
  // decided at $49k MC price $0.049; live quote buys 20x the tokens per SOL -> price is 1/20th
  const mv = impliedMove({ decisionPriceUsd: 0.049, solUsd: 200, outAmountRaw: String(0.1 / (0.049 / 200) * 20 * 1e6), sizeSol: 0.1, decimals: 6 });
  assert.ok(mv < -0.9, `expected ~-0.95, got ${mv}`);
});
test('impliedMove: quote above decision price reads as a pump', () => {
  const mv = impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '200000000', sizeSol: 0.1, decimals: 6 });
  assert.ok(Math.abs(mv - 1) < 1e-9); // half the tokens per SOL = price doubled
});
test('impliedMove: unusable inputs return null (guard falls open to the view check)', () => {
  assert.equal(impliedMove({ decisionPriceUsd: 0, solUsd: 200, outAmountRaw: '100', sizeSol: 0.1, decimals: 6 }), null);
  assert.equal(impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '0', sizeSol: 0.1, decimals: 6 }), null);
  assert.equal(impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: undefined, sizeSol: 0.1, decimals: 6 }), null);
  assert.equal(impliedMove({ decisionPriceUsd: 0.05, solUsd: 200, outAmountRaw: '100', sizeSol: 0.1, decimals: NaN }), null);
});

test('sellProceeds: shadow mode and missing key both fail safe to null', async () => {
  const shadow = new Executor(testCfg(), { quote: quote(1, 1), rpc: async () => ({}) });
  assert.equal(await shadow.sellProceeds('M', {}), null);
  const noKey = new Executor(testCfg({ realMode: true }), { env: {}, rpc: async () => ({}) });
  assert.equal(await noKey.sellProceeds('M', {}), null);
});

test('sellProceeds: sums SOL deltas of out-of-bot sells, excludes bot signatures and buys', async () => {
  const { Keypair } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const kp = Keypair.generate();
  const addr = kp.publicKey.toBase58();
  const MINT = 'MINTX';
  const txSell = {
    meta: {
      err: null, preBalances: [10_000_000_000, 0], postBalances: [10_400_000_000, 0],
      preTokenBalances: [{ mint: MINT, owner: addr, uiTokenAmount: { uiAmount: 1000 } }],
      postTokenBalances: [{ mint: MINT, owner: addr, uiTokenAmount: { uiAmount: 0 } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: addr }, { pubkey: 'OTHER' }] } },
  };
  const txBuy = {
    meta: {
      err: null, preBalances: [10_000_000_000, 0], postBalances: [9_900_000_000, 0],
      preTokenBalances: [{ mint: MINT, owner: addr, uiTokenAmount: { uiAmount: 0 } }],
      postTokenBalances: [{ mint: MINT, owner: addr, uiTokenAmount: { uiAmount: 500 } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: addr }, { pubkey: 'OTHER' }] } },
  };
  let seenTxParams = null;
  const rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress') return [
      { signature: 'SELL1', blockTime: 2000, err: null },
      { signature: 'BOTSELL', blockTime: 1999, err: null },
      { signature: 'BUY1', blockTime: 1998, err: null },
    ];
    if (method === 'getTransaction') { seenTxParams = params[1]; return params[0] === 'SELL1' ? txSell : params[0] === 'BUY1' ? txBuy : txSell; }
    throw new Error('unexpected ' + method);
  };
  const ex = new Executor(testCfg({ realMode: true }), { env: { WALLET_PRIVATE_KEY: bs58.encode(kp.secretKey) }, rpc });
  const r = await ex.sellProceeds(MINT, { sinceSec: 1000, excludeSigs: new Set(['BOTSELL']) });
  assert.ok(r, 'expected a result');
  assert.equal(r.txCount, 1);
  assert.ok(Math.abs(r.proceedsSol - 0.4) < 1e-9, `proceeds ${r.proceedsSol}`);
  assert.equal(seenTxParams.maxSupportedTransactionVersion, 1); // v1 txs (wallet apps) must be parseable
});

// --- fix zero (2026-10-13): sell() must book the TRUE balance delta for partial
// sells. The old formula compared the requested amount to a single immediate
// post-balance read and reported "not confirmed" for almost every partial sell
// even though the swap had landed (DOGCART: unbooked TP1 fired twice).
const realSellRig = async (onSend) => {
  const { Keypair } = await import('@solana/web3.js');
  const bs58 = (await import('bs58')).default;
  const kp = Keypair.generate();
  const rig = { bal: 122854n, reads: 0 };
  const rpc = async (method) => {
    if (method === 'getTokenAccountsByOwner') { rig.reads++; return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: rig.bal.toString() } } } } } }] }; }
    throw new Error('unexpected ' + method);
  };
  const ex = new Executor(testCfg({ realMode: true }), { env: { WALLET_PRIVATE_KEY: bs58.encode(kp.secretKey) }, rpc, quote: quote(0, 45_000_000) });
  ex.signAndSend = async () => { onSend(rig); return { sig: 'SIG1', confirmed: true }; };
  return { ex, rig };
};
test('real sell: partial sell books the true balance delta (DOGCART regression)', { skip: !hasSolana }, async () => {
  const { ex } = await realSellRig((rig) => { rig.bal = 73712n; });
  const s = await ex.sell('M', '49142');
  assert.equal(s.tokensSold, '49142');
  assert.ok(Math.abs(s.solOut - 0.045) < 1e-9);
});
test('real sell: a balance read that lags the swap still confirms via polling', { skip: !hasSolana }, async () => {
  const { ex, rig } = await realSellRig(() => {});
  const orig = ex.tokenBalance.bind(ex);
  let postReads = 0;
  ex.tokenBalance = async (m) => { const v = await orig(m); postReads++; if (postReads >= 4) rig.bal = 73712n; return postReads >= 4 ? 73712n : v; };
  const s = await ex.sell('M', '49142');
  assert.equal(s.tokensSold, '49142');
});
test('real sell: balance that never moves throws not-confirmed', { skip: !hasSolana }, async () => {
  const { ex } = await realSellRig(() => {});
  await assert.rejects(ex.sell('M', '49142'), /sell not confirmed/);
});

// ------------------------------------------------------------ wrong-pool guard (owner order 2026-10-19)
test('execPoolOf: identifies the mint hop pool in single- and multi-hop routes', () => {
  const one = { routePlan: [{ swapInfo: { ammKey: 'POOL1', label: 'PumpSwap', outputMint: 'MINT' } }] };
  assert.deepEqual(execPoolOf(one, 'MINT'), { ammKey: 'POOL1', label: 'PumpSwap' });
  const multi = { routePlan: [
    { swapInfo: { ammKey: 'USDC_POOL', label: 'Orca', outputMint: 'USDC' } },
    { swapInfo: { ammKey: 'WRONG_EARLY', label: 'Raydium', outputMint: 'MINT' } },
    { swapInfo: { ammKey: 'FINAL_POOL', label: 'PumpSwap', outputMint: 'MINT' } },
  ] };
  assert.equal(execPoolOf(multi, 'MINT').ammKey, 'FINAL_POOL', 'the last hop into the mint is the execution pool');
});

test('execPoolOf: unusable route data is null (the guard pass-through case)', () => {
  assert.equal(execPoolOf(null, 'MINT'), null);
  assert.equal(execPoolOf({}, 'MINT'), null);
  assert.equal(execPoolOf({ routePlan: [] }, 'MINT'), null);
  assert.equal(execPoolOf({ routePlan: [{ swapInfo: { ammKey: 'X', outputMint: 'OTHER' } }] }, 'MINT'), null);
});

test('wrongPoolVerdict: each abort leg fires on its own measured failure', () => {
  const base = { execMc: 200_000, execLiq: 60_000, execPriceUsd: 2, viewPriceUsd: 2, minMc: 10_000, minLiqToMc: 0.03, priceTol: 0.20 };
  assert.deepEqual(wrongPoolVerdict(base), { abort: false, fails: [] });
  assert.deepEqual(wrongPoolVerdict({ ...base, execMc: 1_946 }).fails, ['mc']);
  assert.deepEqual(wrongPoolVerdict({ ...base, execMc: 100_000, execLiq: 1_000 }).fails, ['depth']);
  assert.deepEqual(wrongPoolVerdict({ ...base, execPriceUsd: 3 }).fails, ['price']);
  const rockstar = wrongPoolVerdict({ execMc: 1_946, execLiq: 1_957, execPriceUsd: 0.0000020, viewPriceUsd: 0.0000669, minMc: 5_000, minLiqToMc: 0.03, priceTol: 0.20 });
  assert.equal(rockstar.abort, true);
  assert.deepEqual(rockstar.fails, ['mc', 'price'], 'the Rockstar trap pool fails mc + price; its liq/mc ratio itself was fine');
});

test('wrongPoolVerdict: missing measurements never fail a leg', () => {
  const base = { execMc: null, execLiq: null, execPriceUsd: null, viewPriceUsd: 2, minMc: 10_000, minLiqToMc: 0.03, priceTol: 0.20 };
  assert.deepEqual(wrongPoolVerdict(base), { abort: false, fails: [] });
  assert.deepEqual(wrongPoolVerdict({ ...base, execMc: 100_000 }), { abort: false, fails: [] }, 'mc present but depth unmeasurable: depth leg stays silent');
});
