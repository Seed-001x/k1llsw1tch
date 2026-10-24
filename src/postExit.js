// postExit.js — what happens AFTER an exit: keep sampling the price for 5 more minutes
// and log the outcome (did it rip without us? did it die — good exit?). Pure sidecar:
// fed from views the poll loop already fetched, never trades, never blocks, and every
// failure is swallowed — it can observe the bot, never disturb it.
import fs from 'node:fs';
import path from 'node:path';
import { evaluateExit } from './exits.js';

export const POST_EXIT_WINDOW_MS = 5 * 60 * 1000;
const SAMPLE_EVERY_MS = 5000;
const KEEP_DONE = 200;
// Memory loop phase 2 (SPEC §4(c)): long post-exit marks at +1h and +4h,
// so a closed episode can be labeled "found a floor" from durable data.
// A watch finalizes when its h4 mark lands or at +4.5h (marks stay null
// when no view ever arrived — honest, never invented).
export const LONG_H1_MS = 60 * 60 * 1000;
export const LONG_H4_MS = 4 * 60 * 60 * 1000;
export const LONG_FINALIZE_MS = LONG_H4_MS + 30 * 60 * 1000;

export function summarizePostExit(anchorPrice, samples) {
  if (!(anchorPrice > 0) || !samples || !samples.length) {
    return { samples: 0, lastMovePct: null, peakMovePct: null, troughMovePct: null };
  }
  const moves = samples.map(s => (s.price / anchorPrice - 1) * 100);
  return {
    samples: samples.length,
    lastMovePct: +moves[moves.length - 1].toFixed(1),
    peakMovePct: +Math.max(...moves).toFixed(1),
    troughMovePct: +Math.min(...moves).toFixed(1),
  };
}

