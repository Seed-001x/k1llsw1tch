import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

// EXIT-STACK STRIP (user order 2026-10-15) + V2 (user order 2026-10-15 ~20:26
// EDT): the stop family, stall/probation, bleed, generic trail, profit lock,
// the two-path branching, Tratchet, volume decay, the time stop and the max
// hold are disabled IN CODE (src/exits.js STRIP) — the blocks below pin that
// they cannot fire under their former trigger conditions, with their knobs at
// live values. Dead flow survives ONLY as a post-TP2 exit (deadflow.test.mjs).
// What remains live: the TP ladder, the post-TP1 middle trail, TP2 rejection,
// the stall exit and liquidity death. The ENTRY CLIP (owner order 2026-10-18,
// exits.js 5a) is live too, but this file pins the STRIPPED rules, so the
// shared cfg switches it off (entryClip: 0) — its own behavior is pinned in
// entryclip.test.mjs; with it on, every deep-red print below would sell as a
// clip instead of holding, which is the clip working, not a stripped rule
// firing. The TP1 GUARD (owner order 2026-10-22, exits.js 3d-guard) is
// pinned off the same way (tp1Guard: 0): it owns the middle-stage give-back
// since 2026-10-22, and this suite isolates the stripped rules — its own
// behavior is pinned in tp1guard.test.mjs.
const cfg = testCfg({ stallProbationSec: 0, bagTrailConfirmSec: 0, entryClip: 0, tp1Guard: 0 }); const NOW = 1_000_000_000_000; // trail timer off here: this file pins the trail's line, the timer itself is pinned in bagtrailconfirm.test.mjs
const pos = (o = {}) => ({ entrySol: 0.02, remainingFrac: 1, peakRatio: 1, tp1Done: false, entryTs: NOW - 5 * 60000, ...o });
const mark = (valueSol, o = {}) => ({ valueSol, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, ...o });

test('holds in the quiet middle', () => assert.equal(evaluateExit(pos({ entryTs: NOW - 30000 }), mark(0.021), cfg, NOW).fraction, 0));
test('strip: hard floor cannot fire — the old two-check confirmed stop-loss print now holds twice', () => { const c = { ...cfg, dipStopPct: 0 }; const d1 = evaluateExit(pos(), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW); assert.equal(d1.fraction, 0); assert.equal(d1.floorChecks, 0); const d = evaluateExit(pos({ floorChecks: d1.floorChecks }), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW); assert.equal(d.fraction, 0); assert.equal(d.reason, null); });
test('liquidity death beats everything', () => {
  const d = evaluateExit(pos(), mark(0.05, { liqUsd: 1500 }), cfg, NOW); assert.match(d.reason, /liquidity death/);
  assert.match(evaluateExit(pos(), mark(20, { liqUsd: 5000 }), cfg, NOW).reason, /liquidity death/); // $3000 position, pool < 2x position
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30000 }), mark(0.021, { liqUsd: 5000 }), cfg, NOW).fraction, 0);   // small position in the same pool is fine
});

// ---- dip stop (STRIPPED): the former trigger prints now hold ----
const S = 1000;
test('strip: dip stop cannot fire — -45% and -5.5% prints both hold', () => {
  assert.equal(evaluateExit(pos(), mark(0.011), cfg, NOW).fraction, 0);
  assert.equal(evaluateExit(pos(), mark(0.0189), cfg, NOW).fraction, 0);                 // -5.5%: the old instant fire
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0192), cfg, NOW).fraction, 0);      // -4%, holds as before
});
test('strip: dip stop cannot fire on the round-trip-adjusted print either', () => {
  // round-trip 0.90: a flat coin reads 0.018 on 0.02 spent — that is NOT a 10% dip
  const p = pos({ entryRoundTrip: 0.9, entryTs: NOW - 30 * S });
  assert.equal(evaluateExit(p, mark(0.018), cfg, NOW).fraction, 0);
  assert.equal(evaluateExit(p, mark(0.0170), cfg, NOW).fraction, 0);                   // price -5.6%: the old fire print
});
// ---- entry stall (STRIPPED): the deadline sell can never fire — in-band prints
//      at/past the deadline simply hold; a faded spike holds too (v2 stripped Tratchet) ----
const stallCfg = { ...cfg, stallSec: 60, stallBandPct: 0.05, dipStopPct: 0 };
test('strip: entry stall cannot fire — inside the range at/past the deadline holds, no probation state', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 59 * S }), mark(0.0201), stallCfg, NOW).fraction, 0);
  const d = evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0201), stallCfg, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null); assert.equal(d.probationSince, null);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 90 * S }), mark(0.0196), stallCfg, NOW).fraction, 0); // under entry but inside the old range: holds too
});
test('strip v2: the faded-spike print neither the stall nor Tratchet owns anymore — it holds', () => {
  const faded = pos({ entryTs: NOW - 300 * S, peakMove: 1.30 });  // spiked +30% in its first minute, faded back to +1%
  const d = evaluateExit(faded, mark(0.0202), stallCfg, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);   // the ratchet's former print (armed at the +30% peak, faded to its trigger) — v2 stripped the ratchet too, so nothing sells it here
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, peakMove: 1.12, peakRatio: 1.12 }), mark(0.0216), stallCfg, NOW).fraction, 0); // +8% at the check: holds as before
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S }), mark(0.0184), stallCfg, NOW).fraction, 0);                  // -8% with no tracked peak: nothing owns it now — it rides
  // post-TP1: in the old stall range at the deadline, the middle trail is the judge — inside its line it holds
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, tp1Done: true, remainingFrac: 0.35, peakRatio: 1.4 }), mark(0.0074), { ...stallCfg, lockKeep: 0 }, NOW).fraction, 0);
});
// ---- the old asymmetric band (−5% / +3%, UNTXED) is inert too: every former stall print holds ----
const stallUpCfg = { ...cfg, stallSec: 60, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
test('strip: every former asymmetric-band stall print holds', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.02044), stallUpCfg, NOW).fraction, 0);   // move 1.022 — the UNTXED print that used to sell
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0208), stallUpCfg, NOW).fraction, 0); // move 1.04
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0208), { ...stallUpCfg, stallBandUpPct: 0.05 }, NOW).fraction, 0);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0192), stallUpCfg, NOW).fraction, 0); // move 0.96: inside the old downside band
  assert.equal(evaluateExit(pos({ entryTs: NOW - 60 * S }), mark(0.0188), stallUpCfg, NOW).fraction, 0);    // move 0.94
});

