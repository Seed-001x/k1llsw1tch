// BASE MODE (owner order 2026-10-16 23:00 EDT, "Build the base
// strategy" — his diagnosis: the signal stack is fine, the ENTRIES are
// the disease; good and bad coins run and die the same, so the rule
// stack is noise around the one decision that matters, WHERE the bot
// gets in). "Buy the base, not the blast": every live signal becomes a
// WATCH ORDER (demoted at the onSignal seam to an enrollment record);
// the bot buys ONLY a formed base — a range mark in its lower two
// thirds (or the deferred dip into them), a staircase-3 higher low, a
// qualified bottom mark. Base entries carry the owner's hand-set shape:
// TP1 pinned at +50% from birth (tp1AtPct 0.5) and, for range/bottom,
// the base's own low stamped at entry (structureLow — an entry-side
// record the dip-watch/enrollment machinery reads). The STRUCTURAL
// STOP that once sold such a position on two consecutive prints below
// that low was REMOVED by owner order 2026-10-17 ("Remove that", after
// BLOCUS was sold 12 seconds after its range entry): the tests below
// pin the hold, and that the rest of the exit stack still fires on the
// same position shape. BASE_MODE=0 restores tonight's direct-buy behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

// Full-pipeline rig (the fastbond shape): real onSignal, healthy rug,
// working quotes. baseMode rides loadConfig's default unless overridden.
function pipelineRig({ cfgOver = {}, env = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, enrollSignals: 1, ...cfgOver }, env); // this suite tests the enrollment world; ENROLL_SIGNALS defaults 0 since the owner's 2026-10-18 removal order (tests/trendentry.test.mjs pins the direct world)
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { bot, clock, views, exec };
}

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

async function fire(rig, { mint = 'MINTP', setup = 'pop', sig = {} } = {}) {
  const v = view({ address: mint, symbol: 'TEST', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup, strength: 42, metrics: { volM5: 100_000 }, ...sig });
  return rig.bot.journal.signals.at(-1);
}

// ------------------------------------------------------------ config
test('config: BASE_MODE defaults ON (the live strategy order), BOTTOM_LIVE defaults ON, both parse + validate', () => {
  const d = loadConfig({});
  assert.equal(d.baseMode, 1);
  assert.equal(d.bottomLive, 1);
  assert.equal(loadConfig({ BASE_MODE: '0' }).baseMode, 0);
  assert.equal(loadConfig({ BOTTOM_LIVE: '0' }).bottomLive, 0);
  assert.ok(validateConfig(loadConfig({ BASE_MODE: '2' })).some(e => e.includes('BASE_MODE')));
  assert.ok(validateConfig(loadConfig({ BOTTOM_LIVE: '2' })).some(e => e.includes('BOTTOM_LIVE')));
  assert.ok(!validateConfig(d).some(e => e.includes('BASE_MODE') || e.includes('BOTTOM_LIVE')));
});

test('config: the amendment knobs — BASE_MIN_VOL_M5 defaults $5,000, ENROLL_TTL_H defaults 24, both parse + validate', () => {
  const d = loadConfig({});
  assert.equal(d.baseMinVolM5, 5000);
  assert.equal(d.enrollTtlH, 24);
  assert.equal(loadConfig({ BASE_MIN_VOL_M5: '2500' }).baseMinVolM5, 2500);
  assert.equal(loadConfig({ BASE_MIN_VOL_M5: '0' }).baseMinVolM5, 0);
  assert.equal(loadConfig({ ENROLL_TTL_H: '48' }).enrollTtlH, 48);
  assert.ok(validateConfig(loadConfig({ BASE_MIN_VOL_M5: '-1' })).some(e => e.includes('BASE_MIN_VOL_M5')));
  assert.ok(validateConfig(loadConfig({ ENROLL_TTL_H: '0' })).some(e => e.includes('ENROLL_TTL_H')));
  assert.ok(validateConfig(loadConfig({ ENROLL_TTL_H: '721' })).some(e => e.includes('ENROLL_TTL_H')));
});

// ------------------------------------------------------------ demotion
test('base mode: a pop candidate is ENROLLED, never bought — record, tallies, provenance', async () => {
  const rig = pipelineRig();
  const rec = await fire(rig, { setup: 'pop' });
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.ok(rec.reasons.some(r => r === 'base mode: enrolled for base watch — entries only from a formed base'), JSON.stringify(rec.reasons));
  assert.equal(rec.fields.enrolledBy, 'pop');
  assert.equal(rig.bot.stats.baseMode.enrolled, 1);
  assert.deepEqual(rig.bot.stats.baseMode.bySetup, { pop: 1 });
  assert.equal(rig.bot.stats.entries, 0);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.baseEnrolled.get('MINTP').setup, 'pop');
});