export class PostExitTracker {
  constructor(dir, now = () => Date.now()) {
    this.file = path.join(dir, 'post_exit.jsonl');
    this.longFile = path.join(dir, 'post_exit_long.json');
    this.now = now;
    this.pending = new Map(); // position id -> entry
    this.done = [];
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-KEEP_DONE);
      for (const l of lines) { try { this.done.push(JSON.parse(l)); } catch { /* skip bad line */ } }
    } catch { /* no file yet */ }
    // Long +1h/+4h watches persist across restarts (the outcome_pending.json
    // idiom: a small state file rewritten on change) so a redeploy can
    // never silently eat a floor label. Finalized records leave through
    // onLongDone (Bot wires it to Journal.postMark, the durable store).
    this.long = new Map(); // position id -> long watch entry
    this.onLongDone = null;
    try {
      const arr = JSON.parse(fs.readFileSync(this.longFile, 'utf8'));
      if (Array.isArray(arr)) for (const e of arr) if (e && e.id) this.long.set(e.id, e);
    } catch { /* no state yet */ }
  }

  _saveLong() {
    try { fs.writeFileSync(this.longFile, JSON.stringify([...this.long.values()])); } catch { /* best effort */ }
  }

  /** Register a just-closed position. anchorPrice = USD price at exit when known;
   *  otherwise the first post-exit sample becomes the anchor. */
  watch(e) {
    try {
      if (!e || !e.id || this.pending.has(e.id)) return;
      this.pending.set(e.id, {
        id: e.id, mint: e.mint, symbol: e.symbol, setup: e.setup || null,
        exitTs: e.exitTs || this.now(), reason: e.reason || null,
        manual: !!e.manual, pnlSol: e.pnlSol ?? null,
        exitPriceUsd: e.exitPriceUsd > 0 ? e.exitPriceUsd : null,
        anchorPrice: e.exitPriceUsd > 0 ? e.exitPriceUsd : null,
        samples: [],
      });
      // The same close registers a long watch (+1h/+4h floor marks).
      if (e.id && !this.long.has(e.id)) {
        this.long.set(e.id, {
          id: e.id, mint: e.mint, symbol: e.symbol || null, setup: e.setup || null,
          exitTs: e.exitTs || this.now(),
          exitPriceUsd: e.exitPriceUsd > 0 ? e.exitPriceUsd : null,
          anchor: e.exitPriceUsd > 0 ? e.exitPriceUsd : null,
          marks: {},
        });
        this._saveLong();
      }
    } catch { /* observer must never throw into the trading path */ }
  }

  /** Mints with an open long watch — Bot's outcomeTick folds these into
   *  its fetch set (the bottomWatch/rangeWatch idiom). */
  longMints() {
    return [...this.long.values()].map(e => ({ mint: e.mint, since: e.exitTs }));
  }

  /** Feed one fetched view to the long watches for its mint: record the
   *  h1 mark at age >= 60m and the h4 mark at age >= 240m (price + MC +
   *  move vs the exit anchor), then run the expiry sweep. */
  observeLong(v, n) {
    try {
      if (!v || !(v.price > 0)) return;
      let changed = false;
      for (const e of this.long.values()) {
        if (e.mint !== v.address) continue;
        if (!(e.anchor > 0)) { e.anchor = v.price; changed = true; }
        const age = n - e.exitTs;
        for (const [key, ms] of [['h1', LONG_H1_MS], ['h4', LONG_H4_MS]]) {
          if (!e.marks[key] && age >= ms) {
            e.marks[key] = {
              ts: n, price: v.price, mc: v.mc ?? null,
              movePct: e.anchor > 0 ? +((v.price / e.anchor - 1) * 100).toFixed(1) : null,
            };
            changed = true;
          }
        }
      }
      if (changed) this._saveLong();
      this.sweepLong(n);
    } catch { /* observer must never throw into the trading path */ }
  }

  /** Finalize watches whose h4 mark landed or that outlived the window
   *  (marks stay null where no view arrived — the record says so). */
  sweepLong(n) {
    try {
      for (const e of [...this.long.values()]) {
        if (e.marks.h4 || n - e.exitTs >= LONG_FINALIZE_MS) this._finalizeLong(e, n);
      }
    } catch { /* observer must never throw into the trading path */ }
  }

  _finalizeLong(e, n) {
    this.long.delete(e.id);
    this._saveLong();
    const rec = {
      type: 'postmarks', id: e.id, mint: e.mint, symbol: e.symbol, setup: e.setup,
      exitTs: e.exitTs, finalTs: n,
      exitPriceUsd: e.exitPriceUsd, anchorPrice: e.anchor,
      h1: e.marks.h1 || null, h4: e.marks.h4 || null,
    };
    try { if (this.onLongDone) this.onLongDone(rec); } catch { /* observer only */ }
    return rec;
  }

  sample(mint, price, ts) {
    if (!(price > 0)) return;
    for (const e of this.pending.values()) {
      if (e.mint !== mint) continue;
      if (!e.anchorPrice) e.anchorPrice = price;
      const last = e.samples[e.samples.length - 1];
      if (!last || ts - last.ts >= SAMPLE_EVERY_MS) e.samples.push({ ts, price });
    }
  }

  /** Called from the poll loop with a sync price lookup (mint -> USD price | null). */
  tick(priceOf, nowTs) {
    try {
      for (const e of [...this.pending.values()]) {
        let p = null;
        try { p = priceOf(e.mint); } catch { /* ignore */ }
        if (p > 0) this.sample(e.mint, p, nowTs);
        if (nowTs - e.exitTs >= POST_EXIT_WINDOW_MS) this.finalize(e);
      }
    } catch { /* never disturb the poll loop */ }
  }

  finalize(e) {
    this.pending.delete(e.id);
    const s = summarizePostExit(e.anchorPrice, e.samples);
    const rec = {
      id: e.id, mint: e.mint, symbol: e.symbol, setup: e.setup,
      exitTs: e.exitTs, finalTs: this.now(),
      exitPriceUsd: e.exitPriceUsd, anchorPrice: e.anchorPrice,
      reason: e.reason, manual: e.manual, pnlSol: e.pnlSol, ...s,
    };
    this.done.push(rec);
    if (this.done.length > KEEP_DONE) this.done.shift();
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
    return rec;
  }

  recent(n = 50) {
    return {
      pending: [...this.pending.values()].map(e => ({
        id: e.id, mint: e.mint, symbol: e.symbol, exitTs: e.exitTs, samples: e.samples.length,
      })),
      done: this.done.slice(-n).reverse(),
    };
  }
}