// ---- probation leash (STRIPPED): the whole probation system — deadline entry,
//      −7% leash, breakout clearing, 300s expiry — can never fire or accrue state.
//      Live-shaped cfg kept: stallSec 180, probation 300, leash 0.07, band −5% / +3%. ----
const probCfg = { ...cfg, stallSec: 180, stallProbationSec: 300, stallLeashPct: 0.07, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
test('strip: at the stall deadline inside the band the position holds and NEVER enters probation', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 180 * S }), mark(0.0201), probCfg, NOW);   // move 1.005
  assert.equal(d.fraction, 0); assert.equal(d.probationSince, null);
});
test('strip: before the deadline inside the band — no exit, no probation (unchanged)', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 120 * S }), mark(0.0201), probCfg, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.probationSince, null);
});
test('strip: the probation leash cannot fire — a legacy on-probation dive past −7% holds', () => {
  const p = { entryTs: NOW - 200 * S, probationSince: NOW - 20 * S };
  const d = evaluateExit(pos(p), mark(0.0185), probCfg, NOW);                            // move 0.925 — the old instant leash fire
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
  const d2 = evaluateExit(pos(p), mark(0.0188), probCfg, NOW);                           // move 0.94
  assert.equal(d2.fraction, 0); assert.equal(d2.probationSince, NOW - 20 * S);           // stored state passes through inertly, never judged
});
test('strip: probation expiry cannot fire — still in the band at 300s from entry holds', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 300 * S, probationSince: NOW - 120 * S }), mark(0.0201), probCfg, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
});
test('strip: no breakout clearing either — the stored probation stamp is inert either way', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 240 * S, probationSince: NOW - 60 * S }), mark(0.0208), probCfg, NOW); // move 1.04
  assert.equal(d.fraction, 0); assert.equal(d.probationSince, NOW - 60 * S);
});
test('strip: late band entry starts nothing — no probation at 240s, no expiry at 300s', () => {
  const d1 = evaluateExit(pos({ entryTs: NOW - 240 * S }), mark(0.0201), probCfg, NOW);
  assert.equal(d1.fraction, 0); assert.equal(d1.probationSince, null);
  const d2 = evaluateExit(pos({ entryTs: NOW - 300 * S, probationSince: NOW }), mark(0.0201), probCfg, NOW);
  assert.equal(d2.fraction, 0); assert.equal(d2.reason, null);
});
test('strip: with STALL_PROBATION_SEC=0 the deadline is equally silent (no legacy stall sell)', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 180 * S }), mark(0.0201), { ...probCfg, stallProbationSec: 0 }, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
});

// ---- grace stop + hard floor (STRIPPED): arm -10%, 5s grace, floor -20% — none of
//      it can arm, count, confirm or fire anymore, at any knob combination ----
const stopCfg = { ...cfg, stopLoss: 0.10, stopHardPct: 0.20, stopGraceSec: 5, stopFlowVeto: 1, dipStopPct: 0 };
test('strip: breaching the grace-stop arm line arms nothing and sells nothing', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0178), stopCfg, NOW);   // ratio 0.89
  assert.equal(d.fraction, 0); assert.equal(d.stopArmedTs, null);
});
test('strip: a stale arming plus elapsed grace plus dead flow still cannot sell', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S, stopArmedTs: NOW - 5 * S }), mark(0.0178, { buysM5: 1, sellsM5: 9 }), stopCfg, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
  const d2 = evaluateExit(pos({ entryTs: NOW - 30 * S, stopArmedTs: NOW - 6 * S }), mark(0.0178, { buysM5: 20, sellsM5: 25 }), stopCfg, NOW);
  assert.equal(d2.fraction, 0);
});
test('strip: recovery above the arm line still clears a stale arming (state hygiene kept)', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S, stopArmedTs: NOW - 3 * S }), mark(0.0192), stopCfg, NOW); // ratio 0.96
  assert.equal(d.fraction, 0); assert.equal(d.stopArmedTs, null);
});
test('strip: hard floor counts no checks — two consecutive breach prints both hold', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0158, { buysM5: 40, sellsM5: 2 }), stopCfg, NOW); // ratio 0.79
  assert.equal(d.fraction, 0); assert.equal(d.floorChecks, 0);
  const d2 = evaluateExit(pos({ entryTs: NOW - 34 * S, floorChecks: d.floorChecks }), mark(0.0156, { buysM5: 40, sellsM5: 2 }), stopCfg, NOW);
  assert.equal(d2.fraction, 0); assert.equal(d2.reason, null);
});
test('strip: hard floor with STOP_HARD_CONFIRM_CHECKS=1 (the old instant mode) still cannot fire', () => {
  const instant = { ...stopCfg, stopHardConfirmChecks: 1 };
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S }), mark(0.0158), instant, NOW);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
});
test('strip: hard floor with a 3s persistence requirement — no clock ever starts, no sell at any point', () => {
  const timed = { ...stopCfg, stopHardConfirmChecks: 1, stopHardConfirmSec: 3 };
  const t0 = NOW;
  const d = evaluateExit(pos({ entryTs: t0 - 30 * S }), mark(0.0158), timed, t0);
  assert.equal(d.fraction, 0); assert.equal(d.floorSince, null); assert.equal(d.floorChecks, 0);
  const d2 = evaluateExit(pos({ entryTs: t0 - 30 * S, floorChecks: d.floorChecks, floorSince: d.floorSince }), mark(0.0156), timed, t0 + 2 * S);
  assert.equal(d2.fraction, 0);
  const d3 = evaluateExit(pos({ entryTs: t0 - 30 * S, floorChecks: d2.floorChecks, floorSince: d2.floorSince }), mark(0.0156), timed, t0 + 3.5 * S);
  assert.equal(d3.fraction, 0); assert.equal(d3.reason, null);
});
test('strip: stall + dip stop are off even with their knobs fully ON (the strip is code, not config)', () => {
  const on = { ...cfg, stallSec: 60, dipStopPct: 0.05 };
  assert.equal(evaluateExit(pos({ entryTs: NOW - 600 * S, peakMove: 1 }), mark(0.0201), on, NOW).fraction, 0);
  assert.equal(evaluateExit(pos(), mark(0.0189), on, NOW).fraction, 0);
});