test('base mode: flow, confluence, trend and devlaunch candidates all demote the same way', async () => {
  // The trend leg runs with the TREND ENTRY LANE off (owner order
  // 2026-10-18 21:49 EDT gave early trend signals a direct-entry lane —
  // tests/trendentry.test.mjs pins it): with the lane off, trend demotes
  // exactly like the others, which is what this uniformity check is for.
  for (const setup of ['flow', 'confluence', 'trend', 'devlaunch']) {
    const rig = pipelineRig(setup === 'trend' ? { cfgOver: { trendEntryLive: 0 } } : {});
    const rec = await fire(rig, { mint: 'MINT' + setup.toUpperCase(), setup });
    assert.equal(rec.decision, 'skipped', `${setup}: ${JSON.stringify(rec.reasons)}`);
    assert.ok(rec.reasons.some(r => r.startsWith('base mode: enrolled')), `${setup} must carry the base-mode reason`);
    assert.equal(rec.fields.enrolledBy, setup);
    assert.equal(rig.bot.positions.length, 0, `${setup} must not buy`);
  }
});

test('base mode OFF: the same pop candidate buys exactly as tonight (no demotion record)', async () => {
  const rig = pipelineRig({ cfgOver: { baseMode: 0 } });
  const rec = await fire(rig, { setup: 'pop' });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.fields.enrolledBy, undefined);
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(rig.bot.stats.baseMode.enrolled, 0);
});

test('base mode: shadow evaluations pass through untouched — a shadow flow signal stays shadow, never enrolled', async () => {
  const rig = pipelineRig();
  const rec = await fire(rig, { setup: 'flow', sig: { flowShadowOnly: true, shadowReason: 'shadow: flow is shadow-only for this wallet — logged + outcome-tracked, no buy' } });
  assert.equal(rec.decision, 'shadow', JSON.stringify(rec.reasons));
  assert.equal(rig.bot.stats.baseMode.enrolled, 0);
  assert.equal(rig.bot.positions.length, 0);
});

test('base mode: base setups pass the demotion seam — range, staircase and bottom candidates can buy', async () => {
  for (const setup of ['range', 'staircase', 'bottom']) {
    const rig = pipelineRig();
    const rec = await fire(rig, { mint: 'MINT' + setup.toUpperCase(), setup });
    assert.equal(rec.decision, 'taken', `${setup}: ${JSON.stringify(rec.reasons)}`);
    assert.equal(rig.bot.positions.length, 1);
    assert.equal(rig.bot.stats.baseMode.enrolled, 0);
  }
});

// ------------------------------------------------------------ range refinement + dip watch
const RMARK = { type: 'mark', ts: T0, mint: 'MINTR', symbol: 'RNG', markId: 'rw-MINTR-1-m1', episodeId: 'rw-MINTR-1', bandPct: 4, tightness: 0.114, durationMin: 20, rangeHi: 520_000, rangeLo: 500_000, rangeMid: 510_000, markMc: 505_000, markPrice: 1 };

function rangeRig(over = {}, env = {}) {
  const cfg = testCfg({ enrollSignals: 1, ...over }, env); // the range family is judged in the enrollment world; ENROLL_SIGNALS defaults 0 since the owner's 2026-10-18 removal order
  const clock = { t: T0 };
  const views = new Map();
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  const calls = [];
  bot.onSignal = async (v, sig) => { calls.push({ v, sig }); };
  return { bot, clock, views, calls };
}

// ENROLLMENT GATE (owner decision 2026-10-16 23:16 EDT): range entries
// route only for a NOMINATED mint — tests that judge routing stand the
// mint enrolled by a prior signal, exactly as a live demotion leaves it.
const enroll = (bot, mint = 'MINTR', ts = T0) => bot.baseEnrolled.set(mint, { setup: 'pop', ts });

