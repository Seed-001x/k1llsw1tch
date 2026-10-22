// DEAD-FLOW EXIT — REPOSITIONED POST-TP2 (exit-stack v2, user order 2026-10-15
// ~20:26 EDT). The rule's first incarnation judged PRE-TP1 positions at
// altitude (founding case Scout/AAD: peaked ~+12% realizable, buys flatlined,
// round-tripped to −0.4%); the 2026-10-15 strip disabled that placement, and
// v2 re-specified the stack with dead flow owning exactly one stage — the
// MOONBAG: a post-TP2 remainder whose own flow flatlines for a full rolling
// window (buy count rises <= deadflowMaxBuyDelta), with no new peak inside
// the window and the move >= 1pt below the window-start peak, sells in full.
// The drive sequences in the first block are the former PRE-TP1 trigger
// conditions, kept verbatim — every one pins that nothing pre-TP2 can arm or
// fire anymore. The second block pins the new post-TP2 behavior.
// STAGED WAVES (user order 2026-10-16 ~20:15 EDT): the post-TP2 fire is now
// staged by default (BAG_DEAD_STAGED=1) — waves of 50% + a stub floor,
// pinned in tests/bagstaged.test.mjs. The two whole-bag fire tests in the
// second block run under the kill switch (bagDeadStaged: 0) as the legacy
// pins; the protect pin below runs under the staged default, where a
// suppressed wave behaves exactly as the suppressed legacy fire did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const S = 1000;
// Isolate the rule: txFeeSol 0 makes move == ratio; the stall, ratchet, dip
// stop and profit lock are off so only dead-flow (and, where a test arms it,
// TP1) can act. Defaults otherwise real: deadflowArmPct 0.08, window 45s,
// maxBuyDelta 1, peakGap 0.01.
const cfg = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagTrailConfirmSec: 0, bagSmallHold: 0, tp1Guard: 0 }); // trail timer off: this file pins the trail's precedence, the timer is pinned in bagtrailconfirm.test.mjs; small-bag mode off: the post-TP2 tests here pin the closeted dead-flow method (small-bag regime: smallbag.test.mjs); tp1Guard 0: guard pinned off because it owns the middle-stage give-back since 2026-10-22 and this suite isolates the dead-flow rule (guard behavior: tp1guard.test.mjs)
const mark = (pos, ratio, o = {}) => ({ valueSol: pos.entrySol * pos.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
const thread = (p, d) => {
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if ('tp1Arm' in d) p.tp1Arm = d.tp1Arm;
  if ('exitPending' in d) p.exitPending = d.exitPending;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if ('probationSince' in d) p.probationSince = d.probationSince;
  if ('deadflowArmed' in d) p.deadflowArmed = d.deadflowArmed;
  return p;
};
const fresh = (o = {}) => ({ entrySol: 1, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });

// Drive one position check per step ({dt sec, ratio, buys, sells}), appending
// the flow sample BEFORE judging exactly as bot.js does, threading the
// caller-persisted state back in. The clock lives on the fixture (p._now) so
// consecutive drive() calls on one position keep time monotonic. Returns
// every decision.
function drive(p, steps, cfgX = cfg) {
  let now = p._now ?? p.entryTs; const ds = [];
  for (const st of steps) {
    now += (st.dt ?? 4) * S; p._now = now;
    if (st.buys !== undefined || st.sells !== undefined) {
      p.flowHist = [...(p.flowHist || []), { ts: now, buys: st.buys ?? null, sells: st.sells ?? null, tx: (st.buys != null || st.sells != null) ? (st.buys || 0) + (st.sells || 0) : null }].slice(-45);
    }
    const d = evaluateExit(p, mark(p, st.ratio, { buysM5: st.buys ?? null, sellsM5: st.sells ?? 0 }), cfgX, now);
    thread(p, d); ds.push(d);
  }
  return ds;
}
const seq = (ratios, buys, sells = 40) => ratios.map((ratio, i) => ({ ratio, buys: Array.isArray(buys) ? buys[i] : buys, sells: Array.isArray(sells) ? sells[i] : sells }));
const flat = (n, ratio, buys, sells = 40) => Array.from({ length: n }, () => ({ ratio, buys, sells }));
// the shared climb: 8 checks to a 1.12 peak, buy count rising 100 -> 150
const CLIMB_R = [1.03, 1.05, 1.07, 1.09, 1.10, 1.11, 1.115, 1.12];
const CLIMB_B = [100, 108, 116, 124, 132, 138, 144, 150];

test('below the +8% arm line, dead flow never fires (and never arms)', () => {
  const p = fresh();
  const ds = drive(p, [
    ...seq([1.02, 1.03, 1.04, 1.05, 1.055, 1.06], [100, 110, 120, 130, 140, 150]),
    ...flat(16, 1.05, 150), // a full minute of dead flow at a +6% peak
  ]);
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length), 'no arming below the line');
  assert.ok(!p.deadflowArmed);
});