// ---- take profit on the jump + profit lock ----
test('TP1: price +25% banks 65% (adaptive ceiling pinned at the arm = instant bank)', () => {
  const fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0264), fixed, NOW);   // +32% minus ~1.6% fees (0.02 SOL test size)
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true);
  assert.equal(evaluateExit(pos({ stallSince: NOW }), mark(0.0240), fixed, NOW).fraction, 0);       // +20%: not yet
});
test('TP1 judged on what you pocket: chart +31% with 10% round-trip cost is not +25% profit', () => {
  const fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };
  const p = pos({ entryRoundTrip: 0.9, stallSince: NOW });   // flat = 0.018 value
  assert.equal(evaluateExit(p, mark(0.0236), fixed, NOW).fraction, 0);    // price +31% but only +18% realizable
  assert.equal(evaluateExit(p, mark(0.0264), fixed, NOW).fraction, 0.65);  // +32% realizable minus fees ≥ +25%
});
test('strip: post-TP1 trail cannot fire — 25% below peak or back to entry now HOLDS (removed 2026-10-16)', () => {
  const noTp2 = { ...cfg, tp2Pct: 99, tp2RejectZone: 0 };   // isolate the middle stage: TP2 + rejection off
  const p = pos({ tp1Done: true, remainingFrac: 0.35, peakRatio: 1.6, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.02 * 0.35 * 1.2), noTp2, NOW).fraction, 0);  // 1.2x = 25% off 1.6x peak: the old trail print — holds
  assert.equal(evaluateExit(p, mark(0.02 * 0.35 * 1.0), noTp2, NOW).fraction, 0);  // back to entry: the old floor print — holds
  const big = pos({ tp1Done: true, remainingFrac: 0.35, peakRatio: 3, stallSince: NOW });
  assert.equal(evaluateExit(big, mark(0.02 * 0.35 * 2.4), noTp2, NOW).fraction, 0);  // 2.4x vs 3x peak: holds
  assert.equal(evaluateExit(big, mark(0.02 * 0.35 * 2.1), noTp2, NOW).fraction, 0);  // 2.1x ≤ the old 2.25x trail line: holds
});
test('TP2 rejection: peaked in the zone, 10% off the peak without converting sells the rest', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.85, stallSince: NOW });   // wizardcat shape: peak +85%
  const d = evaluateExit(p, mark(0.02 * 0.6 * 1.6465), cfg, NOW);                            // 11% off the peak
  assert.equal(d.fraction, 1); assert.match(d.reason, /TP2 rejection/);
  assert.equal(evaluateExit(p, mark(0.02 * 0.6 * 1.7205), cfg, NOW).fraction, 0);            // only 7% off: still riding
});
test('TP2 rejection: a peak below the zone is just a pullback — it holds (no trail remains under it)', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.6, stallSince: NOW });      // peak +60% < +80% zone
  assert.equal(evaluateExit(p, mark(0.02 * 0.6 * 1.36), cfg, NOW).fraction, 0);              // 15% off peak: holds
});
test('TP2 rejection: zone 0 disables the rule', () => {
  const off = { ...cfg, tp2RejectZone: 0 };
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 1.85, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.02 * 0.6 * 1.6465), off, NOW).fraction, 0);
});
test('fees: SOL tx fees are taken out before calling it a take-profit', () => {
  const pricey = { ...cfg, txFeeSol: 0.0005, tp1AdaptMax: cfg.tp1Pct };  // 3 tx × 0.0005 = 0.0015 on 0.02 basis = 7.5%
  assert.equal(evaluateExit(pos({ stallSince: NOW }), mark(0.0262), pricey, NOW).fraction, 0);   // +31% - 7.5% < 25%
  assert.equal(evaluateExit(pos({ stallSince: NOW }), mark(0.0277), pricey, NOW).fraction, 0.65); // +38.5% - 7.5% ≥ 25%
});
test('strip: profit lock cannot fire — giving back half of the best gain now holds', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.5, peakRatio: 1.4, stallSince: null });  // peak +40%
  assert.equal(evaluateExit(p, mark(0.0125), cfg, NOW).fraction, 0);                         // +25%: holds
  const d = evaluateExit(p, mark(0.0119), cfg, NOW);                                         // +19%: the old lock fire print
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
});
test('strip: generic trailing stop + profit lock cannot fire — the fade print they both claimed now holds', () => {
  // TP1 isolated off (tp1Frac 0): peak 2.2x (past the 1 + trailArm line), faded to 1.6x =
  // 27% off peak (past the 25% trail) with the current gain under half the peak gain —
  // the generic trail's and the lock's exact shared print. Both are stripped: it holds.
  const p = pos({ peakRatio: 2.2, peakMove: 2.2, entryTs: NOW - 30 * S });
  const d = evaluateExit(p, mark(0.032), { ...cfg, tp1Frac: 0 }, NOW);                       // ratio 1.6, move 1.6 (above the ratchet trigger)
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
});
test('a big runner keeps running — deep give-backs hold now that the post-TP1 trail is gone', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.5, peakRatio: 3, stallSince: null });      // peak +200%
  assert.equal(evaluateExit(p, mark(0.0240), { ...cfg, trailPct: 0.9, tp2Pct: 99, tp2RejectZone: 0 }, NOW).fraction, 0);   // 2.4x: holds
  assert.equal(evaluateExit(p, mark(0.0195), { ...cfg, trailPct: 0.9, tp2Pct: 99, tp2RejectZone: 0 }, NOW).fraction, 0);   // 1.95x ≤ the old 2.25x trail line: holds
});