function openRangeEpisode(bot, rec) {
  bot.rangeWatch.track.set(rec.mint, {
    mint: rec.mint, symbol: rec.symbol, firstTs: rec.ts - 3600000, lastTs: rec.ts, samples: [],
    episode: { episodeId: rec.episodeId, markId: rec.markId, startTs: rec.ts, rangeHi: rec.rangeHi, rangeLo: rec.rangeLo, hiPrice: 1.04, loPrice: 1, exitStreak: 0, exitSide: null },
    rearmAfter: 0,
  });
}

test('range refinement: a mark in the TOP THIRD does not buy — verdict tallied (no signal card since the 2026-10-18 declutter order), dip watch opens', async () => {
  const { bot, clock, views, calls } = rangeRig();
  enroll(bot);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 517_000 })); // (517-500)/20 = 0.85 — top third
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.journal.signals.filter(s => s.setup === 'range').length, 0, 'pre-pipeline range verdicts no longer journal');
  assert.equal(bot.stats.baseMode.rangeSkips.byKind.topThird, 1);
  assert.ok(bot.rangeDipWatch.has('rw-MINTR-1'), 'dip watch opened for the episode');
  assert.equal(bot.stats.baseMode.dipWatches, 1);
  assert.equal(clock.t, T0);
});

test('range refinement: a mark in the lower two-thirds buys at once, no dip watch', async () => {
  const { bot, views, calls } = rangeRig();
  enroll(bot);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000 })); // frac 0.25
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'range');
  assert.equal(bot.rangeDipWatch.size, 0);
});

test('dip watch: a dip into the lower two-thirds with the range intact fires ONE deferred eval; a second dip fires none', async () => {
  const { bot, clock, views, calls } = rangeRig();
  enroll(bot);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 517_000 }));
  openRangeEpisode(bot, RMARK);
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  // sampled history now prints the dip: mc 505k = frac 0.25 of the band
  bot.history.m.set('MINTR', [{ ts: clock.t, price: 1.01, mc: 505_000, volM5: 0, volH1: 0, buysM5: 0, sellsM5: 0, liq: 100_000 }]);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000 }));
  clock.t += 60000;
  await bot._rangeDipTick(clock.t);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.deferredDip, true);
  assert.equal(bot.stats.baseMode.dipEntries, 1);
  assert.equal(bot.rangeDipWatch.size, 0, 'the one attempt is spent');
  clock.t += 60000;
  await bot._rangeDipTick(clock.t);
  await flush();
  assert.equal(calls.length, 1, 'no second entry attempt for the episode, ever');
});

test('dip watch: no dip while the range holds — no eval; episode end retires the watch (entry needs the range intact)', async () => {
  const { bot, clock, views, calls } = rangeRig();
  enroll(bot);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 517_000 }));
  openRangeEpisode(bot, RMARK);
  bot._evalRange(RMARK);
  await flush();
  bot.history.m.set('MINTR', [{ ts: clock.t, price: 1.01, mc: 505_000, volM5: 0, volH1: 0, buysM5: 0, sellsM5: 0, liq: 100_000 }]);
  // the episode ENDS (band exited) before the tick: the dip must not buy
  bot.rangeWatch.track.get('MINTR').episode = null;
  clock.t += 60000;
  await bot._rangeDipTick(clock.t);
  await flush();
  assert.equal(calls.length, 0);
  clock.t += 31 * 60000; // episode end + 30m: the watch is garbage-collected
  await bot._rangeDipTick(clock.t);
  assert.equal(bot.rangeDipWatch.size, 0);
});

test('range refinement is base-strategy machinery: BASE_MODE=0 restores the un-refined range path (top-third mark buys)', async () => {
  const { bot, views, calls } = rangeRig({ baseMode: 0 });
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 517_000 }));
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(bot.rangeDipWatch.size, 0);
});

test('dip watch: RANGE_LIVE=0 disables the deferred path too', async () => {
  const { bot, clock, views, calls } = rangeRig({}, { RANGE_LIVE: '0' });
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 517_000 }));
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.rangeDipWatch.size, 0);
  assert.equal(clock.t, T0);
});

// ------------------------------------------------------------ bottom live
const BMARK = { type: 'mark', ts: T0, markId: 'bw-MINTB-1-m1', episodeId: 'bw-MINTB-1', mint: 'MINTB', symbol: 'BOTM', source: 'watched', qualified: true, peakPrice: 2, peakMc: 100_000, lowPrice: 1, lowMc: 50_000, lowTs: T0 - 600000, drawdownPct: 50, quietSec: 300, markPrice: 1.2, markMc: 60_000, pctOffLow: 20, pctOfPeakRecovered: 60, flowKnown: true, buysM5: 30, sellsM5: 10, buyShare: 0.75 };

