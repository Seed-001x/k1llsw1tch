// LIQ RE-CHECK (owner order 2026-10-17, "Ship the liquidity fix" — "The
// liquidity re-check, for every lane, not just confluence. A $0 reading on
// a coin that's seconds old is a broken read, not a decision."): when a
// YOUNG coin's entry evaluation is about to terminal-skip SOLELY because
// liquidity read $0/missing (the eligible() liq + liqToMc legs), the skip
// is deferred — the view is re-fetched every 10s for up to 90s and the
// SAME evaluation resumes the moment liquidity reads real, through every
// remaining gate. A broken read never journals a skip and never stamps
// the per-mint signal cooldown; only the final verdict does. These tests
// pin: (a) $0 at t0, real at t+30s -> the evaluation continues to a
// normal verdict, cooldown stamped once, record carries the re-check
// count; (b) $0 through 90s -> a single terminal skip with the original
// liq reason; (c) failed reads don't consume the cooldown — a fresh
// signal inside the window is not deduped by the pending re-check and
// the pending entry never double-evaluates; (d) a recovered coin still
// dies on the insider block (the re-check grants no bypass); (e) the
// LIQ_RECHECK=0 kill switch restores the legacy one-and-done skip
// byte-identically. Plus the boundary pins: old coins never defer,
// mixed failures never defer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const YENNI = '5B52w1ZW9tuwUduueP5J7HXz5AcGfruGoX6YoAudvyxG';
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

const flush = async (rounds = 12) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

// Full-pipeline rig (liveflips pattern): real Bot + real onSignal +
// scripted-quote Executor; views served from a mutable per-mint map.
function pipelineRig({ cfgOver = {}, env = {}, rug = healthyRug } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...cfgOver }, env);
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
    fetchSolUsd: async () => 150, fetchRug: async () => rug, searchByName: async () => [],
    fetchCurveLife: async () => 9999, // measured, ancient curve — these tests judge the liq re-check, not the fast-bond gate (whose blind block would stop a 2-minute-old pool with an unreadable lifespan; fastbond.test.mjs owns that doctrine)
  });
  return { bot, clock, views };
}

// Routing rig: onSignal stubbed — pins what a lane ROUTES, not the
// downstream gates (pinned in the pipeline tests).
function routingRig(cfgOver = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...cfgOver });
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

const CNF_EV = { id: 'cnf-1', kind: 'confluence', ts: T0, mint: 'MINTC', symbol: 'CNFCOIN', entryTs: T0, clusters: ['paper', 'multi'], entities: ['E1', 'E2'], names: ['paper', 'multi'], maxSol: 2, walletCount: 3, mc: 500_000, viewPrice: 1 };
// A 2-minute-old coin whose liquidity read is broken ($0) vs healed.
const youngBroken = (mint, symbol) => view({ address: mint, symbol, mc: 500_000, liq: 0, createdAt: T0 - 120000 });
const youngHealed = (mint, symbol) => view({ address: mint, symbol, mc: 500_000, liq: 100_000, createdAt: T0 - 120000 });

// Drive the re-check tick at +10s steps, k times.
async function driveTicks(bot, clock, k) {
  for (let i = 0; i < k; i++) { clock.t += 10000; await bot._liqRecheckTick(clock.t); }
}

// ------------------------------------------------------------ config
test('config: LIQ_RECHECK defaults ON with the spec timings; =0 is the kill switch', () => {
  const d = loadConfig({});
  assert.equal(d.liqRecheck, true);
  assert.equal(d.liqRecheckIntervalSec, 10);
  assert.equal(d.liqRecheckWindowSec, 90);
  assert.equal(d.liqRecheckMaxAgeMin, 10);
  assert.equal(loadConfig({ LIQ_RECHECK: '0' }).liqRecheck, false);
});