// ---- TP ladder (user 2026-10-13): adaptive TP1, TP2 at +100%, moonbag ----
test('adaptive TP1: strong run rides past the arm without banking', () => {
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0264), cfg, NOW);   // +30% net, fresh peak, flow 30b/10s
  assert.equal(d.fraction, 0); assert.ok(d.tp1Arm);                            // armed, not fired
});
test('adaptive TP1: ceiling banks the slice', () => {
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0330), cfg, NOW);   // +63% net ≥ +60% ceiling
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true); assert.match(d.reason, /ceiling/);
});
test('adaptive TP1: rollover from the peak banks it', () => {
  const p = pos({ tp1Arm: { ts: NOW - 8000, share: 0.6 }, peakRatio: 1.5, stallSince: NOW });
  const d = evaluateExit(p, mark(0.0272), cfg, NOW);                          // ratio 1.36: ~14 gain pts off the peak
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true); assert.match(d.reason, /rollover/);
});
test('adaptive TP1: weak flow at the arm banks immediately at the arm level', () => {
  const d = evaluateExit(pos({ stallSince: NOW }), mark(0.0264, { buysM5: 5, sellsM5: 30 }), cfg, NOW);  // share 0.14
  assert.equal(d.fraction, 0.65); assert.equal(d.tp1, true); assert.match(d.reason, /strength faded/);
});
test('TP2: at +100% net it sells tp2Frac of the ORIGINAL position', () => {
  const p = pos({ tp1Done: true, remainingFrac: 0.6, peakRatio: 2.2, stallSince: NOW });
  const d = evaluateExit(p, mark(0.02 * 0.6 * 2.1), cfg, NOW);                // ratio 2.1 on the remaining basis
  assert.equal(d.tp2, true); assert.ok(Math.abs(d.fraction - 0.35 / 0.6) < 1e-9);
});
test('moonbag: post-TP2 remainder rides a 15% trail under its recorded peak, immune to lock and the generic trailing stop', () => {
  const cfgBig = { ...cfg, bagSmallHold: 0 }; // the trail lives in the closeted big-bag mode since 2026-10-17 ~04:38; small-bag inertness is pinned in smallbag.test.mjs
  const p = pos({ tp1Done: true, tp2Done: true, remainingFrac: 0.25, peakRatio: 2.8, stallSince: NOW });
  assert.equal(evaluateExit(p, mark(0.02 * 0.25 * 2.42), cfgBig, NOW).fraction, 0);   // 2.42x: 13.6% off peak — bag holds
  const d = evaluateExit(p, mark(0.02 * 0.25 * 2.35), cfgBig, NOW);                    // 2.35x: 16.1% off peak — past the -15% line
  assert.equal(d.fraction, 1); assert.match(d.reason, /moonbag trail/);
});

// ---- late closers (STRIPPED in v2): volume decay (5b), the time stop (6) and
//      the absolute max hold (7) can never fire — a position that outlives
//      every old clock simply rides until the ladder, a trail or the dead
//      check (5, still live — pinned at the bottom of this block) closes it.
//      The shapes below are the former trigger prints verbatim (the takeover
//      suite used two of them as live controls until v2). ----
test('strip v2: time stop cannot fire — 30 min in, under the +10% gain line, holds (pre- and post-TP1 shapes)', () => {
  const post = evaluateExit(pos({ entryTs: NOW - 30 * 60000, tp1Done: true, remainingFrac: 0.6, peakRatio: 1.05 }), mark(0.0126), cfg, NOW); // ratio 1.05 on the remainder — the old fire print
  assert.equal(post.fraction, 0); assert.equal(post.reason, null);
  const pre = evaluateExit(pos({ entryTs: NOW - 30 * 60000 }), mark(0.021), cfg, NOW);   // ratio 1.05, never TP1'd
  assert.equal(pre.fraction, 0); assert.equal(pre.reason, null);
  const late = evaluateExit(pos({ entryTs: NOW - 90 * 60000 }), mark(0.0204), cfg, NOW); // 90 min in at +2%: still not the clock's
  assert.equal(late.fraction, 0);
});
test('strip v2: max hold cannot fire — past the 120m absolute line the position still rides', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 130 * 60000, tp1Done: true, remainingFrac: 0.6, peakRatio: 1.5 }), mark(0.018), cfg, NOW); // ratio 1.5, 130 min old — the old fire print
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
  const older = evaluateExit(pos({ entryTs: NOW - 600 * 60000, tp1Done: true, remainingFrac: 0.6, peakRatio: 1.5 }), mark(0.018), cfg, NOW); // 10 hours in: no clock owns it
  assert.equal(older.fraction, 0); assert.equal(older.reason, null);
});
test('strip v2: volume decay cannot fire — volume at 20% of entry, price flat, past the 5m mark holds', () => {
  const p = pos({ entryTs: NOW - 6 * 60000, entryVolH1: 100_000 });
  const d = evaluateExit(p, mark(0.0205, { volH1: 20_000 }), cfg, NOW);   // volRatio 0.20 < 0.30, ratio 1.025 < 1.05 — the old fire print
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
  const older = evaluateExit(pos({ entryTs: NOW - 60 * 60000, entryVolH1: 100_000 }), mark(0.0196, { volH1: 5_000 }), cfg, NOW); // an hour in, volume at 5%: still holds
  assert.equal(older.fraction, 0);
});
test('stall exit (the undertaker successor, user order 2026-10-16 19:24 EDT) — 15 min in, dead flow: the first check only stamps the pending; still dead 60s later it sells', () => {
  // The old momentum-failure undertaker sold this print INSTANTLY (10 min in,
  // underwater, no buyers). Its successor keeps the conjunction and the sole-
  // undertaker seat, but: no price input (underwater is not a condition), the
  // age gate is 3 minutes, and a 60s confirm stands between stamp and sell.
  const p = pos({ entryTs: NOW - 15 * 60000 });
  const d1 = evaluateExit(p, mark(0.019, { buysM5: 0, sellsM5: 10 }), cfg, NOW);
  assert.equal(d1.fraction, 0);
  assert.equal(d1.stallPending, NOW);
  p.stallPending = d1.stallPending;
  const d2 = evaluateExit(p, mark(0.019, { buysM5: 0, sellsM5: 10 }), cfg, NOW + 60 * S);
  assert.equal(d2.fraction, 1);
  assert.equal(d2.reason, 'stall exit (dead flow, 60s confirm)');
  // and live two-way flow at the same age/price holds, pending or not
  assert.equal(evaluateExit(pos({ entryTs: NOW - 15 * 60000 }), mark(0.019, { buysM5: 30, sellsM5: 10 }), cfg, NOW).fraction, 0);
});

