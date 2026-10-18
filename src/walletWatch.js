// walletWatch.js — wallet-task shadow detectors (user brief 2026-10-14 Phases 4–6;
// go given 2026-10-15). LOG-ONLY observers over the Phase 1–3 wallet sets
// (src/walletSets.json, generated from the investigation scorecards):
//
// LIVE ROUTING (owner order 2026-10-16, "make them all go live"): the
// detectors below still only journal events + outcome-track them — this
// module never trades. The BOT bridges events into live entry attempts via
// the optional liveEval dep (Bot._evalWalletLive: fresh view, held/cooldown
// guards, eligible() floor, then the standard onSignal pipeline under setup
// labels 'devlaunch' / 'confluence'). Kill switches DEVLAUNCH_LIVE=0 /
// CONFLUENCE_LIVE=0 (Bot-side) restore record-only exactly.
//
//   dev-launch  — one of the 23 hand-tagged dev wallets creates a pump.fun coin
//                 or buys into one within DEV_EARLY_MIN of its creation.
//   confluence  — >= CONFL_MIN_CLUSTERS distinct surviving trader ENTITIES buy
//                 the same mint within CONFL_WINDOW_MIN (on-chain buy times;
//                 wallets inside one entity count as a single voice).
//
// Every event is judged in shadow by the live gate stack (which gates WOULD
// have blocked it), then outcome-tracked from a reference entry (dev: 60s
// after coin creation; confluence: the moment the deciding buy landed) using
// GeckoTerminal minute candles: r5/r15/r60, peak, time-to-peak, worst dip, and
// the dev's first sell where applicable. Qualification is computed against the
// pinned taken-pop baseline (runners 21.8% / crashes 38.1% / r60 −37.5%;
// runner = maxRet >= +50%, crash = minRet <= −50%, rug = minRet <= −90%) and
// surfaced as a FLAG ONLY — promotion is the user's call, nothing here trades,
// gates a live entry, or promotes itself.
//
// Detection polls wallet signatures over the existing Helius RPC, exactly like
// flowWatch (first contact adopts the watermark — no backfill fires). Buys and
// sells are read from parsed-tx balance deltas (flowWatch's parsers), so
// pump.fun curve, PumpSwap and Jupiter routes all read identically. A dev
// create with NO bundled buy leaves no balance-delta trace and is not seen in
// v1 — stated limit, not a silent one (DEV_EARLY buys are the dominant shape).

import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, readTailLines } from './util.js';
import { relayRoutePump } from './relayFetch.js';
import { fetchGtJson } from './gtFetch.js';
import { flowRpc, parseWalletBuys, parseWalletSells, FLOW_DUST_SOL } from './flowWatch.js';

export const BASELINE = { runnerShare: 0.218, crashShare: 0.381, r60Median: -0.375 };
const GT = 'https://api.geckoterminal.com/api/v2';
const PF = 'https://frontend-api-v3.pump.fun';

export function loadSets() {
  try { return JSON.parse(fs.readFileSync(new URL('./walletSets.json', import.meta.url), 'utf8')); }
  catch { return { devs: [], survivors: [], baseline: BASELINE }; }
}

/** 'created' when the dev is the coin's creator, 'early' when the buy lands
 *  within earlyMin of creation, else null (not a launch). */
export function classifyDevBuy({ creator, createdTs, buyTs, wallet, earlyMin = 60 }) {
  if (!createdTs || !buyTs) return null;
  if (creator && wallet && creator === wallet) return 'created';
  if (buyTs - createdTs <= earlyMin * 60000 && buyTs >= createdTs - 60000) return 'early';
  return null;
}

/** Earliest moment >= minClusters distinct clusters have bought `mint` inside
 *  a trailing windowMs. buys: [{cluster, entity, wallet, sol, ts}] any order.
 *  Returns { ts, clusters, entities, maxSol } or null. */
