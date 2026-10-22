// confluenceSignal.js — the CONFLUENCE SHADOW SIGNAL (user order
// 2026-10-16, RECORD-ONLY — this module can never trade, gate, or feed
// any decision).
//
// The walletWatch confluence detector (≥2 distinct surviving-trader
// entities buying one mint inside a 5-minute on-chain window) has journaled
// outcome events since 2026-10-15, scored from the fire's blockTime price
// on GeckoTerminal candles. The 2026-10-16 classification study found a
// real, harvestable peak structure in that population (57.2% touch +50%,
// median peak 1.613x at n=544) but every decisive question is FORWARD and
// unanswerable from the candle journal: true touch rates at +20/+30% from
// a TRADABLE entry reference, the cost of the 0–5+ min detection lag
// (300s survivor poll), the undertaker's interaction with dip-first paths,
// and post-friction EV per exit profile. This module is the instrument
// that measures them: on each confluence fire it opens TWO virtual
// positions on the standard shadow stake (cfg.tradeSol, 0.05 SOL live),
// stamped at DETECTION time — the bot process's own clock when
// walletWatch journaled the event (ev.ts) — at the price of the live view
// walletWatch itself fetched at detection (ev.viewPrice / ev.mc, the
// fetchViews machinery signals use). A fire whose detection view has no
// price is journaled as a noView fire and opens nothing (the noView rate
// is itself data). Each fire opens its own pair, even if an earlier
// fire's pair on the same mint is still running — fires are the unit of
// evidence, and the journal keeps them distinct by fireId.
//
// EXIT RULE SETS (exact — the owner corrects from this list):
//   SCALP (the owner's design): 100% exit at the first position check
//     whose net gain reaches cfg.confluenceScalpPct (+20% default),
//     judged on exits.js's own net-gain ruler (ratio − 1 − 3×txFee/basis,
//     so the touch is a real profit, never a gross print). Before the
//     scalp, liquidity death (exits.js §1, verbatim formula) sells in
//     full; after it, the momentum-failure undertaker (exits.js §5,
//     verbatim: ≥10 min held, underwater, buysM5 ≤ 1, sells > 3× buys)
//     sells in full. Nothing else can close a scalp position except the
//     4h terminal.
//   LADDER: the current live exit stack, run through evaluateExit
//     unchanged (TP1 adaptive / TP2 / moonbag trail / post-TP2 dead flow /
//     TP2 rejection / momentum-failure undertaker / liquidity death).
//     State threading is one step MORE faithful than the shadow book
//     (shadowTrades.js): killZone / postTp1PeakMove / deadflowArmed /
//     pathClass are threaded back too, so no live rule is silently inert
//     here that is live on real positions.
//   BOTH profiles: a hard 4h max-hold terminal (CONFLUENCE_CAP_MS) —
//     at the cap the position closes at its last mark ('expired').
//     Fees are the bot's own txFeeSol estimate at the live book's
//     convention (buy + one per virtual sell); no chain fees exist for
//     trades that never happened, and none are invented.
//
// Approximations, stamped on every close record rather than hidden:
//   pnlBasis 'viewQuote': marks are DexScreener VIEW prices (the outcome
//   observer's / trading poll's already-fetched views — this module runs
//   no price fetcher of its own), entryRoundTrip = 1, so the stacks judge
//   pure price moves, slightly kinder than the live stack's Jupiter-quote
//   basis. Mark cadence is the observer/poll cadence (~10–30s), not the
//   live 4s position loop; the measured mean gap between a position's own
//   marks rides on its close record (markCadenceSec).
//
// Persistence: confluence_signal.jsonl (one 'fire' record per event —
// features attached — plus one 'close' record per profile per fire) and
// confluence_signal_pending.json (in-flight state, ShadowTrades
// discipline: open/finalize save immediately, tick saves throttled, boot
// restores in-flight positions and finalizes past-cap ones as expired).
// Dedupe across restarts is by walletWatch event id, rebuilt from the
// journal itself. Kill switch: CONFLUENCE_SIGNAL=0 stops new fires and
// darkens the card; positions already open keep being managed to
// completion (their fires are already journaled — leaving them in limbo
// would corrupt the dataset they exist to complete).
import fs from 'node:fs';
import path from 'node:path';
import { evaluateExit } from './exits.js';
import { median, round } from './util.js';