// ---- break-even ratchet (STRIPPED in v2 — the classic Tratchet, +15% arm /
//      +5% fire at live knob values): its former trigger prints — a pre-TP1
//      position whose peak realizable move reached the arm line, fallen back
//      to the trigger — now simply hold, at any BE_ARM/BE_TRIGGER value.
//      beCfg keeps the old isolation: dip stop off, probation off (shared cfg),
//      young ages keep the momentum/time sections out of the way. ----
const beCfg = { ...cfg, dipStopPct: 0 };
test('strip v2: Tratchet cannot fire — peaked +12.4%, back at the +2% trigger holds', () => {
  // round-trip 0.95: the +1.8% is a MOVE print (ratio 0.9671 under water on raw value) —
  // the ratchet's exact founding shape (the DOG shape: peaked +22%, dead inside a minute).
  const p = pos({ entryTs: NOW - 30 * S, entryRoundTrip: 0.95, peakRatio: 1.068, peakMove: 1.124 });
  const d = evaluateExit(p, mark(0.019342), beCfg, NOW);   // move = 0.9671 / 0.95 = 1.018
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
});
test('strip v2: Tratchet cannot fire at its exact lines — +5% peak, back at exactly +2% holds', () => {
  const d = evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.05 }), mark(0.0204), beCfg, NOW); // move 1.02
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
});
test('break-even ratchet: peak only +4% never arms — +2% and below still hold, other exits keep it', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.04 });
  assert.equal(evaluateExit(p, mark(0.0204), beCfg, NOW).fraction, 0);  // back at +2%: no arm, no fire
  assert.equal(evaluateExit(p, mark(0.0194), beCfg, NOW).fraction, 0);  // through break-even to -3%: still not the ratchet's
});
test('break-even ratchet: armed, dips only to +3% — no fire', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12 }), mark(0.0206), beCfg, NOW).fraction, 0); // move 1.03
});
test('break-even ratchet: armed and still rising — untouched', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12 }), mark(0.024), beCfg, NOW).fraction, 0); // move 1.20, under the TP1 arm
});
test('break-even ratchet: TP1 done — never fires even at +2%, the ladder owns the remainder', () => {
  const p = pos({ entryTs: NOW - 30 * S, tp1Done: true, remainingFrac: 0.6, peakRatio: 1.30, peakMove: 1.30 });
  const d = evaluateExit(p, mark(0.02 * 0.6 * 1.02), { ...beCfg, lockKeep: 0 }, NOW); // ratio 1.02 on the remaining basis
  assert.equal(d.fraction, 0);
});
test('break-even ratchet: BE_ARM_PCT=0 disables it entirely', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.124 });
  assert.equal(evaluateExit(p, mark(0.02036), { ...beCfg, beArmPct: 0 }, NOW).fraction, 0); // move 1.018, would fire if on
});
test('strip v2: with probation AND Tratchet gone, the deadline-check fade and the deep dive both hold', () => {
  const probBeCfg = { ...cfg, stallSec: 180, stallProbationSec: 300, stallLeashPct: 0.07, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
  // deadline check, in band at +0.5% with a +10% tracked peak: no probation detour, no ratchet scratch — it holds
  const start = evaluateExit(pos({ entryTs: NOW - 180 * S, peakMove: 1.10 }), mark(0.0201), probBeCfg, NOW);
  assert.equal(start.fraction, 0); assert.equal(start.reason, null); assert.equal(start.probationSince, null);
  // faded to +1.8%: the ratchet's former scratch print — holds; the stored probation stamp passes through inert
  const faded = evaluateExit(pos({ entryTs: NOW - 204 * S, peakMove: 1.10, probationSince: NOW - 24 * S }), mark(0.02036), probBeCfg, NOW);
  assert.equal(faded.fraction, 0); assert.equal(faded.reason, null); assert.equal(faded.probationSince, NOW - 24 * S);
  // deep dive to -8.5%: neither the leash nor the ratchet owns a print at/below the old trigger — it holds
  const dive = evaluateExit(pos({ entryTs: NOW - 204 * S, peakMove: 1.10, probationSince: NOW - 24 * S }), mark(0.0183), probBeCfg, NOW);
  assert.equal(dive.fraction, 0); assert.equal(dive.reason, null);
});
test('break-even ratchet: no recorded peakMove (legacy position) never arms — the round-trip seed cannot fake a breakout', () => {
  // round-trip 0.90 with no stored peakMove: the peakRatio seed would read 1/0.9 = +11%,
  // but the ratchet arms only off a peak the position actually tracked — a flat print holds.
  const p = pos({ entryTs: NOW - 30 * S, entryRoundTrip: 0.9 });
  assert.equal(evaluateExit(p, mark(0.018), beCfg, NOW).fraction, 0); // flat: move 1.00
});

// ---- bleed exit (STRIPPED): the former "still-falling" trigger — past the prove-itself
//      window (180s), down 7%+ on `move` and below the print of a minute ago — can never
//      fire at any age or depth. bleedCfg keeps the old isolation (dip stop and stall
//      knobs off); positions carry no peakMove, so the ratchet cannot arm here either.
//      The move history itself is still recorded and returned (bookkeeping kept). ----
const bleedCfg = { ...cfg, dipStopPct: 0, stallSec: 0 };
const hist = (...prints) => prints.map(([agoSec, move]) => ({ ts: NOW - agoSec * S, move }));
test('strip: bleed cannot fire — 200s old, -9% and lower than the -8% print of a minute ago holds', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([120, 0.95], [60, 0.92], [4, 0.915]) });
  const d = evaluateExit(p, mark(0.0182), bleedCfg, NOW);   // move 0.91 — the exact old fire print
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  // the current print is still appended to the returned history, bounded and threadable by the caller
  assert.equal(d.moveHist.at(-1).move, 0.91);
  assert.ok(d.moveHist.length <= 40);
});
test('strip: bleed cannot fire on the recovering shape either (nothing to distinguish anymore)', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.88]) });
  assert.equal(evaluateExit(p, mark(0.0182), bleedCfg, NOW).fraction, 0);   // move 0.91 > 0.88
});
test('strip: bleed cannot fire inside the old prove-itself window — 100s old at -15% and falling holds', () => {
  const p = pos({ entryTs: NOW - 100 * S, moveHist: hist([60, 0.90]) });
  assert.equal(evaluateExit(p, mark(0.017), bleedCfg, NOW).fraction, 0);   // move 0.85, age < 180s
});
test('strip: bleed cannot fire above its old line either — -5% and falling at 300s holds', () => {
  const p = pos({ entryTs: NOW - 300 * S, moveHist: hist([60, 0.94]) });
  assert.equal(evaluateExit(p, mark(0.019), bleedCfg, NOW).fraction, 0);   // move 0.95
});
test('strip: the post-restart shape (no lookback reading) holds, as every bleed shape now does', () => {
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, moveHist: [] }), mark(0.018), bleedCfg, NOW).fraction, 0);
  assert.equal(evaluateExit(pos({ entryTs: NOW - 300 * S, moveHist: hist([10, 0.90]) }), mark(0.018), bleedCfg, NOW).fraction, 0);
});
test('strip: BLEED_PCT value is irrelevant — the same falling print holds with the knob on or off', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]) });
  assert.equal(evaluateExit(p, mark(0.0182), { ...bleedCfg, bleedPct: 0 }, NOW).fraction, 0);
  assert.equal(evaluateExit(p, mark(0.0182), { ...bleedCfg, bleedPct: 0.07 }, NOW).fraction, 0);
});
test('strip: bleed vs probation is moot — a legacy probationed, still-falling dive holds under both stripped rules', () => {
  const probBleedCfg = { ...cfg, stallSec: 180, stallProbationSec: 300, stallLeashPct: 0.07, stallBandPct: 0.05, stallBandUpPct: 0.03, dipStopPct: 0 };
  const p = pos({ entryTs: NOW - 204 * S, probationSince: NOW - 24 * S, moveHist: hist([60, 0.95]) });
  const d = evaluateExit(p, mark(0.0183), probBleedCfg, NOW);   // move 0.915: both stripped conditions met
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
});