export function findConfluence(buys, { windowMs = 5 * 60000, minClusters = 2 } = {}) {
  const sorted = [...buys].sort((a, b) => a.ts - b.ts);
  for (let i = 0; i < sorted.length; i++) {
    const win = sorted.filter(b => b.ts >= sorted[i].ts && b.ts - sorted[i].ts <= windowMs);
    // The fire moment is when the minClusters-th distinct cluster's first buy
    // inside the window lands.
    const seen = new Set(); let fireTs = null;
    for (const b of win) { if (!seen.has(b.cluster)) { seen.add(b.cluster); if (seen.size === minClusters) { fireTs = b.ts; break; } } }
    if (fireTs != null) {
      const inWin = win.filter(b => b.ts <= fireTs);
      return { ts: fireTs, clusters: [...seen], entities: [...new Set(inWin.map(b => b.entity))], maxSol: Math.max(...inWin.map(b => b.sol)) };
    }
  }
  return null;
}

const med = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Aggregate the finalized, price-pathed events of a set. Partial outcomes
 *  (no candle path) are counted apart and never enter the rates — the same
 *  discipline as the Phase 2 scorecard's coins_no_price_path. */
export function summarizeEvents(events) {
  const fin = events.filter(e => e.out && e.out.done && e.out.maxRet != null);
  const partial = events.filter(e => e.out && e.out.done && e.out.maxRet == null).length;
  const n = fin.length;
  const share = (f) => (n ? fin.filter(f).length / n : null);
  return {
    events: events.length, finalized: n, partial,
    runnerShare: share(e => e.out.maxRet >= 0.5),
    crashShare: share(e => e.out.minRet <= -0.5),
    rugShare: share(e => e.out.minRet <= -0.9),
    medPeak: med(fin.map(e => 1 + e.out.maxRet)),
    medR60: med(fin.map(e => e.out.r60).filter(x => x != null)),
  };
}

function windowPasses(win, baseline) {
  const s = summarizeEvents(win);
  return s.finalized > 0 && s.runnerShare > baseline.runnerShare && s.crashShare < baseline.crashShare && s.rugShare < 0.15 && s.medPeak >= 2;
}

/** Per-dev status over rolling windows of the last qualN finalized launches:
 *  'qualified' when the latest full window beats the baseline on every leg;
 *  'demoted' when an earlier full window qualified and the latest fails;
 *  otherwise 'collecting'. Flag only — the user promotes. */
export function devStatus(events, baseline = BASELINE, qualN = 10) {
  const fin = events.filter(e => e.out && e.out.done && e.out.maxRet != null).sort((a, b) => a.ts - b.ts);
  if (fin.length < qualN) return 'collecting';
  const latest = fin.slice(-qualN);
  if (windowPasses(latest, baseline)) return 'qualified';
  for (let i = 0; i + qualN <= fin.length - 1; i++) {
    if (windowPasses(fin.slice(i, i + qualN), baseline)) return 'demoted';
  }
  return 'collecting';
}

/** Confluence stream status: qualified once >= qualN finalized events beat the
 *  baseline runner/crash legs. Flag only. */
export function confluenceStatus(events, baseline = BASELINE, qualN = 30) {
  const s = summarizeEvents(events);
  if (s.finalized >= qualN && s.runnerShare > baseline.runnerShare && s.crashShare < baseline.crashShare) return 'qualified';
  return 'collecting';
}

/** Outcome of one event from ascending minute candles [[tsSec,o,h,l,c,v],...].
 *  Entry price = close of the minute containing entryTs (first candle at or
 *  after entryTs when the containing minute has none). Checkpoints read the
 *  first close at/after their target minute. Returns null without candles. */
