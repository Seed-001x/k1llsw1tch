// structureWatch.js — Structure Watch (user 2026-10-15, RECORD-ONLY).
//
// The trend detector judges SLOPE: +25% on the hour with buy pressure fires
// the same way on a blow-off top as on a healthy climb. The user's 'healthy
// trend' concept judges STRUCTURE + SURVIVAL instead: a coin that survives
// its first dump and builds a staircase of higher lows over hours, with
// holder growth as a second witness. Nothing in the bot has ever recorded
// that — holder counts existed only as one-off snapshots at gate-eval time,
// so no holder time series existed to judge the idea against, and signaled
// coins were dropped from view within minutes. This module's primary job
// is to WRITE THAT DATASET: for every signaled mint it keeps an hours-long
// watch, samples price (5m candles) + holder count (Helius DAS) about every
// 5 minutes, tracks the confirmed swing staircase, and journals a
// 'would-enter' mark at each confirmed higher low, scored forward.
//
// ANTI-LOOKAHEAD (the user's own rule, specced for Dip Hunter variant B): a
// swing low is a low lower than the 2 candles on each side and counts ONLY
// from its confirmation, 2 candles after it prints; a candle whose 5m
// window has not fully closed informs NO decision (its close is not a fact
// yet). No code path here may use an unconfirmed swing or a partial candle.
//
// PERCENT CONVENTION: every return/growth value in this module and its
// endpoint is a FRACTION (0.5 = +50%), matching /resignals and /callouts.
//
// HARD BOUNDARIES: strictly record-only. No trading decision reads this
// module; it never buys, sells, signs or posts. Every public method is
// fail-silent — a watch failure (GT down, DAS down, torn file) can never
// reach a trading path. Holder sampling rides the bot's existing DAS helper
// (the Bot passes its knob-respecting _dasHolderSample as fetchHolders).
import fs from 'node:fs';
import { fetchJson, median, round, readTailLines } from './util.js';
import { fetchGtJson } from './gtFetch.js';
import { fetchHolderCount } from './gate.js';

const GT = 'https://api.geckoterminal.com/api/v2';
export const STRUCTURE_MAX_WATCHES = 30;      // concurrent watch cap — beyond it seeds are skipped + counted
export const STRUCTURE_WATCH_MS = 4 * 3600e3; // a watch lives at most 4h from its seed
export const STRUCTURE_SAMPLE_MS = 5 * 60000; // per-watch sampling cadence (~every 5 min)
const CANDLE_MS = 5 * 60000;                  // 5m candles
const DIED_GAP_MS = 30 * 60000;               // no new candle for 30+ min (after a successful fetch) → died
const NO_CANDLE_DIE_MS = 60 * 60000;          // never any candle within 60 min of seed → died
const BOUNCE_MIN = 1.15;                      // intervening swing high must reach ≥ prev low × 1.15
const HORIZONS = [15, 60, 240];               // mark forward-return horizons, minutes
const RKEY = { 15: 'r15', 60: 'r60', 240: 'r240' };
const GROWING = 0.05, SHRINKING = -0.05;      // holder-growth split thresholds (fractions)
const PER_TICK_MAX = 3;                       // samples per poll tick (spreads GT/DAS load)
const CARD_CACHE_MS = 60000;

// ---------- pure staircase engine (tested directly) ----------

/** Only candles whose 5m window has FULLY closed by nowMs may inform any
 *  decision. Returns them ascending. */
/** Trending-seed picker (owner order 2026-10-18 — the structure watch's
 *  second supply line): from one scraped trending-list page, choose the
 *  rows worth seeding — a mint, a readable market cap at/above the floor
 *  (a row whose cap can't be read is skipped: the floor must be verified,
 *  not assumed), deduped within the page, capped at `limit`. Pure — the
 *  Bot owns the hourly budget, the watch-cap headroom and the seeding. */
