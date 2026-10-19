import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

// TREND ENTRY LANE (owner order 2026-10-18 21:49 EDT, out of the godspeed
// post-mortem — a clean trend signal at $62K could only enroll, and every
// base door said no later at worse prices): "allow trends to not just be
// an enrollment type of signal... only the 1 or 2nd time it signals not
// the 20th." A trend signal that survives the whole gate stack enters
// DIRECTLY while it is among the mint's first TREND_ENTRY_MAX_SIGNALS
// trend signals (ordinal counted from the journal, boot-hydrated, and
// stamped on the record either way); past the cap it enrolls exactly as
// before. TREND_ENTRY_LIVE=0 restores enrollment-only.
const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

function pipelineRig({ cfgOver = {}, env = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver }, env);
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

async function fire(rig, { mint = 'MINTT', setup = 'trend' } = {}) {
  const v = view({ address: mint, symbol: 'TEST', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup, strength: 42, metrics: { volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

function seedTrendRecords(bot, mint, n, decision = 'skipped') {
  for (let i = 0; i < n; i++) bot.journal.signal({ mint, symbol: 'TEST', setup: 'trend', decision, reasons: ['seeded'], price: 1, mc: 100_000, metrics: {}, warnings: [], label: null, gates: {}, gatePass: false, fields: null });
}

test('config: TREND_ENTRY_LIVE defaults 1, TREND_ENTRY_MAX_SIGNALS defaults 2, both validate', () => {
  const d = loadConfig({});
  assert.equal(d.trendEntryLive, 1);
  assert.equal(d.trendEntryMaxSignals, 2);
  assert.equal(loadConfig({ TREND_ENTRY_LIVE: '0' }).trendEntryLive, 0);
  assert.equal(loadConfig({ TREND_ENTRY_MAX_SIGNALS: '5' }).trendEntryMaxSignals, 5);
  assert.ok(validateConfig(loadConfig({ TREND_ENTRY_LIVE: '2' })).some(e => e.includes('TREND_ENTRY_LIVE')));
  assert.ok(validateConfig(loadConfig({ TREND_ENTRY_MAX_SIGNALS: '0' })).some(e => e.includes('TREND_ENTRY_MAX_SIGNALS')));
  assert.ok(!validateConfig(d).some(e => e.includes('TREND_ENTRY')));
});

test('the lane: a first trend signal that passes the stack is TAKEN, stamped with its ordinal', async () => {
  const rig = pipelineRig();
  const rec = await fire(rig);
  assert.equal(rec.decision, 'taken');
  assert.equal(rec.fields.trendOrdinal, 1);
  assert.equal(rec.fields.trendEntry, 1);
  assert.equal(rig.bot.positions.length, 1);
  assert.equal(rig.bot.positions[0].setup, 'trend');
  assert.equal(rig.bot.stats.baseMode.trendBypass, 1);
  assert.equal(rig.bot.stats.baseMode.enrolled, 0);
});

test('the cap: with two trend records already journaled, the third signal enrolls like before', async () => {
  const rig = pipelineRig();
  await rig.bot.start();
  seedTrendRecords(rig.bot, 'MINTT', 2);
  const rec = await fire(rig);
  assert.equal(rec.decision, 'skipped');
  assert.match((rec.reasons || []).join(' '), /base mode: enrolled for base watch/);
  assert.equal(rec.fields.trendOrdinal, 3);
  assert.equal(rec.fields.trendEntry, undefined);
  assert.equal(rig.bot.positions.length, 0);
  assert.equal(rig.bot.stats.baseMode.enrolled, 1);
});

test('the second signal still buys (cap is 2): one prior record, the fire is taken as #2', async () => {
  const rig = pipelineRig();
  await rig.bot.start();
  seedTrendRecords(rig.bot, 'MINTT', 1);
  const rec = await fire(rig);
  assert.equal(rec.decision, 'taken');
  assert.equal(rec.fields.trendOrdinal, 2);
  assert.equal(rec.fields.trendEntry, 2);
});

test('kill switch: TREND_ENTRY_LIVE=0 — even the first signal enrolls (ordinal still stamped for the record)', async () => {
  const rig = pipelineRig({ cfgOver: { trendEntryLive: 0 } });
  const rec = await fire(rig);
  assert.equal(rec.decision, 'skipped');
  assert.match((rec.reasons || []).join(' '), /base mode: enrolled/);
  assert.equal(rec.fields.trendOrdinal, 1);
  assert.equal(rig.bot.positions.length, 0);
});

test('the cap dial: TREND_ENTRY_MAX_SIGNALS=1 — the second signal enrolls', async () => {
  const rig = pipelineRig({ cfgOver: { trendEntryMaxSignals: 1 } });
  await rig.bot.start();
  seedTrendRecords(rig.bot, 'MINTT', 1);
  const rec = await fire(rig);
  assert.equal(rec.decision, 'skipped');
  assert.equal(rec.fields.trendOrdinal, 2);
});

test('scope: pop still enrolls untouched; ordinals count only trend records of the same mint', async () => {
  const rig = pipelineRig();
  await rig.bot.start();
  seedTrendRecords(rig.bot, 'OTHER', 5);                       // another mint's history must not inflate MINTT
  rig.bot.journal.signal({ mint: 'MINTT', symbol: 'TEST', setup: 'pop', decision: 'skipped', reasons: ['seeded'], price: 1, mc: 100_000, metrics: {}, warnings: [], label: null, gates: {}, gatePass: false, fields: null });
  const pop = await fire(rig, { setup: 'pop' });
  assert.equal(pop.decision, 'skipped');
  assert.match((pop.reasons || []).join(' '), /base mode: enrolled/);
  assert.equal(pop.fields.trendOrdinal, undefined);
  assert.equal(rig.bot._trendOrdinal('MINTT'), 1);             // the pop record did not count
});

test('restart: the ordinal survives a reboot via the journal, and shadow records never count', async () => {
  const dir = tmp();
  const rig1 = pipelineRig({ cfgOver: { dataDir: dir } });
  await rig1.bot.start();
  seedTrendRecords(rig1.bot, 'MINTT', 2);
  rig1.bot.journal.signal({ mint: 'MINTT', symbol: 'TEST', setup: 'trend', decision: 'shadow', reasons: ['seeded'], price: 1, mc: 100_000, metrics: {}, warnings: [], label: null, gates: {}, gatePass: false, fields: null });
  const rig2 = pipelineRig({ cfgOver: { dataDir: dir } });
  await rig2.bot.start();
  assert.equal(rig2.bot._trendOrdinal('MINTT'), 3);
});
