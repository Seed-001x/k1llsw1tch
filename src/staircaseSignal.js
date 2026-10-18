// staircaseSignal.js — the STAIRCASE-3 SHADOW SIGNAL (user order
// 2026-10-16, RECORD-ONLY — this module can never trade, gate, or feed
// any decision).
//
// The Structure Watch study (structureWatch.js) found the one clean
// pattern in the bot's whole dataset: a signaled coin's 3rd-or-later
// confirmed higher low preceded a median +208% forward PEAK across 154
// finalized marks (67.5% ran at least +50%) — while the median coin still
// round-tripped by r60 (−4.1%). The user's order: mint that moment as a
// named SIGNAL of its own — "shadow signal, record-only, outcome-tracked."
//
// So: whenever Structure Watch journals a mark with ordinal >= 3, this
// module ALSO journals a shadow-signal record to staircase_signals.jsonl
// (one per mark — the mark is the study's unit of evidence; several marks
// on one watch are several signals). Outcomes need no machinery of their
// own: the watch already scores every mark forward, so the score joins
// here at READ time from the structure journal's mark-score records,
// keyed by markId — the same read-time join /structurewatch itself uses.
// A signal reads FINALIZED once its mark carries an r60 — the exact
// convention the study's aggregates ride on — and GET /staircase serves
// the scorecard, split by ordinal band (fresh 3–5 vs deep 6+), because
// the user's own eyeball of the two live exhibits (SOUVENIR building vs
// WORLD's 19th higher low, late and tired) raised the question of whether
// deep ordinals are the same animal as fresh thirds.
//
// HARD BOUNDARIES: strictly record-only. The emission seam is a callback
// Structure Watch invokes AFTER it journals its own mark; a failure here
// can never reach the watch, let alone a trading path. Kill switch:
// STAIRCASE_SIGNAL=0 disables emission and the card.
import fs from 'node:fs';
import { median, round } from './util.js';
import { foldStructureJournal } from './structureWatch.js';

export const STAIRCASE_READY_N = 30;   // finalized signals before the card reads READY
const CARD_CACHE_MS = 60000;           // same cache trade as /structurewatch

/** Ordinal band for a staircase signal: fresh thirds ('3-5') vs deep
 *  ordinals ('6+'). null below the signal threshold. */
export function bandOf(ordinal) {
  if (!(ordinal >= 3)) return null;
  return ordinal >= 6 ? '6+' : '3-5';
}

/** The shadow-signal record for one journaled structure mark, or null
 *  when the mark is not a staircase signal (ordinal < 3 / malformed).
 *  Pure — the single place the record shape is defined. */
export function staircaseRecordOf(mark) {
  if (!mark || mark.type !== 'mark' || !mark.markId || !(mark.ordinal >= 3)) return null;
  return {
    type: 'staircase_signal',
    ts: mark.ts, mint: mark.mint ?? null, symbol: mark.symbol ?? null,
    watchId: mark.watchId ?? null, markId: mark.markId, ordinal: mark.ordinal,
    seedSource: mark.seedSource ?? 'signal',
    price: mark.price ?? null, lowPrev: mark.lowPrev ?? null, lowNew: mark.lowNew ?? null,
  };
}

function statsOf(items) {
  // Aggregates ride on FINALIZED signals (the mark's r60 exists) — a signal
  // still inside its first hour has no verdict yet and must not dilute the
  // medians. Mirrors structureWatch's markAgg convention exactly.
  const fin = items.filter(x => x.score && x.score.r60 != null);
  const peaks = fin.map(x => x.score.peakPct).filter(Number.isFinite);
  const r60s = fin.map(x => x.score.r60).filter(Number.isFinite);
  return {
    n: items.length,
    finalized: fin.length,
    runnerShare: peaks.length ? round(peaks.filter(p => p >= 0.5).length / peaks.length, 3) : null,
    medianPeak: peaks.length ? round(median(peaks)) : null,
    medianR60: r60s.length ? round(median(r60s)) : null,
  };
}

/** Fold staircase signal records + the structure journal's scores (a Map
 *  markId -> mark-score record, as foldStructureJournal returns) into the
 *  /staircase card. Pure — tested directly. */
