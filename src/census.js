// census.js — WALLET CENSUS for open positions (owner design 2026-10-18:
// the brief's #1 signal — "unique buyer wallets"; route chosen by the owner
// ~09:55 EDT: "Websocket", off the bot's existing Helius RPC — Developer
// plan, verified by his billing screenshot — NOT the PumpPortal stream,
// whose wallet sits unfunded by his choice).
//
// Why: every aggregate the bot judges by (buys/sells counts, volume) can be
// puppeted by a volume bot cycling a handful of wallets. A census cannot:
// distinct buyer wallets, first-seen buyers, and buy/sell overlap are facts
// about WHO is trading, not how much. "Buys keep coming but no new wallets
// are arriving" is the corpse signature the grind judge reads.
//
// How: one websocket to the first RPC_URL (https->wss), one logsSubscribe
// (mentions = the mint) per OPEN position's mint (max 2 by config). Each
// notification's transaction is fetched (bounded concurrency) and parsed:
// the trader is the fee payer when the payer's own mint balance moved
// (covers direct curve + PumpSwap trades — validated on real fixtures,
// incl. the bot's own buy), else the single non-venue owner whose balance
// moved; multi-party transactions (migrations, settlements) parse to null
// and are never counted. Venue/pool accounts are excluded by balance size.
//
// RECORD-ONLY in itself: the census accumulates on the position and rides
// ticks, /state and close records. Its one consumer is the grind judge
// (src/grindJudge.js), itself gated. Fail-open everywhere: a dead socket
// or a saturated fetch queue degrades the census (stats show it) and can
// never disturb trading — the judge treats a dark census as no evidence.

import WebSocket from 'ws';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TRADE_PROGRAMS = new Set([PUMP_PROGRAM, PUMPSWAP_PROGRAM, JUPITER_PROGRAM]);

const RING_CAP = 900;          // recent-trade stubs kept per position (~window reads)
const WALLET_CAP = 3000;       // distinct wallets remembered per side per position

