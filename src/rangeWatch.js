// rangeWatch.js — the RANGE STUDY (owner order 2026-10-16, RECORD-ONLY).
//
// The owner's chart read, from the 'Market Maker' (MM) trade: the coin
// based in a TIGHT SIDEWAYS RANGE for ~20 minutes (22:05–22:26), then
// popped vertically — and the bot's confluence entry landed on the
// pop's TIP (its own entry minute stamped chg1m −13.6%) before the coin
// fell back through the range. His words: "The range we really have to
// look for — right before the pop." Every live path fires on the move
// itself (wallet events, pop gain, staircase higher-lows); nobody has
// ever measured the BASE. This module writes that dataset: when a real
// range forms, what happens next — expansion up, breakdown, or more
// range — and how would entering AT the range have done vs chasing the
// expansion? It earns promotion only on its sample, like every shadow.
//
// MECHANICS (owner dials, all named knobs):
//   POPULATION — every mint riding the bot's own continuous sampling
//   streams (the poll loop's watchlist ∪ positions, plus the outcome
//   observer's post-signal mints). The Bot feeds each fresh view to
//   observe() beside History.record / BottomWatch.observe; this module
//   runs NO sampler and NO fetches of its own for detection. A mint
//   with an open episode also joins the outcome observer's fetch set
//   (pendingMints — the scanLab / confluenceSignal / bottomWatch
//   discipline) so the range's exit is followed after the coin leaves
//   the watchlist.
//   QUALIFICATION — judged on the trailing RANGE_WINDOW_MIN (default
//   15) minutes of the module's own sample ring, ANTI-LOOKAHEAD: only
//   samples strictly before the mark instant are judged (the current
//   view is stamped as the mark, never counted in its own window).
//   All four legs must hold:
//     (a) COVERAGE — >= 5 samples spanning >= 80% of the window with
//         no gap > 3 minutes (a range you barely saw is not a range);
//     (b) TIGHT — hi/lo market cap over the window <= 1 +
//         RANGE_MAX_BAND_PCT/100 (default band 35%), judged on the
//         mc-bearing samples (>= 80% of the window must carry an mc);
//     (c) QUIET — no 1-minute step (a sample vs the next sample >= 60s
//         later) moves more than +/- RANGE_MAX_MIN_MOVE_PCT (default
//         18%): a staircase of pumps inside a wide band is not a range;
//     (d) REAL COIN — the mark's own mc >= RANGE_MIN_MC (default
//         $15,000) and the mint's first sample in this tracking cycle
//         is at least one full window old (a launch's first minutes
//         are not a base).
//   MARK — the first qualifying observation journals ONE mark to
//   range_marks.jsonl with the range geometry (hi/lo/mid mc, actual
//   band %, tightness = how much of the allowed band the range used,
//   sample count, and durationMin: how long the base had already been
//   holding at mark time, extending the same tight+quiet test back
//   past the window). SOURCE — 'bot-held' when the bot holds the mint
//   at mark time, else 'bot-exited' when the trade journal holds a
//   close for it, else 'watched' (the bottomWatch derivation, held
//   first: a held coin is a live fact, not a history note).
//   EPISODE — the mark opens an episode on the range. It ends when
//   price exits the band by more than HALF the band width, sustained
//   for 2+ consecutive samples on the same side (one wick out is not
//   an exit), or when the mint goes unsampled for 30 minutes. A mint
//   may re-mark only after its episode ended AND a fresh full window
//   qualifies — every sample of the new window must post-date the
//   episode end, so one endless sideways coin can never spam marks.
//   SCORING — marks are forward-scored with the structure watch's OWN
//   tailer (scoreMark over completed GT 5m candles: r15/r60/r240 +
//   forward peak + worst dip), candles fetched through the structure
//   watch's own fetcher pair, throttled. FINALIZED = r60 present — the
//   house convention, so the studies compare directly. Each score
//   also carries an OUTCOME class read off the candle timeline (the
//   tailer's own candles, walked in order): EXPANDED — a forward peak
//   >= +50% printed before any −30% dip; BROKE DOWN — a dip <= −30%
//   printed first; RANGED — neither printed. If a single candle
//   crosses both lines, the class is BROKE DOWN (risk-first: the dip
//   was real inside that candle whatever else it did). GET
//   /rangewatch serves the card; READY at 30 finalized.
//
// UNITS: mark geometry on the journal/card (bandPct) is PERCENT (35 =
// a 35% hi/lo band); forward scores are FRACTIONS (0.5 = +50%), the
// structure/staircase score convention. tightness is a 0..1 fraction
// of the allowed band actually used (0 = dead flat, 1 = at the limit).
//
// HARD BOUNDARIES: the STUDY is record-only — this module never buys,
// sells, gates, signs or posts, and no trading decision reads it. The
// one bridge out is the onMark tap (the structure watch's own seam):
// when a mark fires, the Bot's _evalRange MAY route a live entry
// attempt through the standard pipeline (RANGE_LIVE, owner correction
// 2026-10-16: "None of this is shadow btw — Real"). The tap changes
// nothing in here: marks journal + score identically with the tap on,
// off, or absent. Every public method is fail-silent — a tracker
// failure can never reach a trading path. Kill switch: RANGE_WATCH=0
// (no observing, no records, card off).
import fs from 'node:fs';
import path from 'node:path';
import { median, round, readTailLines } from './util.js';
import { completedCandles, scoreMark } from './structureWatch.js';

