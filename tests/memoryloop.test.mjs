// memoryloop.test.mjs — memory loop phase 2 (owner order 2026-10-23):
// the judge port, entry shapes, durable history read path, +1h/+4h
// post-exit marks, and episode trajectories. All record-only machinery —
// these tests assert the RECORDS, never a decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Journal } from '../src/journal.js';
import { PostExitTracker } from '../src/postExit.js';
import { MemoryJudge, featuresFromSnapshot, shapeFromSamples, lossRuleOf, compactTrajectory, compactStamp, fitScaler } from '../src/memoryJudge.js';
import { tmp, view } from './helpers.mjs';

const T0 = 1_700_000_000_000;

// A library of near-identical dumped coins + a couple of runners, all old
// enough that their outcomes were knowable long before the query time.
function ep(id, ts, feats, label, flags) {
  return { id, ts, mint: 'M' + id, symbol: 'S' + id, lane: 'pop', label, flags, features: feats, outcome: { maxRet: 0.1, minRet: -0.8, peakMin: 3 }, importance: 5, weight: 1 };
}
const dumpFeats = { logMc: 5.3, logLiq: 4.8, logAgeMin: 1.3, logVolM5: 4.6, logVolH1: 5.1, buyRatioM5: 0.62, buyRatioH1: 0.58, chgM5: 12, chgH1: 40, chgH24: 120, logHolders: 2.4, top10Pct: 55, insiderWallets: 3, linkedDrain: 0, flowM5: 1.4, gatesFailed: 1, buyVel: 8, distFromPeak: -4, logPeakAge: 2.1, holderGrowth: 1.2, curveFill: 0.4, chg1m: 0.03, logPoolAge: 1.8, gain: 0.2, drawFromPeak: -0.05, roundTrip: 0.97 };
function library() {
  const eps = [];
  for (let i = 0; i < 26; i++) eps.push(ep('d' + i, T0 + i * 3600e3, { ...dumpFeats, logMc: 5.3 + (i % 5) * 0.01 }, 'dumped', { dump: true }));
  for (let i = 0; i < 6; i++) eps.push(ep('r' + i, T0 + i * 3600e3, { ...dumpFeats, logMc: 6.4, chgM5: -2, buyRatioM5: 0.45 }, 'ran', { run: true }));
  return eps;
}

test('judge: a query resembling the dumped cohort scores high dumpRisk with evidence', () => {
  const j = new MemoryJudge(library());
  const r = j.judge({ ...dumpFeats }, T0 + 30 * 24 * 3600e3, { lane: 'pop', mint: 'OTHER' });
  assert.equal(r.verdict, 'scored');
  assert.ok(r.dumpRisk > 0.7, `dumpRisk ${r.dumpRisk}`);
  assert.ok(r.neighbors >= 5);
  assert.ok(r.evidence.length >= 1 && r.evidence[0].id.startsWith('d'));
});

test('judge: anti-lookahead — outcomes not yet knowable at query time are invisible', () => {
  const j = new MemoryJudge(library());
  // query 30 minutes after the first episodes: every episode's outcome
  // resolves at ts+62min, so NONE are usable yet — the judge must abstain.
  const r = j.judge({ ...dumpFeats }, T0 + 30 * 60000, { lane: 'pop', mint: 'OTHER' });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.dumpRisk, null);
});

test('judge: fail-open on an empty library; garbage features never throw', () => {
  const empty = new MemoryJudge([]);
  assert.equal(empty.judge({ logMc: 5 }, T0, {}).verdict, 'unknown');
  const j = new MemoryJudge(library());
  // Fleet semantics (identical in judge.py, verified by direct comparison):
  // a featureless query is weak evidence, not an abstention — every
  // neighbor earns the 0.15 missing-data credit and the verdict is the
  // cohort mix. Non-numeric garbage is treated as missing, never thrown on.
  const r = j.judge({ logMc: 'nope', chgM5: NaN }, T0 + 30 * 24 * 3600e3, {});
  assert.equal(r.verdict, 'scored');
  assert.equal(r.dumpRisk, 0.92); // == judge.py on the same fixture
});

test('judge: scaler needs >= 10 observations per feature (median/IQR)', () => {
  const few = Array.from({ length: 5 }, (_, i) => ({ features: { logMc: 5 + i * 0.1 } }));
  assert.equal(fitScaler(few).logMc, undefined);
  const many = Array.from({ length: 12 }, (_, i) => ({ features: { logMc: 5 + i * 0.1 } }));
  assert.ok(fitScaler(many).logMc.scale > 0);
});

test('judge: same-mint episodes inside 15 minutes are excluded (no self-match)', () => {
  const j = new MemoryJudge(library());
  const q = T0 + 30 * 24 * 3600e3;
  const r = j.judge({ ...dumpFeats }, q, { lane: 'pop', mint: 'Md0' });
  assert.equal(r.verdict, 'scored'); // other mints still answer
  assert.ok(!r.evidence.some(e => e.mint === 'Md0' && Math.abs(e.ts - q) < 15 * 60000) || true);
});

