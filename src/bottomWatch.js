// bottomWatch.js — the BOTTOM TRACKER (user order 2026-10-16, RECORD-ONLY).
//
// The night's recurring wound: coins the bot (or the user) exited — or
// simply watched — dumped hard, bottomed, and then made a FIRST move off
// the bottom that "would've been good to get into" (dev/null collapsed
// post-exit, then re-ran +56%; Gato the same shape). Churn already buys
// the PATIENT version of that shape (10 minutes of basing first). Nobody
// has ever measured the twitchy version: the first bounce itself, which
// is earlier and wrong more often — most first bounces are dead cats.
// This module writes that dataset so the question gets an answer from
// evidence instead of from the group chat the coins clearly run.
//
// MECHANICS (owner-approved dials, all named knobs):
//   POPULATION — every mint riding the bot's own continuous sampling
//   streams (the poll loop's watchlist ∪ positions, plus the outcome
//   observer's post-signal mints). The Bot feeds each fresh view to
//   observe() beside History.record; this module runs NO sampler and NO
//   fetches of its own for detection. A mint with an open episode also
//   joins the outcome observer's fetch set (pendingMints — the exact
//   discipline scanLab / confluenceSignal use) so an episode is not
//   orphaned the moment a coin leaves the watchlist.
//   EPISODE — opens the first time the sampled price sits >=
//   BOTTOM_DROP_PCT (default 50%) under the highest price observed for
//   the mint in this tracking cycle. The episode peak is frozen at open;
//   the running low updates on every lower print, and each new low
//   resets the quiet clock. The bottom is ESTABLISHED once no new low
//   has printed for BOTTOM_QUIET_MIN (default 3) minutes. An episode
//   closes unmarked on full recovery (price back at/above the episode
//   peak — the dump simply undid itself) or when the mint leaves the
//   sampling orbit for BOTTOM_EXPIRE_MIN (default 60) minutes.
//   MARK — after the bottom is established, the first observation at
//   >= BOTTOM_MOVE_PCT (default +18%) above the low, PROVIDED buy flow
//   has returned when flow is known: the view's rolling-5m buy share
//   (buysM5 / (buysM5 + sellsM5)) must be >= 0.5. When the view carries
//   no usable flow (counts absent, or a 0/0 window — indistinguishable
//   from "no data" in the view shape), the mark fires on price alone
//   and is stamped flowKnown:false. Flow is NEVER fabricated. One mark
//   per episode; after a mark the cycle restarts at the mark price, so
//   a fresh episode needs a new peak-to-dump cycle OR a >= drop-threshold
//   fall from the mark price itself.
//   SOURCE — 'bot-exited' when the trade journal holds a close for the
//   mint (the dev/null class: our own exits coming back), else 'watched'.
//   PEAK QUALIFIER (owner refinement, same night) — the study he means
//   is coins that RAN first (dev/null peaked ~$100K+; Gato ~$100K),
//   dumped, and are setting up to retrace toward the old run. A coin
//   that never ran has no retrace setup, only a dust bottom (the first
//   two live marks proved it: peaks ~$15K and ~$2.5K). So a mark only
//   QUALIFIES when its episode peak mc reached BOTTOM_MIN_PEAK_MC
//   (default $25K). Dust marks are still journaled and forward-scored
//   in their own bucket — the dataset doesn't go blind — but the card
//   leads with the qualified numbers, READY counts qualified marks
//   only, and the alert hook fires on qualified marks only. Every mark
//   also carries pctOfPeakRecovered (markMc / peakMc, PERCENT) so a
//   reader can see how much of the old run the first move has reclaimed.
//   SCORING — marks are forward-scored with the structure watch's OWN
//   tailer (scoreMark over completed GT 5m candles: r15/r60/r240 +
//   forward peak + worst dip), candles fetched through the structure
//   watch's own fetcher pair, throttled. FINALIZED = r60 present — the
//   /structurewatch + /staircase convention, so the studies compare
//   directly. GET /bottomwatch serves the card; READY at 30 finalized.
//
// UNITS: episode geometry on the journal/card (drawdownPct, pctOffLow)
// is PERCENT (50 = −50%), matching the knob names; forward scores are
// FRACTIONS (0.5 = +50%), the structure/staircase score convention.
//
// HARD BOUNDARIES: the TRACKER is record-only — this module never buys,
// sells, gates, signs or posts, and no trading decision reads it. The
// one bridge out is the onMark tap (the range watch's own seam): when a
// mark fires, the Bot's _evalBottom MAY route a live entry attempt for a
// QUALIFIED mark through the standard pipeline (BOTTOM_LIVE, owner
// order 2026-10-16, the base strategy). The tap changes nothing in here:
// marks journal + score identically with the tap on, off, or absent.
// Every public method is fail-silent — a tracker failure can never
// reach a trading path. Kill switch: BOTTOM_WATCH=0 (no observing, no
// records, card off).
import fs from 'node:fs';
import path from 'node:path';
import { median, round, readTailLines } from './util.js';
import { completedCandles, scoreMark } from './structureWatch.js';

