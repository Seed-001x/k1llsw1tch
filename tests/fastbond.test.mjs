// FAST-BONDER BLOCK (owner order 2026-10-16, "live gate now: block
// sub-2-minute bonders"): a KNOWN graduated coin whose bonding curve lived
// less than FAST_BOND_MAX_SEC (default 120) seconds never buys. The
// measurement is a DURATION — DexScreener pairCreatedAt of the pumpfun
// curve pair vs the first AMM pair (sources.js curveLifeFromPairs) —
// because the camouflaged-bundle species defeats every count: TRUMARS
// (2026-10-16) split its graduation slam across 4 wallets in second 0 and
// padded the tape with a micro-buy swarm (201 curve buys, median $10.76),
// yet the whole curve still lived 78 seconds. Elapsed time cannot be
// faked; buy counts can. Judged in Bot.onSignal immediately after the
// insider block, on the same post-gates seam. FAIL OPEN, ALWAYS: unknown
// (non-graduated, fetch failure, missing stamps, no dep) never blocks.
// FAST_BOND_BLOCK=0 is the kill switch (no fetch, no stamp, no tally).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { fastBondVerdict, burstBondVerdict } from '../src/gate.js';
import { curveLifeFromPairs, curveLifeFromSigTimes, curveBurstFromSigTimes } from '../src/sources.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

// curveLife: fixed seconds | per-mint function | 'throw' (fetch failure).
function pipelineRig({ cfgOver = {}, env = {}, rug = healthyRug, curveLife = null, omitCurveLife = false } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...cfgOver }, env);
  const clock = { t: T0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  let calls = 0;
  const deps = {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => rug, searchByName: async () => [],
  };
  if (!omitCurveLife) deps.fetchCurveLife = async (mint) => {
    calls++;
    if (curveLife === 'throw') throw new Error('dexscreener unreachable');
    return typeof curveLife === 'function' ? curveLife(mint) : curveLife;
  };
  const bot = new Bot(cfg, deps);
  return { bot, clock, views, curveLifeCalls: () => calls };
}