// ------------------------------------------------------------ (a) recover -> normal verdict
test('(a) confluence: liq $0 at t0, real at t+30s — evaluation resumes to taken, cooldown stamped once, record carries the count', async () => {
  const { bot, clock, views } = pipelineRig();
  views.set('MINTC', youngBroken('MINTC', 'CNFCOIN'));
  await bot.start();
  seedHistory(bot, 'MINTC');
  bot._evalWalletLive(CNF_EV);
  await flush();
  // The broken read produced NO record, NO cooldown stamp, NO skip tally.
  assert.equal(bot.journal.signals.filter(s => s.mint === 'MINTC').length, 0);
  assert.equal(bot.lastSignal.has('MINTC'), false);
  assert.equal(bot.stats.walletLive.confluence.skipped, 0);
  assert.equal(bot.liqPending.size, 1);
  assert.deepEqual(bot.stats.liqRecheck, { queued: 1, recovered: 0, expired: 0 });
  // Two re-checks while the read is still broken: still nothing journaled.
  await driveTicks(bot, clock, 2);
  await flush();
  assert.equal(bot.journal.signals.filter(s => s.mint === 'MINTC').length, 0);
  assert.equal(bot.liqPending.size, 1);
  // The read heals; the third re-check resumes the SAME evaluation.
  views.set('MINTC', youngHealed('MINTC', 'CNFCOIN'));
  await driveTicks(bot, clock, 1);
  await flush(20);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1, 'exactly one signal record — the final verdict');
  assert.equal(recs[0].decision, 'taken', JSON.stringify(recs[0].reasons));
  assert.equal(recs[0].liqRechecks, 3);
  assert.equal(bot.positions.length, 1);
  assert.equal(bot.positions[0].setup, 'confluence');
  assert.equal(bot.lastSignal.get('MINTC'), T0 + 30000, 'cooldown stamped once, at the verdict');
  assert.deepEqual(bot.stats.liqRecheck, { queued: 1, recovered: 1, expired: 0 });
  assert.equal(bot.liqPending.size, 0);
});

test('(a2) flow: liq $0 at t0 queues silently (not even the record-only skip), recovery routes the buy', async () => {
  const { bot, clock, views } = pipelineRig({ env: { FLOW_LIVE_WALLETS: YENNI } });
  views.set('MINTF', youngBroken('MINTF', 'FLOWT'));
  await bot.start();
  seedHistory(bot, 'MINTF');
  const agg = { wallets: [YENNI], maxSol: 0.85, count: 1, kind: 'solo', wallet: YENNI, walletSol: 0.85, buyTs: T0, label: 'flow: yenni bought 0.85 SOL' };
  await bot._evalFlow('MINTF', agg);
  await flush();
  assert.equal(bot.journal.signals.filter(s => s.mint === 'MINTF').length, 0, 'no record-only skip for a broken read');
  assert.equal(bot.lastSignal.has('MINTF'), false);
  assert.equal(bot.stats.liqRecheck.queued, 1);
  views.set('MINTF', youngHealed('MINTF', 'FLOWT'));
  await driveTicks(bot, clock, 1);
  await flush(20);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTF');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'taken', JSON.stringify(recs[0].reasons));
  assert.equal(recs[0].liqRechecks, 1);
  assert.equal(bot.positions.length, 1);
});

test('(a3) staircase: a mark evaluated through a healed read routes with the count stamped', async () => {
  const { bot, clock, views, calls } = routingRig();
  const rec = { type: 'mark', mint: 'MINTS', symbol: 'STAIR', ordinal: 3, markId: 'm1', watchId: 'w1', price: 1, lowPrev: 0.9, lowNew: 0.95 };
  views.set('MINTS', youngBroken('MINTS', 'STAIR'));
  await bot._evalStaircaseWithView(rec, views.get('MINTS'), clock.t);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.journal.signals.filter(s => s.mint === 'MINTS').length, 0);
  assert.equal(bot.stats.liqRecheck.queued, 1);
  views.set('MINTS', youngHealed('MINTS', 'STAIR'));
  await driveTicks(bot, clock, 1);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sig.setup, 'staircase');
  assert.equal(calls[0].sig.liqRechecks, 1);
  assert.equal(bot.stats.liqRecheck.recovered, 1);
});