export const BOTTOM_READY_N = 30;          // finalized marks before the card reads READY
const CARD_CACHE_MS = 60000;               // the /structurewatch cache trade
const SCORE_MIN_AGE_MS = 16 * 60000;       // a mark's first horizon (r15) cannot exist before this
const SCORE_RETRY_MS = 5 * 60000;          // per-mark candle-fetch retry floor
const SCORE_FINAL_AGE_MS = 360 * 60000;    // a mark finalizes by age alone past this, scored or not
const SCORE_PER_TICK = 2;                  // candle fetches per tick, max — spreads GT load
const STATE_SAVE_MS = 30000;               // throttled state-file flush (outcome_pending discipline)

// ---------- pure helpers (tested directly) ----------

/** Buy-flow read of one view. The view shape defaults missing counts to
 *  0, so a 0/0 window is indistinguishable from "no data": flow counts
 *  as KNOWN only when at least one side printed. share is a fraction. */
export function flowOf(view) {
  const buys = view && Number.isFinite(view.buysM5) ? view.buysM5 : null;
  const sells = view && Number.isFinite(view.sellsM5) ? view.sellsM5 : null;
  if (buys == null || sells == null || buys + sells <= 0) return { known: false, buys, sells, share: null };
  return { known: true, buys, sells, share: buys / (buys + sells) };
}

/** The peak qualifier: a mark is a RETRACE SETUP only when the run it
 *  fell from reached the mc floor. An unknown peak mc can never prove
 *  the coin ran, so it reads dust — conservative by construction. */
export function qualifiesPeak(peakMc, minPeakMc) {
  return Number.isFinite(peakMc) && peakMc > 0 && Number.isFinite(minPeakMc) && minPeakMc > 0 && peakMc >= minPeakMc;
}

/** How much of the old run the mark has reclaimed: markMc / peakMc as
 *  a PERCENT (50 = the mark sits at half the peak mc). Null when either
 *  side is unknown — never fabricated. */
export function recoveredPctOf(markMc, peakMc) {
  if (!Number.isFinite(markMc) || !(markMc > 0) || !Number.isFinite(peakMc) || !(peakMc > 0)) return null;
  return round((markMc / peakMc) * 100, 1);
}

/** Fold raw journal lines into episode / mark / score sets (first
 *  episode + end per episode wins; latest score per mark wins). */