/** websocket URL for an RPC http(s) URL: same host + key, wss scheme. */
export function wsUrlFor(rpcUrl) {
  if (!rpcUrl) return null;
  if (rpcUrl.startsWith('https://')) return 'wss://' + rpcUrl.slice('https://'.length);
  if (rpcUrl.startsWith('http://')) return 'ws://' + rpcUrl.slice('http://'.length);
  if (rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')) return rpcUrl;
  return null;
}

function programIdsOf(tx) {
  const out = new Set();
  const msg = tx && tx.transaction && tx.transaction.message;
  for (const i of (msg && msg.instructions) || []) if (i && i.programId) out.add(i.programId);
  const meta = tx && tx.meta;
  for (const g of (meta && meta.innerInstructions) || []) {
    for (const i of (g && g.instructions) || []) if (i && i.programId) out.add(i.programId);
  }
  return out;
}

/**
 * Parse one confirmed transaction into a census trade for `mint`.
 * Returns { trader, side: 'buy'|'sell', tokens (whole), ts } or null when
 * the transaction is not a classifiable single-trader trade in the mint.
 * Pure: fixtures in tests/fixtures/census-*.json pin the real shapes.
 */
export function parseCensusTrade(tx, mint) {
  try {
    if (!tx || !tx.meta || tx.meta.err) return null;
    const progs = programIdsOf(tx);
    if (![...TRADE_PROGRAMS].some(p => progs.has(p))) return null;
    const msg = tx.transaction && tx.transaction.message;
    const keys = ((msg && msg.accountKeys) || []).map(k => (typeof k === 'string' ? k : k && k.pubkey)).filter(Boolean);
    if (!keys.length) return null;
    const signer = keys[0];
    const meta = tx.meta;
    // aggregate this mint's raw deltas by token-account owner
    const pre = new Map(), post = new Map(), ownerOf = new Map();
    for (const b of meta.preTokenBalances || []) {
      if (b.mint !== mint) continue;
      pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
      if (b.owner) ownerOf.set(b.accountIndex, b.owner);
    }
    let decimals = 6;
    for (const b of meta.postTokenBalances || []) {
      if (b.mint !== mint) continue;
      post.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
      if (b.owner) ownerOf.set(b.accountIndex, b.owner);
      if (b.uiTokenAmount.decimals != null) decimals = b.uiTokenAmount.decimals;
    }
    const byOwner = new Map(); // owner -> { delta, postBal }
    for (const [idx, postAmt] of post) {
      const owner = ownerOf.get(idx);
      if (!owner) continue;
      const d = postAmt - (pre.get(idx) ?? 0n);
      const cur = byOwner.get(owner) || { delta: 0n, postBal: 0n };
      cur.delta += d; cur.postBal += postAmt;
      byOwner.set(owner, cur);
    }
    // token accounts that existed only pre (closed by the trade) still count
    for (const [idx, preAmt] of pre) {
      if (post.has(idx)) continue;
      const owner = ownerOf.get(idx);
      if (!owner) continue;
      const cur = byOwner.get(owner) || { delta: 0n, postBal: 0n };
      cur.delta -= preAmt;
      byOwner.set(owner, cur);
    }
    const moved = [...byOwner.entries()].filter(([, v]) => v.delta !== 0n);
    if (!moved.length) return null;
    let trader = null, delta = 0n;
    const signerEntry = moved.find(([o]) => o === signer);
    if (signerEntry) {
      trader = signer; delta = signerEntry[1].delta;
    } else {
      // exclude the venue: the candidate holding the largest remaining balance
      const sorted = [...moved].sort((a, b) => (b[1].postBal > a[1].postBal ? 1 : -1));
      const rest = sorted.slice(1);
      if (rest.length !== 1) return null; // multi-party (migration/settlement): never guess
      trader = rest[0][0]; delta = rest[0][1].delta;
    }
    if (!trader || delta === 0n) return null;
    const tokens = Number(delta < 0n ? -delta : delta) / 10 ** decimals;
    if (!(tokens > 0)) return null;
    return { trader, side: delta > 0n ? 'buy' : 'sell', tokens, ts: tx.blockTime ? tx.blockTime * 1000 : null };
  } catch { return null; }
}

/** Fresh per-position census state (JSON-safe: rides the positions file). */
export function newCensus(now) {
  return { startedTs: now, trades: 0, buys: 0, sells: 0, buyers: {}, sellers: {}, ring: [], capped: 0, lastTradeTs: 0 };
}

/** Fold one parsed trade into a position's census. Mutates and returns it. */
export function censusFold(census, trade, now) {
  const c = census;
  c.trades++;
  if (trade.side === 'buy') c.buys++; else c.sells++;
  const book = trade.side === 'buy' ? c.buyers : c.sellers;
  const w = book[trade.trader];
  if (w) { w.n++; w.lastTs = trade.ts || now; }
  else if (Object.keys(book).length < WALLET_CAP) book[trade.trader] = { n: 1, firstTs: trade.ts || now, lastTs: trade.ts || now };
  else c.capped++;
  c.ring.push({ ts: trade.ts || now, side: trade.side, w: trade.trader });
  if (c.ring.length > RING_CAP) c.ring.splice(0, c.ring.length - RING_CAP);
  c.lastTradeTs = trade.ts || now;
  return c;
}

/**
 * Windowed census read over the trailing `windowMs`. "New" buyers are
 * wallets whose first-ever census sighting (this position, since its
 * census started) falls inside the window.
 */
export function censusWindow(census, now, windowMs) {
  if (!census) return null;
  const since = now - windowMs;
  let buys = 0, sells = 0;
  const uniqBuyers = new Set(), uniqSellers = new Set();
  for (const r of census.ring) {
    if (r.ts < since) continue;
    if (r.side === 'buy') { buys++; uniqBuyers.add(r.w); }
    else { sells++; uniqSellers.add(r.w); }
  }
  let newBuyers = 0;
  for (const w of uniqBuyers) {
    const rec = census.buyers[w];
    if (rec && rec.firstTs >= since) newBuyers++;
  }
  let wash = 0;
  for (const w of uniqBuyers) if (uniqSellers.has(w)) wash++;
  return {
    buys, sells,
    uniqBuyers: uniqBuyers.size, uniqSellers: uniqSellers.size,
    newBuyers, wash,
    uniqBuyersTotal: Object.keys(census.buyers).length,
    uniqSellersTotal: Object.keys(census.sellers).length,
    tradesTotal: census.trades, lastTradeTs: census.lastTradeTs || null,
  };
}

/** Compact census stamp for /state positions and close records. */
export function censusStamp(pos, now, windowMs) {
  const c = pos && pos.census;
  if (!c) return null;
  const w = censusWindow(c, now, windowMs);
  return {
    trades: c.trades, buys: c.buys, sells: c.sells,
    uniqBuyers: Object.keys(c.buyers).length, uniqSellers: Object.keys(c.sellers).length,
    buysW: w.buys, sellsW: w.sells, uniqBuyersW: w.uniqBuyers, newBuyersW: w.newBuyers, washW: w.wash,
    lastTradeTs: c.lastTradeTs || null,
  };
}

/**
 * The websocket manager. One socket, one logsSubscribe per watched mint.
 * Modeled on LiveFeed (fail-open, backoff reconnect, periodic sub sync).
 * rpcFn(method, params) fetches transactions (the executor's RPC in prod).
 */
export class CensusFeed {
  constructor({ rpcUrls = [], rpcUrl = null, rpcFn, onTrade, onStats, wsImpl } = {}) {
    // Endpoint: CENSUS_RPC_URL (cfg.censusRpcUrl, wired in index.js) wins
    // over the shared list — the census socket gets its own endpoint so a
    // sick or capped primary RPC can never blind the deep-check layer
    // again (2026-10-22: 71+ failed reconnects against a halted plan
    // while the bot traded on via the fallback). Empty = derive from
    // RPC_URLS[0], the historical behavior.
    this.url = wsUrlFor(rpcUrl || rpcUrls[0]);
    this.rpcFn = rpcFn || (async () => null);
    this.onTrade = onTrade || (() => {});
    this.onStats = onStats || (() => {});
    this.WebSocketImpl = wsImpl || WebSocket;
    this.ws = null;
    this.stopped = false;
    this.backoffMs = 5000;
    this.reconnectTimer = null;
    this.syncTimer = null;
    this.desired = new Set();       // mints we want watched
    this.subIds = new Map();        // mint -> subscription id (live)
    this.subById = new Map();       // subscription id -> mint
    this.seen = new Set();          // signatures already queued (dedupe)
    this.queue = [];
    this.inflight = 0;
    this.maxInflight = 6;
    // endpoint: the dialed host ONLY (never the full URL — a keyed
    // endpoint carries its key in the query) so /state can prove which
    // endpoint the socket is actually on.
    let endpoint = null;
    try { endpoint = this.url ? new URL(this.url).hostname : null; } catch { endpoint = null; }
    this.stats = { connected: false, subs: 0, notifications: 0, fetched: 0, parsed: 0, dropped: 0, reconnects: 0, lastMsgTs: 0, lastTradeTs: 0, lastError: null, endpoint };
  }

  _emitStats() { try { this.onStats({ ...this.stats }); } catch {} }

  start() {
    if (!this.url) { this.stats.lastError = 'no ws url'; this._emitStats(); return; }
    this.stopped = false;
    this._connect();
    if (!this.syncTimer) {
      this.syncTimer = setInterval(() => { try { this._syncSubs(); } catch {} }, 5000);
      if (this.syncTimer.unref) this.syncTimer.unref();
    }
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    this.stats.connected = false;
    this._emitStats();
  }

  /** The bot calls this with the current set of open-position mints. */
  setDesired(mints) {
    this.desired = new Set(mints || []);
    this._syncSubs();
  }

  _send(obj) {
    if (!this.ws || !this.stats.connected) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  _syncSubs() {
    if (!this.stats.connected) return;
    for (const mint of this.desired) {
      if (this.subIds.has(mint)) continue;
      const ok = this._send({ jsonrpc: '2.0', id: 'sub-' + mint, method: 'logsSubscribe', params: [{ mentions: [mint] }, { commitment: 'confirmed' }] });
      if (ok) this.subIds.set(mint, null); // id arrives in the result message
    }
    for (const [mint, id] of [...this.subIds]) {
      if (this.desired.has(mint)) continue;
      if (id != null) this._send({ jsonrpc: '2.0', id: 'unsub-' + mint, method: 'logsUnsubscribe', params: [id] });
      this.subIds.delete(mint);
      if (id != null) this.subById.delete(id);
    }
    this.stats.subs = this.subIds.size;
    this._emitStats();
  }

  _connect() {
    if (this.stopped || !this.url) return;
    let ws;
    try { ws = new this.WebSocketImpl(this.url); } catch (e) { this._scheduleReconnect(); return; }
    this.ws = ws;
    ws.on('open', () => {
      this.stats.connected = true;
      this.backoffMs = 5000;
      this.subIds.clear(); this.subById.clear();
      this._syncSubs();
      this._emitStats();
    });
    ws.on('message', (data) => { try { this._onMessage(data); } catch {} });
    ws.on('error', (e) => { this.stats.lastError = String((e && e.message) || e).slice(0, 120); this._emitStats(); });
    ws.on('close', () => {
      this.stats.connected = false;
      this.subIds.clear(); this.subById.clear();
      this.stats.subs = 0;
      this._emitStats();
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.stats.reconnects++;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect(); }, wait);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _onMessage(data) {
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : data.toString()); } catch { return; }
    if (!m) return;
    // subscription confirmations: { id: 'sub-<mint>', result: <subId> }
    if (typeof m.id === 'string' && m.id.startsWith('sub-') && m.result != null) {
      const mint = m.id.slice(4);
      this.subIds.set(mint, m.result);
      this.subById.set(m.result, mint);
      return;
    }
    if (m.method !== 'logsNotification') return;
    const value = m.params && m.params.result && m.params.result.value;
    const subId = m.params && m.params.subscription;
    const mint = this.subById.get(subId);
    if (!value || !mint) return;
    if (value.err) return;
    const sig = value.signature;
    if (!sig || this.seen.has(sig)) return;
    this.seen.add(sig);
    if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-10000));
    this.stats.notifications++;
    this.stats.lastMsgTs = Date.now();
    if (this.queue.length > 2000) { this.stats.dropped++; this._emitStats(); return; }
    this.queue.push({ mint, sig });
    this._pump();
  }

  _pump() {
    while (this.inflight < this.maxInflight && this.queue.length) {
      const { mint, sig } = this.queue.shift();
      this.inflight++;
      (async () => {
        try {
          const tx = await this.rpcFn('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
          this.stats.fetched++;
          const trade = tx ? parseCensusTrade(tx, mint) : null;
          if (trade) {
            this.stats.parsed++;
            this.stats.lastTradeTs = Date.now();
            try { this.onTrade(mint, { ...trade, sig }); } catch {}
          }
        } catch { /* a failed fetch is a missed trade, never a crash */ }
        this.inflight--;
        this._emitStats();
        this._pump();
      })();
    }
  }
}
