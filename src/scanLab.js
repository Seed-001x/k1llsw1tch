// scanLab.js — Scan Ledger outcome scorer + /scanledger card (user 2026-10-16,
// RECORD-ONLY — nothing in trading reads anything here).
//
// The ledger itself (Bot._foldScan / Bot._finalizeScanSession) answers "what
// did every scanned coin do WHILE watched, and did it ever signal?". This
// lab answers the follow-up the study needs: what did the coin do AFTER the
// watch ended — r15 / r60 = price at session lastTs +15m / +60m vs the
// session's last price. Checkpoints fill from the FIRST observation at or
// after their age (the journal outcome tracker's catch-up rule), fed by the
// same fetched views everything else uses (the poll loop's views plus the
// outcome observer's independent fetches, which include pending scan-score
// mints — so scoring never depends on watch residence either). A checkpoint
// whose price never arrives stays null and the score finalizes flagged
// partial past the horizon — missing data is never fabricated into a number.
// Scores persist in scan_scores.jsonl keyed by session id; pending progress
// is in-memory, rebuilt at boot from recent unscored journal sessions.
import fs from 'node:fs';
import path from 'node:path';
import { round, readTailLines } from './util.js';

export const SCAN_CPS = [15, 60];        // checkpoint minutes after session lastTs
const EXPIRE_MIN = 105;                  // finalize partial once past lastTs + 60m + 45m grace
const BOOT_REBUILD_MS = EXPIRE_MIN * 60000; // at boot, only sessions still inside the scoring horizon re-register

export class ScanLab {
  constructor({ cfg, journal = null, now = Date.now, log = () => {} } = {}) {
    this.cfg = cfg || {};
    this.journal = journal;
    this.now = now;
    this.log = log;
    this.file = path.join(this.cfg.dataDir || '.', 'scan_scores.jsonl');
    this.scores = new Map();  // session id -> score record
    this.pending = new Map(); // session id -> { id, mint, symbol, lastTs, lastPrice, got: {} }
    this._booted = false;
    try {
      for (const line of readTailLines(this.file, 12 * 1024 * 1024)) /* byte-capped tail (2026-10-18 boot-OOM fix) */ {
        try { const r = JSON.parse(line); if (r && r.id) this.scores.set(r.id, r); } catch { /* skip bad line */ }
      }
    } catch { /* no scores yet */ }
  }

  get enabled() { return !!this.cfg.scanLedger; }

  /** Register a freshly finalized session for forward scoring. Sessions
   *  whose checkpoints are already entirely in the past (e.g. registered
   *  long after finalization) are left unscored — their checkpoint prices
   *  were never observed and must not be invented. */
  register(rec) {
    if (!this.enabled || !rec || !rec.id || !(rec.lastPrice > 0)) return false;
    if (this.scores.has(rec.id) || this.pending.has(rec.id)) return false;
    if (this.now() - rec.lastTs > BOOT_REBUILD_MS) return false;
    this.pending.set(rec.id, { id: rec.id, mint: rec.mint, symbol: rec.symbol || null, lastTs: rec.lastTs, lastPrice: rec.lastPrice, got: {} });
    return true;
  }

  /** Mints with scoring in flight — the outcome observer adds these to its
   *  independent fetch set, oldest session first. */
  pendingMints() {
    const byMint = new Map();
    for (const st of this.pending.values()) {
      if (!byMint.has(st.mint) || st.lastTs < byMint.get(st.mint)) byMint.set(st.mint, st.lastTs);
    }
    return [...byMint.entries()].map(([mint, since]) => ({ mint, since })).sort((a, b) => a.since - b.since);
  }

  /** Feed one fetched view in (same view objects the poll/outcome ticks
   *  already carry). First observation at or after a checkpoint's age fills
   *  it; both filled finalizes the score immediately. */
  observe(view, ts = null) {
    if (!this.enabled || !view || !(view.price > 0)) return;
    const n = ts != null ? ts : this.now();
    for (const st of [...this.pending.values()]) {
      if (st.mint !== view.address) continue;
      const ageMin = (n - st.lastTs) / 60000;
      for (const cp of SCAN_CPS) {
        if (ageMin >= cp && st.got[cp] == null) st.got[cp] = view.price / st.lastPrice - 1;
      }
      if (st.got[15] != null && st.got[60] != null) this._finalize(st, n);
    }
  }