export function pickTrendSeeds(rows, { minMc = 0, limit = Infinity, exclude = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of rows || []) {
    if (out.length >= limit) break;
    const mint = row && (row.mint || row.address);
    if (!mint || seen.has(mint)) continue;
    if (exclude && exclude.has(mint)) continue; // already watched — walk deeper into the list instead of spending the limit on collisions
    const mc = row.usd_market_cap ?? row.market_cap ?? row.mc ?? null;
    if (mc == null || !Number.isFinite(mc) || mc < minMc) continue;
    seen.add(mint);
    out.push({ mint, symbol: row.symbol || row.name || null, mc, price: row.price ?? row.usd_price ?? null });
  }
  return out;
}

export function completedCandles(candles, nowMs) {
  return (candles || [])
    .filter(c => c && Number.isFinite(c[0]) && (c[0] * 1000 + CANDLE_MS) <= nowMs)
    .sort((a, b) => a[0] - b[0]);
}

/** Confirmed swings over COMPLETED candles [[tsSec,o,h,l,c,v],…]. A swing
 *  low at index i: low strictly lower than the lows of the 2 candles on
 *  each side; it counts only from candle i+2 (its confirmation candle).
 *  Returns { lows, highs } in center order; each entry carries the center
 *  ts (sec), the extreme value, and the confirmation candle's ts + close. */
export function findConfirmedSwings(candles) {
  const cs = candles || [];
  const lows = [], highs = [];
  for (let i = 2; i + 2 < cs.length; i++) {
    const l = cs[i][3], h = cs[i][2];
    if (l < cs[i - 1][3] && l < cs[i - 2][3] && l < cs[i + 1][3] && l < cs[i + 2][3]) {
      lows.push({ ts: cs[i][0], low: l, confirmTs: cs[i + 2][0], confirmClose: cs[i + 2][4] });
    }
    if (h > cs[i - 1][2] && h > cs[i - 2][2] && h > cs[i + 1][2] && h > cs[i + 2][2]) {
      highs.push({ ts: cs[i][0], high: h, confirmTs: cs[i + 2][0], confirmClose: cs[i + 2][4] });
    }
  }
  return { lows, highs };
}

/** Higher-low marks over confirmed swings. Walking the confirmed swing
 *  lows in order, a mark fires when a new low L2 is higher than the
 *  immediately preceding confirmed swing low L1 AND at least one confirmed
 *  swing high centered between them reached ≥ L1 × 1.15 (a real bounce
 *  between the lows, not two scrapes along the floor). The mark's moment
 *  is L2's confirmation candle: ts = its start, price = its close. The
 *  'previous low' always advances to the newest confirmed low, marked or
 *  not — that is the staircase's running base. */
export function detectHigherLows(swings) {
  const marks = [];
  const lows = (swings && swings.lows) || [];
  const highs = (swings && swings.highs) || [];
  let prev = null;
  for (const l of lows) {
    if (prev && l.low > prev.low) {
      const bounced = highs.some(h => h.ts > prev.ts && h.ts < l.ts && h.high >= prev.low * BOUNCE_MIN);
      if (bounced) marks.push({ lowPrev: prev.low, lowNew: l.low, lowTs: l.ts, ts: l.confirmTs * 1000, price: l.confirmClose });
    }
    prev = l;
  }
  return marks;
}

/** Forward score for one mark from COMPLETED candles. rX = close of the
 *  first candle starting at/after markTs + X min, ÷ mark price − 1 (null
 *  while that candle has not completed — never fabricated). peakPct /
 *  worstDipPct = extremes of candle highs/lows strictly after the mark's
 *  confirmation candle, ÷ mark price − 1. */
export function scoreMark(candles, mark) {
  const out = { r15: null, r60: null, r240: null, peakPct: null, worstDipPct: null };
  if (!mark || !(mark.price > 0)) return out;
  const cs = candles || [];
  for (const h of HORIZONS) {
    const c = cs.find(x => x[0] * 1000 >= mark.ts + h * 60000);
    if (c) out[RKEY[h]] = c[4] / mark.price - 1;
  }
  let peak = null, dip = null;
  for (const c of cs) {
    if (c[0] * 1000 <= mark.ts) continue;
    if (peak == null || c[2] > peak) peak = c[2];
    if (dip == null || c[3] < dip) dip = c[3];
  }
  if (peak != null) out.peakPct = peak / mark.price - 1;
  if (dip != null) out.worstDipPct = dip / mark.price - 1;
  return out;
}

