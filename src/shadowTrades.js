// shadowTrades.js — TRADE-GRADE SHADOW (record-only, user 2026-10-14).
//
// A shadow-mode signal (trend/liftoff with *_SHADOW on) used to stop at a
// price diary: journaled, gate-scored for the record (D1 shadowGateRecord),
// outcome-tracked r5/r15/r60 — but never RUN as a trade, so "the coin went
// up after the signal" could never answer "what would the bot have banked?".
// This tracker closes that gap: when a shadow signal PASSES its gate
// evaluation, a VIRTUAL position opens at the signal price for cfg.tradeSol
// and the bot's REAL exit stack (evaluateExit) manages it to a full exit —
// TP1/TP2 partial banks included — marked off the same price views the
// outcome observer fetches (Bot.outcomeTick's fetch set is extended with the
// open virtual mints; the trading poll's already-fetched views tick it too).
// No separate price poller exists for these positions anywhere.
//
// It can never trade: no exec calls, no real positions, no risk counters, no
// entries, no trade-journal records. Its only outputs are virtual_trades.jsonl
// (one scored record per completed virtual) and stats.shadowTrades.
//
// Approximations, stamped on every record rather than hidden:
//  - pnlBasis 'viewQuote': marks are DexScreener VIEW prices, not Jupiter
//    sell quotes. A virtual entry has no measured round trip, so
//    entryRoundTrip = 1 — the stack judges pure price moves (a flat coin
//    reads move 1.00), slightly kinder than the live stack's quote basis.
//  - markCadenceSec: exits are judged at observer/poll cadence (~10–30s),
//    not the live 4s position loop. flowHist / moveHist are built from those
//    same marks, exactly as the paired shadow exits do. The measured mean
//    gap between this trade's own marks rides on the completed record.
//  - Fees are the bot's own txFeeSol estimate at the live book's convention:
//    buy + one per virtual sell. No chain fees exist for a trade that never
//    happened, and none are invented.
import fs from 'node:fs';
import path from 'node:path';
import { evaluateExit } from './exits.js';

export const SHADOW_TRADE_CAP_MS = 4 * 60 * 60 * 1000; // hard cap: 4h, then mark-to-last and close the book
const KEEP_DONE = 200;
const SAVE_EVERY_MS = 10000; // pending-state flush throttle (open/finalize always save immediately)