function bottomRig(over = {}, env = {}) {
  // PREENTRY_CENSUS off here: these tests pin the bottom ROUTE itself
  // (the direct path the switch restores); the pre-entry watch that now
  // sits on it by default is owned by tests/preentry.test.mjs.
  const r = rangeRig(over, { PREENTRY_CENSUS: '0', ...env });
  r.views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM' }));
  return r;
}

test('bottom live: a QUALIFIED mark routes one bottom eval with the episode low carried', async () => {
  const { bot, calls } = bottomRig();
  bot._evalBottom(BMARK);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'bottom');
  assert.equal(calls[0].sig.structureLow, 50_000);
  assert.equal(calls[0].sig.metrics.bottom.lowMc, 50_000);
  assert.equal(bot.stats.bottom.evals, 1);
});

test('bottom live: a DUST mark (peak under the floor) never routes', async () => {
  const { bot, calls } = bottomRig();
  bot._evalBottom({ ...BMARK, qualified: false });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.bottom, undefined);
});

test('bottom live: BOTTOM_LIVE=0 keeps bottoms record-only', async () => {
  const { bot, calls } = bottomRig({}, { BOTTOM_LIVE: '0' });
  bot._evalBottom(BMARK);
  await flush();
  assert.equal(calls.length, 0);
});

test('bottom live: held / cooldown / no-view disciplines match the sibling paths', async () => {
  const held = bottomRig();
  held.bot.positions.push({ mint: 'MINTB', symbol: 'BOTM' });
  held.bot._evalBottom(BMARK);
  await flush();
  assert.equal(held.calls.length, 0);

  const noview = bottomRig();
  noview.views.delete('MINTB');
  noview.bot._evalBottom(BMARK);
  await flush();
  assert.equal(noview.calls.length, 0);
  assert.equal(noview.bot.stats.bottom.noView, 1);
  assert.ok(noview.bot.bottomPending.has('MINTB'), 'mark queued for retry, not dropped');
  noview.views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM' }));
  noview.clock.t += 20000;
  await noview.bot._bottomRetryTick(noview.clock.t);
  await flush();
  assert.equal(noview.calls.length, 1);
  assert.equal(noview.bot.stats.bottom.retries, 1);
});