export const CONFLUENCE_CAP_MS = 4 * 60 * 60 * 1000; // hard cap: 4h, then mark-to-last and close
export const CONFLUENCE_READY_N = 50;                  // closes per profile before the card reads READY
const CARD_CACHE_MS = 60000;                           // same cache trade as /staircase
const SAVE_EVERY_MS = 10000;                           // pending-state flush throttle

/** The SCALP profile's per-check judge — the downside/terminal rules are
 *  exits.js's own, verbatim; the scalp itself is judged on exits.js's
 *  net-gain ruler. Pure; returns { fraction, reason } in evaluateExit's
 *  shape. s = position state (entrySol/remainingFrac/entryTs), mark =
 *  { valueSol, liqUsd, buysM5, sellsM5, solUsd }. */
export function scalpExit(s, mark, cfg, now) {
  const basis = s.entrySol * s.remainingFrac;
  const ratio = basis > 0 ? mark.valueSol / basis : 0;
  const heldMin = (now - s.entryTs) / 60000;
  // 1. liquidity death: the pool can no longer absorb what we hold (exits.js §1)
  const valueUsd = mark.valueSol * (mark.solUsd || 150);
  if (mark.liqUsd != null && (mark.liqUsd < 2000 || mark.liqUsd < valueUsd * 2)) return { fraction: 1, reason: `liquidity death ($${Math.round(mark.liqUsd)} liq vs $${Math.round(valueUsd)} position)` };
  // 2. the scalp: 100% out at the first check whose NET gain (exits.js's
  //    ruler: ratio minus the round-trip fee fraction) reaches the line
  const feeFrac = basis > 0 ? (3 * (cfg.txFeeSol || 0)) / basis : 0;
  const gain = ratio - 1 - feeFrac;
  const pct = cfg.confluenceScalpPct > 0 ? cfg.confluenceScalpPct : 0.20;
  if (gain >= pct) return { fraction: 1, reason: `confluence scalp +${Math.round(pct * 100)}% (net gain +${(gain * 100).toFixed(0)}%)` };
  // 3. stall exit (exits.js §5, verbatim): past STALL_EXIT_MIN_AGE_SEC, a
  //    dead tape (buysM5 ≤ 1 AND sellsM5 > 3 × buysM5) stamps the pending;
  //    still dead at pending + STALL_EXIT_CONFIRM_SEC it sells in full; any
  //    live check inside the window cancels. No price input, like the rule
  //    it mirrors. The pending rides the decision for the caller to thread.
  let stallPending = s.stallPending ?? null;
  if (cfg.stallExit > 0) {
    const deadFlow = mark.buysM5 != null && mark.buysM5 <= 1 && mark.sellsM5 > mark.buysM5 * 3;
    const ageOk = heldMin * 60 >= (cfg.stallExitMinAgeSec || 0);
    if (ageOk && deadFlow) {
      if (stallPending == null) stallPending = now;
      if (now - stallPending >= (cfg.stallExitConfirmSec || 0) * 1000) return { fraction: 1, reason: `stall exit (dead flow, ${cfg.stallExitConfirmSec}s confirm)`, stallPending: null };
    } else if (stallPending != null) stallPending = null;
  } else stallPending = null;
  return { fraction: 0, reason: null, stallPending };
}

function profileAgg(closes, opened) {
  const n = closes.length;
  const wins = closes.filter(r => r.pnlSol > 0).length;
  const pcts = closes.map(r => r.pnlPct).filter(Number.isFinite);
  const sols = closes.map(r => r.pnlSol).filter(Number.isFinite);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    opened, open: Math.max(0, opened - n), closed: n,
    wins, winRate: n ? round(wins / n, 3) : null,
    meanPnlPct: pcts.length ? round(mean(pcts), 2) : null,
    medianPnlPct: pcts.length ? round(median(pcts), 2) : null,
    meanPnlSol: sols.length ? round(mean(sols), 6) : null,
    netPnlSol: sols.length ? round(sols.reduce((a, b) => a + b, 0), 6) : 0,
    ready: n >= CONFLUENCE_READY_N,
  };
}

/** Fold the confluence_signal journal (fire + close records) into the
 *  /confluencesignal card. Pure — tested directly. pnlPct on close
 *  records is in PERCENT (the shadow-book convention). */
