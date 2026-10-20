// Killswitch Veto Shadow (owner order 2026-10-19): the 8 held Part-1 entry
// vetoes evaluated in shadow at gate time — would-veto records in
// veto_shadow.jsonl, forward outcomes joined at read time, /vetoshadow
// serving the live-vs-shadow card. Record-only: these tests pin the rule
// math (exactly as written in the brief/backtest, boundaries included), the
// linkedDrain stamp extraction (incl. the shadow-gates fallback — the
// follow-up report's ZeroFee lesson), the close-basis R1 leg, and the hard
// boundary that a shadow failure can never disturb the signal path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { evaluateVetoes, parseLinkedDrainReason, linkedDrainFromChecks, buildVetoCard, r8PostPumpBounce, entryQualityStamp, liveTapeStamp, EQ_VOLM5_TERCILE_LOW, EQ_VOLM5_TERCILE_HIGH, VETO_RULES } from '../src/vetoLab.js';
import { newCensus, censusFold } from '../src/census.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const MIN = 60000;
const readVeto = (dir) => { try { return fs.readFileSync(path.join(dir, 'veto_shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const base = { setup: 'pop', chgM5: null, chgH1: null, chgH24: null, ageMin: null, linkedDrain: null, topGuardDistPct: null, topGuardHighAgeSec: null, fakeAliveShare: null };

test('veto: each rule fires exactly at its written line, not before', () => {
  // R1 fakeAlive.share > 0.30 (strict)
  assert.deepEqual(evaluateVetoes({ ...base, fakeAliveShare: 0.30 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, fakeAliveShare: 0.31 }), ['R1']);
  // R2 linkedDrain > 0.10 (strict)
  assert.deepEqual(evaluateVetoes({ ...base, linkedDrain: 0.10 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, linkedDrain: 0.11 }), ['R2']);
  // R3 ageMin < 5 AND chgM5 <= -30 (age strict, chg inclusive)
  assert.deepEqual(evaluateVetoes({ ...base, ageMin: 4, chgM5: -30 }), ['R3']);
  assert.deepEqual(evaluateVetoes({ ...base, ageMin: 5, chgM5: -30 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, ageMin: 4, chgM5: -29.9 }), []);
  // R4 chgM5 > 20 (strict)
  assert.deepEqual(evaluateVetoes({ ...base, chgM5: 20 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, chgM5: 20.1 }), ['R4']);
  // R5 chgH1 > 150 (strict)
  assert.deepEqual(evaluateVetoes({ ...base, chgH1: 150 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, chgH1: 151 }), ['R5']);
  // R6 chgH24 > 500 AND chgH1 < -25 (both strict)
  assert.deepEqual(evaluateVetoes({ ...base, chgH24: 500, chgH1: -26 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, chgH24: 501, chgH1: -25 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, chgH24: 501, chgH1: -26 }), ['R6']);
  // R7 topGuard distPct < 5 AND highAgeSec < 300 (both strict)
  assert.deepEqual(evaluateVetoes({ ...base, topGuardDistPct: 5, topGuardHighAgeSec: 100 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, topGuardDistPct: 4.9, topGuardHighAgeSec: 300 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, topGuardDistPct: 4.9, topGuardHighAgeSec: 299 }), ['R7']);
  // R8 chgM5 < -15, confluence/bottom lanes only
  assert.deepEqual(evaluateVetoes({ ...base, chgM5: -20 }), []); // pop lane: no fire
  assert.deepEqual(evaluateVetoes({ ...base, setup: 'bottom', chgM5: -15 }), []);
  assert.deepEqual(evaluateVetoes({ ...base, setup: 'bottom', chgM5: -15.1 }), ['R8']);
  assert.deepEqual(evaluateVetoes({ ...base, setup: 'confluence', chgM5: -45 }), ['R8']);
});

test('veto: R8 post-pump-bounce tag — pumped-then-dumping only, missing fields stay false', () => {
  // the owner's fixture: chgH1 80, chgM5 -20, confluence — pumped, now dumping
  const pumped = { ...base, setup: 'confluence', chgM5: -20, chgH1: 80, chgH24: 20 };
  assert.deepEqual(evaluateVetoes(pumped), ['R8']);
  assert.equal(r8PostPumpBounce(pumped, ['R8']), true);
  // pumped on the 24h line instead of the 1h line
  const pumpedDay = { ...base, setup: 'bottom', chgM5: -20, chgH1: 10, chgH24: 150 };
  assert.deepEqual(evaluateVetoes(pumpedDay), ['R8']);
  assert.equal(r8PostPumpBounce(pumpedDay, ['R8']), true);
  // the owner's counter-fixture: chgH1 10, chgH24 20 — a dump with no pump behind it
  const quiet = { ...base, setup: 'confluence', chgM5: -20, chgH1: 10, chgH24: 20 };
  assert.deepEqual(evaluateVetoes(quiet), ['R8']);
  assert.equal(r8PostPumpBounce(quiet, ['R8']), false);
  // the lines themselves count as pumped (>=, percent units as stamped)
  assert.equal(r8PostPumpBounce({ ...base, setup: 'bottom', chgM5: -20, chgH1: 50 }, ['R8']), true);
  assert.equal(r8PostPumpBounce({ ...base, setup: 'bottom', chgM5: -20, chgH24: 100 }, ['R8']), true);
  assert.equal(r8PostPumpBounce({ ...base, setup: 'bottom', chgM5: -20, chgH1: 49.9, chgH24: 99.9 }, ['R8']), false);
  // missing features -> false, never guessed
  assert.equal(r8PostPumpBounce({ ...base, setup: 'confluence', chgM5: -20 }, ['R8']), false);
  assert.equal(r8PostPumpBounce(null, ['R8']), false);
  assert.equal(r8PostPumpBounce(pumped, null), false);
  // no R8 fire -> no tag, even on a coin that pumped hard (pop lane, R5 fires instead)
  const pumpedNoR8 = { ...base, setup: 'pop', chgM5: -20, chgH1: 300 };
  assert.deepEqual(evaluateVetoes(pumpedNoR8), ['R5']);
  assert.equal(r8PostPumpBounce(pumpedNoR8, evaluateVetoes(pumpedNoR8)), false);
});

test('veto: card counts post-pump-bounce tags on the R8 aggregate only', () => {
  const recs = [
    { kind: 'veto', ts: 1, mint: 'A', symbol: 'A', setup: 'confluence', decision: 'skipped', basis: 'signal', rules: ['R8'], signalId: 'x1', postPumpBounce: true },
    { kind: 'veto', ts: 2, mint: 'B', symbol: 'B', setup: 'bottom', decision: 'skipped', basis: 'signal', rules: ['R8'], signalId: 'x2', postPumpBounce: false },
    { kind: 'veto', ts: 3, mint: 'C', symbol: 'C', setup: 'confluence', decision: 'skipped', basis: 'signal', rules: ['R8', 'R2'], signalId: 'x3' }, // pre-tag record: no field at all
    { kind: 'veto', ts: 4, mint: 'D', symbol: 'D', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R2'], signalId: 'x4' },
  ];
  const card = buildVetoCard(recs, () => null);
  assert.equal(card.perRule.R8.wouldVeto, 3);
  assert.equal(card.perRule.R8.postPumpBounce, 1);
  assert.equal(card.perRule.R2.postPumpBounce, undefined); // the count lives on R8 only
});

test('veto: Shrub-shaped input fires the same four rules the backtest found', () => {
  const fired = evaluateVetoes({ setup: 'confluence', chgM5: -45.59, chgH1: null, chgH24: null, ageMin: 1, linkedDrain: 0.118, topGuardDistPct: null, topGuardHighAgeSec: null, fakeAliveShare: 0.529 });
  assert.deepEqual(fired, ['R1', 'R2', 'R3', 'R8']);
});

test('veto: unstamped features never fire, garbage never throws', () => {
  assert.deepEqual(evaluateVetoes(base), []);
  assert.deepEqual(evaluateVetoes(null), []);
  assert.deepEqual(evaluateVetoes(undefined), []);
  assert.deepEqual(evaluateVetoes('junk'), []);
  assert.deepEqual(evaluateVetoes({ chgM5: NaN, chgH1: Infinity, linkedDrain: {}, ageMin: [] }), []);
  assert.equal(VETO_RULES.length, 8);
});

test('veto: linkedDrain extraction — raw stamp, reason parse, shadow-gates fallback', () => {
  assert.equal(parseLinkedDrainReason('linked stack could pull 36% of pool SOL'), 0.36);
  assert.equal(parseLinkedDrainReason('linked wallets could dump in one go and pull 42% of pool SOL'), 0.42);
  assert.equal(parseLinkedDrainReason('no linked stack'), 0);
  assert.equal(parseLinkedDrainReason('pool data missing'), null);
  assert.equal(parseLinkedDrainReason(null), null);
  // raw numeric drain wins over the (rounded) reason text
  assert.equal(linkedDrainFromChecks({ linkedDump: { pass: false, drain: 0.364, reason: 'linked stack could pull 36% of pool SOL' } }, null), 0.364);
  // summary-only checks (what skip() actually receives) parse from reason
  assert.equal(linkedDrainFromChecks({ linkedDump: { pass: true, reason: 'linked stack could pull 36% of pool SOL' } }, null), 0.36);
  // ZeroFee shape: the stamp lives in the shadow gates, not the live checks
  assert.equal(linkedDrainFromChecks({}, { linkedDump: { pass: true, reason: 'linked stack could pull 36% of pool SOL' } }), 0.36);
  assert.equal(linkedDrainFromChecks(null, { linkedDump: { pass: false, drain: 0.421, reason: 'x' } }), 0.421);
  // measured zero beats nothing-at-all; unmeasured stays null
  assert.equal(linkedDrainFromChecks({ linkedDump: { pass: true, reason: 'no linked stack' } }, null), 0);
  assert.equal(linkedDrainFromChecks({ linkedDump: { pass: true, unknown: true, reason: 'pool data missing' } }, null), null);
  assert.equal(linkedDrainFromChecks(null, null), null);
  assert.equal(linkedDrainFromChecks({ linkedDump: null }, { other: 1 }), null);
});

test('veto: card folds records per rule with the live (taken) column split out', () => {
  const outcomes = {
    s1: { done: true, r15: 0.1, r60: -0.5, maxRet: 0.2, partial: false },
    s3: { done: true, r15: -0.2, r60: -0.6, maxRet: 0.05, partial: false },
  };
  const recs = [
    { kind: 'veto', ts: 1, mint: 'A', symbol: 'A', setup: 'pop', decision: 'taken', basis: 'signal', rules: ['R2', 'R4'], signalId: 's1' },
    { kind: 'veto', ts: 2, mint: 'B', symbol: 'B', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R2'], signalId: 's2' },
    { kind: 'veto', ts: 3, mint: 'C', symbol: 'C', setup: 'bottom', decision: 'taken', basis: 'close', rules: ['R1'], signalId: 's3', pnlSol: -0.05 },
    { kind: 'note', ts: 4, rules: ['R2'] }, // foreign record kinds are ignored
  ];
  const card = buildVetoCard(recs, (id) => outcomes[id] || null);
  assert.equal(card.perRule.R2.wouldVeto, 2);
  assert.equal(card.perRule.R2.taken, 1);
  assert.equal(card.perRule.R2.skipped, 1);
  assert.equal(card.perRule.R2.finalized, 1);
  assert.equal(card.perRule.R2.medianR60, -0.5);
  assert.equal(card.perRule.R4.wouldVeto, 1);
  assert.equal(card.perRule.R4.medianR15, 0.1);
  assert.equal(card.perRule.R1.wouldVeto, 1);
  assert.equal(card.perRule.R1.realizedPnlSol, -0.05);
  assert.equal(card.perRule.R1.realizedN, 1);
  assert.equal(card.perRule.R8.wouldVeto, 0);
  assert.equal(card.totals.records, 3);
  assert.equal(card.totals.wouldVetoSignals, 2);
  assert.equal(card.totals.takenLive, 1);
  assert.equal(card.totals.r1TakenCloses, 1);
  assert.equal(card.recent[0].symbol, 'C'); // newest first
  assert.equal(card.recent[0].out.r60, -0.6);
});

test('veto: journal joins the would-veto to the signal tracked outcome at read time', () => {
  const dir = tmp();
  let t = T0;
  const j = new Journal(dir, { now: () => t });
  const sid = j.signal({ mint: 'M1', symbol: 'HOT', setup: 'pop', decision: 'skipped', reasons: ['gates'], price: 100, mc: 50000 });
  j.vetoShadow({ kind: 'veto', id: sid, ts: t, basis: 'signal', mint: 'M1', symbol: 'HOT', setup: 'pop', decision: 'skipped', reason: 'gates', rules: ['R4'], features: { chgM5: 33 }, signalId: sid, mc: 50000, price: 100 });
  // pending: no finalized aggregates yet
  let card = j.vetoCard();
  assert.equal(card.perRule.R4.wouldVeto, 1);
  assert.equal(card.perRule.R4.finalized, 0);
  assert.equal(card.perRule.R4.medianR60, null);
  // drive the outcome machinery: +50% by 15m, -20% by 60m
  t = T0 + 16 * MIN; j.observe({ address: 'M1', price: 150 });
  t = T0 + 61 * MIN; j.observe({ address: 'M1', price: 80 });
  card = j.vetoCard();
  assert.equal(card.perRule.R4.finalized, 1);
  assert.equal(card.perRule.R4.medianR15, 0.5);
  assert.equal(card.perRule.R4.medianR60, -0.2);
  assert.equal(card.perRule.R4.sharePosR60, 0);
  assert.equal(readVeto(dir).length, 1);
});

function rigBot(dir, nowFn) {
  const cfg = testCfg({ dataDir: dir });
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  return new Bot(cfg, {
    now: nowFn || (() => T0), exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
}

test('veto: bot.skip journals a would-veto beside the skipped signal — and only on a fire', () => {
  const dir = tmp();
  const bot = rigBot(dir);
  const hot = view({ address: 'HOTMINT', symbol: 'HOT', chgM5: 33.04, chgH1: 183, createdAt: T0 - 3600e3 });
  bot.skip(hot, { setup: 'pop', metrics: {} }, ['some gate'], [], { linkedDump: { pass: true, reason: 'linked stack could pull 36% of pool SOL' } }, true);
  const recs = readVeto(dir);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].rules, ['R2', 'R4', 'R5']);
  assert.equal(recs[0].decision, 'skipped');
  assert.equal(recs[0].features.linkedDrain, 0.36);
  assert.equal(recs[0].features.chgM5, 33.04);
  assert.ok(recs[0].signalId);
  assert.equal(bot.journal.signals.length, 1);
  assert.equal(bot.journal.signals[0].decision, 'skipped');
  // a calm signal writes no veto record
  const calm = view({ address: 'CALMMINT', symbol: 'CALM', chgM5: 2, chgH1: 5, chgH24: 10, createdAt: T0 - 3600e3 });
  bot.skip(calm, { setup: 'pop', metrics: {} }, ['some gate'], [], { linkedDump: { pass: true, reason: 'no linked stack' } }, true);
  assert.equal(readVeto(dir).length, 1);
  assert.equal(bot.journal.signals.length, 2);
});

test('veto: bot journals postPumpBounce on R8 records only — true pumped, false quiet, absent otherwise', () => {
  const dir = tmp();
  const bot = rigBot(dir);
  const gates = { linkedDump: { pass: true, reason: 'no linked stack' } };
  // Gemma/KIM shape: +80% on the hour, now falling hard on the confluence lane
  const pumped = view({ address: 'GEMMA', symbol: 'GEMMA', chgM5: -22, chgH1: 80, chgH24: 20, createdAt: T0 - 3600e3 });
  bot.skip(pumped, { setup: 'confluence', metrics: {} }, ['g'], [], gates, true);
  // same dump, no pump behind it
  const quiet = view({ address: 'QUIET', symbol: 'QUIET', chgM5: -22, chgH1: 10, chgH24: 20, createdAt: T0 - 3600e3 });
  bot.skip(quiet, { setup: 'confluence', metrics: {} }, ['g'], [], gates, true);
  // a non-R8 fire (hot pop) carries no tag field at all
  const hot = view({ address: 'HOT2', symbol: 'HOT2', chgM5: 33, chgH1: 80, chgH24: 20, createdAt: T0 - 3600e3 });
  bot.skip(hot, { setup: 'pop', metrics: {} }, ['g'], [], gates, true);
  const recs = readVeto(dir);
  assert.equal(recs.length, 3);
  const byMint = Object.fromEntries(recs.map(r => [r.mint, r]));
  assert.deepEqual(byMint.GEMMA.rules, ['R8']);
  assert.equal(byMint.GEMMA.postPumpBounce, true);
  assert.deepEqual(byMint.QUIET.rules, ['R8']);
  assert.equal(byMint.QUIET.postPumpBounce, false);
  assert.ok(!byMint.HOT2.rules.includes('R8'));
  assert.ok(!('postPumpBounce' in byMint.HOT2), 'non-R8 records carry no tag field');
  const card = bot.vetoCard();
  assert.equal(card.perRule.R8.wouldVeto, 2);
  assert.equal(card.perRule.R8.postPumpBounce, 1);
});

test('veto: a throwing shadow write can never disturb the signal path', () => {
  const dir = tmp();
  const bot = rigBot(dir);
  bot.journal.vetoShadow = () => { throw new Error('disk on fire'); };
  const hot = view({ address: 'HOTMINT', symbol: 'HOT', chgM5: 86.17, createdAt: T0 - 3600e3 });
  assert.doesNotThrow(() => bot.skip(hot, { setup: 'bottom', metrics: {} }, ['x'], [], {}, null));
  assert.equal(bot.journal.signals.length, 1); // the signal itself still journaled
  // hostile feature shapes also stay silent
  const weird = view({ address: 'WEIRDMINT', symbol: 'WEIRD', chgM5: 'hot', chgH1: undefined, createdAt: 'garbage' });
  assert.doesNotThrow(() => bot._noteVetoShadow({ v: weird, sig: { setup: 'pop' }, checks: { linkedDump: 42, topGuard: 'nope' }, decision: 'skipped', reasons: [], signalId: null }));
});

test('veto: R1 is judged at close on the final fake-alive stamp', () => {
  const dir = tmp();
  const bot = rigBot(dir);
  const sid = bot.journal.signal({ mint: 'GRIND', symbol: 'GRIND', setup: 'confluence', decision: 'taken', reasons: [], price: 1, mc: 30000 });
  const pos = { id: 'GRINDX-1', mint: 'GRIND', symbol: 'GRIND', setup: 'confluence', entryTs: T0 + 3000, entryMc: 30000, entryPrice: 1, entry: { chgM5: -45.59, ageMin: 1, linkedDrain: 0.118 } };
  // share at the line and below: nothing
  bot._noteVetoClose(pos, { fakeAlive: { samples: 9, fake: 2, share: 0.30 }, pnlSol: -0.01, reason: 'x' });
  bot._noteVetoClose(pos, { fakeAlive: { samples: 9, fake: 1, share: 0.11 }, pnlSol: -0.01, reason: 'x' });
  bot._noteVetoClose(pos, { fakeAlive: null, pnlSol: -0.01, reason: 'x' });
  assert.equal(readVeto(dir).length, 0);
  // the Shrub shape: share 0.529 over the hold -> close-basis would-veto
  bot._noteVetoClose(pos, { fakeAlive: { samples: 9, fake: 5, share: 0.529 }, pnlSol: -0.0712, pnlPct: -71.2, reason: 'death detector' });
  const recs = readVeto(dir);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].basis, 'close');
  assert.deepEqual(recs[0].rules, ['R1']);
  assert.equal(recs[0].features.fakeAliveShare, 0.529);
  assert.equal(recs[0].pnlSol, -0.0712);
  assert.equal(recs[0].signalId, sid); // entry signal re-found for the outcome join
  const card = bot.vetoCard();
  assert.equal(card.perRule.R1.wouldVeto, 1);
  assert.equal(card.perRule.R1.taken, 1);
  assert.equal(card.perRule.R1.realizedPnlSol, -0.0712);
  assert.equal(card.totals.r1TakenCloses, 1);
});

test('entryQuality: stamp bands volM5 at the frozen step-4 terciles, dead tape is the low band only', () => {
  // the cutoffs themselves: the step-4 base's 33 1/3 / 66 2/3 percentiles
  // (n=244, computed 2026-10-19 — see vetoLab.js for the derivation)
  assert.equal(EQ_VOLM5_TERCILE_LOW, 13155.71);
  assert.equal(EQ_VOLM5_TERCILE_HIGH, 27529.46);
  // low band, right up to the line — and dead tape
  assert.deepEqual(entryQualityStamp({ volM5: 0, buysM5: 3, sellsM5: 9, chgH1: -4 }),
    { volM5: 0, buysM5: 3, sellsM5: 9, chgH1: -4, activityBand: 'low', deadTape: true });
  assert.equal(entryQualityStamp({ volM5: 13062.89 }).activityBand, 'low'); // the base's own low-segment max
  assert.equal(entryQualityStamp({ volM5: 13155.70 }).activityBand, 'low');
  assert.equal(entryQualityStamp({ volM5: 13155.70 }).deadTape, true);
  // at the line -> mid (the base's mid segment starts at 13,155.71)
  assert.equal(entryQualityStamp({ volM5: 13155.71 }).activityBand, 'mid');
  assert.equal(entryQualityStamp({ volM5: 13155.71 }).deadTape, false);
  assert.equal(entryQualityStamp({ volM5: 20000 }).activityBand, 'mid');
  assert.equal(entryQualityStamp({ volM5: 27486.32 }).activityBand, 'mid'); // the base's mid-segment max
  assert.equal(entryQualityStamp({ volM5: 27529.45 }).activityBand, 'mid');
  // at the high line -> high (the base's high segment starts at 27,529.46)
  assert.equal(entryQualityStamp({ volM5: 27529.46 }).activityBand, 'high');
  assert.equal(entryQualityStamp({ volM5: 349820.03 }).activityBand, 'high'); // the base's max
  assert.equal(entryQualityStamp({ volM5: 27529.46 }).deadTape, false);
  // raw fields ride along untouched
  assert.deepEqual(entryQualityStamp({ volM5: 50000, buysM5: 30, sellsM5: 10, chgH1: 5 }),
    { volM5: 50000, buysM5: 30, sellsM5: 10, chgH1: 5, activityBand: 'high', deadTape: false });
});

test('entryQuality: unstamped fields stay null and never make a band (never guessed)', () => {
  const blank = { volM5: null, buysM5: null, sellsM5: null, chgH1: null, activityBand: null, deadTape: false };
  assert.deepEqual(entryQualityStamp({}), blank);
  assert.deepEqual(entryQualityStamp({ volM5: null, buysM5: undefined, sellsM5: NaN, chgH1: 'hot' }), blank);
  assert.deepEqual(entryQualityStamp(null), blank);
  assert.deepEqual(entryQualityStamp(undefined), blank);
  assert.deepEqual(entryQualityStamp('junk'), blank);
  // a band needs volM5 alone: the other fields missing does not unmake it
  assert.deepEqual(entryQualityStamp({ volM5: 4000 }),
    { volM5: 4000, buysM5: null, sellsM5: null, chgH1: null, activityBand: 'low', deadTape: true });
});

test('entryQuality: card aggregates count bands + dead tape off the same outcome joins', () => {
  const outcomes = {
    q1: { done: true, r15: 0.05, r60: -0.40, maxRet: 0.1, partial: false },
    q2: { done: true, r15: -0.1, r60: -0.60, maxRet: 0.0, partial: false },
    q3: { done: true, r15: 0.2, r60: 0.30, maxRet: 0.5, partial: false },
    q4: { done: true, r15: 0.0, r60: 0.10, maxRet: 0.2, partial: false },
    q5: { done: false, r15: null, r60: null, maxRet: null, partial: true }, // still tracking: counted, not finalized
  };
  const eq = (volM5, band, dead) => ({ volM5, buysM5: 1, sellsM5: 1, chgH1: 0, activityBand: band, deadTape: dead });
  const recs = [
    { kind: 'veto', ts: 1, mint: 'A', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R4'], signalId: 'q1', entryQuality: eq(4000, 'low', true) },
    { kind: 'veto', ts: 2, mint: 'B', setup: 'pop', decision: 'taken', basis: 'signal', rules: ['R2'], signalId: 'q2', entryQuality: eq(9000, 'low', true) },
    { kind: 'veto', ts: 3, mint: 'C', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R4'], signalId: 'q3', entryQuality: eq(20000, 'mid', false) },
    { kind: 'veto', ts: 4, mint: 'D', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R5'], signalId: 'q4', entryQuality: eq(90000, 'high', false) },
    { kind: 'veto', ts: 5, mint: 'E', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R4'], signalId: 'q5', entryQuality: eq(60000, 'high', false) },
    { kind: 'veto', ts: 6, mint: 'F', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R4'], signalId: 'q6', entryQuality: eq(null, null, false) }, // stamped, but no volM5 that day
    { kind: 'veto', ts: 7, mint: 'G', setup: 'pop', decision: 'skipped', basis: 'signal', rules: ['R4'], signalId: 'q7' }, // pre-stamp record: excluded, never back-filled
  ];
  const card = buildVetoCard(recs, (id) => outcomes[id] || null);
  const s = card.entryQuality;
  assert.equal(s.total, 6);
  assert.equal(s.noBand, 1);
  assert.deepEqual(s.bands.low, { n: 2, finalized: 2, medianR60: -0.5, shareR60Positive: 0 });
  assert.deepEqual(s.bands.mid, { n: 1, finalized: 1, medianR60: 0.3, shareR60Positive: 1 });
  assert.deepEqual(s.bands.high, { n: 2, finalized: 1, medianR60: 0.1, shareR60Positive: 1 });
  assert.deepEqual(s.deadTape, { wouldSkip: 2, finalized: 2, medianR60: -0.5, shareR60Positive: 0 });
  // the veto card itself is untouched by the new summary
  assert.equal(card.totals.records, 7);
  assert.equal(card.perRule.R4.wouldVeto, 5);
  // recent rows carry the stamp through for inspection
  const byMint = Object.fromEntries(card.recent.map(r => [r.mint, r]));
  assert.equal(byMint.A.entryQuality.activityBand, 'low');
  assert.equal(byMint.G.entryQuality, null);
  // empty card: zeros and nulls, no crash
  const empty = buildVetoCard([], () => null);
  assert.deepEqual(empty.entryQuality, {
    total: 0, noBand: 0,
    bands: { low: { n: 0, finalized: 0, medianR60: null, shareR60Positive: null }, mid: { n: 0, finalized: 0, medianR60: null, shareR60Positive: null }, high: { n: 0, finalized: 0, medianR60: null, shareR60Positive: null } },
    deadTape: { wouldSkip: 0, finalized: 0, medianR60: null, shareR60Positive: null },
  });
});

test('entryQuality: bot.skip stamps every journaled record — band, dead tape, real decision untouched', () => {
  const dir = tmp();
  const bot = rigBot(dir);
  const gates = { linkedDump: { pass: true, reason: 'no linked stack' } };
  // busy tape + a veto fire (R4): high band, not dead tape
  const busy = view({ address: 'BUSY', symbol: 'BUSY', chgM5: 33, chgH1: 5, volM5: 50000, buysM5: 30, sellsM5: 10, createdAt: T0 - 3600e3 });
  bot.skip(busy, { setup: 'pop', metrics: {} }, ['some gate'], [], gates, true);
  // dead tape + the same fire: low band, deadTape flagged — and the record
  // still says the GATE skipped it; the shadow skipped nothing
  const dead = view({ address: 'DEAD', symbol: 'DEAD', chgM5: 33, chgH1: 5, volM5: 4000, createdAt: T0 - 3600e3 });
  bot.skip(dead, { setup: 'pop', metrics: {} }, ['some gate'], [], gates, true);
  // a taken-path evaluation stamps too (the evaluator sees taken alike)
  bot._noteVetoShadow({ v: view({ address: 'TOOK', symbol: 'TOOK', chgM5: 33, volM5: 20000, createdAt: T0 - 3600e3 }), sig: { setup: 'pop' }, checks: gates, decision: 'taken', reasons: [], signalId: 'took-1' });
  const recs = readVeto(dir);
  assert.equal(recs.length, 3);
  const byMint = Object.fromEntries(recs.map(r => [r.mint, r]));
  assert.deepEqual(byMint.BUSY.entryQuality, { volM5: 50000, buysM5: 30, sellsM5: 10, chgH1: 5, activityBand: 'high', deadTape: false });
  assert.equal(byMint.BUSY.decision, 'skipped');
  assert.deepEqual(byMint.DEAD.entryQuality, { volM5: 4000, buysM5: 30, sellsM5: 10, chgH1: 5, activityBand: 'low', deadTape: true });
  assert.equal(byMint.DEAD.decision, 'skipped'); // the gate's verdict, not the flag's
  assert.equal(byMint.TOOK.entryQuality.activityBand, 'mid');
  assert.equal(byMint.TOOK.decision, 'taken'); // dead-tape logic never reaches a decision
  const card = bot.vetoCard();
  assert.equal(card.entryQuality.total, 3);
  assert.equal(card.entryQuality.bands.low.n, 1);
  assert.equal(card.entryQuality.bands.mid.n, 1);
  assert.equal(card.entryQuality.bands.high.n, 1);
  assert.equal(card.entryQuality.deadTape.wouldSkip, 1);
});

test('entryQuality: the R1 close-basis record stamps from the position entry snapshot', () => {
  const dir = tmp();
  const bot = rigBot(dir);
  bot.journal.signal({ mint: 'GRIND', symbol: 'GRIND', setup: 'confluence', decision: 'taken', reasons: [], price: 1, mc: 30000 });
  const pos = { id: 'GRINDX-1', mint: 'GRIND', symbol: 'GRIND', setup: 'confluence', entryTs: T0 + 3000, entryMc: 30000, entryPrice: 1, entry: { chgM5: -45.59, chgH1: -12, volM5: 6000, buysM5: 12, sellsM5: 30 } };
  bot._noteVetoClose(pos, { fakeAlive: { samples: 9, fake: 5, share: 0.529 }, pnlSol: -0.0712, pnlPct: -71.2, reason: 'death detector' });
  const recs = readVeto(dir);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].entryQuality, { volM5: 6000, buysM5: 12, sellsM5: 30, chgH1: -12, activityBand: 'low', deadTape: true });
  // an entry snapshot without activity fields stamps nulls, never guesses
  const pos2 = { id: 'GRINDX-2', mint: 'GRIND', symbol: 'GRIND', setup: 'confluence', entryTs: T0 + 3000, entryMc: 30000, entryPrice: 1, entry: {} };
  bot._noteVetoClose(pos2, { fakeAlive: { samples: 9, fake: 5, share: 0.529 }, pnlSol: -0.01, reason: 'x' });
  const recs2 = readVeto(dir);
  assert.equal(recs2.length, 2);
  assert.deepEqual(recs2[1].entryQuality, { volM5: null, buysM5: null, sellsM5: null, chgH1: null, activityBand: null, deadTape: false });
});

test('veto: HTTP surface — /vetoshadow serves the card, empty and populated', async () => {
  const dir = tmp();
  let t = T0;
  const bot = rigBot(dir, () => t);
  const srv = startServer(bot, 0);
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    const empty = await (await fetch(baseUrl + '/vetoshadow')).json();
    assert.equal(empty.enabled, true);
    assert.equal(empty.shadowOnly, true);
    assert.equal(empty.perRule.R2.wouldVeto, 0);
    assert.equal(empty.totals.records, 0);
    const hot = view({ address: 'HOTMINT', symbol: 'HOT', chgM5: 33.04, createdAt: T0 - 3600e3 });
    bot.skip(hot, { setup: 'pop', metrics: {} }, ['g'], [], { linkedDump: { pass: true, reason: 'no linked stack' } }, true);
    t = T0 + 61000; // past the card's 60s file-read cache
    const card = await (await fetch(baseUrl + '/vetoshadow')).json();
    assert.equal(card.perRule.R4.wouldVeto, 1);
    assert.equal(card.totals.wouldVetoSignals, 1);
    assert.equal(card.totals.takenLive, 0);
    assert.equal(card.totals.skippedSignals, 1);
  } finally { srv.close(); }
});

// ------------------------------------------------------------ live-tape shadow (owner order 2026-10-19 21:37)
test('livetape: stamp verdict math — pass, buys<sells, uniq<N, and the dial is read live', () => {
  assert.deepEqual(liveTapeStamp({ buys: 10, sells: 5, uniqBuyers: 8 }, 5),
    { buys: 10, sells: 5, uniqBuyers: 8, windowMin: 2, wouldSkip: false });
  assert.equal(liveTapeStamp({ buys: 3, sells: 9, uniqBuyers: 20 }, 5).wouldSkip, true, 'buys < sells skips however broad the buyer set');
  assert.equal(liveTapeStamp({ buys: 30, sells: 10, uniqBuyers: 4 }, 5).wouldSkip, true, 'uniqBuyers < N skips however strong the counts');
  assert.equal(liveTapeStamp({ buys: 30, sells: 10, uniqBuyers: 5 }, 5).wouldSkip, false, 'uniqBuyers == N passes (the line is <)');
  assert.equal(liveTapeStamp({ buys: 30, sells: 10, uniqBuyers: 4 }, 3).wouldSkip, false, 'a lower dial re-judges the same tape');
  // the Rockstar census shape: 1 buy / 899 sells / 1 unique buyer
  assert.equal(liveTapeStamp({ buys: 1, sells: 899, uniqBuyers: 1 }, 5).wouldSkip, true);
});

test('livetape: null and partial samples stamp nulls — unknown, never a guessed verdict', () => {
  const blank = { buys: null, sells: null, uniqBuyers: null, windowMin: 2, wouldSkip: null };
  assert.deepEqual(liveTapeStamp(null, 5), blank);
  assert.deepEqual(liveTapeStamp(undefined, 5), blank);
  assert.deepEqual(liveTapeStamp('junk', 5), blank);
  const partial = liveTapeStamp({ buys: 7 }, 5);
  assert.equal(partial.buys, 7);
  assert.equal(partial.wouldSkip, null, 'a partial sample cannot judge');
});

test('livetape: scoreboard aggregates wouldSkip vs pass with joined r60, noSample counted apart', () => {
  const rec = (id, liveTape, basis = 'signal') => ({ kind: 'veto', id, ts: T0, basis, mint: 'M' + id, symbol: 'X', setup: 'pop', decision: 'taken', rules: ['R4'], signalId: id, liveTape });
  const recs = [
    rec('A', { buys: 1, sells: 9, uniqBuyers: 1, windowMin: 2, wouldSkip: true }),
    rec('B', { buys: 2, sells: 8, uniqBuyers: 3, windowMin: 2, wouldSkip: true }),
    rec('C', { buys: 20, sells: 5, uniqBuyers: 12, windowMin: 2, wouldSkip: false }),
    rec('D', { buys: null, sells: null, uniqBuyers: null, windowMin: 2, wouldSkip: null }),
    rec('E', { buys: 1, sells: 9, uniqBuyers: 1, windowMin: 2, wouldSkip: true }, 'close'), // close-basis: excluded
    { kind: 'veto', id: 'F', ts: T0, basis: 'signal', mint: 'MF', symbol: 'X', setup: 'pop', decision: 'taken', rules: ['R4'], signalId: 'F' }, // pre-stamp record: excluded
  ];
  const outcomes = {
    A: { done: true, r15: -0.5, r60: -0.8 },
    B: { done: true, r15: -0.2, r60: -0.4 },
    C: { done: true, r15: 0.3, r60: 0.6 },
    D: { done: true, r15: 0.1, r60: 0.2 },
  };
  const card = buildVetoCard(recs, (id) => outcomes[id] || null);
  assert.equal(card.liveTape.total, 4);
  assert.equal(card.liveTape.noSample, 1);
  assert.deepEqual(card.liveTape.wouldSkip, { n: 2, finalized: 2, medianR60: -0.6, shareR60Positive: 0 });
  assert.deepEqual(card.liveTape.pass, { n: 1, finalized: 1, medianR60: 0.6, shareR60Positive: 1 });
  assert.equal(card.recent.find(x => x.mint === 'MA').liveTape.wouldSkip, true, 'recent rows carry the stamp for the dashboard');
});

test('livetape: bot stamps the retained pre-entry census on the veto record; an unwatched mint stamps noSample', async () => {
  const dir = tmp();
  const bot = rigBot(dir);
  // a finished bottom watch's census: last-2-min tape of 2 buys (one wallet) vs 9 sells
  const census = newCensus(T0 - 60000);
  censusFold(census, { trader: 'w1', side: 'buy', tokens: 10, ts: T0 - 30000 }, T0 - 30000);
  censusFold(census, { trader: 'w1', side: 'buy', tokens: 10, ts: T0 - 20000 }, T0 - 20000);
  for (let i = 0; i < 9; i++) censusFold(census, { trader: 's' + i, side: 'sell', tokens: 10, ts: T0 - 15000 }, T0 - 15000);
  bot._censusStash = new Map([['TAPEMINT', { census, ts: T0 }]]); // rigBot's clock stands at T0
  const hot = view({ address: 'TAPEMINT', symbol: 'TAPE', chgM5: 33, chgH1: 10, createdAt: T0 - 3600e3 });
  bot.skip(hot, { setup: 'pop', metrics: {} }, ['some gate'], [], {}, true);
  const recs = readVeto(dir);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].liveTape, { buys: 2, sells: 9, uniqBuyers: 1, windowMin: 2, wouldSkip: true });
  // no census anywhere for this mint: nulls, counted as noSample on the card
  const hot2 = view({ address: 'BAREMINT', symbol: 'BARE', chgM5: 33, chgH1: 10, createdAt: T0 - 3600e3 });
  bot.skip(hot2, { setup: 'pop', metrics: {} }, ['some gate'], [], {}, true);
  const recs2 = readVeto(dir);
  assert.equal(recs2.length, 2);
  assert.deepEqual(recs2[1].liveTape, { buys: null, sells: null, uniqBuyers: null, windowMin: 2, wouldSkip: null });
  const card = bot.vetoCard();
  assert.equal(card.liveTape.total, 2);
  assert.equal(card.liveTape.noSample, 1);
  assert.equal(card.liveTape.wouldSkip.n, 1);
});