export const RANGE_READY_N = 30;           // finalized marks before the card reads READY
export const RANGE_EXPAND_FRAC = 0.5;      // forward peak >= +50% → EXPANDED
export const RANGE_BREAK_FRAC = -0.30;     // forward dip <= −30% → BROKE DOWN
const CARD_CACHE_MS = 60000;               // the /structurewatch cache trade
const SCORE_MIN_AGE_MS = 16 * 60000;       // a mark's first horizon (r15) cannot exist before this
const SCORE_RETRY_MS = 5 * 60000;          // per-mark candle-fetch retry floor
const SCORE_FINAL_AGE_MS = 360 * 60000;    // a mark finalizes by age alone past this, scored or not
const SCORE_PER_TICK = 2;                  // candle fetches per tick, max — spreads GT load
const STATE_SAVE_MS = 30000;               // throttled state-file flush (outcome_pending discipline)
const GAP_MAX_MS = 3 * 60000;              // coverage: no sample gap wider than this inside a window
const MIN_SAMPLES = 5;                     // coverage floor: fewer prints than this is not a window
const COVERAGE_FRAC = 0.8;                 // the window must be spanned / mc-carried to this fraction
const STALE_MS = 30 * 60000;               // unsampled this long → episode ends 'stale', tracking drops
const EXTEND_MAX_MS = 120 * 60000;         // duration look-back cap (and the sample ring's retention past the window)
const EXIT_SUSTAIN = 2;                    // consecutive out-of-zone samples that end an episode

// ---------- pure helpers (tested directly) ----------

/** One ~1-minute step test over ascending samples: for each sample,
 *  compare against the next sample at least 60s later (when one exists
 *  inside the set); any step beyond +/- maxMoveFrac fails the set. */
function quietOk(samples, maxMoveFrac) {
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    if (!(a.price > 0)) continue;
    for (let j = i + 1; j < samples.length; j++) {
      if (samples[j].ts - a.ts < 60000) continue;
      const b = samples[j];
      if (b.price > 0 && Math.abs(b.price / a.price - 1) > maxMoveFrac) return false;
      break; // only the FIRST sample >= 60s later is the step partner
    }
  }
  return true;
}

function bandOf(mcSamples) {
  let hi = null, lo = null;
  for (const s of mcSamples) {
    if (hi == null || s.mc > hi) hi = s.mc;
    if (lo == null || s.mc < lo) lo = s.mc;
  }
  return { hi, lo };
}

/** Judge a trailing window of samples as a RANGE. samples: ascending
 *  [{ts, price, mc}] (the module's ring — may reach past the window;
 *  only samples in (now - windowMs, now) are judged: strictly before
 *  the mark instant, anti-lookahead by construction). Returns null, or
 *  { bandPct, tightness, rangeHi, rangeLo, rangeMid, sampleCount,
 *    durationMin, hiPrice, loPrice } with PERCENT bandPct. */