// ------------------------------------------------------------ (b) expiry -> one terminal skip
test('(b) liq $0 through the whole 90s window — a single terminal skip with the original liq reason', async () => {
  const { bot, clock, views, calls } = routingRig();
  views.set('MINTC', youngBroken('MINTC', 'CNFCOIN'));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(bot.liqPending.size, 1);
  await driveTicks(bot, clock, 9); // +10s .. +90s: nine re-checks, read never heals
  await flush();
  assert.equal(calls.length, 0, 'never routed');
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1, 'exactly one record — the terminal skip');
  assert.equal(recs[0].decision, 'skipped');
  assert.ok(recs[0].reasons[0].startsWith('confluence-live: liq $0 < $'), JSON.stringify(recs[0].reasons));
  assert.ok(recs[0].reasons.some(r => r.includes('liq is 0.0% of mc')), JSON.stringify(recs[0].reasons));
  assert.equal(recs[0].liqRechecks, 9);
  assert.equal(bot.stats.walletLive.confluence.skipped, 1, 'the lane tally is stamped once, at the verdict');
  assert.equal(bot.lastSignal.has('MINTC'), false, 'a skip never stamps the signal cooldown (legacy shape)');
  assert.deepEqual(bot.stats.liqRecheck, { queued: 1, recovered: 0, expired: 1 });
  assert.equal(bot.liqPending.size, 0);
});

// ------------------------------------------------------------ (c) cooldown discipline
test('(c) a fresh signal inside the window is NOT deduped by the pending re-check — and the pending entry never double-evaluates', async () => {
  const { bot, clock, views, calls } = routingRig();
  views.set('MINTC', youngBroken('MINTC', 'CNFCOIN'));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(bot.liqPending.size, 1);
  // A second event for the same mint while pending: no record, no second
  // queue entry, no cooldown stamp — it supersedes the pending resume.
  clock.t += 5000;
  bot._evalWalletLive({ ...CNF_EV, id: 'cnf-2' });
  await flush();
  assert.equal(bot.journal.signals.filter(s => s.mint === 'MINTC').length, 0);
  assert.equal(bot.liqPending.size, 1);
  assert.equal(bot.stats.liqRecheck.queued, 1, 'still one queueing, not two');
  assert.equal(bot.lastSignal.has('MINTC'), false);
  // The read heals and a FRESH event evaluates immediately — the pending
  // re-check did not consume the coin's one evaluation.
  views.set('MINTC', youngHealed('MINTC', 'CNFCOIN'));
  bot._evalWalletLive({ ...CNF_EV, id: 'cnf-3' });
  await flush();
  assert.equal(calls.length, 1, 'the fresh signal evaluated at once');
  assert.equal(bot.lastSignal.get('MINTC'), T0 + 5000);
  // The pending entry now finds the cooldown stamped by that fresh
  // evaluation and drops quietly — no second routing, no counters.
  await driveTicks(bot, clock, 1);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(bot.liqPending.size, 0);
  assert.deepEqual(bot.stats.liqRecheck, { queued: 1, recovered: 0, expired: 0 });
});

// ------------------------------------------------------------ (d) no bypass on recovery
test('(d) a recovered coin still dies on the insider block — the re-check grants no bypass', async () => {
  const insiderRug = { ...healthyRug, graphInsidersDetected: 9 };
  const { bot, clock, views } = pipelineRig({ rug: insiderRug });
  views.set('MINTC', youngBroken('MINTC', 'CNFCOIN'));
  await bot.start();
  seedHistory(bot, 'MINTC');
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(bot.stats.liqRecheck.queued, 1);
  views.set('MINTC', youngHealed('MINTC', 'CNFCOIN'));
  await driveTicks(bot, clock, 1);
  await flush(20);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'skipped');
  assert.ok(recs[0].reasons.some(r => r.includes('insiders 9 >= 3')), JSON.stringify(recs[0].reasons));
  assert.equal(recs[0].gates.insiderBlock.pass, false);
  assert.equal(recs[0].liqRechecks, 1);
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.liqRecheck.recovered, 1);
});