export function buildConfluenceCard(records, now = Date.now()) {
  const fires = (records || []).filter(r => r && r.type === 'fire' && r.fireId);
  const closes = (records || []).filter(r => r && r.type === 'close' && r.fireId);
  const fireById = new Map(fires.map(f => [f.fireId, f]));
  const noView = fires.filter(f => f.noView).length;
  const opened = fires.length - noView;
  const scalpCloses = closes.filter(r => r.profile === 'scalp');
  const ladderCloses = closes.filter(r => r.profile === 'ladder');
  const scalp = profileAgg(scalpCloses, opened);
  const touches = scalpCloses.filter(r => r.timeToTouchSec != null);
  scalp.touches = touches.length;
  scalp.touchRate = scalpCloses.length ? round(touches.length / scalpCloses.length, 3) : null;
  scalp.medianTimeToTouchSec = touches.length ? round(median(touches.map(r => r.timeToTouchSec)), 1) : null;
  const ladder = profileAgg(ladderCloses, opened);
  ladder.touched20Share = ladderCloses.length ? round(ladderCloses.filter(r => r.touched20).length / ladderCloses.length, 3) : null;
  const recentCloses = [...closes].sort((a, b) => b.exitTs - a.exitTs).slice(0, 8).map(r => {
    const f = fireById.get(r.fireId);
    return { ...r, names: f ? (f.names || null) : null, lagSec: f ? (f.lagSec ?? null) : null, gatePass: f ? (f.gatePass ?? null) : null };
  });
  return {
    generatedTs: now,
    fires: fires.length, noView,
    noViewRate: fires.length ? round(noView / fires.length, 3) : null,
    ready: scalp.ready && ladder.ready, readyN: CONFLUENCE_READY_N,
    profiles: { scalp, ladder },
    recentCloses,
  };
}

/** Fresh exit-stack state for one virtual position (the ShadowTrades
 *  shape, plus the three fields the shadow book drops: killZone,
 *  postTp1PeakMove, deadflowArmed — threaded here so the ladder profile
 *  is the live stack entire). */
function freshState(fire, profile) {
  return {
    key: `${fire.fireId}:${profile}`, fireId: fire.fireId, profile,
    mint: fire.mint, symbol: fire.symbol,
    entryTs: fire.ts, entryPrice: fire.entryPrice, entryMc: fire.mc ?? null,
    entrySol: fire.sizeSol, sizeSol: fire.sizeSol,
    entryRoundTrip: 1, entryVolH1: 0,
    remainingFrac: 1, peakRatio: 1, peakMove: 1,
    tp1Done: false, tp2Done: false, tp1Arm: null,
    stallSince: null, stopArmedTs: null, floorChecks: 0, floorSince: null,
    probationSince: null, moveHist: [], exitPending: {}, stallPending: null, clipPending: null, bagDeadWaves: 0, bagDeadHot: false, flowHist: [],
    killZone: null, postTp1PeakMove: null, deadflowArmed: false,
    pathClass: null, killZoneOverlay: false,
    realizedSol: 0, sells: 0, legs: [],
    lastValueSol: fire.sizeSol, lastTickTs: 0,
    marks: 0, firstMarkTs: null, lastMarkTs: null,
    touch20Ts: null,
  };
}

export class ConfluenceSignal {
  /**
   * deps: { cfg, dir, now, log }
   * The module owns its two files in dir (journal + pending state), the
   * walletWatch/shadowTrades pattern — it does not ride the Journal.
   */
  constructor({ cfg = {}, dir = null, now = () => Date.now(), log = null } = {}) {
    this.cfg = cfg;
    this.dir = dir;
    this.now = now;
    this.log = log;
    this.file = dir ? path.join(dir, 'confluence_signal.jsonl') : null;
    this.pendFile = dir ? path.join(dir, 'confluence_signal_pending.json') : null;
    this.pending = new Map(); // `${fireId}:${profile}` -> exit-stack state
    this.cardCache = null;
    this.cardCacheTs = 0;
    this._dirty = false;
    this._savedAt = 0;
    // Dedupe: one shadow pair per walletWatch event, ever — rebuilt from
    // the journal file itself so a restart can never re-open a fire.
    this.seen = new Set();
    for (const r of this._readJournal()) if (r && r.type === 'fire' && r.fireId) this.seen.add(r.fireId);
    // Restore in-flight virtuals (ShadowTrades discipline): a restart
    // resumes each position where it left off; one already past the cap
    // at boot finalizes as expired on its last mark, never silent limbo.
    try {
      const saved = JSON.parse(fs.readFileSync(this.pendFile, 'utf8'));
      const n = this.now();
      const expired = [];
      for (const s of (saved && saved.positions) || []) {
        if (!s || !s.key || !s.mint || !(s.entryPrice > 0) || !(s.entrySol > 0)) continue;
        if (n - s.entryTs >= CONFLUENCE_CAP_MS) expired.push(s);
        else this.pending.set(s.key, s);
      }
      for (const s of expired) this._finalize(s, 'expired', null, n, this.cfg);
      if (this._dirty) this._save(true);
    } catch { /* no saved state yet */ }
  }