export function assessRange(samples, { now, windowMs, maxBandPct, maxMinMovePct } = {}) {
  if (!Array.isArray(samples) || !samples.length || !(windowMs > 0)) return null;
  const maxBandFrac = maxBandPct / 100, maxMoveFrac = maxMinMovePct / 100;
  const win = samples.filter(s => s && s.ts >= now - windowMs && s.ts < now && s.price > 0);
  if (win.length < MIN_SAMPLES) return null;
  // (a) coverage: span + gaps
  if (win[win.length - 1].ts - win[0].ts < COVERAGE_FRAC * windowMs) return null;
  for (let i = 1; i < win.length; i++) if (win[i].ts - win[i - 1].ts > GAP_MAX_MS) return null;
  // (b) tight: band over the mc-bearing samples; most of the window must carry an mc
  const mcWin = win.filter(s => Number.isFinite(s.mc) && s.mc > 0);
  if (mcWin.length < Math.ceil(COVERAGE_FRAC * win.length)) return null;
  const { hi, lo } = bandOf(mcWin);
  if (!(lo > 0) || hi / lo > 1 + maxBandFrac) return null;
  // (c) quiet: no 1-minute step beyond the line anywhere in the window
  if (!quietOk(win, maxMoveFrac)) return null;
  // duration: how long had the base already been holding? Extend the
  // same test backwards from the window's first sample, sample by
  // sample, while band / gap / quiet all keep holding (capped).
  let extStart = win[0].ts;
  const older = samples.filter(s => s && s.ts < win[0].ts && s.price > 0);
  let extHi = hi, extLo = lo;
  for (let i = older.length - 1; i >= 0; i--) {
    const s = older[i];
    if (extStart - s.ts > EXTEND_MAX_MS) break;
    const nextTs = i + 1 < older.length ? older[i + 1].ts : win[0].ts;
    if (nextTs - s.ts > GAP_MAX_MS) break;
    if (Number.isFinite(s.mc) && s.mc > 0) {
      const nHi = Math.max(extHi, s.mc), nLo = Math.min(extLo, s.mc);
      if (nHi / nLo > 1 + maxBandFrac) break;
      extHi = nHi; extLo = nLo;
    }
    // quiet across the seam: s vs the first sample >= 60s after it
    const chain = [s, ...older.slice(i + 1), ...win];
    const pi = chain.findIndex(x => x.ts >= s.ts + 60000);
    if (pi > 0 && !quietOk(chain.slice(0, pi + 1), maxMoveFrac)) break;
    extStart = s.ts;
  }
  let pHi = null, pLo = null;
  for (const s of win) { if (pHi == null || s.price > pHi) pHi = s.price; if (pLo == null || s.price < pLo) pLo = s.price; }
  const bandPct = round((hi / lo - 1) * 100, 1);
  return {
    bandPct,
    tightness: round((hi / lo - 1) / maxBandFrac, 3),
    rangeHi: hi, rangeLo: lo, rangeMid: round((hi + lo) / 2, 2),
    sampleCount: win.length,
    durationMin: round((win[win.length - 1].ts - extStart) / 60000, 1),
    hiPrice: pHi, loPrice: pLo,
  };
}

/** Outcome class off the candle TIMELINE (completed candles ascending,
 *  the tailer's own set): walk candles strictly after the mark candle;
 *  the first threshold crossed decides. A candle crossing BOTH lines
 *  classes BROKE DOWN (risk-first). No candles → null (unknown, never
 *  fabricated); candles but neither line → 'ranged'. */
export function classifyOutcome(candles, mark) {
  if (!mark || !(mark.price > 0) || !Array.isArray(candles) || !candles.length) return null;
  for (const c of candles) {
    if (!c || c[0] * 1000 <= mark.ts) continue;
    const up = c[2] / mark.price - 1, down = c[3] / mark.price - 1;
    if (down <= RANGE_BREAK_FRAC && up >= RANGE_EXPAND_FRAC) return 'broke-down';
    if (up >= RANGE_EXPAND_FRAC) return 'expanded';
    if (down <= RANGE_BREAK_FRAC) return 'broke-down';
  }
  return 'ranged';
}

/** Fold raw journal lines into mark / score / end sets (first mark +
 *  end per id wins; latest score per mark wins). */
export function foldRangeJournal(records) {
  const marks = new Map(), scores = new Map(), ends = new Map();
  for (const r of records || []) {
    if (!r || !r.type) continue;
    if (r.type === 'mark' && r.markId) { if (!marks.has(r.markId)) marks.set(r.markId, r); }
    else if (r.type === 'mark-score' && r.markId) scores.set(r.markId, r);
    else if (r.type === 'episode-end' && r.episodeId) { if (!ends.has(r.episodeId)) ends.set(r.episodeId, r); }
  }
  return { marks, scores, ends };
}