export function computeOutcome(candles, entryTs) {
  if (!candles || !candles.length) return null;
  const cs = candles.filter(c => c && c[0] * 1000 >= entryTs - 120000 && c[0] * 1000 <= entryTs + 62 * 60000);
  if (!cs.length) return null;
  const entryCandle = cs.find(c => c[0] * 1000 <= entryTs && entryTs < c[0] * 1000 + 60000) || cs.find(c => c[0] * 1000 >= entryTs) || cs[0];
  const entry = entryCandle[4];
  if (!(entry > 0)) return null;
  const closeAt = (min) => { const c = cs.find(x => x[0] * 1000 >= entryTs + min * 60000); return c ? c[4] / entry - 1 : null; };
  let maxH = -Infinity, minL = Infinity, peakTs = null;
  for (const c of cs) { if (c[2] > maxH) { maxH = c[2]; peakTs = c[0] * 1000; } if (c[3] < minL) minL = c[3]; }
  return {
    done: true, partial: false, refSource: 'candles', entryPrice: entry,
    r5: closeAt(5), r15: closeAt(15), r60: closeAt(60),
    maxRet: maxH / entry - 1, minRet: minL / entry - 1,
    peakMin: peakTs != null ? Math.max(0, Math.round((peakTs - entryTs) / 60000)) : null,
  };
}

async function defaultCoinFacts(mint) {
  // Via the pump relay when configured (2026-10-16, same direct-v3 disease as
  // gradWatch/pumpMovers: a direct call is Cloudflare-403'd from the bot's
  // host and the coin facts silently came back null).
  const { url, headers } = relayRoutePump(`${PF}/coins/${mint}`);
  const j = await fetchJson(url, { headers, timeout: 8000 });
  if (!j || !j.mint) return null;
  return { creator: j.creator || null, createdTs: Number(j.created_timestamp) || null, symbol: j.symbol || null };
}

async function defaultCandles(pool, entryTs) {
  if (!pool) return [];
  const before = Math.floor((entryTs + 62 * 60000) / 1000);
  const j = await fetchGtJson(`${GT}/networks/solana/pools/${pool}/ohlcv/minute?limit=100&before_timestamp=${before}`, { consumer: 'walletWatch', timeout: 12000, expect: 'ohlcv' });
  const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
  if (!Array.isArray(list)) return [];
  return list.map(r => [r[0], r[1], r[2], r[3], r[4], r[5]]).sort((a, b) => a[0] - b[0]);
}

export class WalletWatch {
  /**
   * deps: { cfg, dir, now, rpcFn, fetchViews, fetchCoin, fetchCandles,
   *         shadowGates(view, setup) -> {gates, gatePass}, noteMint, log, sets }
   */
  constructor({ cfg, dir, now = Date.now, rpcFn = null, fetchViews = null, fetchCoin = null, fetchCandles = null, shadowGates = null, noteMint = null, onEvent = null, liveEval = null, log = console.log, sets = null }) {
    this.cfg = cfg; this.dir = dir; this.now = now; this.log = log;
    this.rpcFn = rpcFn || ((m, p) => flowRpc(cfg.rpcUrls, m, p));
    this.fetchViews = fetchViews; this.shadowGates = shadowGates; this.noteMint = noteMint;
    this.onEvent = onEvent; // optional observer tap (Callout Shadow Lab): fired with the event right after it is journaled — record-only, fail-silent
    this.liveEval = liveEval; // optional LIVE tap (owner order 2026-10-16): fired with the event right after it is journaled, alongside onEvent — the Bot self-guards per kind (DEVLAUNCH_LIVE / CONFLUENCE_LIVE) and routes the standard entry pipeline; fail-silent here
    this.fetchCoin = fetchCoin || defaultCoinFacts;
    this.fetchCandles = fetchCandles || defaultCandles;
    this.sets = sets || loadSets();
    this.baseline = (this.sets && this.sets.baseline) || BASELINE;
    this.devByAddr = new Map((this.sets.devs || []).map(d => [d.address, d]));
    this.entityByWallet = new Map();
    for (const s of this.sets.survivors || []) for (const w of s.wallets || []) this.entityByWallet.set(w, s);
    this.file = dir ? path.join(dir, 'wallet_events.jsonl') : null;
    this.events = new Map();
    this.launchedKeys = new Set();   // `${dev}:${mint}` — one launch event per dev+coin
    this.lastConflAt = new Map();    // mint -> ts of last confluence event (dedupe)
    this.lastSig = new Map();
    this.seenSigs = new Set();
    this.buys = [];                  // recent survivor buys for confluence
    this.coinCache = new Map();
    this.seq = 0;
    this.timers = [];
    this.polling = { dev: false, confl: false };
    this._load();
  }