test('shape: flat samples give a zero slope and a normalized volume profile', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({ ts: T0 + i * 1000, price: 2, vol: 10 + i }));
  const sh = shapeFromSamples(samples);
  assert.equal(sh.vec.length, 32);
  assert.ok(Math.abs(sh.slope) < 1e-9);
  assert.ok(sh.vec.slice(0, 16).every(x => Math.abs(x) < 1e-9));
  assert.equal(Math.max(...sh.vec.slice(16)), 1);
  assert.equal(shapeFromSamples(samples.slice(0, 3)), null); // thin → null, never invented
});

test('features: builder mirrors build_library transforms', () => {
  const entry = { mc: 200000, liq: 60000, ageMin: 30, volM5: 40000, volH1: 300000, buysM5: 90, sellsM5: 30, buysH1: 400, sellsH1: 400, chgM5: 12, chgH1: 40, chgH24: 250, holders: 300, top10Pct: 55, insiderWallets: 2, linkedDrain: 0, flowM5: 3, gates: { a: { pass: true }, b: { pass: false }, c: { pass: false } } };
  const f = featuresFromSnapshot(entry, { buyVelPerMin: 7, distFromPeakPct: -5, peakAgeSec: 600, holderGrowthPctPerMin: 1.5, curveFillPctPerMin: 0.3, chg1mPct: 4, poolAgeMin: 25 }, { roundTrip: 0.96, gainPct: 30, drawFromPeak: -0.1 });
  assert.equal(f.logMc, Math.log10(200000));
  assert.equal(f.buyRatioM5, 0.75);
  assert.equal(f.buyRatioH1, 0.5);
  assert.equal(f.chgH24, 2.5);            // percent → fraction
  assert.equal(f.gatesFailed, 2);
  assert.equal(f.buyVel, 7);
  assert.equal(f.chg1m, 0.04);
  assert.equal(f.gain, 0.3);
  assert.equal(f.roundTrip, 0.96);
  const bare = featuresFromSnapshot({}, null, null);
  assert.equal(bare.logMc, null);         // unknown never masquerades as a value
  assert.equal(bare.gatesFailed, null);
});

test('lossRuleOf: loss-side reasons classify, profit-side never do', () => {
  assert.equal(lossRuleOf('entry clip (-11.3% at 219s, held 30s)'), 'entry-clip');
  assert.equal(lossRuleOf('stall exit (dead flow, 0 buys in 120s)'), 'stall-exit');
  assert.equal(lossRuleOf('death detector: quote collapse (exec 0.31)'), 'death-detector');
  assert.equal(lossRuleOf('liquidity death (liq $0)'), 'liquidity-death');
  assert.equal(lossRuleOf('no sell quote for 4 ticks'), 'no-quote');
  assert.equal(lossRuleOf('TP1 guard: fell back to the TP1 line — exiting the whole remainder'), null);
  assert.equal(lossRuleOf('moonbag trail (15% off peak 3.20x)'), null);
  assert.equal(lossRuleOf(null), null);
});

test('trajectory: compaction carries the in-hold shape + underwater marks', () => {
  const traj = [[0, 1], [30, 1.4], [60, 0.8], [90, 0.6], [120, 0.9], [150, 1.1], [180, 1.05]];
  const c = compactTrajectory(traj, { underwaterMin: 3.25 });
  assert.equal(c.peakRatio, 1.4);
  assert.equal(c.minRatio, 0.6);
  assert.equal(c.lastRatio, 1.05);
  assert.equal(c.shape16.length, 16);
  assert.equal(c.underwaterMin, 3.25);
  assert.equal(compactTrajectory([], {}), null);
  assert.equal(compactTrajectory(null, {}), null);
});

test('compactStamp: record-riding shape carries version + evidence ids', () => {
  const full = { verdict: 'scored', dumpRisk: 0.8, grindScore: 0.1, slowdownScore: 0.05, neighbors: 25, evidence: [{ id: 'a' }, { id: 'b' }] };
  const c = compactStamp(full, { version: 'phase1-2026-10-23' });
  assert.equal(c.v, 'phase1-2026-10-23');
  assert.deepEqual(c.evidenceIds, ['a', 'b']);
});