// ------------------------------------------------------------ TP1 stamp + base-low stamp (full pipeline)
async function openRangePosition(rig, over = {}) {
  const v = view({ address: 'MINTR', symbol: 'RNG', mc: 505_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set('MINTR', v);
  enroll(rig.bot); // the range entry gate: the mint stands nominated (no-op for the stamps when BASE_MODE=0)
  await rig.bot.start();
  seedHistory(rig.bot, 'MINTR');
  await rig.bot._evalRangeWithView({ ...RMARK, mint: 'MINTR' }, v, T0);
  await flush();
  assert.equal(rig.bot.positions.length, 1, 'range position opened');
  return rig.bot.positions[0];
}

test('base entry: a range position is born with tp1AtPct 0.5 and its base low stamped; the taken record carries baseTp1', async () => {
  const rig = pipelineRig();
  const pos = await openRangePosition(rig);
  assert.equal(pos.tp1AtPct, 0.5);
  assert.equal(pos.structureLow, 500_000);
  const taken = rig.bot.journal.signals.at(-1);
  assert.equal(taken.decision, 'taken');
  assert.equal(taken.fields.baseTp1, true);
});

test('base entry: a staircase position is born with tp1AtPct 0.5 (no structure low — that is range/bottom only)', async () => {
  const rig = pipelineRig({ cfgOver: { staircaseLive: 1 } });
  const v = view({ address: 'MINTS', symbol: 'STAIR', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set('MINTS', v);
  await rig.bot.start();
  seedHistory(rig.bot, 'MINTS');
  await rig.bot._evalStaircaseWithView({ type: 'mark', ts: T0, mint: 'MINTS', symbol: 'STAIR', watchId: 'sw-1', markId: 'sw-1-m3', ordinal: 3, price: 1, lowPrev: 0.9, lowNew: 0.95 }, v, T0);
  await flush();
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(rig.bot.positions[0].tp1AtPct, 0.5);
  assert.equal(rig.bot.positions[0].structureLow, undefined);
});

test('non-base entry (BASE_MODE=0): a range position carries NEITHER stamp — tonight\u2019s shape exactly', async () => {
  const rig = pipelineRig({ cfgOver: { baseMode: 0 } });
  const pos = await openRangePosition(rig);
  assert.equal(pos.tp1AtPct, undefined);
  assert.equal(pos.structureLow, undefined);
});

// Drive managePosition with a controlled realizable mark:
// realizableMc = entryMc x (valueSol / basis) / entryRoundTrip.
function driveMarks(rig, pos) {
  const state = { valueSol: null };
  rig.bot.exec.markValue = async () => state.valueSol;
  rig.bot.exec.sell = async (mint, raw) => ({ tokensSold: raw, solOut: 0.01, sig: 'sig', simulated: true });
  const valueForMc = (mc) => pos.entrySol * pos.remainingFrac * (pos.entryRoundTrip > 0 ? pos.entryRoundTrip : 1) * (mc / pos.entryMc);
  return { state, valueForMc };
}

test('structural stop REMOVED: consecutive realizable prints below the base low HOLD \u2014 no sell, no base-broke close, no breach bookkeeping', async () => {
  const rig = pipelineRig();
  const pos = await openRangePosition(rig);
  assert.equal(pos.structureLow, 500_000, 'the entry-side base-low stamp itself is untouched');
  const { state, valueForMc } = driveMarks(rig, pos);
  state.valueSol = valueForMc(490_000); // below the 500k base low
  await rig.bot.managePosition(pos, 150);
  await rig.bot.managePosition(pos, 150);
  await rig.bot.managePosition(pos, 150);
  assert.equal(rig.bot.positions.length, 1, 'three consecutive sub-low prints must not exit \u2014 the stop is gone');
  assert.equal(pos.structureBreach, undefined, 'no breach counting is stamped anymore');
  assert.equal(rig.bot.journal.trades.filter(t => t.type === 'sell').length, 0, 'nothing sold');
  assert.equal(rig.bot.journal.trades.filter(t => t.type === 'close').length, 0, 'no close record at all');
  assert.equal(rig.bot.stats.baseMode.structureStops, 0);
});

test('structural stop REMOVED: below/above/below print sequences never accumulate toward an exit', async () => {
  const rig = pipelineRig();
  const pos = await openRangePosition(rig);
  const { state, valueForMc } = driveMarks(rig, pos);
  state.valueSol = valueForMc(490_000);
  await rig.bot.managePosition(pos, 150);
  state.valueSol = valueForMc(510_000); // back inside the base
  await rig.bot.managePosition(pos, 150);
  state.valueSol = valueForMc(490_000);
  await rig.bot.managePosition(pos, 150);
  await rig.bot.managePosition(pos, 150);
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(pos.structureBreach, undefined);
  assert.equal(rig.bot.journal.trades.filter(t => t.type === 'close').length, 0);
});

test('structural stop REMOVED: the rest of the exit stack still fires on the same position shape \u2014 TP1 banks at its +50% stamp after sub-low holds', async () => {
  const rig = pipelineRig();
  const pos = await openRangePosition(rig);
  const { state, valueForMc } = driveMarks(rig, pos);
  state.valueSol = valueForMc(490_000); // under the base low \u2014 holds now
  await rig.bot.managePosition(pos, 150);
  await rig.bot.managePosition(pos, 150);
  assert.equal(rig.bot.positions.length, 1);
  state.valueSol = valueForMc(959_500); // entryMc 505k x 1.9 \u2014 net of fees/round-trip, clear of the +50% TP1 stamp
  await rig.bot.managePosition(pos, 150);
  assert.equal(pos.tp1Done, true, 'TP1 fired on the same position the stop used to kill');
  assert.ok(pos.remainingFrac < 1, 'TP1 banked a fraction');
  assert.equal(rig.bot.positions.length, 1, 'TP1 is a partial \u2014 the position rides on');
  const sell = rig.bot.journal.trades.filter(t => t.type === 'sell').at(-1);
  assert.ok(sell && /TP1 \+50% \(override\)/.test(sell.reason), JSON.stringify(sell));
  assert.equal(rig.bot.journal.trades.filter(t => t.type === 'close' && t.reason === 'base broke: fell below the base low').length, 0);
});

test('structural stop REMOVED: post-TP1 and protected positions under the old low hold exactly as before', async () => {
  // tp1Guard 0: guard pinned off because it owns the middle-stage give-back
  // since 2026-10-22 and this test isolates the structural stop's removal —
  // with the guard on, the post-TP1 leg's sub-entry print would exit on the
  // guard floor instead of holding for the stop question (guard behavior:
  // tp1guard.test.mjs).
  const rig = pipelineRig({ cfgOver: { tp1Guard: 0 } });
  const pos = await openRangePosition(rig);
  pos.tp1Done = true;
  const { state, valueForMc } = driveMarks(rig, pos);
  state.valueSol = valueForMc(490_000);
  await rig.bot.managePosition(pos, 150);
  await rig.bot.managePosition(pos, 150);
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(rig.bot.stats.baseMode.structureStops, 0);

  const rig2 = pipelineRig();
  const pos2 = await openRangePosition(rig2);
  pos2.protected = T0;
  const d2 = driveMarks(rig2, pos2);
  d2.state.valueSol = d2.valueForMc(490_000);
  await rig2.bot.managePosition(pos2, 150);
  await rig2.bot.managePosition(pos2, 150);
  assert.equal(rig2.bot.positions.length, 1);
  assert.equal(rig2.bot.stats.baseMode.structureStops, 0);
});

// ------------------------------------------------------------ amendment gates (owner decision 2026-10-16 23:16 EDT)
test('pulse floor: a $958-volM5 range mark skips as a dead base — the ALIENS shape from tonight’s burst', async () => {
  const { bot, views, calls } = rangeRig();
  enroll(bot);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000, volM5: 958 }));
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  const rec = bot.journal.signals.at(-1);
  assert.equal(rec.decision, 'skipped');
  assert.ok(rec.reasons.some(r => r === 'base pulse: volM5 $958 under the $5,000 floor — dead base'), JSON.stringify(rec.reasons));
  assert.equal(bot.stats.baseMode.pulseSkips.total, 1);
  assert.deepEqual(bot.stats.baseMode.pulseSkips.bySetup, { range: 1 });
});

test('pulse floor: a $13.7K-volM5 range mark passes the pulse gate and routes', async () => {
  const { bot, views, calls } = rangeRig();
  enroll(bot);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000, volM5: 13_700 }));
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(bot.stats.baseMode.pulseSkips.total, 0);
});