  get enabled() { return !!this.cfg.confluenceSignal; }

  _readJournal() {
    if (!this.file) return [];
    let txt = '';
    try { txt = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out = [];
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn tail line — skip */ }
    }
    return out;
  }

  _append(rec) {
    if (!this.file) return;
    try { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n'); } catch { /* best effort */ }
  }

  /** Emission seam — invoked by Bot for EVERY walletWatch event (Bot's
   *  onEvent chain); only confluence events land. Journals the fire with
   *  its bucket features and, when the detection view carried a price,
   *  opens the SCALP + LADDER pair stamped at detection time. Returns the
   *  fire record, else null. Fail-silent: nothing here may disturb the
   *  detector, let alone a trading path. ctx: { held, signaled } — Bot's
   *  own book at the detection moment. */
  noteEvent(ev, ctx = {}) {
    if (!this.enabled) return null;
    try {
      if (!ev || ev.kind !== 'confluence' || !ev.id || !ev.mint) return null;
      if (this.seen.has(ev.id)) return null;
      this.seen.add(ev.id);
      const detectTs = ev.ts || this.now();
      const price = ev.viewPrice > 0 ? ev.viewPrice : null;
      const fire = {
        type: 'fire', fireId: ev.id, ts: detectTs, mint: ev.mint, symbol: ev.symbol || null,
        windowCloseTs: ev.entryTs || null,
        lagSec: ev.entryTs ? Math.max(0, Math.round((detectTs - ev.entryTs) / 100) / 10) : null,
        clusters: ev.clusters || [], entities: ev.entities || [], names: ev.names || [],
        walletCount: ev.walletCount ?? null, maxSol: ev.maxSol ?? null,
        mc: ev.mc ?? null, coinAgeMin: ev.coinAgeMin ?? null, pool: ev.pool || null,
        gates: ev.gates ?? null, gatePass: ev.gatePass ?? null, firstBlocker: ev.firstBlocker ?? null,
        held: !!ctx.held, signaled: !!ctx.signaled,
        entryPrice: price, sizeSol: price ? (this.cfg.tradeSol || 0.05) : null,
        noView: !price,
      };
      this._append(fire);
      this.cardCache = null;
      if (price) {
        for (const profile of ['scalp', 'ladder']) {
          const s = freshState(fire, profile);
          this.pending.set(s.key, s);
        }
        this._save(true);
        if (this.log) this.log(`[confluence-signal] ${fire.symbol || fire.mint}: shadow pair opened at detection (lag ${fire.lagSec ?? '?'}s, mc ${fire.mc != null ? '$' + Math.round(fire.mc) : 'n/a'}) — SCALP +${Math.round((this.cfg.confluenceScalpPct || 0.2) * 100)}% / LADDER, record only`);
      } else if (this.log) {
        this.log(`[confluence-signal] ${fire.symbol || ev.mint}: fire journaled as noView (no detection view) — no shadow positions`);
      }
      return fire;
    } catch { return null; }
  }

  /** Mints with a virtual in flight, oldest entry first — Bot.outcomeTick
   *  merges these into its fetch set so marks never depend on watchlist
   *  residence (the trade-grade shadow's guarantee, mirrored). */
  pendingMints() {
    const byMint = new Map();
    for (const s of this.pending.values()) {
      const cur = byMint.get(s.mint);
      if (!cur || s.entryTs < cur.since) byMint.set(s.mint, { mint: s.mint, since: s.entryTs });
    }
    return [...byMint.values()].sort((a, b) => a.since - b.since);
  }

  /** Called with a sync view lookup (mint -> view | null) from the trading
   *  poll and from the outcome observer — the same views everything else in
   *  the bot reads, never a fetch of this tracker's own. */
  tick(viewOf, nowTs, cfg, solUsd = null) {
    try {
      let mustSave = false;
      for (const s of [...this.pending.values()]) {
        if (nowTs - s.entryTs >= CONFLUENCE_CAP_MS) { this._finalize(s, 'expired', null, nowTs, cfg); mustSave = true; continue; }
        if (nowTs <= (s.lastTickTs || 0)) continue; // same-cycle double tick (poll + observer share a timestamp)
        let v = null;
        try { v = viewOf(s.mint); } catch { /* ignore */ }
        if (!v || !(v.price > 0)) continue;
        s.lastTickTs = nowTs;
        const valueSol = s.entrySol * s.remainingFrac * (v.price / s.entryPrice);
        s.lastValueSol = valueSol;
        s.marks++;
        if (s.firstMarkTs == null) s.firstMarkTs = nowTs;
        s.lastMarkTs = nowTs;
        // the virtual position's own flow history, same shape managePosition keeps
        s.flowHist = s.flowHist || [];
        s.flowHist.push({ ts: nowTs, buys: v.buysM5 ?? null, sells: v.sellsM5 ?? null, tx: (v.buysM5 != null || v.sellsM5 != null) ? (v.buysM5 || 0) + (v.sellsM5 || 0) : null });
        if (s.flowHist.length > 45) s.flowHist.splice(0, s.flowHist.length - 45);
        const mark = { valueSol, liqUsd: v.liq != null ? v.liq : null, buysM5: v.buysM5 != null ? v.buysM5 : null, sellsM5: v.sellsM5 || 0, solUsd, volH1: v.volH1 || 0 };
        // running peak + first +20% ratio touch, both profiles (record-only
        // bookkeeping; the ladder's judge recomputes its own peak internally)
        const basis = s.entrySol * s.remainingFrac;
        const ratio = basis > 0 ? valueSol / basis : 0;
        if (ratio > (s.peakRatio || 1)) s.peakRatio = ratio;
        if (s.touch20Ts == null && ratio >= 1.2) s.touch20Ts = nowTs;
        let d = null;
        if (s.profile === 'scalp') {
          d = scalpExit(s, mark, cfg, nowTs);
          if ('stallPending' in d) s.stallPending = d.stallPending;
          if ('clipPending' in d) s.clipPending = d.clipPending;
        } else {
          d = evaluateExit(s, mark, cfg, nowTs);
          // thread the decision's state outputs back exactly like
          // managePosition does — plus the three fields the shadow book
          // drops (killZone / postTp1PeakMove / deadflowArmed) and the
          // TP1 lane stamp, so the ladder here is the live stack entire
          if (d.newPeak) s.peakRatio = d.newPeak;
          if (d.newPeakMove != null) s.peakMove = d.newPeakMove;
          if ('stallSince' in d) s.stallSince = d.stallSince;
          if ('stopArmedTs' in d) s.stopArmedTs = d.stopArmedTs;
          if ('floorChecks' in d) s.floorChecks = d.floorChecks;
          if ('floorSince' in d) s.floorSince = d.floorSince;
          if ('probationSince' in d) s.probationSince = d.probationSince;
          if ('moveHist' in d) s.moveHist = d.moveHist;
          if ('exitPending' in d) s.exitPending = d.exitPending;
          if ('tp1Arm' in d) s.tp1Arm = d.tp1Arm;
          if ('tp1FireGain' in d) s.tp1FireGain = d.tp1FireGain;
          if ('tp1GuardTrimmed' in d) s.tp1GuardTrimmed = d.tp1GuardTrimmed;
          if ('killZone' in d) s.killZone = d.killZone;
          if ('postTp1PeakMove' in d) s.postTp1PeakMove = d.postTp1PeakMove;
          if ('deadflowArmed' in d) s.deadflowArmed = d.deadflowArmed;
          if ('bagDeadWaves' in d) s.bagDeadWaves = d.bagDeadWaves;
          if ('bagDeadHot' in d) s.bagDeadHot = d.bagDeadHot;
          if ('stallPending' in d) s.stallPending = d.stallPending;
          if ('clipPending' in d) s.clipPending = d.clipPending;
          if (d.pathClass) { s.pathClass = d.pathClass; s.killZoneOverlay = !!d.killZoneOverlay; }
        }
        this._dirty = true;
        if (!d || !(d.fraction > 0)) continue;
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
    this.pending.delete(s.key);
    const proceeds = s.realizedSol + (status === 'expired' ? (s.lastValueSol || 0) : 0);
    const txFee = cfg && cfg.txFeeSol > 0 ? cfg.txFeeSol : (this.cfg.txFeeSol || 0);
    const fees = txFee * (1 + s.sells); // buy + one per virtual sell, the live book's convention
    const pnlSol = +(proceeds - s.sizeSol - fees).toFixed(6);
    const cadence = s.marks >= 2 && s.lastMarkTs > s.firstMarkTs
      ? Math.round((s.lastMarkTs - s.firstMarkTs) / (s.marks - 1) / 1000)
      : (s.marks === 1 && s.firstMarkTs > s.entryTs ? Math.round((s.firstMarkTs - s.entryTs) / 1000) : null);
    const rec = {
      type: 'close', fireId: s.fireId, profile: s.profile, mint: s.mint, symbol: s.symbol,
      entryTs: s.entryTs, exitTs: nowTs,
      heldMin: +((nowTs - s.entryTs) / 60000).toFixed(1),
      entryPrice: s.entryPrice, entryMc: s.entryMc ?? null,
      sizeSol: s.sizeSol,
      exitReason: reason, legs: s.legs,
      peakRatio: +(s.peakRatio || 1).toFixed(4),
      touched20: s.touch20Ts != null,
      touch20Sec: s.touch20Ts != null ? Math.round((s.touch20Ts - s.entryTs) / 1000) : null,
      timeToTouchSec: (s.profile === 'scalp' && status === 'exited' && reason && reason.includes('confluence scalp'))
        ? Math.round((nowTs - s.entryTs) / 1000) : null,
      proceedsSol: +proceeds.toFixed(6), feesSol: +fees.toFixed(6),
      pnlSol, pnlPct: s.sizeSol > 0 ? +(pnlSol / s.sizeSol * 100).toFixed(2) : null,
      pnlBasis: 'viewQuote', entryRoundTrip: s.entryRoundTrip,
      markCadenceSec: cadence, marks: s.marks,
      status,
    };
    this._append(rec);
    this.cardCache = null;
    this._dirty = true;
    this._save(true);
    if (this.log) this.log(`[confluence-signal] ${s.profile.toUpperCase()} closed ${s.symbol || s.mint}: ${status === 'expired' ? 'expired (4h cap)' : reason} — pnl ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${rec.pnlPct}%)`);
    return rec;
  }

  /** Persist in-flight state (whole-map rewrite; the pending set is
   *  small). Open/finalize save immediately; tick-driven state saves are
   *  throttled. Best-effort — a failed write must never disturb the bot. */
  _save(force) {
    if (!this._dirty && !force) return;
    const n = this.now();
    if (!force && n - this._savedAt < SAVE_EVERY_MS) return;
    try {
      fs.writeFileSync(this.pendFile, JSON.stringify({ positions: [...this.pending.values()] }));
      this._dirty = false; this._savedAt = n;
    } catch { /* disk full etc. — never crash the bot */ }
  }

  /** GET /confluencesignal payload: the journal folded at read time
   *  (fires + closes), per-profile aggregates, ~60s cache — the
   *  /staircase trade. */
  card() {
    if (!this.enabled) return { enabled: false };
    const n = this.now();
    if (this.cardCache && n - this.cardCacheTs < CARD_CACHE_MS) return this.cardCache;
    const card = {
      enabled: true,
      ...buildConfluenceCard(this._readJournal(), n),
      rules: {
        stakeSol: this.cfg.tradeSol || 0.05,
        scalpPct: this.cfg.confluenceScalpPct > 0 ? this.cfg.confluenceScalpPct : 0.20,
        capH: CONFLUENCE_CAP_MS / 3600000,
        pnlBasis: 'viewQuote',
      },
    };
    this.cardCache = card;
    this.cardCacheTs = n;
    return card;
  }
}