  get active() { return !!(this.cfg.walletWatchEnabled && this.cfg.rpcUrls && this.cfg.rpcUrls.length && (this.devByAddr.size || this.entityByWallet.size)); }

  _load() {
    if (!this.file) return;
    try {
      for (const l of readTailLines(this.file, 16 * 1024 * 1024) /* byte-capped tail (2026-10-18 boot-OOM fix) */) {
        if (!l.trim()) continue;
        let r; try { r = JSON.parse(l); } catch { continue; }
        if (r.t === 'ev' && r.ev && r.ev.id) {
          this.events.set(r.ev.id, r.ev);
          if (r.ev.kind === 'dev') this.launchedKeys.add(`${r.ev.dev}:${r.ev.mint}`);
          if (r.ev.kind === 'confluence') this.lastConflAt.set(r.ev.mint, Math.max(this.lastConflAt.get(r.ev.mint) || 0, r.ev.ts));
        } else if (r.t === 'fin' && this.events.has(r.id)) this.events.get(r.id).out = r.out;
        else if (r.t === 'sell' && this.events.has(r.id)) this.events.get(r.id).devSell = r.sell;
      }
    } catch { /* no file yet */ }
  }

  _append(rec) { if (this.file) { try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort */ } } }

  start() {
    if (!this.active || this.timers.length) return;
    const mk = (fn, sec) => { const t = setInterval(() => { fn().catch(e => this.log(`[walletwatch] poll failed: ${e && e.message}`)); }, sec * 1000); if (t.unref) t.unref(); return t; };
    if (this.devByAddr.size) this.timers.push(mk(() => this.pollGroup('dev'), this.cfg.devPollSec));
    if (this.entityByWallet.size) this.timers.push(mk(() => this.pollGroup('confl'), this.cfg.conflPollSec));
    this.log(`[walletwatch] shadow detectors on: ${this.devByAddr.size} devs every ${this.cfg.devPollSec}s, ${this.entityByWallet.size} survivor wallets (${(this.sets.survivors || []).length} entities) every ${this.cfg.conflPollSec}s — live routing: devlaunch ${this.cfg.devlaunchLive ? 'LIVE' : 'off'}, confluence ${this.cfg.confluenceLive ? 'LIVE' : 'off'}`);
  }

  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async pollGroup(role) {
    if (this.polling[role] || !this.active) return;
    this.polling[role] = true;
    try {
      const wallets = role === 'dev' ? [...this.devByAddr.keys()] : [...this.entityByWallet.keys()];
      for (let i = 0; i < wallets.length; i += 8) {
        await Promise.all(wallets.slice(i, i + 8).map(w => this.pollWallet(w, role).catch(e => this.log(`[walletwatch] ${role} wallet poll failed: ${e && e.message}`))));
      }
    } finally { this.polling[role] = false; }
  }

  async pollWallet(wallet, role) {
    const sigs = await this.rpcFn('getSignaturesForAddress', [wallet, { limit: 25 }]);
    if (!Array.isArray(sigs) || !sigs.length) return;
    if (!this.lastSig.has(wallet)) { this.lastSig.set(wallet, sigs[0].signature); return; } // first contact: adopt watermark, no backfill
    const fresh = [];
    for (const s of sigs) {
      if (!s || !s.signature) continue;
      if (s.signature === this.lastSig.get(wallet)) break;
      if (!this.seenSigs.has(s.signature)) fresh.push(s);
    }
    if (sigs[0] && sigs[0].signature) this.lastSig.set(wallet, sigs[0].signature);
    for (const s of fresh.reverse()) {
      this.seenSigs.add(s.signature);
      if (s.err) continue;
      let tx = null;
      try { tx = await this.rpcFn('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]); } catch { tx = null; }
      if (!tx) continue;
      const ts = s.blockTime ? s.blockTime * 1000 : this.now();
      for (const b of parseWalletBuys(tx, wallet)) {
        if (!(b.sol >= FLOW_DUST_SOL)) continue;
        if (role === 'dev') await this.onDevBuy(wallet, b, ts);
        else this.onSurvivorBuy(wallet, b, ts);
      }
      if (role === 'dev') {
        for (const s2 of parseWalletSells(tx, wallet)) this.onDevSell(wallet, s2, ts);
      }
    }
    if (this.seenSigs.size > 5000) this.seenSigs = new Set([...this.seenSigs].slice(-2000));
  }

  async coinFacts(mint) {
    if (this.coinCache.has(mint)) return this.coinCache.get(mint);
    let facts = null;
    try { facts = await this.fetchCoin(mint); } catch { facts = null; }
    if (this.coinCache.size > 4000) this.coinCache = new Map([...this.coinCache].slice(-2000));
    this.coinCache.set(mint, facts);
    return facts;
  }

  async viewFor(mint) {
    if (!this.fetchViews) return null;
    try { const m = await this.fetchViews([mint]); return (m && m.get(mint)) || null; } catch { return null; }
  }

  async gateVerdict(v, setup) {
    if (!v || !this.shadowGates) return { gates: null, gatePass: null, firstBlocker: null };
    try {
      const g = await this.shadowGates(v, setup);
      if (!g) return { gates: null, gatePass: null, firstBlocker: null };
      let firstBlocker = null;
      if (g.gates) for (const [k, val] of Object.entries(g.gates)) { if (val && val.pass === false) { firstBlocker = k; break; } }
      return { gates: g.gates, gatePass: g.gatePass, firstBlocker };
    } catch { return { gates: null, gatePass: null, firstBlocker: null }; }
  }

  async onDevBuy(wallet, buy, ts) {
    const key = `${wallet}:${buy.mint}`;
    if (this.launchedKeys.has(key)) return;
    const facts = await this.coinFacts(buy.mint);
    if (!facts || !facts.createdTs) return; // can't prove creation/age — not a provable launch
    const sub = classifyDevBuy({ creator: facts.creator, createdTs: facts.createdTs, buyTs: ts, wallet, earlyMin: this.cfg.devEarlyMin });
    if (!sub) return;
    this.launchedKeys.add(key);
    const dev = this.devByAddr.get(wallet);
    const v = await this.viewFor(buy.mint);
    const verdict = await this.gateVerdict(v, 'devlaunch');
    const ev = {
      id: `dev-${ts}-${++this.seq}`, kind: 'dev', sub, ts: this.now(),
      dev: wallet, devName: dev ? dev.name : wallet, mint: buy.mint,
      symbol: (v && v.symbol) || facts.symbol || null,
      launchTs: facts.createdTs, buyTs: ts, buySol: buy.sol,
      entryTs: facts.createdTs + 60000,
      mc: v ? v.mc : null, pool: v ? (v.pairAddress || null) : null, viewPrice: v ? v.price : null,
      gates: verdict.gates, gatePass: verdict.gatePass, firstBlocker: verdict.firstBlocker,
      out: null, devSell: null,
    };
    this.events.set(ev.id, ev);
    this._append({ t: 'ev', ev });
    if (this.onEvent) try { this.onEvent(ev); } catch { /* observer */ }
    if (this.liveEval) try { this.liveEval(ev); } catch { /* live tap — Bot self-guards */ }
    if (this.noteMint) try { this.noteMint(buy.mint, 'devlaunch'); } catch { /* observer */ }
    this.log(`[walletwatch] DEV LAUNCH ${ev.devName} ${sub} ${ev.symbol || buy.mint} (bought ${buy.sol.toFixed(2)} SOL) — gates would ${verdict.gatePass === false ? `block (${verdict.firstBlocker})` : verdict.gatePass === true ? 'pass' : 'n/a'}`);
  }

  onDevSell(wallet, sell, ts) {
    for (const ev of this.events.values()) {
      if (ev.kind !== 'dev' || ev.dev !== wallet || ev.mint !== sell.mint || ev.devSell) continue;
      if (ts <= ev.buyTs) continue;
      ev.devSell = { ts, sol: sell.sol };
      this._append({ t: 'sell', id: ev.id, sell: ev.devSell });
      this.log(`[walletwatch] DEV FIRST SELL ${ev.devName} sold ${ev.symbol || sell.mint} (+${((ts - ev.buyTs) / 60000).toFixed(1)}m after buy)`);
    }
  }

  onSurvivorBuy(wallet, buy, ts) {
    const ent = this.entityByWallet.get(wallet);
    if (!ent) return;
    const n = this.now();
    this.buys.push({ cluster: ent.cluster || ent.entity, entity: ent.entity, name: ent.name, wallet, mint: buy.mint, sol: buy.sol, ts });
    const horizon = this.cfg.conflWindowMin * 60000 * 4;
    this.buys = this.buys.filter(b => n - b.ts <= horizon || ts - b.ts <= horizon);
    const mine = this.buys.filter(b => b.mint === buy.mint);
    const trig = findConfluence(mine, { windowMs: this.cfg.conflWindowMin * 60000, minClusters: this.cfg.conflMinClusters });
    if (!trig) return;
    if (n - (this.lastConflAt.get(buy.mint) || 0) < 30 * 60000) return; // one event per mint per 30m
    this.lastConflAt.set(buy.mint, n);
    void this.createConfluence(buy.mint, trig, ts);
  }

  async createConfluence(mint, trig, ts) {
    const v = await this.viewFor(mint);
    const verdict = await this.gateVerdict(v, 'confluence');
    const names = [...new Set(this.buys.filter(b => b.mint === mint && trig.entities.includes(b.entity)).map(b => b.name))];
    // Confluence Shadow Signal bucket features (additive, record-only):
    // distinct WALLETS among the in-window buys (entities/clusters collapse
    // them; the raw count is a separate axis), and the coin's age at
    // detection when the view carries a creation time.
    const winMs = this.cfg.conflWindowMin * 60000;
    const walletCount = new Set(this.buys.filter(b => b.mint === mint && b.ts <= trig.ts && trig.ts - b.ts <= winMs).map(b => b.wallet)).size;
    const coinAgeMin = v && v.createdAt ? Math.max(0, Math.round((this.now() - v.createdAt) / 600) / 100) : null;
    const ev = {
      id: `cnf-${ts}-${++this.seq}`, kind: 'confluence', ts: this.now(),
      mint, symbol: v ? v.symbol : null, entryTs: trig.ts,
      clusters: trig.clusters, entities: trig.entities, names, maxSol: trig.maxSol,
      walletCount, coinAgeMin,
      mc: v ? v.mc : null, pool: v ? (v.pairAddress || null) : null, viewPrice: v ? v.price : null,
      gates: verdict.gates, gatePass: verdict.gatePass, firstBlocker: verdict.firstBlocker,
      out: null,
    };
    this.events.set(ev.id, ev);
    this._append({ t: 'ev', ev });
    if (this.onEvent) try { this.onEvent(ev); } catch { /* observer */ }
    if (this.liveEval) try { this.liveEval(ev); } catch { /* live tap — Bot self-guards */ }
    if (this.noteMint) try { this.noteMint(mint, 'confluence'); } catch { /* observer */ }
    this.log(`[walletwatch] CONFLUENCE ${ev.symbol || mint}: ${trig.clusters.length} entities (${names.join(', ')}) within ${this.cfg.conflWindowMin}m — gates would ${verdict.gatePass === false ? `block (${verdict.firstBlocker})` : verdict.gatePass === true ? 'pass' : 'n/a'}`);
  }

  /** Finalize outcomes for events past their 60m window. Called from the bot's
   *  poll tick; throttled per event and per tick. Fail-silent throughout. */
  async finalizeTick(n = this.now()) {
    let fetched = 0;
    for (const ev of this.events.values()) {
      if (ev.out && ev.out.done) continue;
      if (n < ev.entryTs + 65 * 60000) continue;
      if (ev.nextTry && n < ev.nextTry) continue;
      ev.nextTry = n + 10 * 60000;
      if (fetched >= 3) continue;
      fetched++;
      let out = null;
      try { out = computeOutcome(await this.fetchCandles(ev.pool, ev.entryTs), ev.entryTs); } catch { out = null; }
      if (!out) {
        if (n < ev.entryTs + 6 * 3600000) continue; // candles may lag; retry for up to 6h
        out = { done: true, partial: true, refSource: 'none', entryPrice: ev.viewPrice || null, r5: null, r15: null, r60: null, maxRet: null, minRet: null, peakMin: null };
      }
      ev.out = out;
      this._append({ t: 'fin', id: ev.id, out });
      this.log(`[walletwatch] ${ev.kind} outcome ${ev.symbol || ev.mint}: peak ${out.maxRet != null ? (out.maxRet * 100).toFixed(0) + '%' : 'n/a'}, r60 ${out.r60 != null ? (out.r60 * 100).toFixed(0) + '%' : 'n/a'}${out.partial ? ' (partial — no candle path)' : ''}`);
    }
  }

  snapshot() {
    const all = [...this.events.values()].sort((a, b) => a.ts - b.ts);
    const devEvents = all.filter(e => e.kind === 'dev');
    const cnfEvents = all.filter(e => e.kind === 'confluence');
    const slim = (e) => ({ id: e.id, kind: e.kind, sub: e.sub || null, ts: e.ts, symbol: e.symbol, mint: e.mint, devName: e.devName || null, names: e.names || null, buySol: e.buySol || null, buyTs: e.buyTs || null, maxSol: e.maxSol || null, mc: e.mc, gatePass: e.gatePass, firstBlocker: e.firstBlocker, entryTs: e.entryTs, out: e.out, devSell: e.devSell || null });
    return {
      enabled: !!this.cfg.walletWatchEnabled,
      liveRouting: { devlaunch: !!this.cfg.devlaunchLive, confluence: !!this.cfg.confluenceLive }, // LIVE flips (owner order 2026-10-16): the running process's routing state for each detector, readable on /devwatch
      baseline: this.baseline,
      qual: { devN: this.cfg.devQualN, conflN: this.cfg.conflQualN },
      counts: { devWallets: this.devByAddr.size, survivorWallets: this.entityByWallet.size, survivorEntities: (this.sets.survivors || []).length, events: all.length, pending: all.filter(e => !(e.out && e.out.done)).length },
      devs: (this.sets.devs || []).map(d => {
        const evs = devEvents.filter(e => e.dev === d.address);
        return { address: d.address, name: d.name, ...summarizeEvents(evs), status: devStatus(evs, this.baseline, this.cfg.devQualN), recent: evs.slice(-5).reverse().map(slim) };
      }),
      confluence: { ...summarizeEvents(cnfEvents), status: confluenceStatus(cnfEvents, this.baseline, this.cfg.conflQualN), recent: cnfEvents.slice(-10).reverse().map(slim) },
      recent: all.slice(-20).reverse().map(slim),
    };
  }
}