// ---------- pure scorecard (tested directly) ----------

/** Fold raw journal lines into the watch/mark/score sets (latest score
 *  per mark wins; first seed/end per watch wins). */
export function foldStructureJournal(records) {
  const seeds = new Map(), ends = new Map(), marks = new Map(), scores = new Map();
  let samples = 0, holderSamples = 0, skippedCap = 0;
  for (const r of records || []) {
    if (!r || !r.type) continue;
    if (r.type === 'seed' && r.watchId) { if (!seeds.has(r.watchId)) seeds.set(r.watchId, r); }
    else if (r.type === 'end' && r.watchId) { if (!ends.has(r.watchId)) ends.set(r.watchId, r); }
    else if (r.type === 'sample') { samples++; if (r.holderTried) holderSamples++; }
    else if (r.type === 'skip') skippedCap++;
    else if (r.type === 'mark' && r.markId) { if (!marks.has(r.markId)) marks.set(r.markId, r); }
    else if (r.type === 'mark-score' && r.markId) scores.set(r.markId, r);
  }
  return { seeds, ends, marks, scores, samples, holderSamples, skippedCap };
}

function markAgg(items) {
  // Aggregates ride on FINALIZED marks (r60 present) — a mark still inside
  // its first hour has no verdict yet and must not dilute the medians.
  const fin = items.filter(x => x.score && x.score.r60 != null);
  const r60s = fin.map(x => x.score.r60).filter(Number.isFinite);
  const peaks = fin.map(x => x.score.peakPct).filter(Number.isFinite);
  return {
    n: items.length,
    finalized: fin.length,
    medianR60: r60s.length ? round(median(r60s)) : null,
    medianPeak: peaks.length ? round(median(peaks)) : null,
    sharePeak50: peaks.length ? round(peaks.filter(x => x >= 0.5).length / peaks.length, 3) : null,
  };
}

export function buildStructureCard(records) {
  const f = foldStructureJournal(records);
  const joined = [...f.marks.values()].map(m => ({ m, score: f.scores.get(m.markId) || null }));
  const byOrdinal = { '1': [], '2': [], '3+': [] };
  for (const x of joined) byOrdinal[x.m.ordinal >= 3 ? '3+' : String(x.m.ordinal || 1)].push(x);
  const split = { growing: [], flat: [], shrinking: [] };
  let unknown = 0;
  for (const x of joined) {
    const g = x.m.holderGrowthPct;
    if (g == null || !Number.isFinite(g)) unknown++;
    else if (g >= GROWING) split.growing.push(x);
    else if (g <= SHRINKING) split.shrinking.push(x);
    else split.flat.push(x);
  }
  const recentMarks = [...joined].sort((a, b) => b.m.ts - a.m.ts).slice(0, 10).map(({ m, score }) => ({
    markId: m.markId, watchId: m.watchId, ts: m.ts, mint: m.mint || null,
    symbol: m.symbol != null ? m.symbol : ((f.seeds.get(m.watchId) || {}).symbol ?? null),
    seedSource: m.seedSource ?? ((f.seeds.get(m.watchId) || {}).seedSource ?? null),
    ordinal: m.ordinal, price: m.price ?? null, lowPrev: m.lowPrev ?? null, lowNew: m.lowNew ?? null,
    holdersAtSeed: m.holdersAtSeed ?? null, holdersAtMark: m.holdersAtMark ?? null, holderGrowthPct: m.holderGrowthPct ?? null,
    score: score ? {
      r15: score.r15 ?? null, r60: score.r60 ?? null, r240: score.r240 ?? null,
      peakPct: score.peakPct ?? null, worstDipPct: score.worstDipPct ?? null, final: !!score.final,
    } : null,
  }));
  const seedSources = {};
  for (const s of f.seeds.values()) { const k = s.seedSource || 'signal'; seedSources[k] = (seedSources[k] || 0) + 1; }
  return {
    watching: [...f.seeds.keys()].filter(id => !f.ends.has(id)).length,
    watchedTotal: f.seeds.size,
    seedSources,
    ended: f.ends.size,
    samples: f.samples,
    holderSamples: f.holderSamples,
    skippedCap: f.skippedCap,
    marks: joined.length,
    marksFinalized: joined.filter(x => x.score && x.score.r60 != null).length,
    byOrdinal: { '1': markAgg(byOrdinal['1']), '2': markAgg(byOrdinal['2']), '3+': markAgg(byOrdinal['3+']) },
    holderSplit: { growing: markAgg(split.growing), flat: markAgg(split.flat), shrinking: markAgg(split.shrinking), unknown },
    ready: joined.filter(x => x.score && x.score.r60 != null).length >= 30,
    recentMarks,
  };
}