test('strip: the full former trigger sequence — climb past +8%, 45s of dead flow — neither arms nor fires', () => {
  const p = fresh();
  const stallR = [1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.105];
  const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(stallR, 150)]);
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length), 'no arming event on the +8% crossing, no fire at window lapse');
  assert.ok(ds.every(d => d.fraction === 0), 'every check holds, including the former fire check');
  assert.ok(!p.deadflowArmed);
  const last = ds[ds.length - 1];
  assert.equal(last.reason, null);
});

test('strip: a buy burst and its aging out of the window change nothing — no fire anywhere', () => {
  const p = fresh();
  const pre = drive(p, [...seq(CLIMB_R, CLIMB_B), ...flat(10, 1.11, 150), { ratio: 1.118, buys: 156, sells: 40 }]);
  assert.ok(pre.every(d => d.fraction === 0));
  const post = drive(p, [...flat(11, 1.108, 156)]);
  assert.ok(post.every(d => d.fraction === 0));
  const tail = drive(p, [{ ratio: 1.105, buys: 156, sells: 40 }]); // the former fire check, window clear of the burst
  assert.equal(tail[0].fraction, 0);
  assert.equal(tail[0].reason, null);
});

test('strip: a new peak inside the window and its aging to a window start change nothing', () => {
  const p = fresh();
  const ds = drive(p, [
    ...seq(CLIMB_R, CLIMB_B),
    ...flat(10, 1.11, 150),
    { ratio: 1.125, buys: 150, sells: 40 }, // new peak mid-window
    ...flat(10, 1.108, 150),
  ]);
  assert.ok(ds.every(d => d.fraction === 0));
  const tail = drive(p, [{ ratio: 1.105, buys: 150, sells: 40 }, { ratio: 1.105, buys: 150, sells: 40 }]);
  assert.equal(tail[0].fraction, 0);
  assert.equal(tail[1].fraction, 0, 'the former fire check (new peak aged to window start, price below) holds');
});

test('strip: steady two-way flow at altitude — no arming event, no fire (as before, now for a stronger reason)', () => {
  const p = fresh();
  const buys = Array.from({ length: 20 }, (_, i) => 153 + i * 3);
  const sells = Array.from({ length: 20 }, (_, i) => 42 + i * 2);
  const chop = Array.from({ length: 20 }, (_, i) => [1.115, 1.118, 1.112][i % 3]);
  const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(chop, buys, sells)]);
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length), 'the position never arms under the strip');
  assert.ok(ds.every(d => d.fraction === 0));
});

test('TP1-done position is untouched by the rule', () => {
  const p = fresh({ tp1Done: true, pathClass: 'ladder', remainingFrac: 0.6, peakRatio: 1.12, peakMove: 1.12, postTp1PeakMove: 1.12 });
  const ds = drive(p, seq([1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.104, 1.103, 1.102, 1.101, 1.10], 150));
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length && !d.deadflowArmed), 'no arming, no events post-TP1');
});

test('strip + protect: a protected position rides the full former trigger sequence; no block is reported (nothing to suppress)', () => {
  const p = fresh({ protected: true });
  const stallR = [1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.105];
  const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(stallR, 150)]);
  assert.ok(ds.every(d => d.fraction === 0), 'protection never sells');
  assert.equal(ds[ds.length - 1].protectedBlock, null, 'the rule is off for everyone — the qualifying check reports no suppression');
});

