// TWO-PATH EXIT REDESIGN (user 2026-10-15, variant c) — BRANCHING STRIPPED the
// same day (user order ~17:05 EDT, the exit-stack strip): the TP1 classification
// STAMP (pathClass / killZoneOverlay on the decision, persisted by bot.js,
// stamped on closes) remains as record-only journaling and is pinned below.
// NOTHING branches on it anymore: the modest target/split (3a) and the kill
// zone (4e) can never fire — every remainder judges through the plain ladder.
// Original design, for the record: classification at TP1 by the fire's realized
// gain ([+20%, +40%] modest / above ladder / below ladder + kill-zone overlay),
// the modest remainder (no trails — a +50% target that SPLITS 2/3 banked + 1/3
// converted to ladder), and the kill zone (absolute +10% floor, arms only at a
// 1.25x post-TP1 peak, 10s confirmation window, instant sell on re-entry).
// Design record: user/files/exit-redesign-note-2026-10-15.md (§1, §7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg } from './helpers.mjs';

const T0 = 1_700_000_000_000;
const S = 1000;
// txFeeSol 0 makes gain == ratio - 1 exactly, so fire prices land where the test
// aims them. TP1: arms +10%, ceiling +60%, giveback 8pts — fires print the drop
// target via rollover.
// 2026-10-16: the post-TP1 middle trail (3d) was REMOVED by user order (STRIP
// postTp1Trail) — the prints below that it used to own now HOLD, and several
// tests pin exactly that.
const cfg = testCfg({ txFeeSol: 0, tp1Pct: 0.10, tp1AdaptMax: 0.60, tp1Giveback: 0.08, tp1Frac: 0.4, tp2Pct: 0.80, exitConfirmSec: 10, stallProbationSec: 0, lockKeep: 0, dipStopPct: 0, bagTrailConfirmSec: 0, bagSmallHold: 0, tp1Guard: 0 }); // trail timer off here: the overlay test pins the trail owning the bag, the timer is pinned in bagtrailconfirm.test.mjs; bagSmallHold 0: the trail lives in the closeted big-bag mode since 2026-10-17 ~04:38; tp1Guard 0: guard pinned off because it owns the middle-stage give-back since 2026-10-22 and this suite isolates the two-path family (guard behavior: tp1guard.test.mjs)
const mark = (pos, ratio, o = {}) => ({ valueSol: pos.entrySol * pos.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
// thread the caller-persisted state from a decision back into the fixture, as bot.js does
const thread = (p, d) => {
  if (d.newPeak != null) p.peakRatio = d.newPeak;
  if (d.newPeakMove != null) p.peakMove = d.newPeakMove;
  if ('tp1Arm' in d) p.tp1Arm = d.tp1Arm;
  if ('exitPending' in d) p.exitPending = d.exitPending;
  if ('killZone' in d) p.killZone = d.killZone;
  if ('postTp1PeakMove' in d) p.postTp1PeakMove = d.postTp1PeakMove;
  if ('moveHist' in d) p.moveHist = d.moveHist;
  if ('probationSince' in d) p.probationSince = d.probationSince;
  return p;
};
const fresh = (o = {}) => ({ entrySol: 1, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });
const rem = (o = {}) => ({ entrySol: 0.05, remainingFrac: 0.6, peakRatio: 1, peakMove: 1, tp1Done: true, entryTs: T0, exitPending: {}, flowHist: [], moveHist: [], ...o });

// Drive a TP1 fire at an exact realized gain: rise to the peak (arms TP1), then
// drop to the fire gain (rollover banks it). Returns the firing decision.
function classifyAt(fireGain, peakGain) {
  const p = fresh();
  const d1 = evaluateExit(p, mark(p, 1 + peakGain), cfg, T0);
  assert.equal(d1.fraction, 0, 'peak check must not fire');
  thread(p, d1);
  const d2 = evaluateExit(p, mark(p, 1 + fireGain), cfg, T0 + 4 * S);
  assert.equal(d2.tp1, true, `expected a TP1 fire at +${fireGain * 100}%`);
  return d2;
}

// ---- classification band edges ----
test('classify: fire at +19.9% → ladder + kill-zone overlay', () => {
  const d = classifyAt(0.199, 0.30);
  assert.equal(d.pathClass, 'ladder'); assert.equal(d.killZoneOverlay, true);
});
test('classify: fire at the +20% band edge → modest, no overlay', () => {
  const d = classifyAt(0.20 + 1e-9, 0.30);
  assert.equal(d.pathClass, 'modest'); assert.equal(d.killZoneOverlay, false);
});
test('classify: fire at +30% (mid-band) → modest', () => {
  const d = classifyAt(0.30, 0.42);
  assert.equal(d.pathClass, 'modest'); assert.equal(d.killZoneOverlay, false);
});
test('classify: fire at the +40% band edge → modest', () => {
  const d = classifyAt(0.40 - 1e-9, 0.50);
  assert.equal(d.pathClass, 'modest'); assert.equal(d.killZoneOverlay, false);
});
test('classify: fire at +40.1% → ladder, no overlay', () => {
  const d = classifyAt(0.401, 0.50);
  assert.equal(d.pathClass, 'ladder'); assert.equal(d.killZoneOverlay, false);
});
test('classify: NEYMAR shape — fire at +11% → ladder + overlay', () => {
  const d = classifyAt(0.11, 0.30);
  assert.equal(d.pathClass, 'ladder'); assert.equal(d.killZoneOverlay, true);
});

// ---- modest remainder under the strip: plain ladder — no split exists, and
// ---- since 2026-10-16 no middle trail either: deep fades HOLD ----
test('strip: SCRIP shape — a modest remainder now judges EXACTLY like the ladder control: the old trail print holds for both', () => {
  const base = { pathClass: 'modest', peakRatio: 1.66, peakMove: 1.66, postTp1PeakMove: 1.66, killZone: { armed: true, entries: 0 } };
  const d = evaluateExit(rem(base), mark(rem(base), 1.402), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
  const ctl = { ...base, pathClass: 'ladder' };
  const dc = evaluateExit(rem(ctl), mark(rem(ctl), 1.402), cfg, T0 + 60 * S);
  assert.equal(dc.fraction, 0); assert.equal(dc.reason, null);
});
test('strip: crossing +50% splits nothing — no modestSplit, no bank; the remainder rides the ladder', () => {
  const p = rem({ pathClass: 'modest', peakRatio: 1.49, peakMove: 1.49, postTp1PeakMove: 1.49 });
  const d = evaluateExit(p, mark(p, 1.52), cfg, T0 + 60 * S);
  assert.equal(d.modestSplit, undefined);
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
});
test('modest: the converted slice is plain ladder — TP2 fires on it (original-fraction convention clamps to the whole slice)', () => {
  // after the split: 0.6 * (1 - 2/3) = 0.20 of the original remains; TP2 sells
  // tp2Frac (0.35) OF THE ORIGINAL → 0.35/0.20 > 1 → clamped to the full slice.
  const p = rem({ remainingFrac: 0.2, pathClass: 'ladder', splitDone: true, peakRatio: 1.66, peakMove: 1.66, postTp1PeakMove: 1.66 });
  const d = evaluateExit(p, mark(p, 1.85), cfg, T0 + 120 * S);
  assert.equal(d.tp2, true); assert.equal(d.fraction, 1);
});

// ---- kill zone: arming gate ----
test('zone: inert before arming — a dip to +5% with a 1.20x post-TP1 peak accrues no zone state', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.20, killZone: null });
  const d = evaluateExit(p, mark(p, 1.05), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0);
  assert.equal(d.killZone, null);
  assert.equal(d.killzoneEvents.length, 0);
});
test('strip: the zone NEVER arms — a post-TP1 peak through 1.25x accrues no zone state, no event', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.10, killZone: null });
  const d = evaluateExit(p, mark(p, 1.26), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0);
  assert.deepEqual(d.killzoneEvents, []);
  assert.equal(d.killZone, null);
});