function rangeAgg(items) {
  // Aggregates ride on FINALIZED marks (r60 present) — the house
  // convention, so a young mark never dilutes the medians. Outcome
  // shares ride on the finalized marks whose outcome is known (a
  // starved mark finalizes unscored and classes nothing).
  const fin = items.filter(x => x.score && x.score.r60 != null);
  const known = fin.filter(x => x.score.outcome);
  const peaks = fin.map(x => x.score.peakPct).filter(Number.isFinite);
  const r60s = fin.map(x => x.score.r60).filter(Number.isFinite);
  const share = (k) => known.length ? round(known.filter(x => x.score.outcome === k).length / known.length, 3) : null;
  return {
    n: items.length,
    finalized: fin.length,
    expanded: known.filter(x => x.score.outcome === 'expanded').length,
    brokeDown: known.filter(x => x.score.outcome === 'broke-down').length,
    ranged: known.filter(x => x.score.outcome === 'ranged').length,
    expandedShare: share('expanded'),
    brokeDownShare: share('broke-down'),
    rangedShare: share('ranged'),
    medianPeak: peaks.length ? round(median(peaks)) : null,
    medianR60: r60s.length ? round(median(r60s)) : null,
  };
}

export function buildRangeCard(records, now = Date.now(), live = {}) {
  const f = foldRangeJournal(records);
  const joined = [...f.marks.values()].map(m => ({ m, score: f.scores.get(m.markId) || null }));
  const byTightness = { le20: [], gt20: [] };
  const byDuration = { lt30: [], ge30: [] };
  const bySource = { 'bot-held': [], 'bot-exited': [], watched: [] };
  for (const x of joined) {
    (x.m.bandPct != null && x.m.bandPct <= 20 ? byTightness.le20 : byTightness.gt20).push(x);
    const dur = x.m.durationMin != null ? x.m.durationMin : (x.m.windowMin || 15);
    (dur < 30 ? byDuration.lt30 : byDuration.ge30).push(x);
    (bySource[x.m.source] || bySource.watched).push(x);
  }
  const recent = [...joined].sort((a, b) => b.m.ts - a.m.ts).slice(0, 10).map(({ m, score }) => ({
    markId: m.markId, episodeId: m.episodeId, ts: m.ts, mint: m.mint || null, symbol: m.symbol ?? null,
    source: m.source || 'watched', windowMin: m.windowMin ?? null, durationMin: m.durationMin ?? null,
    bandPct: m.bandPct ?? null, tightness: m.tightness ?? null,
    markMc: m.markMc ?? null, markPrice: m.markPrice ?? null,
    rangeHi: m.rangeHi ?? null, rangeLo: m.rangeLo ?? null, rangeMid: m.rangeMid ?? null,
    sampleCount: m.sampleCount ?? null,
    score: score ? {
      r15: score.r15 ?? null, r60: score.r60 ?? null, r240: score.r240 ?? null,
      peakPct: score.peakPct ?? null, worstDipPct: score.worstDipPct ?? null,
      outcome: score.outcome ?? null, final: !!score.final,
    } : null,
  }));
  const aggregates = rangeAgg(joined);
  return {
    generatedTs: now,
    tracking: live.tracking ?? null,
    episodesOpen: live.episodesOpen ?? null,
    episodes: f.marks.size,
    episodesEnded: f.ends.size,
    windowMin: live.windowMin ?? null,
    maxBandPct: live.maxBandPct ?? null,
    minMc: live.minMc ?? null,
    marks: joined.length,
    finalized: aggregates.finalized,
    ready: aggregates.finalized >= RANGE_READY_N,
    aggregates,
    byTightness: { le20: rangeAgg(byTightness.le20), gt20: rangeAgg(byTightness.gt20) },
    byDuration: { lt30: rangeAgg(byDuration.lt30), ge30: rangeAgg(byDuration.ge30) },
    bySource: { 'bot-held': rangeAgg(bySource['bot-held']), 'bot-exited': rangeAgg(bySource['bot-exited']), watched: rangeAgg(bySource.watched) },
    recent,
  };
}