test('pulse floor: an UNKNOWN volM5 counts as dead — skips, journaled as unknown', async () => {
  const { bot, views, calls } = rangeRig();
  enroll(bot);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000, volM5: undefined }));
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  const rec = bot.journal.signals.at(-1);
  assert.ok(rec.reasons.some(r => r === 'base pulse: volM5 unknown under the $5,000 floor — dead base'), JSON.stringify(rec.reasons));
  assert.equal(bot.stats.baseMode.pulseSkips.total, 1);
});

test('pulse floor: the bottom eval carries the gate (its marks nominate; the tape must still be alive)', async () => {
  const brig = bottomRig();
  brig.views.set('MINTB', view({ address: 'MINTB', symbol: 'BOTM', volM5: 100 }));
  brig.bot._evalBottom(BMARK);
  await flush();
  assert.equal(brig.calls.length, 0);
  assert.equal(brig.bot.stats.baseMode.pulseSkips.bySetup.bottom, 1);
});

test('pulse floor: staircase evals are EXEMPT at the default dial (owner order 2026-10-18 — the mark’s structure is its aliveness proof)', async () => {
  const srig = rangeRig({ staircaseLive: 1 });
  srig.views.set('MINTS', view({ address: 'MINTS', symbol: 'STAIR', volM5: 300 }));
  srig.bot._evalStaircase({ type: 'mark', ts: T0, mint: 'MINTS', symbol: 'STAIR', watchId: 'sw-1', markId: 'sw-1-m3', ordinal: 3, price: 1, lowPrev: 0.9, lowNew: 0.95 });
  await flush();
  assert.equal(srig.bot.stats.baseMode.pulseSkips.bySetup.staircase, undefined, 'no staircase pulse skip at the default dial');
  assert.equal(srig.bot.stats.baseMode.pulseSkips.total, 0);
  const rec = srig.bot.journal.signals.at(-1);
  assert.ok(!rec || !(rec.reasons || []).some(r => r.includes('base pulse')), 'no pulse reason journaled for the staircase eval');
});