// ---- kill zone under the strip: its former prints belonged to the middle
// ---- trail; with the trail also removed (2026-10-16) they simply HOLD ----
test('strip: the former first-entry print now HOLDS — no zone, no trail, no pending, no events', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  const d = evaluateExit(p, mark(p, 1.08), cfg, T0 + 100 * S); // 1.08 is inside the old zone floor AND past the old 15% trail line (1.30 × 0.85 = 1.105)
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  assert.equal(d.exitPending.killzone, undefined);
  assert.deepEqual(d.killzoneEvents, []);
  assert.deepEqual(d.exitConfirmEvents, []);
});
test('strip: a stored armed zone record is inert — entries never count, re-entry kills do not exist', () => {
  const p = rem({ pathClass: 'modest', postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  let d = evaluateExit(p, mark(p, 1.20), cfg, T0 + 100 * S); thread(p, d);   // above the old trail line: holds
  assert.equal(d.fraction, 0);
  assert.equal(d.killZone.entries, 0);
  d = evaluateExit(p, mark(p, 1.30), cfg, T0 + 104 * S); thread(p, d);       // recovery print: no cancel event, no entry counted
  assert.equal(d.fraction, 0);
  assert.deepEqual(d.killzoneEvents, []);
  assert.equal(d.killZone.entries, 0);
  d = evaluateExit(p, mark(p, 1.07), cfg, T0 + 108 * S);                      // second dip past the old trail line: holds — no trail, no zone kill
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  assert.deepEqual(d.killzoneEvents, []);
});

// ---- overlay ladder remainders: ladder intact + zone overlaid ----
test('overlay: TP2 still fires — and the overlay adds nothing (no zone, and no trail since 2026-10-16)', () => {
  const tp2p = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  const dTp2 = evaluateExit(tp2p, mark(tp2p, 1.85), cfg, T0 + 60 * S);
  assert.equal(dTp2.tp2, true);
  // the old trail line (1.32 * 0.85 = 1.122) sat above the zone floor and owned
  // this descent; with the trail removed the dip simply holds
  const trp = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.32, killZone: { armed: true, entries: 0 }, peakRatio: 1.32, peakMove: 1.32 });
  const dTr = evaluateExit(trp, mark(trp, 1.10), cfg, T0 + 60 * S);
  assert.equal(dTr.fraction, 0); assert.equal(dTr.reason, null);
  assert.equal(dTr.exitPending.killzone, undefined);
  // NOTHING takes this dip either — no zone pending arms; the remainder rides on
  const zp = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.26, killZone: { armed: true, entries: 0 }, peakRatio: 1.26, peakMove: 1.26 });
  const dZ = evaluateExit(zp, mark(zp, 1.09), cfg, T0 + 60 * S);
  assert.equal(dZ.fraction, 0); assert.equal(dZ.exitPending.killzone, undefined); assert.deepEqual(dZ.killzoneEvents, []);
});
test('overlay: NEYMAR shape — a run to 2.5x is never zone-sold; post-TP2 the bag trail owns it', () => {
  const p = rem({ pathClass: 'ladder', killZoneOverlay: true, postTp1PeakMove: 1.11, killZone: null, peakRatio: 1.11, peakMove: 1.11 });
  let d = evaluateExit(p, mark(p, 1.40), cfg, T0 + 60 * S); thread(p, d);
  assert.equal(d.fraction, 0);
  d = evaluateExit(p, mark(p, 2.00), cfg, T0 + 120 * S); thread(p, d);
  assert.equal(d.tp2, true, 'the ladder TP2 banks on the way up, as today');
  assert.ok(!d.killzoneEvents.some(e => e.type === 'fired' || e.type === 'reentry'));
  const bag = rem({ pathClass: 'ladder', killZoneOverlay: true, tp2Done: true, postTp1PeakMove: 2.51, killZone: { armed: true, entries: 0 }, peakRatio: 2.51, peakMove: 2.51 });
  const dBag = evaluateExit(bag, mark(bag, 1.05), cfg, T0 + 300 * S);
  assert.equal(dBag.fraction, 1); assert.match(dBag.reason, /moonbag trail/);
});