  /** Slow-cadence housekeeping: one-time boot rebuild of in-horizon
   *  unscored sessions, then partial finalization of pendings that ran
   *  past the horizon without their prices ever arriving. */
  tick(n = null) {
    if (!this.enabled) return;
    const now = n != null ? n : this.now();
    if (!this._booted) {
      this._booted = true;
      try {
        const sessions = (this.journal && this.journal.scanSessions) || [];
        for (const rec of sessions) this.register(rec);
      } catch { /* rebuild is best-effort */ }
    }
    for (const st of [...this.pending.values()]) {
      if ((now - st.lastTs) / 60000 > EXPIRE_MIN) this._finalize(st, now);
    }
  }

  _finalize(st, n) {
    this.pending.delete(st.id);
    const rec = {
      id: st.id, mint: st.mint, symbol: st.symbol, lastTs: st.lastTs,
      r15: round(st.got[15]), r60: round(st.got[60]),
      partial: st.got[15] == null || st.got[60] == null,
      scoredTs: n,
    };
    this.scores.set(st.id, rec);
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort — never disturb the bot */ }
    return rec;
  }

  scoreOf(id) { return this.scores.get(id) || null; }
}

/** Read-only /scanledger payload over the retained session ledger: totals,
 *  the latest 100 sessions newest-first, and the near-miss list — sessions
 *  that ran hardest while watched but NEVER signaled (samples >= 5, so a
 *  one-glance coin can't top the study list). r15/r60 join from the score
 *  map when scored, null otherwise. Pure — tested directly. */
export function buildScanCard(sessions, scoreOf, now = Date.now()) {
  const all = sessions || [];
  const join = (s) => {
    const sc = scoreOf ? scoreOf(s.id) : null;
    return { ...s, r15: sc ? sc.r15 : null, r60: sc ? sc.r60 : null };
  };
  const signaled = all.filter(s => s.signaled).length;
  // Evaluation-stamp aggregate (2026-10-16): failing-condition counts per
  // setup over finalized sessions — each session contributes the failing
  // metrics of its BEST verdict per setup, once per metric. Read-time
  // computed from the retained records; sessions finalized before stamps
  // shipped carry no verdicts and simply don't contribute.
  const failHistogram = {};
  let evaluatedSessions = 0, neverEvaluated = 0, passedNotSignaled = 0;
  for (const s of all) {
    if (s.verdicts) {
      evaluatedSessions++;
      let anyPass = false;
      for (const [setup, vd] of Object.entries(s.verdicts)) {
        if (!vd) continue;
        if (vd.passed) anyPass = true;
        if (!vd.evaluated || vd.passed || !Array.isArray(vd.fails)) continue;
        const h = failHistogram[setup] || (failHistogram[setup] = {});
        for (const m of new Set(vd.fails.map(f => f.metric))) if (m) h[m] = (h[m] || 0) + 1;
      }
      if (anyPass && !s.signaled) passedNotSignaled++;
    } else if (s.evaluated === false) neverEvaluated++;
  }
  return {
    generatedTs: now,
    totals: {
      sessions: all.length,
      signaled,
      signaledPct: all.length ? round(100 * signaled / all.length, 1) : 0,
      evaluatedSessions,
      neverEvaluated,
      passedNotSignaled,
      failHistogram,
    },
    recent: all.slice(-100).reverse().map(join),
    signaledSessions: all
      .filter(s => s.signaled)
      .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
      .slice(0, 100)
      .map(join),
    nearMisses: all
      .filter(s => !s.signaled && (s.samples || 0) >= 5)
      .sort((a, b) => (b.runFromFirst || 0) - (a.runFromFirst || 0))
      .slice(0, 50)
      .map(join),
  };
}