// ------------------------------------------------------------ (e) kill switch = legacy
test('(e) LIQ_RECHECK=0: the one-and-done skip lands immediately, byte-identical record shape', async () => {
  const { bot, clock, views, calls } = routingRig({ liqRecheck: false });
  views.set('MINTC', youngBroken('MINTC', 'CNFCOIN'));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(calls.length, 0);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'skipped');
  assert.ok(recs[0].reasons[0].startsWith('confluence-live: liq $0 < $'), JSON.stringify(recs[0].reasons));
  assert.equal('liqRechecks' in recs[0], false, 'no re-check stamp on a legacy record');
  assert.equal(bot.liqPending.size, 0);
  assert.equal(bot.stats.liqRecheck, undefined, 'no counters exist with the switch off');
  assert.equal(bot.stats.walletLive.confluence.skipped, 1);
  await driveTicks(bot, clock, 3); // the tick is inert too
  assert.equal(bot.journal.signals.filter(s => s.mint === 'MINTC').length, 1);
});

// ------------------------------------------------------------ boundaries
test('boundary: an OLD coin with a $0 read never defers — the legacy skip stands (a real judgment)', async () => {
  const { bot, views, calls } = routingRig();
  views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', mc: 500_000, liq: 0, createdAt: T0 - 30 * 60000 }));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.liqPending.size, 0);
  assert.equal(bot.stats.liqRecheck.queued, 0);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'skipped');
});

test('boundary: a young coin failing liq AND a real judgment (dead bounce) never defers', async () => {
  const { bot, views, calls } = routingRig();
  views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', mc: 500_000, liq: 0, chgH1: -60, createdAt: T0 - 120000 }));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.liqPending.size, 0);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'skipped');
  assert.ok(recs[0].reasons.some(r => r.includes('dead bounce')), JSON.stringify(recs[0].reasons));
});

test('boundary: a THIN-BUT-REAL print at t0 never defers — the legacy skip judges the true figure at once', async () => {
  const { bot, views, calls } = routingRig();
  // liq $5,000 is a working read (sources.js prints 0 only when the pool
  // read is missing): it fails the floors as a judgment, not a glitch.
  views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', mc: 500_000, liq: 5_000, createdAt: T0 - 120000 }));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(bot.liqPending.size, 0);
  assert.equal(bot.stats.liqRecheck.queued, 0);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'skipped');
  assert.ok(recs[0].reasons.some(r => r.includes('liq $5000 < $')), JSON.stringify(recs[0].reasons));
});

test('boundary: a read that heals to THIN-BUT-REAL resumes and is judged on the true figure — no re-deferral loop', async () => {
  const { bot, clock, views, calls } = routingRig();
  views.set('MINTC', youngBroken('MINTC', 'CNFCOIN'));
  bot._evalWalletLive(CNF_EV);
  await flush();
  assert.equal(bot.liqPending.size, 1);
  views.set('MINTC', view({ address: 'MINTC', symbol: 'CNFCOIN', mc: 500_000, liq: 5_000, createdAt: T0 - 120000 }));
  await driveTicks(bot, clock, 1);
  await flush();
  // The read works again (liq > 0), so the evaluation resumed — and its
  // own eligible() floor then skipped it on the REAL $5,000 figure,
  // stamped with the re-check it took to get a working read.
  assert.equal(bot.stats.liqRecheck.recovered, 1);
  assert.equal(bot.liqPending.size, 0, 'no re-queue on a thin-but-real print');
  assert.equal(calls.length, 0);
  const recs = bot.journal.signals.filter(s => s.mint === 'MINTC');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].decision, 'skipped');
  assert.ok(recs[0].reasons.some(r => r.includes('liq $5000 < $')), JSON.stringify(recs[0].reasons));
  assert.equal(recs[0].liqRechecks, 1);
});