// ---- fail-safe confirmation (user 2026-10-14, "a fail safe to the fail safe"): after
//      the strip + v2, NONE of the three original fail-safe exits remains live — the
//      bleed and leash blocks below pin that their pendings can never even arm, and the
//      ratchet block now pins the same for Tratchet: its trigger arms NO pending, a
//      held trigger never confirms into a sell, and a stale pre-v2 pending passes
//      through untouched and inert (never confirmed, never cancelled, never sold).
//      Fixtures below carry exitPending: {} — the state bot.js initializes at entry.
//      `run` threads the returned state back onto the position exactly as bot.js does. ----
const run = (p, m, c, now) => {
  const d = evaluateExit(p, m, c, now);
  if ('exitPending' in d) p.exitPending = d.exitPending;
  if ('probationSince' in d) p.probationSince = d.probationSince;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  return d;
};
const confBeCfg = { ...beCfg, exitConfirmSec: 10 };
const confBleedCfg = { ...bleedCfg, exitConfirmSec: 10 };
const confProbCfg = { ...probCfg, exitConfirmSec: 10 };

test('exit confirmation config: EXIT_CONFIRM_SEC defaults to 10 and validates; 0 is a designed off value; negatives rejected', () => {
  const c = loadConfig({});
  assert.equal(c.exitConfirmSec, 10);
  assert.equal(validateConfig(c).length, 0);
  assert.equal(loadConfig({ EXIT_CONFIRM_SEC: '0' }).exitConfirmSec, 0);
  assert.equal(validateConfig(loadConfig({ EXIT_CONFIRM_SEC: '0' })).length, 0);
  assert.ok(validateConfig(loadConfig({ EXIT_CONFIRM_SEC: '-1' })).some(e => e.includes('EXIT_CONFIRM_SEC')));
});

// ---- ratchet (STRIPPED in v2): the confirmation machinery can never engage —
//      no pending arms on the former trigger, none confirms through the window ----
test('strip v2: Tratchet trigger arms NO pending and emits NO events; a recovery is equally inert (no cancel exists)', () => {
  const p = pos({ entryTs: NOW - 30 * S, entryRoundTrip: 0.95, peakRatio: 1.068, peakMove: 1.124, exitPending: {} });
  const d1 = run(p, mark(0.019342), confBeCfg, NOW);                    // move 1.018 — the old trigger
  assert.equal(d1.fraction, 0);
  assert.equal(p.exitPending.ratchet, undefined);                        // no window opens
  assert.deepEqual(d1.exitConfirmEvents, []);
  const d2 = run(p, mark(0.01995), confBeCfg, NOW + 4 * S);              // move 1.05: back above the +2% line
  assert.equal(d2.fraction, 0);
  assert.equal(p.exitPending.ratchet, undefined);
  assert.deepEqual(d2.exitConfirmEvents, []);                            // no 'cancelled' event — the machinery is off, not disarmed
});
test('strip v2: the Tratchet trigger held through the whole former window never sells — not at 10s, not ever', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} });
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW).fraction, 0);
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW + 4 * S).fraction, 0);
  assert.equal(run(p, mark(0.0204), confBeCfg, NOW + 8 * S).fraction, 0);
  const d = run(p, mark(0.0204), confBeCfg, NOW + 12 * S);               // the old confirmation lapse print
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  assert.deepEqual(d.exitConfirmEvents, []);
  assert.deepEqual(p.exitPending, {});
  const q = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} });
  assert.equal(run(q, mark(0.0204), confBeCfg, NOW).fraction, 0);
  assert.equal(run(q, mark(0.0204), confBeCfg, NOW + 10 * S).fraction, 0); // exactly ON the old window edge: still nothing
});
test('strip v2: a stale pre-v2 ratchet pending passes through untouched (never confirmed, never sold, never cancelled)', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: { ratchet: NOW - 20000 } });
  const d = run(p, mark(0.0204), confBeCfg, NOW);                        // window long past, trigger still true
  assert.equal(d.fraction, 0);
  assert.equal(p.exitPending.ratchet, NOW - 20000);                      // inert: the section never judges it
  assert.deepEqual(d.exitConfirmEvents, []);
  const d2 = run(p, mark(0.0212), confBeCfg, NOW + 4 * S);               // recovery print: no cancel either
  assert.equal(d2.fraction, 0);
  assert.equal(p.exitPending.ratchet, NOW - 20000);
  assert.deepEqual(d2.exitConfirmEvents, []);
});

// ---- bleed (STRIPPED): the confirmation machinery can never engage — no pending
//      arms on the former trigger, none confirms through the window, none re-arms ----
test('strip: bleed trigger arms NO pending and emits NO events', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([120, 0.95], [60, 0.92], [4, 0.915]), exitPending: {} });
  const d1 = run(p, mark(0.0182), confBleedCfg, NOW);                    // move 0.91, still falling — the old trigger
  assert.equal(d1.fraction, 0);
  assert.equal(p.exitPending.bleed, undefined);
  assert.deepEqual(d1.exitConfirmEvents, []);
  const d2 = run(p, mark(0.0192), confBleedCfg, NOW + 4 * S);            // recovery print: equally inert
  assert.equal(d2.fraction, 0);
  assert.deepEqual(d2.exitConfirmEvents, []);
});
test('strip: still falling through the whole former window never sells — not at 10s, not ever', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([120, 0.95], [60, 0.92], [4, 0.915]), exitPending: {} });
  assert.equal(run(p, mark(0.0182), confBleedCfg, NOW).fraction, 0);
  assert.equal(run(p, mark(0.0181), confBleedCfg, NOW + 4 * S).fraction, 0);
  assert.equal(run(p, mark(0.01806), confBleedCfg, NOW + 8 * S).fraction, 0);
  const d = run(p, mark(0.018), confBleedCfg, NOW + 12 * S);               // the old confirmation lapse print
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  assert.deepEqual(d.exitConfirmEvents, []);
  assert.deepEqual(p.exitPending, {});
});
test('strip: a stale pre-strip bleed pending passes through untouched (never confirmed, never sold)', () => {
  const p = pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: { bleed: NOW - 20000 } });
  const d = run(p, mark(0.0182), confBleedCfg, NOW);                     // window long past, condition still true
  assert.equal(d.fraction, 0);
  assert.equal(p.exitPending.bleed, NOW - 20000);                        // inert: the section never judges it
  assert.deepEqual(d.exitConfirmEvents, []);
});