test('TP1 firing on the same check wins over dead flow', () => {
  const cfgX = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, tp1Pct: 0.10, tp1AdaptMax: 0.60, tp1Giveback: 0.03, tp1Frac: 0.4 });
  const p = fresh();
  const climbR = [1.05, 1.10, 1.15, 1.20, 1.24, 1.27, 1.29, 1.30];
  const climbB = [100, 110, 120, 130, 140, 150, 160, 170];
  const ds = drive(p, [
    ...seq(climbR, climbB, 73),
    ...flat(10, 1.30, 170, 73), // plateau, flow dead from the peak print on
    { ratio: 1.29, buys: 170, sells: 73 },
    { ratio: 1.27, buys: 170, sells: 73 }, // giveback hits 3pts exactly as the 45s window completes
  ], cfgX);
  assert.ok(ds.slice(0, -1).every(d => d.fraction === 0));
  const last = ds[ds.length - 1];
  assert.equal(last.tp1, true, 'TP1 takes the check');
  assert.equal(last.fraction, 0.4);
  assert.match(last.reason, /^TP1 /);
  assert.equal(last.pathClass, 'modest');
});

test('strip: AAD shape — the founding case itself now rides (choppy stall at +10.6% never sells)', () => {
  const p = fresh();
  const climbR = [1.04, 1.07, 1.09, 1.105, 1.115, 1.12];
  const climbB = [90, 102, 114, 126, 138, 150];
  const stallR = [1.108, 1.113, 1.106, 1.112, 1.107, 1.11, 1.105, 1.109, 1.104, 1.107, 1.103, 1.106];
  const ds = drive(p, [...seq(climbR, climbB, 55), ...seq(stallR, 150, 55)]);
  assert.ok(ds.every(d => d.fraction === 0), 'the exact sequence that founded the rule now produces no exit at all');
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length));
});

test('SCRIP-shaped first stall — buys still ticking in two-way flow — does NOT fire', () => {
  const cfgX = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, tp1Frac: 0 }); // TP1 off: isolate the rule on a runner
  const p = fresh();
  const climbR = [1.06, 1.12, 1.18, 1.24, 1.30, 1.35, 1.39, 1.42, 1.44, 1.45];
  const climbB = [120, 150, 180, 205, 228, 248, 265, 280, 292, 300];
  const stallR = [1.44, 1.435, 1.445, 1.44, 1.45, 1.442, 1.455, 1.448, 1.452, 1.446, 1.45, 1.443, 1.449, 1.447];
  const stallB = stallR.map((_, i) => 304 + i * 4);
  const stallS = stallR.map((_, i) => 120 + i * 3);
  const ds = drive(p, [...seq(climbR, climbB, 90), ...seq(stallR, stallB, stallS), ...seq([1.50, 1.58], [364, 372], [165, 170])], cfgX);
  assert.ok(ds.every(d => d.fraction === 0), 'a live stall is not dead flow — the run continues untouched');
});

test('strip is code, not config: the knob value is irrelevant — window 45 (shipped) and window 0 behave identically', () => {
  const stallR = [1.115, 1.112, 1.11, 1.109, 1.108, 1.108, 1.107, 1.107, 1.106, 1.106, 1.105, 1.105];
  for (const w of [45, 0]) {
    const cfgX = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, deadflowWindowSec: w });
    const p = fresh();
    const ds = drive(p, [...seq(CLIMB_R, CLIMB_B), ...seq(stallR, 150)], cfgX);
    assert.ok(ds.every(d => d.fraction === 0), `window ${w}: no fire`);
    assert.ok(ds.every(d => !(d.deadflowEvents || []).length), `window ${w}: no events`);
  }
});

test('missing flow data fails closed — a stall with unknown buy counts never fires', () => {
  const p = fresh();
  const steps = [
    ...[1.04, 1.07, 1.09, 1.105, 1.115, 1.12].map(ratio => ({ ratio, buys: null, sells: null })),
    ...Array.from({ length: 14 }, () => ({ ratio: 1.108, buys: null, sells: null })),
  ];
  const ds = drive(p, steps);
  assert.ok(ds.every(d => d.fraction === 0));
});