export function buildStaircaseCard(records, scores, now = Date.now()) {
  const scoreOf = (markId) => (scores && typeof scores.get === 'function' ? scores.get(markId) : (scores || {})[markId]) || null;
  const sigs = (records || []).filter(r => r && r.type === 'staircase_signal' && r.markId);
  const joined = sigs.map(rec => ({ rec, score: scoreOf(rec.markId) }));
  const bands = { '3-5': [], '6+': [] };
  for (const x of joined) { const b = bandOf(x.rec.ordinal); if (b) bands[b].push(x); }
  const recent = [...joined].sort((a, b) => b.rec.ts - a.rec.ts).slice(0, 10).map(({ rec, score }) => ({
    ...rec,
    score: score ? {
      r15: score.r15 ?? null, r60: score.r60 ?? null, r240: score.r240 ?? null,
      peakPct: score.peakPct ?? null, worstDipPct: score.worstDipPct ?? null, final: !!score.final,
    } : null,
  }));
  const aggregates = statsOf(joined);
  return {
    generatedTs: now,
    signals: sigs.length,
    finalized: aggregates.finalized,
    ready: aggregates.finalized >= STAIRCASE_READY_N,
    aggregates,
    byBand: { '3-5': statsOf(bands['3-5']), '6+': statsOf(bands['6+']) },
    recent,
  };
}

export class StaircaseSignal {
  /**
   * deps: { cfg, journal, now, log }
   * The journal owns both files this module reads: its own
   * staircase_signals.jsonl (f.stair) and the structure journal
   * (f.swatch) whose mark-score records carry the outcomes.
   */
  constructor({ cfg = {}, journal = null, now = () => Date.now(), log = null } = {}) {
    this.cfg = cfg;
    this.journal = journal;
    this.now = now;
    this.log = log;
    this.cardCache = null;
    this.cardCacheTs = 0;
    // One record per mark, ever — rebuilt from the journal file itself so
    // a restart can never re-emit a mark that already produced a signal
    // (Structure Watch's marksFired discipline, mirrored on this side of
    // the seam in case the seam is ever invoked twice for one mark).
    this.emitted = new Set();
    for (const r of this._readOwn()) if (r && r.type === 'staircase_signal' && r.markId) this.emitted.add(r.markId);
  }

  get enabled() { return !!this.cfg.staircaseSignal; }

  _ownFile() { return this.journal && this.journal.f ? this.journal.f.stair : null; }
  _swFile() { return this.journal && this.journal.f ? this.journal.f.swatch : null; }

  _read(file) {
    if (!file) return [];
    let txt = '';
    try { txt = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail line — skip */ }
    }
    return out;
  }

  _readOwn() { return this._read(this._ownFile()); }

  /** Emission seam — invoked by Structure Watch for EVERY journaled mark
   *  (Bot wires it as the watch's onMark callback). Journals the shadow
   *  signal for ordinal >= 3 marks and returns the record, else null.
   *  Fail-silent: nothing here may disturb the watch. */
  noteMark(mark) {
    if (!this.enabled) return null;
    try {
      const rec = staircaseRecordOf(mark);
      if (!rec) return null;
      if (this.emitted.has(rec.markId)) return null;
      this.emitted.add(rec.markId);
      if (this.journal) this.journal.staircaseSignal(rec);
      if (this.log) this.log(`[staircase] ${rec.symbol || rec.mint}: higher low #${rec.ordinal} — STAIRCASE-3 shadow signal (record only)`);
      return rec;
    } catch { return null; }
  }

  /** GET /staircase payload: this module's signal records with the
   *  watch's forward scores joined at read time by markId. ~60s cache,
   *  the /structurewatch trade. */
  card() {
    if (!this.enabled) return { enabled: false };
    const n = this.now();
    if (this.cardCache && n - this.cardCacheTs < CARD_CACHE_MS) return this.cardCache;
    let scores = new Map();
    try { scores = foldStructureJournal(this._read(this._swFile())).scores; } catch { scores = new Map(); }
    const card = { enabled: true, ...buildStaircaseCard(this._readOwn(), scores, n) };
    this.cardCache = card;
    this.cardCacheTs = n;
    return card;
  }
}