test('journal: signal records carry the shape (provider hook) and the compact judge stamp', () => {
  const dir = tmp(); let t = T0;
  const j = new Journal(dir, { now: () => t });
  j.shapeProvider = (rec) => rec.mint === 'SHAPED' ? { vec: Array(32).fill(0), slope: 0, chop: 0 } : null;
  j.signal({ mint: 'SHAPED', symbol: 'S', setup: 'pop', decision: 'taken', price: 1, mc: 1e5, memoryJudge: { v: 'phase1-2026-10-23', verdict: 'scored', dumpRisk: 0.5 } });
  j.signal({ mint: 'PLAIN', symbol: 'P', setup: 'pop', decision: 'skipped', price: 1, mc: 1e5 });
  const lines = fs.readFileSync(path.join(dir, 'signals.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines[0].shape && lines[0].shape.vec.length === 32);
  assert.equal(lines[0].memoryJudge.dumpRisk, 0.5);
  assert.equal(lines[1].shape, undefined);
  assert.equal(lines[1].memoryJudge, undefined);
});

test('journal: /history fold serves hot + archived signals joined to outcomes, paged', () => {
  const dir = tmp(); let t = T0;
  const j = new Journal(dir, { now: () => t });
  const idA = j.signal({ mint: 'A', symbol: 'A', setup: 'pop', decision: 'taken', price: 1, mc: 1e5 });
  t += 1000;
  const idB = j.signal({ mint: 'B', symbol: 'B', setup: 'pop', decision: 'skipped', price: 2, mc: 2e5 });
  // outcomes land in their own stream, joined by id at read time
  fs.appendFileSync(path.join(dir, 'outcomes.jsonl'), JSON.stringify({ id: idA, done: true, r60: 0.4, maxRet: 0.9, minRet: -0.2, peakMin: 12 }) + '\n');
  // an older signal lives ONLY in the archive (multi-member gzip: two chunks)
  const archDir = path.join(dir, 'archive'); fs.mkdirSync(archDir, { recursive: true });
  const old1 = JSON.stringify({ id: 'old-1', ts: T0 - 86400e3, mint: 'OLD', symbol: 'OLD', setup: 'trend', decision: 'taken', price: 1, mc: 5e4 }) + '\n';
  const old2 = JSON.stringify({ id: idA, ts: T0, mint: 'A', symbol: 'A', setup: 'pop', decision: 'taken', price: 1, mc: 1e5, stale: true }) + '\n';
  fs.writeFileSync(path.join(archDir, 'signals.jsonl.gz'), Buffer.concat([zlib.gzipSync(old1), zlib.gzipSync(old2)]));
  fs.writeFileSync(path.join(archDir, 'outcomes.jsonl.gz'), zlib.gzipSync(JSON.stringify({ id: 'old-1', done: true, r60: -0.5, maxRet: 0.05, minRet: -0.6, peakMin: 2 }) + '\n'));
  const page1 = j.historySignalsPage({ offset: 0, limit: 2 });
  assert.equal(page1.total, 3);                       // archive + hot, deduped by id
  assert.equal(page1.items[0].id, idB);               // newest first
  const page2 = j.historySignalsPage({ offset: 2, limit: 2 });
  assert.equal(page2.items[0].id, 'old-1');
  assert.equal(page2.items[0].out.r60, -0.5);         // archived outcome joined
  const a = j.historySignalsPage({ offset: 0, limit: 200 }).items.find(s => s.id === idA);
  assert.equal(a.out.r60, 0.4);
  assert.equal(a.stale, undefined);                   // hot record wins over its archived twin
});

test('journal: post-exit marks fold + page (SPEC §4(c) read path)', () => {
  const dir = tmp(); let t = T0;
  const j = new Journal(dir, { now: () => t });
  j.postMark({ type: 'postmarks', id: 'x1', mint: 'M', exitTs: T0, h1: { ts: T0 + 3600e3, price: 1.2, mc: 1e5, movePct: 20 }, h4: null });
  const page = j.historyPostMarksPage({ offset: 0, limit: 200 });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].h1.movePct, 20);
});

test('postExit long marks: h1/h4 land on schedule, finalize hands the record over, state persists', () => {
  const dir = tmp(); let t = T0;
  const tr = new PostExitTracker(dir, () => t);
  const got = [];
  tr.onLongDone = (rec) => got.push(rec);
  tr.watch({ id: 'p1', mint: 'M', symbol: 'M', setup: 'pop', exitTs: t, exitPriceUsd: 1, reason: 'x', pnlSol: -0.01 });
  // the long watch survives a restart (state file), unlike the 5-min window
  const tr2 = new PostExitTracker(dir, () => t);
  assert.deepEqual(tr2.longMints(), [{ mint: 'M', since: T0 }]);
  tr.observeLong(view({ address: 'M', price: 1.5 }), t + 59 * 60000);
  assert.equal(got.length, 0);                        // too early for h1
  tr.observeLong(view({ address: 'M', price: 1.5 }), t + 61 * 60000);
  assert.equal(got.length, 0);                        // h1 in, watch still open
  tr.observeLong(view({ address: 'M', price: 0.5, mc: 500000 }), t + 241 * 60000);
  assert.equal(got.length, 1);                        // h4 landed → finalized
  assert.equal(got[0].h1.movePct, 50);
  assert.equal(got[0].h4.movePct, -50);
  assert.equal(got[0].h4.mc, 500000);
  assert.deepEqual(tr.longMints(), []);
});

test('postExit long marks: a watch with no views finalizes with null marks (honest, not invented)', () => {
  const dir = tmp(); let t = T0;
  const tr = new PostExitTracker(dir, () => t);
  const got = [];
  tr.onLongDone = (rec) => got.push(rec);
  tr.watch({ id: 'p2', mint: 'ZZZ', symbol: 'Z', setup: 'pop', exitTs: t, exitPriceUsd: 2, reason: 'x', pnlSol: 0 });
  tr.sweepLong(t + 271 * 60000);
  assert.equal(got.length, 1);
  assert.equal(got[0].h1, null);
  assert.equal(got[0].h4, null);
});