// ---------- the tracker ----------

export class RangeWatch {
  /**
   * deps: { cfg, journal, dir, now, log, wasExited(mint) -> bool,
   *         isHeld(mint) -> bool, onMark(rec),
   *         fetchCandles(pool, fromTs, toTs), resolvePool(mint) }
   * fetchCandles/resolvePool are the structure watch's own pair (the
   * Bot wires them); absent them, marks simply never score. wasExited
   * reads the trade journal's closes; isHeld reads the bot's open
   * positions (both wired by the Bot); absent them, every mark tags
   * 'watched'. onMark is the live tap (Bot._evalRange, RANGE_LIVE) —
   * notified after a mark journals; absent it, marks are study-only.
   */
  constructor({ cfg = {}, journal = null, dir = null, now = () => Date.now(), log = null, wasExited = null, isHeld = null, onMark = null, fetchCandles = null, resolvePool = null } = {}) {
    this.cfg = cfg;
    this.journal = journal;
    this.dir = dir;
    this.now = now;
    this.log = log;
    this.wasExited = wasExited;
    this.isHeld = isHeld;
    this.onMark = onMark;
    this.fetchCandles = fetchCandles;
    this.resolvePool = resolvePool;
    this.track = new Map();       // mint -> { mint, symbol, firstTs, lastTs, samples[], episode, rearmAfter }
    this.markState = new Map();   // markId -> { rec, pool, lastTry, score } for unscored/unfinal marks
    this.dirty = false;
    this.lastSave = 0;
    this.cardCache = null;
    this.cardCacheTs = 0;
    this._restore();
  }

  get enabled() { return this.cfg.rangeWatch !== 0; }
  get windowMs() { const v = Number(this.cfg.rangeWindowMin); return (Number.isFinite(v) && v > 0 ? v : 15) * 60000; }
  get windowMin() { return this.windowMs / 60000; }
  get maxBandPct() { const v = Number(this.cfg.rangeMaxBandPct); return Number.isFinite(v) && v > 0 ? v : 35; }
  get maxMinMovePct() { const v = Number(this.cfg.rangeMaxMinMovePct); return Number.isFinite(v) && v > 0 ? v : 18; }
  get minMc() { const v = Number(this.cfg.rangeMinMc); return Number.isFinite(v) && v > 0 ? v : 15000; }

  _file() { return this.journal && this.journal.f ? this.journal.f.rwatch : null; }
  _stateFile() { return this.dir ? path.join(this.dir, 'range_watch_state.json') : null; }

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

  _append(rec) { try { if (this.journal) this.journal.rangeWatch(rec); } catch { /* record-only */ } }

  _restore() {
    // Tracking state (sample rings + open episodes) survives restarts
    // via the state file — a range mid-formation at deploy time keeps
    // its samples instead of restarting the window blind.
    try {
      const sf = this._stateFile();
      if (sf) {
        const saved = JSON.parse(fs.readFileSync(sf, 'utf8'));
        for (const st of (saved && saved.track) || []) {
          if (st && st.mint && Array.isArray(st.samples)) this.track.set(st.mint, st);
        }
      }
    } catch { /* no/corrupt state file — start clean, the journal still holds every mark */ }
    // Marks still owed a final score rejoin the scoring queue.
    try {
      const f = foldRangeJournal(this._readAll());
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
      // Sample rings persist thinned to >= 15s spacing — a restored
      // ring is a touch sparser than the live one, far inside the
      // coverage/gap tolerances, and the file stays small.
      const track = [...this.track.values()].map(st => {
        const thin = [];
        for (const s of st.samples) if (!thin.length || s.ts - thin[thin.length - 1].ts >= 15000) thin.push(s);
        const last = st.samples[st.samples.length - 1];
        if (last && thin[thin.length - 1] !== last) thin.push(last);
        return { ...st, samples: thin };
      });
      fs.writeFileSync(sf, JSON.stringify({ v: 1, savedTs: n, track }));
      this.dirty = false;
      this.lastSave = n;
    } catch { /* disk full etc. — never crash the bot */ }
  }

  _sourceOf(mint) {
    try { if (this.isHeld && this.isHeld(mint)) return 'bot-held'; } catch { /* fall through */ }
    try { return this.wasExited && this.wasExited(mint) ? 'bot-exited' : 'watched'; }
    catch { return 'watched'; }
  }