// ---------------------------------------------------------------------------
// D1 paired shadow exits (record-only). When the HUMAN closes a position, the
// bot's exit question doesn't end — it just stops being answerable from the
// trade log: would the bot's own exit stack have done better or worse on the
// remainder the human sold? This tracker keeps a VIRTUAL copy of the position
// (same entry state the live position had at the manual exit) and runs the
// real evaluateExit against it on every poll, marked off the live view price
// the poll loop already fetches. It can never trade and never reopens
// anything: its only output is one comparison record per manual exit, written
// when the virtual position would have fully exited — or when the cap hits,
// marked to the last seen price. Marks: valueSol = basis × (price/entryPrice)
// × entryRoundTrip, the same round-trip haircut convention live marks carry
// (a flat coin reads move 1.00), so the virtual stack judges the same shape
// the live stack would have seen.
export const SHADOW_EXIT_CAP_MS = 60 * 60 * 1000;
const KEEP_PAIRED = 200;

export class PairedShadowExits {
  constructor(dir, now = () => Date.now()) {
    this.file = path.join(dir, 'paired_shadow_exits.jsonl');
    this.now = now;
    this.pending = new Map(); // position id -> virtual position state
    this.done = [];
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean).slice(-KEEP_PAIRED);
      for (const l of lines) { try { this.done.push(JSON.parse(l)); } catch { /* skip bad line */ } }
    } catch { /* no file yet */ }
  }

  /** Register the virtual remainder of a just-manually-closed position.
   *  `s` carries the live position's exit-relevant state (see bot._pairedState). */
  watch(s) {
    try {
      if (!s || !s.id || this.pending.has(s.id)) return;
      this.pending.set(s.id, {
        ...s,
        tokensFrac: s.remainingFrac, // share of the ORIGINAL position still virtually held
        realizedSol: 0, sells: 0,
        lastValueSol: s.manualMarkSol ?? null,
      });
    } catch { /* observer must never throw into the trading path */ }
  }

  /** Called from the poll loop with a sync view lookup (mint -> view | null). */
  tick(viewOf, nowTs, cfg, solUsd = null) {
    try {
      for (const s of [...this.pending.values()]) {
        if (nowTs - s.manualTs >= SHADOW_EXIT_CAP_MS) { this.finalize(s, 'expired', null, nowTs, cfg); continue; }
        let v = null;
        try { v = viewOf(s.mint); } catch { /* ignore */ }
        if (!v || !(v.price > 0) || !(s.entryPrice > 0)) continue;
        const basis = s.entrySol * s.remainingFrac;
        if (!(basis > 0)) { this.finalize(s, 'expired', null, nowTs, cfg); continue; }
        const rt = s.entryRoundTrip > 0 ? s.entryRoundTrip : 1;
        const valueSol = s.entrySol * s.tokensFrac * (v.price / s.entryPrice) * rt;
        s.lastValueSol = valueSol;
        // the virtual position's own flow history, same shape managePosition keeps
        s.flowHist = s.flowHist || [];
        s.flowHist.push({ ts: nowTs, buys: v.buysM5 ?? null, sells: v.sellsM5 ?? null, tx: (v.buysM5 != null || v.sellsM5 != null) ? (v.buysM5 || 0) + (v.sellsM5 || 0) : null });
        if (s.flowHist.length > 45) s.flowHist.splice(0, s.flowHist.length - 45);
        const mark = { valueSol, liqUsd: v.liq != null ? v.liq : null, buysM5: v.buysM5 != null ? v.buysM5 : null, sellsM5: v.sellsM5 || 0, solUsd, volH1: v.volH1 || 0 };
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
        if ('tp1Arm' in d) s.tp1Arm = d.tp1Arm;
        if ('tp1FireGain' in d) s.tp1FireGain = d.tp1FireGain;
        if ('tp1GuardTrimmed' in d) s.tp1GuardTrimmed = d.tp1GuardTrimmed;
        if (!(d.fraction > 0)) continue;
        s.realizedSol += d.fraction * valueSol;
        s.sells++;
        if (d.fraction >= 1 || s.tokensFrac * (1 - d.fraction) <= 1e-9) { this.finalize(s, 'exited', d.reason, nowTs, cfg); continue; }
        s.tokensFrac *= (1 - d.fraction);
        if (d.tp1) { s.tp1Done = true; s.remainingFrac *= (1 - d.fraction); }
        if (d.tp2) { s.tp2Done = true; s.remainingFrac *= (1 - d.fraction); }
        if (d.bagWave) s.remainingFrac *= (1 - d.fraction); // staged moonbag wave: book the partial like the live seam does
      }
    } catch { /* never disturb the poll loop */ }
  }

  finalize(s, status, reason, nowTs, cfg) {
    this.pending.delete(s.id);
    const proceeds = s.realizedSol + (status === 'expired' ? (s.lastValueSol || 0) : 0);
    const fees = ((cfg && cfg.txFeeSol) || 0) * s.sells; // virtual sell-side fees at the same estimate the live book uses
    const rec = {
      id: s.id, mint: s.mint, symbol: s.symbol, setup: s.setup || null,
      manualTs: s.manualTs, manualPnlSol: s.manualPnlSol ?? null,
      manualMarkSol: s.manualMarkSol != null ? +s.manualMarkSol.toFixed(6) : null,
      // D1 follow-up: 'chainTx' when the manual side was priced from the real
      // sell transaction's deltas (see bot._manualFill) — the comparison is
      // then real-vs-would-be, not mark-vs-would-be. manualFillSol is the
      // realized per-token fill (gross of the sell fee, per the convention).
      manualMarkSource: s.manualFillSource ? 'chainTx' : 'viewPrice',
      manualFillSol: s.manualFillSol != null ? +s.manualFillSol.toFixed(10) : null,
      basisSol: +s.basisSol.toFixed(6),
      manualRemainderPnlSol: s.manualMarkSol != null ? +(s.manualMarkSol - s.basisSol).toFixed(6) : null,
      status, wouldReason: reason, wouldTs: nowTs,
      wouldHeldMin: +((nowTs - s.entryTs) / 60000).toFixed(1),
      afterManualMin: +((nowTs - s.manualTs) / 60000).toFixed(1),
      virtualSells: s.sells,
      wouldProceedsSol: +proceeds.toFixed(6),
      wouldPnlSol: +(proceeds - s.basisSol - fees).toFixed(6),
      markSource: 'viewPrice',
    };
    this.done.push(rec);
    if (this.done.length > KEEP_PAIRED) this.done.shift();
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
    return rec;
  }

  /** Newest-first page over completed paired records + live pending summaries. */
  page({ offset = 0, limit = 50 } = {}) {
    const all = this.done.slice().reverse();
    const off = Math.max(0, offset | 0);
    const lim = Math.max(1, limit | 0);
    return {
      pending: [...this.pending.values()].map(s => ({ id: s.id, mint: s.mint, symbol: s.symbol, manualTs: s.manualTs, ageMin: +((this.now() - s.manualTs) / 60000).toFixed(1) })),
      total: all.length, offset: off, limit: lim,
      done: all.slice(off, off + lim),
    };
  }
}