// ---- >+40% ladder: byte-identical behavior, no zone, no target ----
test('ladder (>40%): no zone accrues, no modest target exists, and no trail (removed 2026-10-16) — the deep fade holds', () => {
  const p = rem({ pathClass: 'ladder', killZoneOverlay: false, postTp1PeakMove: 1.66, killZone: null, peakRatio: 1.66, peakMove: 1.66 });
  const d = evaluateExit(p, mark(p, 1.05), cfg, T0 + 60 * S);
  assert.equal(d.fraction, 0); assert.equal(d.reason, null);
  assert.equal(d.killZone, null); assert.equal(d.killzoneEvents.length, 0);
  const p2 = rem({ pathClass: 'ladder', killZoneOverlay: false, peakRatio: 1.55, peakMove: 1.55 });
  const d2 = evaluateExit(p2, mark(p2, 1.55), cfg, T0 + 60 * S);
  assert.equal(d2.fraction, 0); assert.equal(d2.modestSplit, undefined);
});

// ---- protect under the strip: nothing in the two-path family exists to suppress or fire ----
test('strip + protect: a protected modest remainder gets no zone suppression report and no split — both prints judge as plain ladder', () => {
  const p = rem({ pathClass: 'modest', protected: T0, postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30 });
  const d = evaluateExit(p, mark(p, 1.20), cfg, T0 + 60 * S);   // above the trail line (1.105): holds under any reading
  assert.equal(d.fraction, 0);
  assert.equal(d.protectedBlock, null);
  assert.equal(d.exitPending.killzone, undefined);
  const d2 = evaluateExit(p, mark(p, 1.52), cfg, T0 + 64 * S);  // the old +50% split target print
  assert.equal(d2.modestSplit, undefined);
  assert.equal(d2.fraction, 0);
});

