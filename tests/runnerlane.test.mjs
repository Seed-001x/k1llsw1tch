import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { runnerLaneVerdict } from '../src/gate.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

// ESTABLISHED-RUNNER LANE (owner order 2026-10-22, the yagi case):
// Nagi and Pokke (EU1MHvQvBoJ7DnLorurze1hwR2JWuyoKyAmkwymwpump),
// launched ~19h earlier, signaled three times in one day — staircase at
// $369K, pop at $572K and $868K market cap — and the flat age cap
// vetoed all three with the coin mid-run (+31% prints, $55K of 5-minute
// volume, buyers in control). The lane gives a capped coin one hearing
// on its live tape at the age-cap seam: established market cap,
// sustained + live volume, buyers in control, price holding near its
// trailing-hour peak. A pass lifts ONLY the age veto — the full gate
// stack still judges. RUNNER_LANE=0 restores the absolute cap.
const T0 = 1_000_000_000_000;

// The yagi 19:28 EDT print, as a view: 0.78 days old, $868K cap,
// $224K hourly volume, $55K 5-minute volume, buyers at 60% of the tape.
const yagiView = (o = {}) => view({
  symbol: 'YAGI', name: 'Nagi and Pokke', price: 0.0008985, mc: 868_156, liq: 81_423,
  volH1: 224_328, volM5: 55_325, buysM5: 120, sellsM5: 80,
  createdAt: T0 - 19 * 3600e3, ...o,
});
const flatSamples = (price, n = 12) => Array.from({ length: n }, (_, k) => ({ ts: T0 - (n - 1 - k) * 30000, price }));

test('lane verdict: the yagi shape passes — established, alive, bought, holding near its peak', () => {
  const rl = runnerLaneVerdict(yagiView(), { ageDays: 0.78, samples: flatSamples(0.0008985), metricsDraw: 0.05, now: T0 });
  assert.equal(rl.pass, true, rl.reason);
  assert.equal(rl.stamp.mc, 868_156);
  assert.equal(rl.stamp.buyRatioM5, 0.6);
  assert.equal(rl.stamp.drawPeakPct, 0);
  assert.equal(rl.stamp.ageDays, 0.78);
});

test('lane verdict: past the lane ceiling the coin is stale no matter the tape', () => {
  const rl = runnerLaneVerdict(yagiView(), { ageDays: 2.5, samples: flatSamples(0.0008985), now: T0 });
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /ceiling/);
});

test('lane verdict: under the established market-cap floor fails', () => {
  const rl = runnerLaneVerdict(yagiView({ mc: 250_000 }), { ageDays: 0.78, samples: flatSamples(0.0008985), now: T0 });
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /market cap .* established floor/);
});

test('lane verdict: unknown market cap fails — established must be provable', () => {
  const rl = runnerLaneVerdict(yagiView({ mc: null }), { ageDays: 0.78, samples: flatSamples(0.0008985), now: T0 });
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /market cap unknown/);
});

test('lane verdict: thin sustained volume fails', () => {
  const rl = runnerLaneVerdict(yagiView({ volH1: 20_000 }), { ageDays: 0.78, samples: flatSamples(0.0008985), now: T0 });
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /hourly volume .* sustained-volume floor/);
});

test('lane verdict: a dead 5-minute tape fails even with a loud hour behind it', () => {
  const rl = runnerLaneVerdict(yagiView({ volM5: 5_000 }), { ageDays: 0.78, samples: flatSamples(0.0008985), now: T0 });
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /5-minute volume .* live-tape floor/);
});

test('lane verdict: sellers in control of the live tape fails', () => {
  const rl = runnerLaneVerdict(yagiView({ buysM5: 40, sellsM5: 60 }), { ageDays: 0.78, samples: flatSamples(0.0008985), now: T0 });
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /buyers hold only 40%/);
});

test('lane verdict: no 5-minute tape at all fails', () => {
  const rl = runnerLaneVerdict(yagiView({ buysM5: 0, sellsM5: 0 }), { ageDays: 0.78, samples: flatSamples(0.0008985), now: T0 });
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /no 5-minute tape/);
});

test('lane verdict: deep under the sampled hour peak fails — a bounce, not a climb', () => {
  const rl = runnerLaneVerdict(yagiView(), { ageDays: 0.78, samples: flatSamples(0.0011231), now: T0 }); // peak ~25% above price
  assert.equal(rl.pass, false);
  assert.match(rl.reason, /under its trailing-hour peak/);
  assert.ok(rl.stamp.drawPeakPct > 10);
});