async function popFire(rig, { mint = 'MINTP', symbol = 'POPT', dex = 'pumpswap' } = {}) {
  const v = view({ address: mint, symbol, mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

async function trendFire(rig, { mint = 'MINTT', symbol = 'TRENT' } = {}) {
  const v = view({ address: mint, symbol, mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'trend', metrics: { volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

// ------------------------------------------------------------ config
test('config: fast-bond block defaults ON at 180s; env knobs read; validation bounds the line', () => {
  const d = loadConfig({});
  assert.equal(d.fastBondBlock, true);
  assert.equal(d.fastBondMaxSec, 180, 'owner order 2026-10-21: the line is 3 minutes');
  assert.equal(loadConfig({ FAST_BOND_BLOCK: '0' }).fastBondBlock, false);
  assert.equal(loadConfig({ FAST_BOND_MAX_SEC: '45' }).fastBondMaxSec, 45);
  assert.equal(d.fastBondUnknownBlock, true, 'blind-on-young block defaults ON (2026-10-21)');
  assert.equal(d.fastBondUnknownMaxPoolAgeMin, 60);
  assert.equal(loadConfig({ FAST_BOND_UNKNOWN_BLOCK: '0' }).fastBondUnknownBlock, false);
  assert.equal(loadConfig({ FAST_BOND_UNKNOWN_MAX_POOL_AGE_MIN: '30' }).fastBondUnknownMaxPoolAgeMin, 30);
  assert.ok(validateConfig({ ...d, fastBondMaxSec: 0 }).some(e => e.includes('FAST_BOND_MAX_SEC')));
  assert.ok(validateConfig({ ...d, fastBondMaxSec: 86401 }).some(e => e.includes('FAST_BOND_MAX_SEC')));
  assert.ok(!validateConfig(d).some(e => e.includes('FAST_BOND_MAX_SEC')));
});

// ------------------------------------------------------------ verdict helper
test('fastBondVerdict: under the line blocks, at/over passes, unmeasured is unknown and never blocks', () => {
  assert.deepEqual(fastBondVerdict(119, 120), { pass: false, lifeSec: 119, unknown: false, reason: 'curve lifespan 119s < 120s — fast bonder blocked' });
  assert.equal(fastBondVerdict(120, 120).pass, true, 'boundary: exactly at the line passes');
  assert.equal(fastBondVerdict(121, 120).pass, true);
  assert.equal(fastBondVerdict(78, 120).pass, false, 'the TRUMARS shape');
  for (const bad of [null, undefined, NaN, 'fast', -5]) {
    const v = fastBondVerdict(bad, 120);
    assert.deepEqual({ pass: v.pass, lifeSec: v.lifeSec, unknown: v.unknown }, { pass: true, lifeSec: null, unknown: true }, `${String(bad)} must read unknown`);
  }
});

test('fastBondVerdict blind block: unknown on a young pool blocks; old pool / no scope / knob off still passes', () => {
  const young = fastBondVerdict(null, 180, { poolAgeMin: 36, unknownBlockPoolAgeMin: 60 });
  assert.equal(young.pass, false, 'CYBERCAT shape: 36m-old pool, unreadable lifespan');
  assert.equal(young.unknown, true, 'still honest: nothing was measured');
  assert.equal(young.blindBlock, true);
  assert.match(young.reason, /not bought blind/);
  assert.equal(fastBondVerdict(null, 180, { poolAgeMin: 60, unknownBlockPoolAgeMin: 60 }).blindBlock, true, 'boundary: exactly at the age line blocks');
  assert.equal(fastBondVerdict(null, 180, { poolAgeMin: 61, unknownBlockPoolAgeMin: 60 }).pass, true, 'past the age line the fail-open read stands');
  assert.equal(fastBondVerdict(null, 180, { poolAgeMin: 600, unknownBlockPoolAgeMin: 60 }).pass, true, 'old pool: stamps rot, survival is evidence');
  assert.equal(fastBondVerdict(null, 180, { poolAgeMin: null, unknownBlockPoolAgeMin: 60 }).pass, true, 'no pool age read — no scope, no block');
  assert.equal(fastBondVerdict(null, 180, { poolAgeMin: 10, unknownBlockPoolAgeMin: 0 }).pass, true, 'knob at 0 disables the blind block');
  assert.equal(fastBondVerdict(5000, 180, { poolAgeMin: 10, unknownBlockPoolAgeMin: 60 }).pass, true, 'a measured life is judged on its number, never on age');
  assert.equal(fastBondVerdict(60, 180, { poolAgeMin: 10, unknownBlockPoolAgeMin: 60 }).pass, false, 'a measured sub-line life blocks as before');
});

// ------------------------------------------------------------ measurement (pure)
test('curveLifeFromPairs: graduation stamp minus curve stamp, earliest AMM pair wins', () => {
  const curve = { dexId: 'pumpfun', pairCreatedAt: 1792198759000 };
  const swap = { dexId: 'pumpswap', pairCreatedAt: 1792198837000 };
  assert.equal(curveLifeFromPairs([curve, swap]), 78, 'the TRUMARS pair set');
  assert.equal(curveLifeFromPairs([swap, curve]), 78, 'order in the payload does not matter');
  const raydiumLater = { dexId: 'raydium', pairCreatedAt: 1792198837000 + 3600e3 };
  assert.equal(curveLifeFromPairs([curve, raydiumLater, swap]), 78, 'the FIRST AMM pair is the graduation');
  assert.equal(curveLifeFromPairs([{ dexId: 'pumpfun', pairCreatedAt: 1000000 }, { dexId: 'pumpswap', pairCreatedAt: 1000000 + 120000 }]), 120);
});

test('curveLifeFromPairs: EQUAL stamps are a measured 0 (owner order 2026-10-21, the MILK/KIMCHI hole)', () => {
  // DexScreener stamps the curve pair and the AMM pair with the same
  // pairCreatedAt second when a curve is slammed to graduation inside one
  // timestamp tick. That used to read null ("unavailable — not judged")
  // and fastBond waved MILK (11:56:27 both stamps) and two KIMCHI clones
  // (13:14:06 / 13:47:44, both stamps equal) through in one day.
  const ts = 1792604864000;
  assert.equal(curveLifeFromPairs([{ dexId: 'pumpfun', pairCreatedAt: ts }, { dexId: 'pumpswap', pairCreatedAt: ts }]), 0, 'same-second graduation is a measured 0s life');
  assert.equal(fastBondVerdict(0, 120).pass, false, 'a measured 0 blocks at the 120s line');
  assert.equal(fastBondVerdict(0, 120).unknown, false, 'a measured 0 is judged, not unknown');
});

test('curveLifeFromPairs: every unmeasurable shape reads null (unknown), never a number', () => {
  const curve = { dexId: 'pumpfun', pairCreatedAt: 1792198759000 };
  const swap = { dexId: 'pumpswap', pairCreatedAt: 1792198837000 };
  assert.equal(curveLifeFromPairs([curve]), null, 'no AMM pair — not graduated yet');
  assert.equal(curveLifeFromPairs([swap]), null, 'no curve pair — not a pump launch (or DS dropped it)');
  assert.equal(curveLifeFromPairs([]), null);
  assert.equal(curveLifeFromPairs(null), null);
  assert.equal(curveLifeFromPairs([{ dexId: 'pumpfun' }, swap]), null, 'curve stamp missing');
  assert.equal(curveLifeFromPairs([curve, { dexId: 'pumpswap' }]), null, 'AMM stamp missing');
  assert.equal(curveLifeFromPairs([{ dexId: 'pumpfun', pairCreatedAt: 2000 }, { dexId: 'pumpswap', pairCreatedAt: 1000 }]), null, 'AMM stamped before the curve — indexer noise');
  assert.equal(curveLifeFromPairs([{ dexId: 'pumpfun', pairCreatedAt: 1000 }, { dexId: 'pumpswap', pairCreatedAt: 1500 }]), null, 'sub-second — same-stamp noise, not a duration');
  assert.equal(curveLifeFromPairs([{ pairCreatedAt: 1000 }, swap]), null, 'a pair without dexId identifies nothing');
});

// ------------------------------------------------------------ pipeline: the block
test('fast bond: TRUMARS shape on the TREND path — 78s curve skipped, stamped, tallied, no buy', async () => {
  const rig = pipelineRig({ curveLife: 78 });
  const rec = await trendFire(rig);
  assert.equal(rec.setup, 'trend');
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.deepEqual(rec.reasons, ['curve lifespan 78s < 180s — fast bonder blocked']);
  assert.equal(rec.gatePass, true, 'the gate stack itself passed — the block is what stopped it');
  assert.equal(rec.gates.fastBond.pass, false);
  assert.equal(rec.gates.fastBond.curveLifeSec, 78);
  assert.equal(rec.gates.fastBond.max, 180);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.stats.entries, 0);
  assert.deepEqual(rig.bot.stats.fastBond, { blocked: 1, passed: 0, unknown: 0 });
  assert.equal(rig.curveLifeCalls(), 1, 'measured lazily, once, at the seam');
});

test('fast bond: boundary — 179s blocks, exactly 180s buys with the stamp on the taken record', async () => {
  const r179 = pipelineRig({ curveLife: 179 });
  const rec179 = await popFire(r179);
  assert.equal(rec179.decision, 'skipped');
  assert.deepEqual(rec179.reasons, ['curve lifespan 179s < 180s — fast bonder blocked']);
  const r180 = pipelineRig({ curveLife: 180 });
  const rec180 = await popFire(r180);
  assert.equal(rec180.decision, 'taken', JSON.stringify(rec180.reasons));
  assert.equal(rec180.gates.fastBond.pass, true);
  assert.equal(rec180.gates.fastBond.curveLifeSec, 180);
  assert.equal(r180.bot.positions.length, 1);
  assert.deepEqual(r180.bot.stats.fastBond, { blocked: 0, passed: 1, unknown: 0 });
});

test('fast bond: FAST_BOND_MAX_SEC moves the line — 78s passes at 60, 59s blocks', async () => {
  const r78 = pipelineRig({ cfgOver: { fastBondMaxSec: 60 }, curveLife: 78 });
  assert.equal((await popFire(r78)).decision, 'taken');
  const r59 = pipelineRig({ cfgOver: { fastBondMaxSec: 60 }, curveLife: 59 });
  const rec59 = await popFire(r59);
  assert.equal(rec59.decision, 'skipped');
  assert.deepEqual(rec59.reasons, ['curve lifespan 59s < 60s — fast bonder blocked']);
});

test('fast bond: a measured 0s curve life (same-second bonder) is BLOCKED on the pop path', async () => {
  const rig = pipelineRig({ curveLife: 0 });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.deepEqual(rec.reasons, ['curve lifespan 0s < 180s — fast bonder blocked']);
  assert.equal(rec.gates.fastBond.pass, false);
  assert.equal(rec.gates.fastBond.curveLifeSec, 0);
  assert.equal(rec.gates.fastBond.unknown, undefined, 'a measured life is judged — the unknown stamp is only set when unmeasured');
  assert.equal(rig.bot.positions.length, 0);
  assert.deepEqual(rig.bot.stats.fastBond, { blocked: 1, passed: 0, unknown: 0 });
});

// ------------------------------------------------------------ pipeline: fail open, always
test('fast bond FAIL OPEN: non-graduated curve coin (no lifespan) buys untouched, record says unknown', async () => {
  const rig = pipelineRig({ curveLife: null });
  const rec = await popFire(rig, { dex: 'pumpfun' });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.fastBond.pass, true);
  assert.equal(rec.gates.fastBond.curveLifeSec, null);
  assert.equal(rec.gates.fastBond.unknown, true);
  assert.deepEqual(rig.bot.stats.fastBond, { blocked: 0, passed: 0, unknown: 1 });
  assert.equal(rig.bot.positions.length, 1, 'a curve-side path is definitionally untouched');
});

test('fast bond FAIL OPEN: the lifespan fetch throwing still buys, tallied unknown', async () => {
  const rig = pipelineRig({ curveLife: 'throw' });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.fastBond.unknown, true);
  assert.deepEqual(rig.bot.stats.fastBond, { blocked: 0, passed: 0, unknown: 1 });
});

test('fast bond FAIL OPEN: no fetchCurveLife dep wired (unit rigs) — buys, tallied unknown', async () => {
  const rig = pipelineRig({ omitCurveLife: true });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.fastBond.unknown, true);
  assert.deepEqual(rig.bot.stats.fastBond, { blocked: 0, passed: 0, unknown: 1 });
});

// ------------------------------------------------------------ kill switch
test('fast bond: kill switch FAST_BOND_BLOCK=0 — a 30s bonder buys, no stamp, no tally, no fetch', async () => {
  const rig = pipelineRig({ cfgOver: { fastBondBlock: false }, curveLife: 30 });
  const rec = await popFire(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.fastBond, undefined, 'no verdict stamped when the block is off');
  assert.equal(rig.bot.stats.fastBond, undefined, 'no tally when the block is off');
  assert.equal(rig.curveLifeCalls(), 0, 'the measurement is never even fetched when off');
  assert.equal(rig.bot.positions.length, 1);
});

// ------------------------------------------------------------ cache
test('curve life cache: a measured lifespan is fetched once per mint and never refetched', async () => {
  const rig = pipelineRig({ curveLife: 78 });
  assert.equal(await rig.bot._curveLifeSec('MINTX'), 78);
  assert.equal(await rig.bot._curveLifeSec('MINTX'), 78);
  assert.equal(rig.curveLifeCalls(), 1, 'second read is a cache hit — lifespan is immutable');
  assert.equal(await rig.bot._curveLifeSec('MINTY'), 78);
  assert.equal(rig.curveLifeCalls(), 2, 'a different mint gets its own single read');
});

test('curve life cache: unknown is negatively cached 60s, then re-measured (graduation meanwhile counts)', async () => {
  let life = null;
  const rig = pipelineRig({ curveLife: () => life });
  assert.equal(await rig.bot._curveLifeSec('MINTX'), null);
  assert.equal(await rig.bot._curveLifeSec('MINTX'), null);
  assert.equal(rig.curveLifeCalls(), 1);
  rig.clock.t += 59_000;
  assert.equal(await rig.bot._curveLifeSec('MINTX'), null);
  assert.equal(rig.curveLifeCalls(), 1, 'inside the negative-cache window: no refetch');
  rig.clock.t += 2_000;
  life = 5000;
  assert.equal(await rig.bot._curveLifeSec('MINTX'), 5000, 'after the window the mint is re-measured');
  assert.equal(rig.curveLifeCalls(), 2);
});

// ------------------------------------------------------------ blind block (owner order 2026-10-21, CYBERCAT)
async function popFireYoung(rig, { mint = 'MINTY', symbol = 'YOUNG', ageMin = 30 } = {}) {
  const v = view({ address: mint, symbol, mc: 500_000, liq: 100_000, createdAt: T0 - ageMin * 60e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

test('blind block: CYBERCAT shape — unreadable lifespan on a 30m-old pool is SKIPPED, not bought blind', async () => {
  const rig = pipelineRig({ curveLife: null });
  const rec = await popFireYoung(rig);
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.equal(rec.reasons.length, 1);
  assert.match(rec.reasons[0], /curve lifespan unavailable on a 30m-old pool — not bought blind/);
  assert.equal(rec.gates.fastBond.pass, false);
  assert.equal(rec.gates.fastBond.curveLifeSec, null, 'nothing was measured — the record stays honest');
  assert.equal(rec.gates.fastBond.unknown, true);
  assert.equal(rec.gates.fastBond.blindBlock, true);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.stats.fastBond.blindBlocked, 1);
  assert.equal(rig.bot.stats.fastBond.blocked, 0, 'a blind block is not a measured block');
  assert.equal(rig.bot.stats.fastBond.unknown, 0, 'nor a passed unknown');
  assert.equal(rig.bot.birthVerdicts.size, 0, 'blindness writes NO birth verdict — a later read may judge the mint fresh');
});

test('blind block: FAST_BOND_UNKNOWN_BLOCK off restores fail-open on the same young blind coin', async () => {
  const rig = pipelineRig({ cfgOver: { fastBondUnknownBlock: false }, curveLife: null });
  const rec = await popFireYoung(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.fastBond.unknown, true);
  assert.equal(rec.gates.fastBond.blindBlock, undefined);
  assert.equal(rig.bot.stats.fastBond.unknown, 1);
});

test('blind block: young pool with a MEASURED long life buys; blind read past the age line buys', async () => {
  const measured = pipelineRig({ curveLife: 5000 });
  const recM = await popFireYoung(measured);
  assert.equal(recM.decision, 'taken', JSON.stringify(recM.reasons));
  assert.equal(recM.gates.fastBond.curveLifeSec, 5000);
  const old = pipelineRig({ curveLife: null });
  const recO = await popFireYoung(old, { ageMin: 61 });
  assert.equal(recO.decision, 'taken', JSON.stringify(recO.reasons));
  assert.equal(recO.gates.fastBond.unknown, true);
  assert.equal(recO.gates.fastBond.blindBlock, undefined, 'past the 60m scope the fail-open read stands');
});

// ------------------------------------------------------------ chain measurement (pure)
test('curveLifeFromSigTimes: complete window is the exact span; order and junk are handled', () => {
  assert.equal(curveLifeFromSigTimes([1000, 1078], true, 180), 78, 'the TRUMARS span from chain times');
  assert.equal(curveLifeFromSigTimes([1078, 1000], true, 180), 78, 'unsorted input is sorted');
  assert.equal(curveLifeFromSigTimes([1000, null, NaN, -3, 1078], true, 180), 78, 'junk entries are ignored');
  assert.equal(curveLifeFromSigTimes([1000], true, 180), null, 'one timestamp measures nothing');
  assert.equal(curveLifeFromSigTimes([], true, 180), null);
  assert.equal(curveLifeFromSigTimes(null, true, 180), null);
});

test('curveLifeFromSigTimes: a truncated window speaks only when its span alone clears the line', () => {
  assert.equal(curveLifeFromSigTimes([1000, 1500], false, 180), 500, 'lower bound 500s >= 180s line: the true life is longer still — a sound pass measurement');
  assert.equal(curveLifeFromSigTimes([1000, 1100], false, 180), null, 'lower bound under the line proves nothing — unknown');
});

// --- Birth-burst clause (owner order 2026-10-21, the OA hole) -------------
// OA's real curve history (blockTimes, seconds): creation at t, ELEVEN txs
// inside the first 15 seconds, silence, then the graduation cluster at
// t+506. Pair-age said "507s, safe"; the buying said insta-bond.
const OA_TIMES = [0, 1, 1, 3, 5, 6, 8, 10, 11, 13, 15, 506, 506, 506, 506, 506, 506, 1040].map(x => 1_700_000_000 + x);

test('curveBurstFromSigTimes: OA shape — most of the curve inside its first breath', () => {
  const b = curveBurstFromSigTimes(OA_TIMES, 180, true);
  assert.deepEqual(b, { total: 18, inWindow: 11, windowSec: 180 });
  assert.equal(curveBurstFromSigTimes(OA_TIMES, 180, false), null, 'a truncated history loses the birth window — measures nothing');
  assert.equal(curveBurstFromSigTimes([100, 200, 300], 180, true), null, 'too few txs to judge a shape');
  const spread = Array.from({ length: 20 }, (_, i) => 1_700_000_000 + i * 120);
  assert.equal(curveBurstFromSigTimes(spread, 180, true).inWindow, 2, 'an organic grind keeps its buys spread');
});

test('burstBondVerdict: blocks a birth burst, passes a spread, silent on darkness', () => {
  const v = burstBondVerdict({ total: 18, inWindow: 11, windowSec: 180 }, { windowSec: 180, minFrac: 0.5 });
  assert.equal(v.blocked, true);
  assert.match(v.reason, /insta-bond burst: 11 of 18 curve txs landed within 180s/);
  assert.equal(burstBondVerdict({ total: 20, inWindow: 2, windowSec: 180 }, { windowSec: 180, minFrac: 0.5 }).blocked, false);
  assert.equal(burstBondVerdict({ total: 20, inWindow: 10, windowSec: 180 }, { windowSec: 180, minFrac: 0.5 }).blocked, true, 'exactly at the frac line blocks');
  assert.equal(burstBondVerdict(null, { windowSec: 180, minFrac: 0.5 }).blocked, false, 'no measurement, no verdict');
});

test('burst seam: OA shape — measured 507s lifespan pass is overturned by the birth burst', async () => {
  const rig = pipelineRig({ curveLife: 507 });
  rig.bot.d.fetchCurveBurst = async () => ({ total: 18, inWindow: 11, windowSec: 180 });
  const sig = await popFire(rig, { mint: 'MINTOA', symbol: 'OA' });
  assert.equal(sig.decision, 'skipped');
  assert.equal(sig.gates.fastBond.pass, false);
  assert.equal(sig.gates.fastBond.burstBlocked, true);
  assert.match(sig.gates.fastBond.reason, /insta-bond burst/);
  assert.ok(rig.bot.birthVerdicts.get('MINTOA'), 'a burst block is a birth fact — remembered');
});

test('burst seam: spread curve and unmeasured burst both leave the lifespan pass standing', async () => {
  const spread = pipelineRig({ curveLife: 507 });
  spread.bot.d.fetchCurveBurst = async () => ({ total: 20, inWindow: 2, windowSec: 180 });
  const sigA = await popFire(spread, { mint: 'MINTSPREAD', symbol: 'SPRD' });
  assert.equal(sigA.gates.fastBond.pass, true);
  assert.notEqual(sigA.decision, 'skipped');
  const dark = pipelineRig({ curveLife: 507 });
  dark.bot.d.fetchCurveBurst = async () => null;
  const sigB = await popFire(dark, { mint: 'MINTDARK', symbol: 'DARK' });
  assert.equal(sigB.gates.fastBond.pass, true);
  assert.notEqual(sigB.decision, 'skipped');
});
