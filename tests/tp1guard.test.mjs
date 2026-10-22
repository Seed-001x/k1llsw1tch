// TP1 GUARD (owner order 2026-10-22, exits.js section 3d-guard): the
// middle stage's give-back rule. Once TP1 banks, its fire gain is stamped
// on the position (tp1FireGain); a fall back to/below that line sells
// TP1_GUARD_TRIM_FRAC of the remainder, once; the surviving slice exits
// in full at TP1_GUARD_FLOOR_PCT (default 0 = entry, net of fees). A gap
// straight through both lines exits in full without a trim. Founding
// case: MONEKO 2026-10-22 — TP1 banked +17% adaptive, TP2 (+80%) never
// in reach, remainder rode to −70% and the owner hand-sold it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExit } from '../src/exits.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, tmp } from './helpers.mjs';

const NOW = 1_000_000_000_000;
// txFeeSol 0 (gain == ratio − 1); the other downside families inert so the
// guard is the only judge that can speak; TP2 rejection off (its own
// tests own it) — the guard is what fires below the rejection zone.
const cfg = testCfg({ txFeeSol: 0, dipStopPct: 0, lockKeep: 0, stallSec: 0, stallProbationSec: 0, beArmPct: 0, entryClip: 0, stallExit: 0, tp2RejectZone: 0 });
const pos = (o = {}) => ({ entrySol: 0.2, remainingFrac: 1, peakRatio: 1, peakMove: 1, tp1Done: false, entryTs: NOW - 5 * 60000, exitPending: {}, flowHist: [], moveHist: [], ...o });
const mark = (p, ratio, o = {}) => ({ valueSol: p.entrySol * p.remainingFrac * ratio, liqUsd: 200_000, buysM5: 30, sellsM5: 10, solUsd: 150, volH1: 0, ...o });
// Thread a decision's state back the way bot.js does, booking any partial.
const carry = (p, d) => {
  const q = { ...p };
  if (d.newPeak != null) q.peakRatio = d.newPeak;
  if (d.newPeakMove != null) q.peakMove = d.newPeakMove;
  if ('tp1FireGain' in d) q.tp1FireGain = d.tp1FireGain;
  if ('tp1GuardTrimmed' in d) q.tp1GuardTrimmed = d.tp1GuardTrimmed;
  if (d.fraction > 0 && d.fraction < 1) q.remainingFrac *= (1 - d.fraction);
  if (d.tp1) q.tp1Done = true;
  if (d.tp2) q.tp2Done = true;
  return q;
};
// A MONEKO-shaped middle stage: 0.2 in, TP1 banked 60% at +17%, peak +45%.
const mid = (o = {}) => pos({ tp1Done: true, remainingFrac: 0.4, peakRatio: 1.45, peakMove: 1.45, tp1FireGain: 0.17, ...o });

test('config: TP1 guard defaults on at 0.5 / floor 0, env overrides, validation bounds them', () => {
  const base = loadConfig({ DATA_DIR: tmp() });
  assert.equal(base.tp1Guard, 1);
  assert.equal(base.tp1GuardTrimFrac, 0.5);
  assert.equal(base.tp1GuardFloorPct, 0);
  assert.equal(loadConfig({ DATA_DIR: tmp(), TP1_GUARD: '0' }).tp1Guard, 0);
  assert.equal(loadConfig({ DATA_DIR: tmp(), TP1_GUARD_TRIM_FRAC: '0.25' }).tp1GuardTrimFrac, 0.25);
  assert.equal(loadConfig({ DATA_DIR: tmp(), TP1_GUARD_FLOOR_PCT: '0.05' }).tp1GuardFloorPct, 0.05);
  assert.ok(validateConfig({ ...base, tp1Guard: 2 }).some(e => /TP1_GUARD/.test(e)));
  assert.ok(validateConfig({ ...base, tp1GuardTrimFrac: 1 }).some(e => /TP1_GUARD_TRIM_FRAC/.test(e)));
  assert.ok(validateConfig({ ...base, tp1GuardFloorPct: -0.6 }).some(e => /TP1_GUARD_FLOOR_PCT/.test(e)));
});

test('TP1 fire stamps its gain on the decision (adaptive fade-fire)', () => {
  const p = pos();
  // Sells-heavy tape: strength fails, so the arm fires the check it sets.
  const d = evaluateExit(p, mark(p, 1 + cfg.tp1Pct + 0.02, { buysM5: 5, sellsM5: 30 }), cfg, NOW);
  assert.equal(d.tp1, true);
  assert.ok(Math.abs(d.tp1FireGain - (cfg.tp1Pct + 0.02)) < 1e-9, `fire gain stamped, got ${d.tp1FireGain}`);
});

test('holding above the TP1 line: the guard is silent', () => {
  const p = mid();
  const d = evaluateExit(p, mark(p, 1.30), cfg, NOW);
  assert.equal(d.fraction, 0);
  assert.equal(d.tp1GuardTrimmed, false);
});

test('cross-down through the TP1 line trims half the remainder, once', () => {
  let p = mid();
  let d = evaluateExit(p, mark(p, 1.17), cfg, NOW); // exactly back at the +17% line
  assert.equal(d.fraction, 0.5);
  assert.match(d.reason, /TP1 guard trim/);
  assert.equal(d.tp1GuardTrimmed, true);
  p = carry(p, d);
  assert.equal(p.remainingFrac, 0.2); // 20% of the original rides on
  // Still under the line but above the floor: no second trim, no exit.
  d = evaluateExit(p, mark(p, 1.10), cfg, NOW + 4000);
  assert.equal(d.fraction, 0);
});

test('after the trim, reaching entry exits the last slice in full', () => {
  let p = mid({ tp1GuardTrimmed: true, remainingFrac: 0.2 });
  const d = evaluateExit(p, mark(p, 1.0), cfg, NOW);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /TP1 guard exit/);
});

test('a gap straight through both lines exits in full, no trim first', () => {
  const p = mid();
  const d = evaluateExit(p, mark(p, 0.93), cfg, NOW);
  assert.equal(d.fraction, 1);
  assert.match(d.reason, /TP1 guard exit/);
});

test('no fire stamp (banked before this build): the line falls back to tp1Pct', () => {
  const p = mid({ tp1FireGain: null });
  const d = evaluateExit(p, mark(p, 1 + cfg.tp1Pct - 0.01), cfg, NOW);
  assert.equal(d.fraction, 0.5);
  assert.match(d.reason, /TP1 guard trim/);
});

test('scope: pre-TP1 and post-TP2 positions are never the guard\u2019s', () => {
  const pre = pos({ remainingFrac: 1 });
  assert.equal(evaluateExit(pre, mark(pre, 0.9), cfg, NOW).fraction, 0);
  const bag = mid({ tp2Done: true, remainingFrac: 0.05 });
  assert.equal(evaluateExit(bag, mark(bag, 0.9), cfg, NOW).fraction, 0);
});

test('kill switch: TP1_GUARD=0 leaves the middle stage unguarded', () => {
  const off = { ...cfg, tp1Guard: 0 };
  const p = mid();
  assert.equal(evaluateExit(p, mark(p, 0.93), off, NOW).fraction, 0);
  assert.equal(evaluateExit(p, mark(p, 1.10), off, NOW).fraction, 0);
});