  _pushSample(st, ts, price, mc) {
    const s = { ts, price, mc: Number.isFinite(mc) && mc > 0 ? mc : null };
    const last = st.samples[st.samples.length - 1];
    if (last && last.ts === ts) st.samples[st.samples.length - 1] = s;
    else st.samples.push(s);
    const floor = ts - this.windowMs - EXTEND_MAX_MS;
    while (st.samples.length && st.samples[0].ts < floor) st.samples.shift();
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
        st = { mint, symbol: view.symbol || null, firstTs: ts, lastTs: ts, samples: [], episode: null, rearmAfter: 0 };
        this.track.set(mint, st);
      }
      st.lastTs = ts;
      if (view.symbol) st.symbol = view.symbol;

      const ep = st.episode;
      if (ep) {
        // Episode exit: the value must leave the band by more than
        // half the band width, sustained EXIT_SUSTAIN consecutive
        // samples on the same side. Judged on mc when the view carries
        // one, on price against the price band otherwise — the two are
        // the same ratio while supply is fixed.
        const useMc = mc != null;
        const v = useMc ? mc : price;
        const hi = useMc ? ep.rangeHi : ep.hiPrice, lo = useMc ? ep.rangeLo : ep.loPrice;
        const width = hi - lo;
        const side = v > hi + width / 2 ? 'up' : v < lo - width / 2 ? 'down' : null;
        if (side) {
          ep.exitStreak = ep.exitSide === side ? ep.exitStreak + 1 : 1;
          ep.exitSide = side;
          if (ep.exitStreak >= EXIT_SUSTAIN) {
            this._append({ type: 'episode-end', episodeId: ep.episodeId, ts, mint, reason: side === 'up' ? 'exit-up' : 'exit-down' });
            if (this.log) this.log(`[rangewatch] ${st.symbol || mint}: range episode ended — price exited ${side} through the band (record only)`);
            st.episode = null;
            st.rearmAfter = ts;
            this.dirty = true;
            this._save(true);
          }
        } else { ep.exitStreak = 0; ep.exitSide = null; }
        this._pushSample(st, ts, price, mc);
        return null;
      }