test('strip: a data gap (restart) and a full fresh window after it — still no fire', () => {
  const p = fresh();
  const pre = drive(p, [...seq(CLIMB_R, CLIMB_B), ...flat(6, 1.11, 150), { dt: 60, ratio: 1.105, buys: 150, sells: 40 }]);
  assert.ok(pre.every(d => d.fraction === 0));
  const post = drive(p, flat(11, 1.105, 150));
  assert.ok(post.every(d => d.fraction === 0));
  const tail = drive(p, [{ ratio: 1.105, buys: 150, sells: 40 }]);
  assert.equal(tail[0].fraction, 0, 'the former post-gap fire check holds — there is no window judgment anymore');
  assert.equal(tail[0].reason, null);
});

// ---- POST-TP2 (exit-stack v2): the rule's only stage now ----
// A moonbag-stage fixture: TP1 + TP2 banked, 25% riding, peak 1.90x. The
// moonbag trail (bagTrailPct 0.15 at test defaults) lines at 1.615 — the flat
// 1.86 prints below stay well above it, so only dead flow can act.
const bag = (o = {}) => fresh({ tp1Done: true, tp2Done: true, pathClass: 'ladder', remainingFrac: 0.25, peakRatio: 1.9, peakMove: 1.9, postTp1PeakMove: 1.9, ...o });
const BAG_CLIMB = [1.90, 1.90, 1.90];
const BAG_CLIMB_B = [300, 306, 312];

test('v2 post-TP2: the bag arms on its first check (peak far past the +8% line)', () => {
  const p = bag();
  const ds = drive(p, seq([1.90], [300]));
  assert.deepEqual(ds[0].deadflowEvents, [{ type: 'armed' }]);
  assert.equal(p.deadflowArmed, true);
  assert.equal(ds[0].fraction, 0);
});

test('v2 post-TP2 (legacy, BAG_DEAD_STAGED=0): a full 45s window of dead flow sells the whole bag — not before the window completes', () => {
  const cfgLegacy = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, bagDeadStaged: 0, bagSmallHold: 0 });
  const p = bag();
  const ds = drive(p, [...seq(BAG_CLIMB, BAG_CLIMB_B), ...flat(14, 1.86, 312)], cfgLegacy);
  const fireIdx = ds.findIndex(d => d.fraction === 1);
  assert.ok(fireIdx >= 13, `no fire before the window can complete (fired at index ${fireIdx})`);
  assert.ok(ds.slice(0, fireIdx).every(d => d.fraction === 0));
  // (the drive keeps judging after the fire — the live bot removes the position
  // on the full sell, so later identical fires are a harness artifact)
  assert.match(ds[fireIdx].reason, /^dead flow after TP2 \(\+86\.0%, 0 new buys in 45s, peak stalled\)$/);
  assert.deepEqual(ds[fireIdx].deadflowEvents, [{ type: 'fired' }]);
});

test('v2 post-TP2 (legacy, BAG_DEAD_STAGED=0): the live 120s window value fires at its own lapse, with the window in the reason', () => {
  const cfgX = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, deadflowWindowSec: 120, bagDeadStaged: 0, bagSmallHold: 0 });
  const p = bag();
  const ds = drive(p, [...seq(BAG_CLIMB, BAG_CLIMB_B), ...flat(34, 1.86, 312)], cfgX);
  const fireIdx = ds.findIndex(d => d.fraction === 1);
  assert.ok(fireIdx >= 31, `no fire before the 120s window can complete (fired at index ${fireIdx})`);
  assert.ok(ds.slice(0, fireIdx).every(d => d.fraction === 0));
  assert.match(ds[fireIdx].reason, /^dead flow after TP2 \(\+86\.0%, 0 new buys in 120s, peak stalled\)$/);
});

test('v2 post-TP2: live flow (buys still rising) never fires, however long the plateau', () => {
  const p = bag();
  const buys = Array.from({ length: 14 }, (_, i) => 315 + i * 3);
  const ds = drive(p, [...seq(BAG_CLIMB, BAG_CLIMB_B), ...seq(Array(14).fill(1.86), buys)]);
  assert.ok(ds.every(d => d.fraction === 0));
  assert.equal(p.deadflowArmed, true);   // armed — it is the flow, not the arming, that holds the fire
});