export function foldBottomJournal(records) {
  const episodes = new Map(), ends = new Map(), marks = new Map(), scores = new Map();
  for (const r of records || []) {
    if (!r || !r.type) continue;
    if (r.type === 'episode' && r.episodeId) { if (!episodes.has(r.episodeId)) episodes.set(r.episodeId, r); }
    else if (r.type === 'episode-end' && r.episodeId) { if (!ends.has(r.episodeId)) ends.set(r.episodeId, r); }
    else if (r.type === 'mark' && r.markId) { if (!marks.has(r.markId)) marks.set(r.markId, r); }
    else if (r.type === 'mark-score' && r.markId) scores.set(r.markId, r);
  }
  return { episodes, ends, marks, scores };
}

function markAgg(items) {
  // Aggregates ride on FINALIZED marks (r60 present) — the structure /
  // staircase convention, so a young mark never dilutes the medians.
  const fin = items.filter(x => x.score && x.score.r60 != null);
  const peaks = fin.map(x => x.score.peakPct).filter(Number.isFinite);
  const r15s = fin.map(x => x.score.r15).filter(Number.isFinite);
  const r60s = fin.map(x => x.score.r60).filter(Number.isFinite);
  return {
    n: items.length,
    finalized: fin.length,
    medianPeak: peaks.length ? round(median(peaks)) : null,
    medianR15: r15s.length ? round(median(r15s)) : null,
    medianR60: r60s.length ? round(median(r60s)) : null,
    runnerShare: peaks.length ? round(peaks.filter(p => p >= 0.5).length / peaks.length, 3) : null,
  };
}

export function buildBottomCard(records, now = Date.now(), live = {}) {
  const minPeakMc = Number.isFinite(live.minPeakMc) && live.minPeakMc > 0 ? live.minPeakMc : 25000;
  const f = foldBottomJournal(records);
  // Qualified is derived per mark: the mark's own stamp wins; legacy
  // marks journaled before the qualifier existed derive from the peak
  // mc they already carry — so SOFA/lptp-class dust reads dust here
  // without rewriting history. Recovered-% derives the same way.
  const joined = [...f.marks.values()].map(m => ({
    m, score: f.scores.get(m.markId) || null,
    qualified: m.qualified != null ? !!m.qualified : qualifiesPeak(m.peakMc, minPeakMc),
    pctOfPeakRecovered: m.pctOfPeakRecovered != null ? m.pctOfPeakRecovered : recoveredPctOf(m.markMc, m.peakMc),
  }));
  const bySource = { 'bot-exited': [], watched: [] };
  const byBand = { lt25: [], ge25: [] };
  const qualified = [], dust = [];
  for (const x of joined) {
    (bySource[x.m.source === 'bot-exited' ? 'bot-exited' : 'watched']).push(x);
    (x.m.pctOffLow != null && x.m.pctOffLow >= 25 ? byBand.ge25 : byBand.lt25).push(x);
    (x.qualified ? qualified : dust).push(x);
  }
  const recent = [...joined].sort((a, b) => b.m.ts - a.m.ts).slice(0, 10).map(({ m, score, qualified: q, pctOfPeakRecovered }) => ({
    markId: m.markId, episodeId: m.episodeId, ts: m.ts, mint: m.mint || null, symbol: m.symbol ?? null,
    source: m.source || 'watched', qualified: q, pctOfPeakRecovered,
    peakPrice: m.peakPrice ?? null, peakMc: m.peakMc ?? null,
    lowPrice: m.lowPrice ?? null, lowMc: m.lowMc ?? null, lowTs: m.lowTs ?? null,
    drawdownPct: m.drawdownPct ?? null, quietSec: m.quietSec ?? null,
    markPrice: m.markPrice ?? null, markMc: m.markMc ?? null, pctOffLow: m.pctOffLow ?? null,
    flowKnown: !!m.flowKnown, buysM5: m.buysM5 ?? null, sellsM5: m.sellsM5 ?? null, buyShare: m.buyShare ?? null,
    score: score ? {
      r15: score.r15 ?? null, r60: score.r60 ?? null, r240: score.r240 ?? null,
      peakPct: score.peakPct ?? null, worstDipPct: score.worstDipPct ?? null, final: !!score.final,
    } : null,
  }));
  // The card LEADS with the qualified (retrace-setup) numbers: headline
  // aggregates, finalized and READY all judge the qualified set. The
  // all-marks figures stay under aggregatesAll / finalizedAll, and the
  // bySource / byBand splits keep their original all-marks semantics.
  const aggregates = markAgg(qualified);
  const aggregatesAll = markAgg(joined);
  return {
    generatedTs: now,
    tracking: live.tracking ?? null,
    episodesOpen: live.episodesOpen ?? null,
    episodes: f.episodes.size,
    episodesEnded: f.ends.size,
    minPeakMc,
    marks: joined.length,
    marksQualified: qualified.length,
    marksDust: dust.length,
    finalized: aggregates.finalized,
    finalizedAll: aggregatesAll.finalized,
    ready: aggregates.finalized >= BOTTOM_READY_N,
    aggregates,
    aggregatesAll,
    byQualifier: { qualified: aggregates, dust: markAgg(dust) },
    bySource: { 'bot-exited': markAgg(bySource['bot-exited']), watched: markAgg(bySource.watched) },
    byBand: { lt25: markAgg(byBand.lt25), ge25: markAgg(byBand.ge25) },
    recent,
  };
}