      // No open episode: judge the trailing window on samples strictly
      // BEFORE this observation (anti-lookahead), then record it.
      let mark = null;
      if (mc != null && mc >= this.minMc && ts - st.firstTs >= this.windowMs) {
        const a = assessRange(st.samples, { now: ts, windowMs: this.windowMs, maxBandPct: this.maxBandPct, maxMinMovePct: this.maxMinMovePct });
        // a re-mark's window must be FRESH: every judged sample
        // post-dates the last episode end (no spam off one base).
        if (a && (!st.rearmAfter || st.samples.find(s => s.ts >= ts - this.windowMs && s.ts < ts).ts >= st.rearmAfter)) {
          mark = this._fireMark(st, view, ts, a);
        }
      }
      this._pushSample(st, ts, price, mc);
      // The sample ring IS this tracker's state (unlike the bottom
      // tracker's scalars): keep the state file warm on the throttled
      // flush so a restart mid-window does not blind the study.
      this.dirty = true;
      this._save(false);
      return mark;
    } catch { return null; }
  }

  _fireMark(st, view, ts, a) {
    const episodeId = `rw-${st.mint.slice(0, 6)}-${ts}`;
    const markId = `${episodeId}-m1`;
    const source = this._sourceOf(st.mint);
    const rec = {
      type: 'mark', markId, episodeId, ts, markTs: ts, mint: st.mint, symbol: st.symbol,
      source, windowMin: this.windowMin,
      bandPct: a.bandPct, tightness: a.tightness,
      markPrice: view.price, markMc: Number.isFinite(view.mc) && view.mc > 0 ? view.mc : null,
      rangeHi: a.rangeHi, rangeLo: a.rangeLo, rangeMid: a.rangeMid,
      sampleCount: a.sampleCount, durationMin: a.durationMin,
    };
    this._append(rec);
    this.markState.set(markId, { rec, pool: null, lastTry: 0, score: null });
    st.episode = {
      episodeId, markId, startTs: ts,
      rangeHi: a.rangeHi, rangeLo: a.rangeLo, hiPrice: a.hiPrice, loPrice: a.loPrice,
      exitStreak: 0, exitSide: null,
    };
    this.dirty = true;
    this._save(true);
    if (this.log) this.log(`[rangewatch] ${st.symbol || st.mint}: RANGE formed — ${a.durationMin}m base, band ${a.bandPct}% ($${Math.round(a.rangeLo)}–$${Math.round(a.rangeHi)} mc), mark at $${Math.round(rec.markMc || 0)} [${source}] — record only`);
    // The live tap (Bot._evalRange via RANGE_LIVE): notified AFTER the
    // mark is journaled and the episode is open — the study's records
    // are already complete whatever the tap does with it.
    try { if (this.onMark) this.onMark(rec); } catch { /* live tap — fail-silent, can never disturb the study */ }
    return rec;
  }

  /** The mint's OPEN range episode, or null when no episode is open
   *  (never formed, already ended, or tracking dropped). Read by the
   *  Bot's deferred dip watch (base strategy): a top-third mark's entry
   *  may only fire while THIS episode — same episodeId, same band — is
   *  still intact. Returns a copy of the episode's geometry; the
   *  tracker stays the only writer. */
  episodeFor(mint) {
    const st = this.track.get(mint);
    if (!st || !st.episode) return null;
    const ep = st.episode;
    return { episodeId: ep.episodeId, markId: ep.markId, startTs: ep.startTs, rangeHi: ep.rangeHi, rangeLo: ep.rangeLo, hiPrice: ep.hiPrice, loPrice: ep.loPrice };
  }

  /** Mints with an open range episode — the outcome observer's fetch
   *  set keeps pricing them after they leave the watchlist, the same
   *  guarantee scanLab / confluenceSignal / bottomWatch marks get. */
  pendingMints() {
    if (!this.enabled) return [];
    const out = [];
    for (const st of this.track.values()) if (st.episode) out.push({ mint: st.mint, since: st.episode.startTs });
    return out;
  }

  /** Periodic pass — rides the bot's poll tick: end episodes on mints
   *  that left the sampling orbit, forward-score due marks from GT
   *  candles (throttled), flush the state file. All fail-silent. */
  async tick(n = this.now()) {
    if (!this.enabled) return;
    try {
      for (const [mint, st] of [...this.track]) {
        if (n - st.lastTs > STALE_MS) {
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
            const completed = completedCandles(candles, n);
            const s = scoreMark(completed, { ts: x.rec.ts, price: x.rec.markPrice });
            const outcome = classifyOutcome(completed, { ts: x.rec.ts, price: x.rec.markPrice });
            const prev = x.score;
            const newHorizon = [15, 60, 240].some(h => s[`r${h}`] != null && (!prev || prev[`r${h}`] == null));
            const final = s.r240 != null || n - x.rec.ts >= SCORE_FINAL_AGE_MS;
            if (!newHorizon && !final) continue;
            const rec = {
              type: 'mark-score', markId: x.rec.markId, ts: n,
              r15: s.r15 != null ? round(s.r15) : null, r60: s.r60 != null ? round(s.r60) : null, r240: s.r240 != null ? round(s.r240) : null,
              peakPct: s.peakPct != null ? round(s.peakPct) : null, worstDipPct: s.worstDipPct != null ? round(s.worstDipPct) : null,
              outcome, final: !!final,
            };
            x.score = rec;
            this._append(rec);
            if (final) this.markState.delete(x.rec.markId);
          } catch { /* one mark's scoring can never disturb the tick */ }
        }
      }
      this._save(false);
    } catch { /* shadow study — fail silent */ }
  }

  /** GET /rangewatch payload. Computed from the FULL journal file
   *  (never a capped tail — readiness spans weeks), ~60s cache. */
  card() {
    if (!this.enabled) return { enabled: false };
    const n = this.now();
    if (this.cardCache && n - this.cardCacheTs < CARD_CACHE_MS) return this.cardCache;
    const records = this._readAll();
    let episodesOpen = 0;
    for (const st of this.track.values()) if (st.episode) episodesOpen++;
    const card = { enabled: true, journalRecords: records.length, ...buildRangeCard(records, n, { tracking: this.track.size, episodesOpen, windowMin: this.windowMin, maxBandPct: this.maxBandPct, minMc: this.minMc }) };
    this.cardCache = card;
    this.cardCacheTs = n;
    return card;
  }
}