// ---------- default network access (injectable for tests) ----------

async function defaultFetchCandles(pool, fromTs, toTs) {
  const byTs = new Map();
  let before = Math.floor(toTs / 1000) + 300;
  for (let page = 0; page < 4; page++) {
    const j = await fetchGtJson(`${GT}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=5&limit=1000&before_timestamp=${before}`, { consumer: 'structureWatch', timeout: 15000, expect: 'ohlcv' });
    const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
    if (!list || !list.length) break;
    let oldest = Infinity;
    for (const row of list) { byTs.set(row[0], row); if (row[0] < oldest) oldest = row[0]; }
    if (oldest * 1000 <= fromTs || list.length < 1000) break;
    before = oldest - 1;
  }
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

async function defaultResolvePool(mint) {
  // GT top pool first (the wallet detectors'/callout scorer's discipline);
  // DexScreener's deepest pair as the fallback for mints GT hasn't ranked.
  try {
    const j = await fetchGtJson(`${GT}/networks/solana/tokens/${mint}`, { consumer: 'structureWatch', timeout: 12000 });
    const pools = j && j.data && j.data.relationships && j.data.relationships.top_pools && j.data.relationships.top_pools.data;
    if (pools && pools.length) {
      const id = String(pools[0].id || '');
      const p = id.startsWith('solana_') ? id.slice('solana_'.length) : id;
      if (p) return p;
    }
  } catch { /* fall through to DexScreener */ }
  try {
    const j = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 12000 });
    const pairs = ((j && j.pairs) || []).filter(p => p && p.chainId === 'solana' && p.pairAddress);
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    if (pairs.length) return pairs[0].pairAddress;
  } catch { /* no pool anywhere — the watch samples holders only until expiry */ }
  return null;
}

// ---------- the watch ----------

export class StructureWatch {
  /**
   * deps: { cfg, journal, now, fetchCandles(pool, fromTs, toTs),
   *         resolvePool(mint), fetchHolders(mint) -> count|null, log }
   * fetchHolders is ONE Helius DAS call per invocation — the credit meter
   * (holderSamples) counts invocations at sample time.
   */
  constructor({ cfg = {}, journal = null, now = () => Date.now(), fetchCandles = null, resolvePool = null, fetchHolders = null, log = null, onMark = null } = {}) {
    this.cfg = cfg;
    this.journal = journal;
    this.now = now;
    this.onMark = onMark; // Staircase-3 shadow-signal tap (record-only): invoked with each journaled mark AFTER the watch's own append; the watch reads nothing back from it
    this.fetchCandles = fetchCandles || defaultFetchCandles;
    this.resolvePool = resolvePool || defaultResolvePool;
    this.fetchHolders = fetchHolders || ((mint) => fetchHolderCount(mint, { rpcUrls: (cfg && cfg.rpcUrls) || [], now: this.now() }));
    this.log = log;
    this.active = new Map();     // watchId -> live watch state
    this.activeMint = new Map(); // mint -> watchId (one active watch per mint)
    this.seq = 0;
    this.stats = { samples: 0, holderSamples: 0, skippedCap: 0 };
    this.cardCache = null;
    this.cardCacheTs = 0;
    this._restore();
  }