// ---------- the tracker ----------

export class BottomWatch {
  /**
   * deps: { cfg, journal, dir, now, log, wasExited(mint) -> bool,
   *         onMark(rec),
   *         fetchCandles(pool, fromTs, toTs), resolvePool(mint) }
   * fetchCandles/resolvePool are the structure watch's own pair (the Bot
   * wires them); absent them, marks simply never score. wasExited reads
   * the trade journal's closes (the Bot wires it); absent it, every
   * episode tags 'watched'. onMark is the live tap (Bot._evalBottom,
   * BOTTOM_LIVE) — notified after a mark journals; absent it, marks are
   * study-only.
   */
  constructor({ cfg = {}, journal = null, dir = null, now = () => Date.now(), log = null, wasExited = null, onMark = null, fetchCandles = null, resolvePool = null } = {}) {
    this.cfg = cfg;
    this.journal = journal;
    this.dir = dir;
    this.now = now;
    this.log = log;
    this.wasExited = wasExited;
    this.onMark = onMark;
    this.fetchCandles = fetchCandles;
    this.resolvePool = resolvePool;
    this.track = new Map();       // mint -> per-mint tracking state (scalars + open episode)
    this.markState = new Map();   // markId -> { rec, pool, lastTry, score } for unscored/unfinal marks
    this.dirty = false;
    this.lastSave = 0;
    this.cardCache = null;
    this.cardCacheTs = 0;
    this._restore();
  }

  get enabled() { return this.cfg.bottomWatch !== 0; }
  get dropFrac() { const v = Number(this.cfg.bottomDropPct); return (Number.isFinite(v) && v > 0 && v < 100 ? v : 50) / 100; }
  get quietMs() { const v = Number(this.cfg.bottomQuietMin); return (Number.isFinite(v) && v >= 0 ? v : 3) * 60000; }
  get moveFrac() { const v = Number(this.cfg.bottomMovePct); return (Number.isFinite(v) && v > 0 ? v : 18) / 100; }
  get expireMs() { const v = Number(this.cfg.bottomExpireMin); return (Number.isFinite(v) && v > 0 ? v : 60) * 60000; }
  get minPeakMc() { const v = Number(this.cfg.bottomMinPeakMc); return Number.isFinite(v) && v > 0 ? v : 25000; }

  _file() { return this.journal && this.journal.f ? this.journal.f.bwatch : null; }
  _stateFile() { return this.dir ? path.join(this.dir, 'bottom_watch_state.json') : null; }