// ---- probation leash (STRIPPED): no pending arms, no expiry, stored probation is inert ----
test('strip: leash trigger arms NO pending; the dive holds through and past the former window', () => {
  const p = pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} });
  const d1 = run(p, mark(0.0185), confProbCfg, NOW);                     // move 0.925 — the old leash trigger
  assert.equal(d1.fraction, 0);
  assert.equal(p.exitPending.leash, undefined);
  assert.equal(p.probationSince, NOW - 20 * S);                          // stored state untouched, never judged
  assert.equal(run(p, mark(0.0185), confProbCfg, NOW + 4 * S).fraction, 0);
  assert.equal(run(p, mark(0.0185), confProbCfg, NOW + 8 * S).fraction, 0);
  const d = run(p, mark(0.0185), confProbCfg, NOW + 12 * S);
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  assert.deepEqual(d.exitConfirmEvents, []);
});
test('strip: no leash re-trigger cycle exists — repeated dives and recoveries change nothing', () => {
  const p = pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} });
  run(p, mark(0.0185), confProbCfg, NOW);
  run(p, mark(0.0188), confProbCfg, NOW + 4 * S);
  const re = run(p, mark(0.0185), confProbCfg, NOW + 8 * S);
  assert.equal(re.fraction, 0);
  assert.equal(p.exitPending.leash, undefined);
  assert.equal(run(p, mark(0.0185), confProbCfg, NOW + 20 * S).fraction, 0);
});

// ---- EXIT_CONFIRM_SEC=0: the layer is off — and with every fail-safe stripped
//      in v2, instant mode changes nothing for any of the three shapes ----
test('exit confirmation OFF (EXIT_CONFIRM_SEC=0): the ratchet cannot fire either — all three fail-safe shapes hold in instant mode', () => {
  const r = evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {} }), mark(0.0204), { ...confBeCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(r.fraction, 0); assert.equal(r.reason, null); assert.deepEqual(r.exitPending, {});
  const b = evaluateExit(pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: {} }), mark(0.0182), { ...confBleedCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(b.fraction, 0); assert.equal(b.reason, null);
  const l = evaluateExit(pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} }), mark(0.0185), { ...confProbCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(l.fraction, 0); assert.equal(l.reason, null);
});

// ---- interplay: a stale fail-safe pending is inert — it never blocks the stack ----
test('strip v2: a TP1 decision executes immediately with a stale ratchet pending on the position; the pending passes through untouched', () => {
  const tpCfg = { ...cfg, dipStopPct: 0, exitConfirmSec: 10, tp1Pct: 0.20, tp1Frac: 0.4, tp1AdaptMax: 0.60, tp1Giveback: 0.08, lockKeep: 0 };
  const p = pos({ entryTs: NOW - 30 * S, peakRatio: 1.45, peakMove: 1.45, exitPending: { ratchet: NOW - 20000 } });
  const d1 = run(p, mark(0.0204), tpCfg, NOW);                           // faded to +2%: the ratchet's old trigger print
  assert.equal(d1.fraction, 0);                                          // no sell, no confirm — the pending is a fossil
  assert.equal(p.exitPending.ratchet, NOW - 20000);
  const d2 = run(p, mark(0.026), tpCfg, NOW + 4 * S);                    // rips to 1.30x: TP1 rollover off the 1.45 peak
  assert.equal(d2.tp1, true);
  assert.equal(d2.fraction, 0.4);                                        // banked NOW — the fossil never delayed it
  assert.equal(d2.exitPending.ratchet, NOW - 20000);                     // ...and it is still sitting there, inert
  assert.deepEqual(d2.exitConfirmEvents, []);
});