  _file() { return this.journal && this.journal.f ? this.journal.f.swatch : null; }

  _readAll() {
    const f = this._file();
    if (!f) return [];
    // Byte-capped tail (2026-10-18 boot-OOM fix): watches live for hours,
    // so the last ~24MB of journal covers every live watch; older history
    // folds out of the boot aggregates instead of OOMing the instance.
    const out = [];
    for (const line of readTailLines(f, 24 * 1024 * 1024)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail line - skip */ }
    }
    return out;
  }

  _append(rec) { try { if (this.journal) this.journal.structure(rec); } catch { /* record-only */ } }

  _stagger() { return (this.seq * 37 % 60) * 1000; } // 0–59s per-watch offset, spreads the 5-min herd

  _restore() {
    const records = this._readAll();
    const f = foldStructureJournal(records);
    this.stats.samples = f.samples;
    this.stats.holderSamples = f.holderSamples;
    this.stats.skippedCap = f.skippedCap;
    const byWatch = new Map(); // watchId -> journal rows in file order, for state rebuild
    for (const r of records) {
      if (!r || !r.watchId) continue;
      if (!byWatch.has(r.watchId)) byWatch.set(r.watchId, []);
      byWatch.get(r.watchId).push(r);
    }
    for (const [watchId, seed] of f.seeds) {
      this.seq++; // keep post-restart ids unique — seq only ever grows past the journaled count
      if (f.ends.has(watchId)) continue;
      const w = this._newWatch(seed);
      for (const r of byWatch.get(watchId) || []) {
        if (r.type === 'sample') {
          if (w.holdersAtSeed == null && r.holders != null) w.holdersAtSeed = r.holders;
          if (r.holders != null) w.lastHolders = r.holders;
          if (r.candleTs != null && (w.lastCandleTs == null || r.candleTs > w.lastCandleTs)) w.lastCandleTs = r.candleTs;
          if (r.ts > w.lastSampleAt) { w.lastSampleAt = r.ts; w.nextSampleAt = r.ts + STRUCTURE_SAMPLE_MS + w.staggerMs; }
        } else if (r.type === 'mark') {
          w.marksFired.add(r.lowTs);
          w.marks.set(r.markId, r);
          if (r.ordinal > w.ordinal) w.ordinal = r.ordinal;
        } else if (r.type === 'mark-score') {
          w.scores.set(r.markId, r);
        }
      }
      this.active.set(watchId, w);
      this.activeMint.set(seed.mint, watchId);
    }
  }

  _newWatch(seedRec) {
    return {
      rec: seedRec, pool: null, candles: [],
      holdersAtSeed: null, lastHolders: null,
      lastSampleAt: 0, nextSampleAt: seedRec.ts, lastCandleTs: null,
      staggerMs: this._stagger(),
      marksFired: new Set(), marks: new Map(), scores: new Map(), ordinal: 0,
      sampling: false,
    };
  }

  /** Seed a watch from a freshly journaled signal record (called from the
   *  Journal.signal() funnel via a Bot-wired callback). Synchronous claim —
   *  the active-mint set is updated before any await — so two signals in
   *  the same tick can never double-seed a mint. Returns the seed record,
   *  or null when the mint is already watched or the cap is full (counted). */
  seed(rec) {
    try {
      if (!rec || !rec.mint) return null;
      if (this.activeMint.has(rec.mint)) return null;
      const ts = rec.ts || this.now();
      if (this.active.size >= STRUCTURE_MAX_WATCHES) {
        this.stats.skippedCap++;
        this._append({ type: 'skip', ts, mint: rec.mint, setup: rec.setup || null, reason: 'cap' });
        return null;
      }
      const watchId = `sw-${ts}-${++this.seq}`;
      const srec = {
        type: 'seed', watchId, ts, signalId: rec.id || null, mint: rec.mint,
        symbol: rec.symbol || null, setup: rec.setup || null, decision: rec.decision || null,
        seedSource: rec.seedSource || 'signal',
        mc: rec.mc ?? null, price: rec.price ?? null,
      };
      const w = this._newWatch(srec);
      w.nextSampleAt = ts + STRUCTURE_SAMPLE_MS + w.staggerMs;
      this.active.set(watchId, w);
      this.activeMint.set(rec.mint, watchId);
      this._append(srec);
      if (this.log) this.log(`[structurewatch] watching ${srec.symbol || srec.mint} (${srec.setup || '?'}/${srec.decision || '?'}) — record only`);
      // First sample immediately (fire-and-forget): holdersAtSeed should sit
      // as close to the signal as the DAS allows, not 5 minutes after it.
      this._sample(w, ts).catch(() => {});
      return srec;
    } catch { return null; }
  }

  /** Sampling pass — rides the bot's poll tick. Per tick: expire watches
   *  past their 4h life (one last sample first, so finals score on the
   *  freshest candles), then sample due watches, capped per tick. All
   *  fail-silent; nothing here can throw into the trading loop. */
  async tick(n = this.now()) {
    try {
      let sampled = 0;
      for (const w of [...this.active.values()]) {
        if (!this.active.has(w.rec.watchId)) continue; // ended mid-pass
        if (n - w.rec.ts >= STRUCTURE_WATCH_MS) {
          try { await this._sample(w, n); } catch { /* fail silent */ }
          this._end(w, n, 'expired');
          continue;
        }
        if (sampled >= PER_TICK_MAX) continue;
        if (!w.sampling && n >= w.nextSampleAt) {
          sampled++;
          try { await this._sample(w, n); } catch { /* fail silent */ }
        }
      }
    } catch { /* shadow watch — fail silent */ }
  }

  async _sample(w, n) {
    if (w.sampling || !this.active.has(w.rec.watchId)) return;
    w.sampling = true;
    try {
      w.lastSampleAt = n;
      w.nextSampleAt = n + STRUCTURE_SAMPLE_MS + w.staggerMs;
      if (!w.pool) { try { w.pool = await this.resolvePool(w.rec.mint); } catch { w.pool = null; } }
      let candles = null, fetchOk = false;
      if (w.pool) {
        try { candles = await this.fetchCandles(w.pool, w.rec.ts - CANDLE_MS, n); fetchOk = Array.isArray(candles); }
        catch { candles = null; }
      }
      let price = null;
      if (fetchOk && candles.length) {
        price = candles[candles.length - 1][4];
        const lastTs = candles[candles.length - 1][0] * 1000;
        if (w.lastCandleTs == null || lastTs > w.lastCandleTs) w.lastCandleTs = lastTs;
        w.candles = candles;
      }
      // One DAS holder read per sample — attempted unconditionally, and the
      // attempt is the meter (a failed read still made the call).
      this.stats.holderSamples++;
      let holders = null;
      try { const h = await this.fetchHolders(w.rec.mint); holders = Number.isFinite(h) ? h : null; } catch { holders = null; }
      if (holders != null) {
        w.lastHolders = holders;
        if (w.holdersAtSeed == null) w.holdersAtSeed = holders;
      }
      this.stats.samples++;
      this._append({ type: 'sample', watchId: w.rec.watchId, ts: n, price: price ?? null, holders, holderTried: true, candleTs: w.lastCandleTs });
      if (fetchOk) {
        const done = completedCandles(w.candles, n);
        this._runEngine(w, done);
        this._updateScores(w, done, n, false);
        // Death is judged only on a SUCCESSFUL fetch: a GT outage is not a
        // dead coin. The candle stream going quiet for 30+ min is.
        if (w.lastCandleTs != null && n - (w.lastCandleTs + CANDLE_MS) >= DIED_GAP_MS) { this._end(w, n, 'died'); return; }
        if (w.lastCandleTs == null && n - w.rec.ts >= NO_CANDLE_DIE_MS) { this._end(w, n, 'died', 'no-candles'); return; }
      }
    } catch { /* fail silent */ } finally { w.sampling = false; }
  }

  _runEngine(w, completed) {
    const found = detectHigherLows(findConfirmedSwings(completed));
    for (const m of found) {
      if (w.marksFired.has(m.lowTs)) continue;
      w.marksFired.add(m.lowTs);
      w.ordinal++;
      const markId = `${w.rec.watchId}-m${w.ordinal}`;
      const holdersAtMark = w.lastHolders;
      const growth = (holdersAtMark != null && w.holdersAtSeed != null && w.holdersAtSeed > 0)
        ? round(holdersAtMark / w.holdersAtSeed - 1) : null;
      const rec = {
        type: 'mark', markId, watchId: w.rec.watchId, ordinal: w.ordinal,
        ts: m.ts, price: m.price, lowPrev: m.lowPrev, lowNew: m.lowNew, lowTs: m.lowTs,
        mint: w.rec.mint, symbol: w.rec.symbol, seedSource: w.rec.seedSource || 'signal',
        holdersAtMark: holdersAtMark ?? null, holdersAtSeed: w.holdersAtSeed ?? null, holderGrowthPct: growth,
      };
      w.marks.set(markId, rec);
      this._append(rec);
      if (this.onMark) { try { this.onMark(rec); } catch { /* observer only — the shadow signal can never disturb the watch */ } }
      if (this.log) this.log(`[structurewatch] ${w.rec.symbol || w.rec.mint}: higher low #${w.ordinal} confirmed (${m.lowPrev} → ${m.lowNew}) — would-enter mark, record only`);
    }
  }

  _updateScores(w, completed, n, final) {
    for (const [markId, mrec] of w.marks) {
      const s = scoreMark(completed, mrec);
      const prev = w.scores.get(markId) || null;
      const newHorizon = HORIZONS.some(h => s[RKEY[h]] != null && (!prev || prev[RKEY[h]] == null));
      if (!newHorizon && !final) continue;
      const rec = {
        type: 'mark-score', markId, watchId: w.rec.watchId, ts: n,
        r15: s.r15 != null ? round(s.r15) : null, r60: s.r60 != null ? round(s.r60) : null, r240: s.r240 != null ? round(s.r240) : null,
        peakPct: s.peakPct != null ? round(s.peakPct) : null, worstDipPct: s.worstDipPct != null ? round(s.worstDipPct) : null,
        final: !!final,
      };
      w.scores.set(markId, rec);
      this._append(rec);
    }
  }

  _end(w, n, reason, note) {
    try {
      if (!this.active.has(w.rec.watchId)) return;
      // Final scores first (whatever horizons exist — missing stays null),
      // scored on the freshest completed candles the watch has seen.
      try { this._updateScores(w, completedCandles(w.candles, n), n, true); } catch { /* fail silent */ }
      this._append({ type: 'end', watchId: w.rec.watchId, ts: n, reason, ...(note ? { note } : {}) });
      this.active.delete(w.rec.watchId);
      if (this.activeMint.get(w.rec.mint) === w.rec.watchId) this.activeMint.delete(w.rec.mint);
      if (this.log) this.log(`[structurewatch] ${w.rec.symbol || w.rec.mint}: watch ended (${reason}${note ? `, ${note}` : ''}) — ${w.ordinal} mark(s)`);
    } catch { /* fail silent */ }
  }

  /** GET /structurewatch payload. Computed from the FULL journal file
   *  (never a capped tail — readiness spans weeks of watches), ~60s cache. */
  scorecard() {
    const n = this.now();
    if (this.cardCache && n - this.cardCacheTs < CARD_CACHE_MS) return this.cardCache;
    const records = this._readAll();
    const card = { enabled: true, generatedTs: n, journalRecords: records.length, ...buildStructureCard(records) };
    this.cardCache = card;
    this.cardCacheTs = n;
    return card;
  }
}