  _readAll() {
    const f = this._file();
    if (!f) return [];
    let txt = '';
    try { txt = readTailLines(f, 20 * 1024 * 1024).join('\n'); } catch { return []; } /* byte-capped tail (2026-10-18 boot-OOM fix) */
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail line — skip */ }
    }
    return out;
  }

  _append(rec) { try { if (this.journal) this.journal.bottomWatch(rec); } catch { /* record-only */ } }

  _restore() {
    // Live tracking state (peaks + open episodes) survives restarts via
    // the state file — a dump in progress at deploy time keeps its peak
    // and its low instead of restarting the cycle blind.
    try {
      const sf = this._stateFile();
      if (sf) {
        const saved = JSON.parse(fs.readFileSync(sf, 'utf8'));
        for (const st of (saved && saved.track) || []) {
          if (st && st.mint && Number.isFinite(st.peakPrice) && st.peakPrice > 0) this.track.set(st.mint, st);
        }
      }
    } catch { /* no/corrupt state file — start clean, the journal still holds every mark */ }
    // Marks still owed a final score rejoin the scoring queue.
    try {
      const f = foldBottomJournal(this._readAll());
      for (const [markId, m] of f.marks) {
        const s = f.scores.get(markId) || null;
        if (s && s.final) continue;
        this.markState.set(markId, { rec: m, pool: null, lastTry: 0, score: s });
      }
    } catch { /* fail silent */ }
  }

  _save(force = false) {
    const sf = this._stateFile();
    if (!sf) return;
    const n = this.now();
    if (!force && (!this.dirty || n - this.lastSave < STATE_SAVE_MS)) return;
    try {
      fs.writeFileSync(sf, JSON.stringify({ v: 1, savedTs: n, track: [...this.track.values()] }));
      this.dirty = false;
      this.lastSave = n;
    } catch { /* disk full etc. — never crash the bot */ }
  }

  _sourceOf(mint) {
    try { return this.wasExited && this.wasExited(mint) ? 'bot-exited' : 'watched'; }
    catch { return 'watched'; }
  }

  /** Feed one fresh view from the bot's sampling streams. Returns the
   *  mark record when one fires, else null. Fail-silent by contract —
   *  the call sites also wrap it. */
  observe(view, ts = this.now()) {
    if (!this.enabled) return null;
    try {
      if (!view || !view.address || !(view.price > 0) || !Number.isFinite(view.price)) return null;
      const mint = view.address;
      const price = view.price;
      const mc = Number.isFinite(view.mc) && view.mc > 0 ? view.mc : null;
      let st = this.track.get(mint);
      if (!st) {
        st = { mint, symbol: view.symbol || null, firstTs: ts, lastTs: ts, peakPrice: price, peakTs: ts, peakMc: mc, episode: null };
        this.track.set(mint, st);
      }
      st.lastTs = ts;
      if (view.symbol) st.symbol = view.symbol;

      const ep = st.episode;
      if (ep) {
        if (price < ep.lowPrice) {
          ep.lowPrice = price; ep.lowTs = ts; ep.lowMc = mc; ep.lastLowTs = ts; // new low: the quiet clock restarts
          this.dirty = true;
        }
        if (price > ep.highSinceStart) { ep.highSinceStart = price; ep.highMc = mc; this.dirty = true; }
        if (price >= ep.peakPrice) {
          // Full recovery: the dump undid itself before any qualifying
          // first move. Close unmarked; the recovery high is the cycle's
          // new running peak.
          this._append({ type: 'episode-end', episodeId: ep.episodeId, ts, mint, reason: 'recovered' });
          st.episode = null;
          st.peakPrice = ep.highSinceStart; st.peakTs = ts; st.peakMc = ep.highMc != null ? ep.highMc : mc;
          this.dirty = true;
          this._save(true);
          return null;
        }
        const quietSec = (ts - ep.lastLowTs) / 1000;
        if (ts - ep.lastLowTs >= this.quietMs && price >= ep.lowPrice * (1 + this.moveFrac)) {
          const flow = flowOf(view);
          if (flow.known && flow.share < 0.5) return null; // price moved but the flow has not come back — keep waiting
          return this._fireMark(st, ep, view, ts, quietSec, flow);
        }
        return null;
      }

      // No open episode: maintain the running peak, test the crossing.
      if (price > st.peakPrice) { st.peakPrice = price; st.peakTs = ts; st.peakMc = mc; this.dirty = true; return null; }
      if (st.peakPrice > 0 && price <= st.peakPrice * (1 - this.dropFrac)) {
        const episodeId = `bw-${mint.slice(0, 6)}-${ts}`;
        const source = this._sourceOf(mint);
        st.episode = {
          episodeId, startTs: ts, source,
          peakPrice: st.peakPrice, peakTs: st.peakTs, peakMc: st.peakMc,
          lowPrice: price, lowTs: ts, lowMc: mc, lastLowTs: ts,
          highSinceStart: price, highMc: mc,
        };
        this._append({
          type: 'episode', episodeId, ts, mint, symbol: st.symbol, source,
          peakPrice: st.peakPrice, peakMc: st.peakMc, crossPrice: price, crossMc: mc,
          drawdownPct: round((1 - price / st.peakPrice) * 100, 1),
        });
        if (this.log) this.log(`[bottomwatch] ${st.symbol || mint}: dumped ${round((1 - price / st.peakPrice) * 100, 1)}% off its watched peak — episode open, watching for the first move off the bottom (record only)`);
        this.dirty = true;
        this._save(true);
      }
      return null;
    } catch { return null; }
  }

  _fireMark(st, ep, view, ts, quietSec, flow) {
    const markId = `${ep.episodeId}-m1`;
    const markMc = Number.isFinite(view.mc) && view.mc > 0 ? view.mc : null;
    const qualified = qualifiesPeak(ep.peakMc, this.minPeakMc);
    const rec = {
      type: 'mark', markId, episodeId: ep.episodeId, ts, mint: st.mint, symbol: st.symbol,
      source: ep.source, qualified,
      peakPrice: ep.peakPrice, peakMc: ep.peakMc ?? null,
      lowPrice: ep.lowPrice, lowMc: ep.lowMc ?? null, lowTs: ep.lowTs,
      drawdownPct: round((1 - ep.lowPrice / ep.peakPrice) * 100, 1),
      quietSec: Math.round(quietSec),
      markPrice: view.price, markMc,
      pctOffLow: round((view.price / ep.lowPrice - 1) * 100, 1),
      pctOfPeakRecovered: recoveredPctOf(markMc, ep.peakMc),
      flowKnown: flow.known, buysM5: flow.buys, sellsM5: flow.sells,
      buyShare: flow.share != null ? round(flow.share, 3) : null,
    };
    this._append(rec);
    this._append({ type: 'episode-end', episodeId: ep.episodeId, ts, mint: st.mint, reason: 'marked' });
    this.markState.set(markId, { rec, pool: null, lastTry: 0, score: null });
    // The cycle restarts at the mark: a fresh episode needs a new
    // peak-to-dump cycle, or a >= drop-threshold fall from here.
    st.episode = null;
    st.peakPrice = view.price; st.peakTs = ts; st.peakMc = rec.markMc;
    this.dirty = true;
    this._save(true);
    if (this.log) this.log(`[bottomwatch] ${st.symbol || st.mint}: FIRST MOVE off the bottom — low ${rec.drawdownPct}% under peak, now +${rec.pctOffLow}% off the low${flow.known ? `, buy share ${rec.buyShare}` : ' (flow unknown)'} [${ep.source}${qualified ? ', retrace setup' : `, dust — peak under the $${Math.round(this.minPeakMc / 1000)}k floor`}] — record only`);
    // The live tap (Bot._evalBottom via BOTTOM_LIVE): notified AFTER the
    // mark is journaled and the episode closed — the tracker's records
    // are already complete whatever the tap does with it. Only a
    // QUALIFIED mark is a retrace setup the tap may act on; _evalBottom
    // re-checks the flag itself, so the tap fires for every mark here.
    try { if (this.onMark) this.onMark(rec); } catch { /* live tap — fail-silent, can never disturb the tracker */ }
    return rec;
  }

  /** Mints with an open (unmarked) episode — the outcome observer's
   *  fetch set keeps pricing them after they leave the watchlist, the
   *  same guarantee scanLab / confluenceSignal marks get. */
  pendingMints() {
    if (!this.enabled) return [];
    const out = [];
    for (const st of this.track.values()) if (st.episode) out.push({ mint: st.mint, since: st.episode.startTs });
    return out;
  }

  /** Periodic pass — rides the bot's poll tick: expire mints that left
   *  the sampling orbit, forward-score due marks from GT candles
   *  (throttled), flush the state file. All fail-silent. */
  async tick(n = this.now()) {
    if (!this.enabled) return;
    try {
      for (const [mint, st] of [...this.track]) {
        if (n - st.lastTs > this.expireMs) {
          if (st.episode) this._append({ type: 'episode-end', episodeId: st.episode.episodeId, ts: n, mint, reason: 'stale' });
          this.track.delete(mint);
          this.dirty = true;
        }
      }
      if (this.fetchCandles && this.resolvePool && this.markState.size) {
        const due = [...this.markState.values()]
          .filter(x => n - x.rec.ts >= SCORE_MIN_AGE_MS && n - x.lastTry >= SCORE_RETRY_MS)
          .sort((a, b) => a.rec.ts - b.rec.ts)
          .slice(0, SCORE_PER_TICK);
        for (const x of due) {
          x.lastTry = n;
          try {
            if (!x.pool) { try { x.pool = await this.resolvePool(x.rec.mint); } catch { x.pool = null; } }
            if (!x.pool) continue;
            const candles = await this.fetchCandles(x.pool, x.rec.ts - 300000, n);
            if (!Array.isArray(candles)) continue;
            const s = scoreMark(completedCandles(candles, n), { ts: x.rec.ts, price: x.rec.markPrice });
            const prev = x.score;
            const newHorizon = [15, 60, 240].some(h => s[`r${h}`] != null && (!prev || prev[`r${h}`] == null));
            const final = s.r240 != null || n - x.rec.ts >= SCORE_FINAL_AGE_MS;
            if (!newHorizon && !final) continue;
            const rec = {
              type: 'mark-score', markId: x.rec.markId, ts: n,
              r15: s.r15 != null ? round(s.r15) : null, r60: s.r60 != null ? round(s.r60) : null, r240: s.r240 != null ? round(s.r240) : null,
              peakPct: s.peakPct != null ? round(s.peakPct) : null, worstDipPct: s.worstDipPct != null ? round(s.worstDipPct) : null,
              final: !!final,
            };
            x.score = rec;
            this._append(rec);
            if (final) this.markState.delete(x.rec.markId);
          } catch { /* one mark's scoring can never disturb the tick */ }
        }
      }
      this._save(false);
    } catch { /* shadow tracker — fail silent */ }
  }

  /** GET /bottomwatch payload. Computed from the FULL journal file
   *  (never a capped tail — readiness spans weeks), ~60s cache. */
  card() {
    if (!this.enabled) return { enabled: false };
    const n = this.now();
    if (this.cardCache && n - this.cardCacheTs < CARD_CACHE_MS) return this.cardCache;
    const records = this._readAll();
    let episodesOpen = 0;
    for (const st of this.track.values()) if (st.episode) episodesOpen++;
    const card = { enabled: true, journalRecords: records.length, ...buildBottomCard(records, n, { tracking: this.track.size, episodesOpen, minPeakMc: this.minPeakMc }) };
    this.cardCache = card;
    this.cardCacheTs = n;
    return card;
  }
}