test('lane verdict: the peak leg falls back to the signal drawFromPeak, and passes unmeasured', () => {
  const fb = runnerLaneVerdict(yagiView(), { ageDays: 0.78, samples: [], metricsDraw: 0.05, now: T0 });
  assert.equal(fb.pass, true, fb.reason);
  assert.equal(fb.stamp.drawPeakPct, 5);
  const fbFail = runnerLaneVerdict(yagiView(), { ageDays: 0.78, samples: [], metricsDraw: 0.3, now: T0 });
  assert.equal(fbFail.pass, false);
  const unmeasured = runnerLaneVerdict(yagiView(), { ageDays: 0.78, samples: [], metricsDraw: null, now: T0 });
  assert.equal(unmeasured.pass, true, unmeasured.reason);
  assert.equal(unmeasured.stamp.drawPeakPct, null);
});

test('config: runner lane defaults on with the shipped floors, all validate', () => {
  const d = loadConfig({});
  assert.equal(d.runnerLane, true);
  assert.equal(d.runnerMinMcUsd, 300000);
  assert.equal(d.runnerMinVolH1Usd, 50000);
  assert.equal(d.runnerMinVolM5Usd, 15000);
  assert.equal(d.runnerMinBuyRatioM5, 0.55);
  assert.equal(d.runnerMaxDrawPeakPct, 10);
  assert.equal(d.runnerMaxAgeDays, 2);
  assert.deepEqual(validateConfig(d), []);
  assert.equal(loadConfig({ RUNNER_LANE: '0' }).runnerLane, false);
  assert.equal(loadConfig({ RUNNER_MIN_MC_USD: '500000' }).runnerMinMcUsd, 500000);
  assert.ok(validateConfig(loadConfig({ RUNNER_MIN_BUY_RATIO_M5: '2' })).some(e => e.includes('RUNNER_MIN_BUY_RATIO_M5')));
  assert.ok(validateConfig(loadConfig({ RUNNER_MAX_AGE_DAYS: '-1' })).some(e => e.includes('RUNNER_MAX_AGE_DAYS')));
  assert.ok(validateConfig(loadConfig({ RUNNER_MAX_DRAW_PEAK_PCT: '101' })).some(e => e.includes('RUNNER_MAX_DRAW_PEAK_PCT')));
});

// --- bot-level: the seam in onSignal ---------------------------------
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price, mc) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc, volM5: 55_000, volH1: 224_000, buysM5: 120, sellsM5: 80, liq: 81_423 });
  bot.history.m.set(mint, samples);
}

function pipelineRig({ cfgOver = {}, env = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, enrollSignals: 0, maxCoinAgeDays: 0.0833, ...cfgOver }, env);
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

async function fire(rig, { mint = 'YAGI1', viewOver = {}, metrics = { gainPct: 30.7, drawFromPeak: 0.05, buyRatioM5: 0.6, volH1: 224_328, volM5: 55_325 } } = {}) {
  const v = yagiView({ address: mint, ...viewOver });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint, v.price, v.mc);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 30.7, metrics });
  return rig.bot.journal.signals.at(-1);
}

test('bot: a capped coin that passes the lane is taken, with the age veto and the lane verdict both on the record', async () => {
  const rig = pipelineRig();
  const rec = await fire(rig);
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.ageCap.pass, false);
  assert.equal(rec.gates.runnerLane.pass, true);
  assert.equal(rec.metrics.runnerLane.mc, 868_156);
  assert.equal(rig.bot.stats.runnerLane.passed, 1);
});

test('bot: a capped coin that fails the lane skips on the age cap, the lane reason appended', async () => {
  const rig = pipelineRig();
  const rec = await fire(rig, { viewOver: { volM5: 5_000 }, metrics: { gainPct: 30.7, drawFromPeak: 0.05, buyRatioM5: 0.6, volH1: 224_328, volM5: 5_000 } });
  assert.equal(rec.decision, 'skipped');
  assert.match(rec.reasons[0], /^age cap:/);
  assert.match(rec.reasons[1], /^runner lane: 5-minute volume/);
  assert.equal(rec.gates.runnerLane.pass, false);
  assert.equal(rig.bot.stats.runnerLane.evaluated, 1);
  assert.equal(rig.bot.stats.runnerLane.passed, 0);
});

test('bot: RUNNER_LANE=0 restores the absolute cap — same record as before the lane existed', async () => {
  const rig = pipelineRig({ cfgOver: { runnerLane: false } });
  const rec = await fire(rig);
  assert.equal(rec.decision, 'skipped');
  assert.equal(rec.reasons.length, 1);
  assert.match(rec.reasons[0], /^age cap:/);
  assert.equal(rec.gates.runnerLane, undefined);
});

test('bot: a young coin never meets the lane — taken with no age stamps at all', async () => {
  const rig = pipelineRig();
  const rec = await fire(rig, { viewOver: { createdAt: T0 - 100 * 60000 } }); // 100m old: under the 2h cap, past the 60m blind fast-bond window
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.ageCap, undefined);
  assert.equal(rec.gates.runnerLane, undefined);
});