// ---- precedence under the strip: no slot contention remains ----
test('strip: the old bleed-vs-zone contention print now HOLDS — no bleed, no zone, and (2026-10-16) no trail remains to take it', () => {
  const t = T0 + 400 * S; // age 400s: past the old bleed prove-itself window
  const p = rem({ pathClass: 'modest', entryTs: T0, postTp1PeakMove: 1.30, killZone: { armed: true, entries: 0 }, peakRatio: 1.30, peakMove: 1.30, moveHist: [{ ts: t - 60 * S, move: 0.95 }] });
  const d = evaluateExit(p, mark(p, 0.90), cfg, t);
  assert.equal(d.fraction, 0);
  assert.equal(d.reason, null);
  assert.deepEqual(d.exitPending, {});
  assert.deepEqual(d.killzoneEvents, []);
});

// ---- config: knobs + validation ----
test('config: redesign knobs carry the decided defaults and validate', () => {
  const c = loadConfig({ DATA_DIR: '/tmp/twopath-cfg' });
  assert.equal(c.modestMinPct, 0.20); assert.equal(c.modestMaxPct, 0.40);
  assert.equal(c.modestTargetPct, 0.50); assert.equal(c.modestSplitBankFrac, 0.6667);
  assert.equal(c.killZoneFloorPct, 0.10); assert.equal(c.killZoneArmMult, 1.25);
  const bad = loadConfig({ DATA_DIR: '/tmp/twopath-cfg', MODEST_MIN_PCT: '0.5', MODEST_MAX_PCT: '0.4', KILL_ZONE_ARM_MULT: '0.5' });
  const errs = validateConfig(bad);
  assert.ok(errs.some(e => e.includes('MODEST_MAX_PCT')), errs.join('; '));
  assert.ok(errs.some(e => e.includes('KILL_ZONE_ARM_MULT')), errs.join('; '));
});

// ---- bot-level: unprotect re-arms the zone fresh; close records carry the class ----
test('bot: unprotect resets the kill-zone record; ensureClose stamps path; /state exposes path', () => {
  const cfgB = testCfg();
  const exec = new Executor(cfgB, { quote: async (input) => (input === SOL_MINT ? { outAmount: '1000000000', priceImpactPct: '0.01' } : { outAmount: '0' }) });
  const deps = { now: () => T0, exec, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] };
  const bot = new Bot(cfgB, deps);
  const p = { id: 'posZ', mint: 'MINTZ', symbol: 'ZZZ', setup: 'pop', entrySol: 0.05, remainingFrac: 0.6, peakRatio: 1.3, peakMove: 1.3, entryTs: T0, exitPending: {}, protected: T0, pathClass: 'modest', killZone: { armed: true, entries: 1 } };
  bot.positions.push(p);
  assert.equal(bot.state().positions[0].path, 'modest');
  bot.unprotectPosition('MINTZ');
  assert.equal(p.killZone, null, 'unprotect re-arms the zone fresh');
  const ok = bot.ensureClose(p, { id: p.id, mint: p.mint, symbol: p.symbol, setup: p.setup, entrySol: p.entrySol, exitSol: 0.06, pnlSol: 0.01, heldMin: 5, reason: 'test close', simulated: false, ts: T0 });
  assert.equal(ok, true);
  const close = bot.journal.trades.find(x => x.type === 'close' && x.id === 'posZ');
  assert.equal(close.path, 'modest');
});