test('pulse floor: a staircase floor set above zero binds staircase evals at THAT floor, not the shared one', async () => {
  const srig = rangeRig({ staircaseLive: 1, baseStaircaseMinVolM5: 1000 });
  srig.views.set('MINTS', view({ address: 'MINTS', symbol: 'STAIR', volM5: 300 }));
  srig.bot._evalStaircase({ type: 'mark', ts: T0, mint: 'MINTS', symbol: 'STAIR', watchId: 'sw-1', markId: 'sw-1-m3', ordinal: 3, price: 1, lowPrev: 0.9, lowNew: 0.95 });
  await flush();
  assert.equal(srig.calls.length, 0);
  assert.equal(srig.bot.stats.baseMode.pulseSkips.bySetup.staircase, 1);
  const rec = srig.bot.journal.signals.at(-1);
  assert.ok(rec.reasons.some(r => r === 'base pulse: volM5 $300 under the $1,000 floor — dead base'), JSON.stringify(rec.reasons));
});

test('enrollment gate: an UNENROLLED mint’s range mark tallies silently and never buys — base alone is not a nomination', async () => {
  const { bot, views, calls } = rangeRig();
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000 })); // healthy tape, lower two-thirds — everything but the nomination
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.journal.signals.filter(s => s.setup === 'range').length, 0, 'the nomination verdict no longer journals a signal card');
  assert.equal(bot.stats.baseMode.rangeUnenrolled, 1);
  assert.equal(bot.stats.baseMode.rangeSkips.byKind.unenrolled, 1);
  assert.equal(bot.rangeDipWatch.size, 0, 'an unenrolled mark opens no dip watch either');
});

test('enrollment gate is OFF with the enrollment removal: an unenrolled mint’s range mark routes on its own', async () => {
  const { bot, views, calls } = rangeRig({ enrollSignals: 0 });
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000 }));
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 1, 'no nomination needed once enrollment is removed');
  assert.equal(bot.stats.baseMode.rangeUnenrolled, 0);
});

test('enrollment gate: TTL expiry re-gates — an enrollment older than ENROLL_TTL_H no longer nominates', async () => {
  const { bot, clock, views, calls } = rangeRig();
  enroll(bot, 'MINTR', T0);
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000 }));
  clock.t = T0 + 25 * 3600000; // 25h later — past the 24h TTL
  bot._evalRange({ ...RMARK, ts: clock.t });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.stats.baseMode.rangeUnenrolled, 1);
  clock.t = T0 + 23 * 3600000; // inside the TTL the same mint routes (fresh mark)
  bot._evalRange({ ...RMARK, ts: clock.t, markId: 'rw-MINTR-2-m1', episodeId: 'rw-MINTR-2' });
  await flush();
  assert.equal(calls.length, 1);
});

test('enrollment gate: boot restore re-arms a journal-enrolled mint — a restart does not un-nominate it', async () => {
  const dir = tmp();
  const rec = { id: 'sig-1', ts: T0, mint: 'MINTR', symbol: 'RNG', setup: 'pop', decision: 'skipped', reasons: ['base mode: enrolled for base watch — entries only from a formed base'], price: 1, mc: 505_000, fields: { enrolledBy: 'pop' } };
  fs.writeFileSync(path.join(dir, 'signals.jsonl'), JSON.stringify(rec) + '\n');
  const cfg = testCfg({ dataDir: dir, enrollSignals: 1 });
  const clock = { t: T0 };
  const views = new Map();
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  assert.ok(bot.baseEnrolled.has('MINTR'), 'the constructor restore folded the journal enrollment into the live map');
  assert.equal(bot.baseEnrolled.get('MINTR').setup, 'pop');
  const calls = [];
  bot.onSignal = async (v, sig) => { calls.push({ v, sig }); };
  views.set('MINTR', view({ address: 'MINTR', symbol: 'RNG', mc: 505_000 }));
  bot._evalRange(RMARK);
  await flush();
  assert.equal(calls.length, 1, 'the restored enrollment lets the range mark route');
});

test('enrollment gate is range-only: an unenrolled mint’s STAIRCASE mark still routes (pulse permitting)', async () => {
  const { bot, views, calls } = rangeRig({ staircaseLive: 1 });
  views.set('MINTS', view({ address: 'MINTS', symbol: 'STAIR' })); // volM5 healthy by default
  bot._evalStaircase({ type: 'mark', ts: T0, mint: 'MINTS', symbol: 'STAIR', watchId: 'sw-1', markId: 'sw-1-m3', ordinal: 3, price: 1, lowPrev: 0.9, lowNew: 0.95 });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(bot.stats.baseMode.rangeUnenrolled, 0);
});