test('v2 post-TP2: a new peak inside the window voids it — no fire while the peak is still in-window', () => {
  const p = bag();
  const ds = drive(p, [
    ...seq(BAG_CLIMB, BAG_CLIMB_B),
    ...flat(10, 1.86, 312),
    { ratio: 1.93, buys: 312, sells: 40 },   // fresh peak mid-window
    ...flat(8, 1.86, 312),
  ]);
  assert.ok(ds.every(d => d.fraction === 0));
});

test('v2 post-TP2: protect suppresses the fire and reports the block — the bag rides', () => {
  const p = bag({ protected: true });
  const ds = drive(p, [...seq(BAG_CLIMB, BAG_CLIMB_B), ...flat(14, 1.86, 312)]);
  assert.ok(ds.every(d => d.fraction === 0), 'protection never sells');
  assert.ok(ds.every(d => !(d.deadflowEvents || []).some(e => e.type === 'fired')), 'no fire event under the flag');
  assert.equal(ds[ds.length - 1].protectedBlock, 'dead flow');
});

test('v2 post-TP2: a deep fade still exits via the moonbag trail — the trail keeps its label and precedence', () => {
  const p = bag();
  const ds = drive(p, [...seq(BAG_CLIMB, BAG_CLIMB_B), { ratio: 1.55, buys: 312, sells: 40 }]); // 1.55 <= 1.9 x 0.85
  const d = ds[ds.length - 1];
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /^moonbag trail/);
  assert.ok(!(d.deadflowEvents || []).some(e => e.type === 'fired'));
});

test('v2: a post-TP1 / pre-TP2 runner in dead flow never arms and never fires — the ladder owns it', () => {
  const p = fresh({ tp1Done: true, pathClass: 'ladder', remainingFrac: 0.6, peakRatio: 1.9, peakMove: 1.9, postTp1PeakMove: 1.9 });
  const ds = drive(p, [...seq(BAG_CLIMB, BAG_CLIMB_B), ...flat(14, 1.86, 312)]);
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length), 'no arming before TP2');
  assert.ok(!p.deadflowArmed);
});

test('v2 post-TP2: a bag whose peak never reached the arm line never arms (and cannot fire)', () => {
  const p = bag({ peakRatio: 1.05, peakMove: 1.05, postTp1PeakMove: 1.05 });
  const ds = drive(p, [...flat(17, 1.03, 312)]);
  assert.ok(ds.every(d => d.fraction === 0));
  assert.ok(ds.every(d => !(d.deadflowEvents || []).length));
  assert.ok(!p.deadflowArmed);
});

// ---- config ----
test('config: dead-flow knobs default to the shipped values and validate', () => {
  const c = loadConfig({});
  assert.equal(c.deadflowArmPct, 0.08);
  assert.equal(c.deadflowWindowSec, 45);
  assert.equal(c.deadflowMaxBuyDelta, 1);
  assert.equal(c.deadflowPeakGapPct, 0.01);
  assert.equal(validateConfig(c).filter(e => e.includes('DEADFLOW')).length, 0);
  assert.equal(loadConfig({ DEADFLOW_WINDOW_SEC: '30' }).deadflowWindowSec, 30);
  assert.equal(loadConfig({ DEADFLOW_WINDOW_SEC: '0' }).deadflowWindowSec, 0);
  assert.equal(validateConfig(loadConfig({ DEADFLOW_WINDOW_SEC: '0' })).filter(e => e.includes('DEADFLOW')).length, 0, '0 = off validates');
  assert.ok(validateConfig(loadConfig({ DEADFLOW_WINDOW_SEC: '-5' })).some(e => e.includes('DEADFLOW_WINDOW_SEC')));
  assert.ok(validateConfig(loadConfig({ DEADFLOW_ARM_PCT: '2' })).some(e => e.includes('DEADFLOW_ARM_PCT')));
  assert.ok(validateConfig(loadConfig({ DEADFLOW_PEAK_GAP_PCT: '0.9' })).some(e => e.includes('DEADFLOW_PEAK_GAP_PCT')));
});