// ---- PROTECT switch (user 2026-10-15, "just the stop loss… no ratchet", "no SL until
//      I say"): a one-time per-position flag (pos.protected, set via POST /protect).
//      Since the strip + v2, the stop-loss family AND Tratchet are off for EVERYONE —
//      protection's only live suppression left is the post-TP2 dead flow (3c2, pinned
//      in deadflow.test.mjs). The stop-state clearing under the flag is kept (stale
//      armings/counters are dropped from the returned state) and pinned below;
//      momentum and the full TP ladder judge as normal. The flag holds for the life
//      of the position; /unprotect restores normal judging. ----
const protPos = (o = {}) => pos({ protected: NOW - 60000, ...o });
test('strip + protect: the deep stop-family print holds for protected AND unprotected alike; protect still clears stop state', () => {
  const d = evaluateExit(protPos(), mark(0.011), cfg, NOW);   // move 0.55 — deep in the old dip-stop / floor / grace territory
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, null);                       // the STRIPPED family reports nothing (the strip holds it) — and since the SL ladder's removal (user 2026-10-16 19:24 EDT) nothing live is left on this print for protect to suppress: the stall exit is flow-judged and this tape (30b/10s) is alive
  assert.equal(d.stopArmedTs, null);
  assert.equal(d.floorChecks, 0);
  const ctl = evaluateExit(pos(), mark(0.011), cfg, NOW);     // control: unprotected holds too now
  assert.equal(ctl.fraction, 0); assert.equal(ctl.protectedBlock, null);
});
test('strip + protect: a stale grace arming is cleared under the flag and can never sell, elapsed or not', () => {
  const c = { ...cfg, dipStopPct: 0, stopHardPct: 0 };
  const dead = mark(0.011, { buysM5: 1, sellsM5: 1 });        // ratio 0.55, no buyers
  const d = evaluateExit(protPos({ stopArmedTs: NOW - 10000 }), dead, c, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.stopArmedTs, null);                          // pre-flag arming is cleared, not carried
  const ctl = evaluateExit(pos({ stopArmedTs: NOW - 10000 }), dead, c, NOW); // control: unprotected holds too
  assert.equal(ctl.fraction, 0); assert.equal(ctl.reason, null);
});
test('strip + protect: stale hard-floor counters are cleared under the flag; the print holds either way', () => {
  const c = { ...cfg, dipStopPct: 0 };
  const p = protPos({ floorChecks: 1, floorSince: NOW - 10000 });
  const d = evaluateExit(p, mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, null);                       // the floor counters report nothing (stripped) — and no live rule is suppressed on this print either (1b/1s is not the stall exit's dead-flow conjunction: sells must exceed 3x buys)
  assert.equal(d.floorChecks, 0); assert.equal(d.floorSince, null);
  const ctl = evaluateExit(pos({ floorChecks: 1, floorSince: NOW - 10000 }), mark(0.011, { buysM5: 1, sellsM5: 1 }), c, NOW);
  assert.equal(ctl.fraction, 0); assert.equal(ctl.reason, null); // control: no second-check sell exists anymore
});
test('strip v2 + protect: the ratchet print holds for protected AND unprotected alike; protect still drops a stale ratchet pending silently', () => {
  const p = protPos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: { ratchet: NOW - 12000 } });
  const d = evaluateExit(p, mark(0.0204), confBeCfg, NOW);    // move 1.02 — the armed ratchet's old trigger
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, null);                       // nothing to suppress — the strip, not the flag, holds it (no noteBlock exists to report)
  assert.equal(d.exitPending.ratchet, undefined);             // the protect block still drops the fossil from the returned state
  assert.ok(!d.exitConfirmEvents.some(e => e.kind === 'ratchet')); // and it is NOT counted as a cancelled window
  const ctl = evaluateExit(pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: { ratchet: NOW - 12000 } }), mark(0.0204), confBeCfg, NOW);
  assert.equal(ctl.fraction, 0); assert.equal(ctl.reason, null); // control: unprotected holds too — the pending passes through inert
  assert.equal(ctl.exitPending.ratchet, NOW - 12000);
});
test('protect: a bleed pending is left exactly as it was — still armed, still ticking', () => {
  const p = protPos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: { ratchet: NOW - 5000, bleed: NOW - 5000 } });
  const d = evaluateExit(p, mark(0.0182), confBleedCfg, NOW); // move 0.91 and falling: the bleed trigger holds
  assert.equal(d.fraction, 0);                                // 5s into its 10s window: not sold YET — the layer's normal timing
  assert.equal(d.exitPending.bleed, NOW - 5000);              // bleed pending preserved to the tick
  assert.equal(d.exitPending.ratchet, undefined);             // only the ratchet pending was dropped
  assert.deepEqual(d.exitConfirmEvents, []);
  assert.equal(d.protectedBlock, null);                       // the bleed itself proceeded normally (pending preserved above) — and nothing else live is suppressed on this print: the tape (30b/10s) is alive, so the stall exit has nothing to stamp, protected or not
});
test('strip + protect: the bleed print cannot fire, protected or not', () => {
  const p = protPos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: {} });
  const d = evaluateExit(p, mark(0.0182), { ...confBleedCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  const ctl = evaluateExit(pos({ entryTs: NOW - 200 * S, moveHist: hist([60, 0.92]), exitPending: {} }), mark(0.0182), { ...confBleedCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(ctl.fraction, 0);
});
test('strip + protect: the probation-leash print cannot fire, protected or not', () => {
  const p = protPos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} });
  const d = evaluateExit(p, mark(0.0185), { ...confProbCfg, exitConfirmSec: 0 }, NOW); // move 0.925 — through the old −7% leash
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  const ctl = evaluateExit(pos({ entryTs: NOW - 200 * S, probationSince: NOW - 20 * S, exitPending: {} }), mark(0.0185), { ...confProbCfg, exitConfirmSec: 0 }, NOW);
  assert.equal(ctl.fraction, 0);
});
test('protect: TP1 still banks on schedule', () => {
  const fixed = { ...cfg, tp1AdaptMax: cfg.tp1Pct };
  const d = evaluateExit(protPos({ stallSince: NOW }), mark(0.0264), fixed, NOW);
  assert.equal(d.tp1, true);
  assert.equal(d.fraction, 0.65);
});
test('strip + unprotect: no grace stop exists to re-arm — the deep print holds before and after unprotect', () => {
  const c = { ...cfg, dipStopPct: 0, stopHardPct: 0 };
  const dead = mark(0.011, { buysM5: 1, sellsM5: 1 });
  const p = protPos({ stopArmedTs: NOW - 10000 });
  const d1 = evaluateExit(p, dead, c, NOW);
  assert.equal(d1.fraction, 0); assert.equal(d1.stopArmedTs, null); // protection cleared the stale arming
  delete p.protected;                                              // POST /unprotect
  p.stopArmedTs = d1.stopArmedTs;                                  // bot.js threads the returned state back
  const d2 = evaluateExit(p, dead, c, NOW);
  assert.equal(d2.fraction, 0); assert.equal(d2.stopArmedTs, null); // nothing re-arms — the family is stripped
  p.stopArmedTs = d2.stopArmedTs;
  const d3 = evaluateExit(p, dead, c, NOW + 6 * S);
  assert.equal(d3.fraction, 0); assert.equal(d3.reason, null);
});
test('strip v2 + unprotect: no ratchet exists to re-arm — the trigger print holds before and after unprotect', () => {
  const p = pos({ entryTs: NOW - 30 * S, peakMove: 1.12, exitPending: {}, protected: NOW - 60000 });
  const d1 = run(p, mark(0.0204), confBeCfg, NOW);
  assert.equal(d1.fraction, 0); assert.equal(d1.protectedBlock, null); // the flag suppresses nothing here anymore
  assert.deepEqual(p.exitPending, {});                             // no pending could arm under the flag
  delete p.protected;                                              // POST /unprotect
  const d2 = run(p, mark(0.0204), confBeCfg, NOW + 2 * S);
  assert.equal(d2.fraction, 0); assert.equal(p.exitPending.ratchet, undefined); // no fresh window opens — the ratchet is stripped for everyone
  const d3 = run(p, mark(0.0204), confBeCfg, NOW + 13 * S);
  assert.equal(d3.fraction, 0); assert.equal(d3.reason, null);
});