export class ShadowTrades {
  constructor(dir, now = () => Date.now(), opts = {}) {
    this.file = path.join(dir, 'virtual_trades.jsonl');
    this.pendFile = path.join(dir, 'virtual_pending.json');
    this.now = now;
    this.feeHint = opts.txFeeSol > 0 ? opts.txFeeSol : 0; // boot-time finalize fallback; tick() gets the live cfg
    // Optional observer hooks (record-only consumers, e.g. the stream ratchet
    // judge's fire-quality probes + completion records): onTick(s, move, ts)
    // fires per virtual per tick with its mark move, onClose(s, rec) at every
    // finalize. Both are invoked fail-silent — an observer can never disturb
    // the book. Set before the boot-restore below, which may finalize.
    this.onTick = typeof opts.onTick === 'function' ? opts.onTick : null;
    this.onClose = typeof opts.onClose === 'function' ? opts.onClose : null;
    this.pending = new Map(); // virtual id -> exit-stack state
    this.done = [];
    this.totals = { opened: 0, completed: 0, wins: 0, netPnlSol: 0 };
    this._dirty = false;
    this._savedAt = 0;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-KEEP_DONE);
      for (const l of lines) { try { this.done.push(JSON.parse(l)); } catch { /* skip bad line */ } }
    } catch { /* no file yet */ }
    // Restore in-flight virtuals (same discipline as outcome_pending): a
    // restart resumes the trade where it left off — earned peak, banked
    // legs and exit-stack state intact — instead of resetting it. Virtuals
    // already past the cap at boot finalize as expired on their last mark,
    // never silent limbo.
    try {
      const saved = JSON.parse(fs.readFileSync(this.pendFile, 'utf8'));
      if (saved && saved.totals) this.totals = { opened: saved.totals.opened || 0, completed: saved.totals.completed || 0, wins: saved.totals.wins || 0, netPnlSol: saved.totals.netPnlSol || 0 };
      const n = this.now();
      const expired = [];
      for (const s of (saved && saved.pending) || []) {
        if (!s || !s.id || !s.mint || !(s.entryPrice > 0) || !(s.entrySol > 0)) continue;
        if (n - s.entryTs >= SHADOW_TRADE_CAP_MS) expired.push(s);
        else this.pending.set(s.id, s);
      }
      for (const s of expired) this._finalize(s, 'expired', null, n, null);
      if (this._dirty) this._save(true);
    } catch { /* no saved state yet */ }
  }

  /** Open a virtual position for a gate-passing shadow signal. One open
   *  virtual per mint: a repeat signal while one is running opens nothing.
   *  Returns true when a virtual was opened. */
  open({ id, mint, symbol, setup, price, mc, ts, sizeSol, volH1 = 0 }) {
    try {
      if (!id || !mint || !(price > 0) || !(sizeSol > 0)) return false;
      if (this.pending.has(id)) return false;
      for (const s of this.pending.values()) if (s.mint === mint) return false;
      this.pending.set(id, {
        id, mint, symbol, setup: setup || null,
        entryTs: ts, entryPrice: price, entryMc: mc ?? null,
        entrySol: sizeSol, sizeSol,
        // viewQuote basis: no measured round trip exists for a signal that
        // never traded, so the stack judges the price move itself (see header)
        entryRoundTrip: 1,
        entryVolH1: volH1 || 0,
        remainingFrac: 1, peakRatio: 1, peakMove: 1,
        tp1Done: false, tp2Done: false, tp1Arm: null,
        stallSince: null, stopArmedTs: null, floorChecks: 0, floorSince: null,
        probationSince: null, moveHist: [], exitPending: {}, stallPending: null, clipPending: null, bagDeadWaves: 0, bagDeadHot: false, bagTrailSince: null, bagFloorSince: null, bagTp2Ratio: null, bagTrimDone: false, flowHist: [],
        realizedSol: 0, sells: 0, legs: [],
        lastValueSol: sizeSol, lastTickTs: 0,
        marks: 0, firstMarkTs: null, lastMarkTs: null,
      });
      this.totals.opened++;
      this._save(true);
      return true;
    } catch { return false; /* observer must never throw into the signal path */ }
  }

  /** The open virtual on a mint, or null — one runs per mint by construction.
   *  Bot's stream ratchet judge keys its per-mint lookup on this. */
  openVirtual(mint) {
    for (const s of this.pending.values()) if (s.mint === mint) return s;
    return null;
  }

  /** Mints with a virtual in flight, oldest entry first — Bot.outcomeTick
   *  merges these into its fetch set so marks never depend on the watchlist. */
  pendingMints() {
    return [...this.pending.values()]
      .map(s => ({ mint: s.mint, since: s.entryTs }))
      .sort((a, b) => a.since - b.since);
  }

  /** Called with a sync view lookup (mint -> view | null) from the trading
   *  poll and from the outcome observer — the same views everything else in
   *  the bot reads, never a fetch of this tracker's own. */
  tick(viewOf, nowTs, cfg, solUsd = null) {
    try {
      let mustSave = false; // a banked leg is significant state: it forces the flush, throttle or not
      for (const s of [...this.pending.values()]) {
        if (nowTs - s.entryTs >= SHADOW_TRADE_CAP_MS) { this._finalize(s, 'expired', null, nowTs, cfg); continue; }
        if (nowTs <= (s.lastTickTs || 0)) continue; // same-cycle double tick (poll + observer share a timestamp)
        let v = null;
        try { v = viewOf(s.mint); } catch { /* ignore */ }
        if (!v || !(v.price > 0)) continue;
        s.lastTickTs = nowTs;
        const valueSol = s.entrySol * s.remainingFrac * (v.price / s.entryPrice) * (s.entryRoundTrip > 0 ? s.entryRoundTrip : 1);
        s.lastValueSol = valueSol;
        s.marks++;
        if (s.firstMarkTs == null) s.firstMarkTs = nowTs;
        s.lastMarkTs = nowTs;
        // the virtual position's own flow history, same shape managePosition keeps
        s.flowHist = s.flowHist || [];
        s.flowHist.push({ ts: nowTs, buys: v.buysM5 ?? null, sells: v.sellsM5 ?? null, tx: (v.buysM5 != null || v.sellsM5 != null) ? (v.buysM5 || 0) + (v.sellsM5 || 0) : null });
        if (s.flowHist.length > 45) s.flowHist.splice(0, s.flowHist.length - 45);
        const mark = { valueSol, liqUsd: v.liq != null ? v.liq : null, buysM5: v.buysM5 != null ? v.buysM5 : null, sellsM5: v.sellsM5 || 0, solUsd, volH1: v.volH1 || 0 };
        if (this.onTick) { // observer hook: this tick's mark move, before the stack judges it
          const mv = s.entrySol > 0 && s.remainingFrac > 0 ? (valueSol / (s.entrySol * s.remainingFrac)) / (s.entryRoundTrip > 0 ? s.entryRoundTrip : 1) : null;
          try { this.onTick(s, mv, nowTs); } catch { /* observer only */ }
        }
        const d = evaluateExit(s, mark, cfg, nowTs);
        // thread the decision's state outputs back exactly like managePosition does
        if (d.newPeak) s.peakRatio = d.newPeak;
        if (d.newPeakMove != null) s.peakMove = d.newPeakMove;
        if ('stallSince' in d) s.stallSince = d.stallSince;
        if ('stopArmedTs' in d) s.stopArmedTs = d.stopArmedTs;
        if ('floorChecks' in d) s.floorChecks = d.floorChecks;
        if ('floorSince' in d) s.floorSince = d.floorSince;
        if ('probationSince' in d) s.probationSince = d.probationSince;
        if ('moveHist' in d) s.moveHist = d.moveHist;
        if ('exitPending' in d) s.exitPending = d.exitPending;
        if ('stallPending' in d) s.stallPending = d.stallPending;
        if ('clipPending' in d) s.clipPending = d.clipPending;
        if ('bagDeadWaves' in d) s.bagDeadWaves = d.bagDeadWaves;
        if ('bagDeadHot' in d) s.bagDeadHot = d.bagDeadHot;
        if ('bagTrailSince' in d) s.bagTrailSince = d.bagTrailSince;
        if ('bagFloorSince' in d) s.bagFloorSince = d.bagFloorSince;
        if ('bagTp2Ratio' in d) s.bagTp2Ratio = d.bagTp2Ratio;
        if ('bagTrimDone' in d) s.bagTrimDone = d.bagTrimDone;
        if ('tp1Arm' in d) s.tp1Arm = d.tp1Arm;
        if ('tp1FireGain' in d) s.tp1FireGain = d.tp1FireGain;
        if ('tp1GuardTrimmed' in d) s.tp1GuardTrimmed = d.tp1GuardTrimmed;
        this._dirty = true;
        if (!(d.fraction > 0)) continue;
        mustSave = true;
        const banked = d.fraction * valueSol;
        s.realizedSol += banked;
        s.sells++;
        s.legs.push({
          reason: d.reason, frac: +d.fraction.toFixed(4),
          fracOfOriginal: +(d.fraction * s.remainingFrac).toFixed(4),
          price: v.price, ts: nowTs, proceedsSol: +banked.toFixed(6),
        });
        if (d.fraction >= 1 || s.remainingFrac * (1 - d.fraction) <= 1e-9) { this._finalize(s, 'exited', d.reason, nowTs, cfg); continue; }
        s.remainingFrac *= (1 - d.fraction);
        s.lastValueSol = valueSol * (1 - d.fraction); // the stored mark always values the CURRENT holding
        if (d.tp1) s.tp1Done = true;
        if (d.tp2) s.tp2Done = true;
      }
      this._save(mustSave);
    } catch { /* never disturb the poll loop */ }
  }

  _finalize(s, status, reason, nowTs, cfg) {
    this.pending.delete(s.id);
    const proceeds = s.realizedSol + (status === 'expired' ? (s.lastValueSol || 0) : 0);
    const txFee = cfg && cfg.txFeeSol > 0 ? cfg.txFeeSol : this.feeHint;
    const fees = txFee * (1 + s.sells); // buy + one per virtual sell, the live book's convention
    const pnlSol = +(proceeds - s.sizeSol - fees).toFixed(6);
    const cadence = s.marks >= 2 && s.lastMarkTs > s.firstMarkTs
      ? Math.round((s.lastMarkTs - s.firstMarkTs) / (s.marks - 1) / 1000)
      : (s.marks === 1 && s.firstMarkTs > s.entryTs ? Math.round((s.firstMarkTs - s.entryTs) / 1000) : null);
    const rec = {
      id: s.id, mint: s.mint, symbol: s.symbol, setup: s.setup,
      entryTs: s.entryTs, exitTs: nowTs,
      heldMin: +((nowTs - s.entryTs) / 60000).toFixed(1),
      entryPrice: s.entryPrice, entryMc: s.entryMc ?? null,
      sizeSol: s.sizeSol,
      exitReason: reason, legs: s.legs,
      peakRatio: +(s.peakRatio || 1).toFixed(4),
      proceedsSol: +proceeds.toFixed(6), feesSol: +fees.toFixed(6),
      pnlSol, pnlPct: s.sizeSol > 0 ? +(pnlSol / s.sizeSol * 100).toFixed(2) : null,
      pnlBasis: 'viewQuote', entryRoundTrip: s.entryRoundTrip,
      markCadenceSec: cadence, marks: s.marks,
      status,
    };
    this.done.push(rec);
    if (this.done.length > KEEP_DONE) this.done.shift();
    this.totals.completed++;
    if (pnlSol > 0) this.totals.wins++;
    this.totals.netPnlSol = +(this.totals.netPnlSol + pnlSol).toFixed(6);
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
    this._dirty = true;
    this._save(true);
    if (this.onClose) { try { this.onClose(s, rec); } catch { /* observer only */ } }
    return rec;
  }

  /** Persist in-flight state (whole-map rewrite; the pending set is small).
   *  Open/finalize save immediately; tick-driven state saves are throttled.
   *  Best-effort — a failed write must never disturb the bot. */
  _save(force) {
    if (!this._dirty && !force) return;
    const n = this.now();
    if (!force && n - this._savedAt < SAVE_EVERY_MS) return;
    try {
      fs.writeFileSync(this.pendFile, JSON.stringify({ totals: this.totals, pending: [...this.pending.values()] }));
      this._dirty = false; this._savedAt = n;
    } catch { /* disk full etc. — never crash the bot */ }
  }

  totalsView() {
    return { opened: this.totals.opened, completed: this.totals.completed, wins: this.totals.wins, netPnlSol: +this.totals.netPnlSol.toFixed(6) };
  }

  /** Newest-first page over completed virtual trades + live pending summaries
   *  (the /postexit paired shape). */
  page({ offset = 0, limit = 50 } = {}) {
    const all = this.done.slice().reverse();
    const off = Math.max(0, offset | 0);
    const lim = Math.max(1, limit | 0);
    return {
      pending: [...this.pending.values()].map(s => ({
        id: s.id, mint: s.mint, symbol: s.symbol, setup: s.setup, entryTs: s.entryTs,
        ageMin: +((this.now() - s.entryTs) / 60000).toFixed(1),
        remainingFrac: +s.remainingFrac.toFixed(4), peakRatio: +(s.peakRatio || 1).toFixed(3),
        lastValueSol: s.lastValueSol != null ? +s.lastValueSol.toFixed(6) : null,
      })),
      total: all.length, offset: off, limit: lim,
      done: all.slice(off, off + lim),
    };
  }
}
