// GRIND JUDGE (owner order 2026-10-18 ~10:11 EDT, "do what must be
// done" — after his two diagnoses: volume bots puppet the flow vitals,
// and liquidity barely moves on pump-family coins, so the downside stack
// was blind in a grind: detector fires 3 = collapses 3, the specimen 🤗
// ground 88K -> 32K over 171 minutes with every vital green and was
// exited by hand at -65%). The judge sells a pre-TP1 position only when
// BOTH unfakeable witnesses agree the bid is manufactured: the trailing
// fake-alive share is high AND the wallet census shows buys printing
// from a dead census (few distinct wallets, zero first-seen arrivals),
// held through a slow confirm. These tests pin the conjunction leg by
// leg, the specimen end-to-end, every rescue path, and the
// pre-registered kill rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { sampleFakeAlive, fakeAliveWindow } from '../src/fakeAlive.js';
import { evaluateGrind, grindKillTally } from '../src/grindJudge.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const MINT = 'MINTP';
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

function pipelineRig({ cfgOver = {}, env = {} } = {}) {
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
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  return { bot, clock, views, exec, cfg };
}

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

async function openPop(rig, mint = MINT) {
  const v = view({ address: mint, symbol: 'GRIND', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { volM5: 100_000 } });
  await flush();
  assert.equal(rig.bot.positions.length, 1, 'pop position opened');
  rig.bot.latest.set(mint, v);
  rig.bot._syncCensus();
  return { pos: rig.bot.positions[0], v };
}

async function drive(rig, pos, v, { ratio, buys = 30, sells = 32 }) {
  const basis = pos.entrySol * pos.remainingFrac;
  rig.bot.exec.markValue = async () => ratio * basis;
  v.buysM5 = buys; v.sellsM5 = sells;
  rig.clock.t += 15_000;
  await rig.bot.managePosition(pos, 150);
  await flush();
}
const fold = (rig, trader, side = 'buy') => rig.bot._censusOnTrade(MINT, { trader, side, tokens: 1000, ts: rig.clock.t });
const grindRecords = (rig) => { try { return fs.readFileSync(rig.bot.journal.f.grind, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

// ------------------------------------------------------------ config
test('config: grind judge defaults — module on, live OFF until GRIND_JUDGE_LIVE=1, dials at the specimen calibration', () => {
  const c = loadConfig({});
  assert.equal(c.grindJudge, true);
  assert.equal(c.grindJudgeLive, false);
  assert.equal(loadConfig({ GRIND_JUDGE_LIVE: '1' }).grindJudgeLive, true);
  assert.equal(loadConfig({ GRIND_JUDGE: '0' }).grindJudge, false);
  assert.equal(c.grindFaShare, 0.30);
  assert.equal(c.grindMaxUniqBuyers, 4);
  assert.equal(c.grindKillN, 10);
  assert.equal(c.grindKillWrong, 6);
});

// ------------------------------------------------------------ the conjunction
const CFG = loadConfig({});
const HOT_IN = { cfg: CFG, ageSec: 1500, ratio: 0.7, faWin: { samples: 60, fake: 40, share: 0.67 }, cenWin: { buys: 20, sells: 18, uniqBuyers: 3, newBuyers: 0 }, censusAgeMs: 1500_000 };
test('evaluateGrind: the full conjunction reads hot', () => {
  assert.deepEqual(evaluateGrind(HOT_IN), { hot: true, why: 'hot' });
});
test('evaluateGrind: every leg vetoes on its own', () => {
  const cases = [
    [{ ageSec: 599 }, 'young'],
    [{ ratio: 0.96 }, 'not-underwater'],
    [{ ratio: null }, 'not-underwater'],
    [{ faWin: null }, 'fa-thin'],
    [{ faWin: { samples: 29, fake: 29, share: 1 } }, 'fa-thin'],
    [{ faWin: { samples: 60, fake: 17, share: 0.29 } }, 'fa-low'],
    [{ cenWin: null }, 'census-dark'],
    [{ censusAgeMs: 599_999 }, 'census-young'],
    [{ cenWin: { buys: 7, sells: 5, uniqBuyers: 3, newBuyers: 0 } }, 'tape-quiet'],
    [{ cenWin: { buys: 20, sells: 5, uniqBuyers: 5, newBuyers: 0 } }, 'buyers-alive'],
    [{ cenWin: { buys: 20, sells: 5, uniqBuyers: 3, newBuyers: 1 } }, 'new-arriving'],
  ];
  for (const [over, why] of cases) {
    const out = evaluateGrind({ ...HOT_IN, ...over });
    assert.equal(out.hot, false, why);
    assert.equal(out.why, why);
  }
  assert.equal(evaluateGrind({ ...HOT_IN, cfg: { ...CFG, grindJudge: false } }).why, 'off');
});

// ------------------------------------------------------------ trailing fake-alive window
test('fakeAliveWindow: trailing share reads only the window, old samples expire', () => {
  const pos = {};
  sampleFakeAlive(pos, { ratio: 1.10, buysM5: 30, sellsM5: 32, ts: 0 });       // seed
  sampleFakeAlive(pos, { ratio: 0.90, buysM5: 30, sellsM5: 32, ts: 10_000 });  // fake
  sampleFakeAlive(pos, { ratio: 0.88, buysM5: 30, sellsM5: 32, ts: 20_000 });  // fake
  sampleFakeAlive(pos, { ratio: 0.86, buysM5: 1, sellsM5: 40, ts: 90_000 });   // honest tape: not fake
  const w = fakeAliveWindow(pos, 100_000, 30_000);
  assert.equal(w.samples, 1);
  assert.equal(w.share, 0);
  const wAll = fakeAliveWindow(pos, 100_000, 200_000);
  assert.equal(wAll.samples, 3);
  assert.equal(wAll.fake, 2);
  assert.equal(fakeAliveWindow({}, 0, 1000), null);
});

// ------------------------------------------------------------ kill-rule tally
test('grindKillTally: only grind-judge closes count; rips >= the bar are wrong', () => {
  const done = [
    { reason: 'grind judge: fake-alive 0.5 (30m), census 9 buys/3 uniq/0 new (10m)', peakMovePct: 31 },
    { reason: 'grind judge: x', peakMovePct: 24.9 },
    { reason: 'grind judge: x', peakMovePct: null },
    { reason: 'take profit 1: +19%', peakMovePct: 90 },
    { reason: 'grind judge: x', peakMovePct: 25 },
    null, {},
  ];
  assert.deepEqual(grindKillTally(done, CFG), { finalized: 4, wrong: 2 });
});

// ------------------------------------------------------------ the specimen, end to end
test('live path: the specimen — balanced tape, three wallets, zero arrivals: the judge sells it', async () => {
  const rig = pipelineRig({ cfgOver: { grindJudgeLive: true } });
  const { pos, v } = await openPop(rig);
  fold(rig, 'A'); fold(rig, 'B'); fold(rig, 'C');
  await drive(rig, pos, v, { ratio: 1.06 });                       // sampled peak
  for (let i = 0; i < 8; i++) { fold(rig, 'A'); fold(rig, 'B'); await drive(rig, pos, v, { ratio: 1.03 - i * 0.01 }); }
  let drives = 9;
  while (rig.bot.positions.length && drives < 90) {
    fold(rig, 'A'); fold(rig, 'C');
    await drive(rig, pos, v, { ratio: Math.max(0.62, 0.95 - (drives - 9) * 0.008) });
    drives++;
  }
  assert.equal(rig.bot.positions.length, 0, 'the judge closed the grind');
  assert.ok(drives >= 45, `it took a real grind to get there (${drives} drives ≈ ${(drives * 15 / 60).toFixed(1)} min)`);
  const closes = fs.readFileSync(rig.bot.journal.f.trades, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.type === 'close' && r.id === pos.id);
  assert.equal(closes.length, 1);
  assert.ok(closes[0].reason.startsWith('grind judge'), closes[0].reason);
  assert.ok(closes[0].census, 'close record carries the census stamp');
  assert.equal(closes[0].census.uniqBuyers, 3, 'three wallets puppeted the whole bid');
  const types = grindRecords(rig).map(r => r.type);
  assert.ok(types.includes('grindHot'), 'first-hot was journaled');
  assert.ok(types.includes('grindFire'), 'the fire was journaled');
  assert.equal(rig.bot.grindState.fires, 1);
  assert.equal(rig.bot.grindState.closes, 1);
  assert.equal(rig.bot.state().grindJudge.live, true);
});

// ------------------------------------------------------------ rescue paths
async function grindToHot(rig, pos, v) {
  fold(rig, 'A'); fold(rig, 'B'); fold(rig, 'C');
  await drive(rig, pos, v, { ratio: 1.06 });
  for (let i = 0; i < 8; i++) { fold(rig, 'A'); fold(rig, 'B'); await drive(rig, pos, v, { ratio: 1.03 - i * 0.01 }); }
  let drives = 9;
  while (!pos.grindPendingSince && drives < 90) {
    fold(rig, 'A'); fold(rig, 'C');
    await drive(rig, pos, v, { ratio: Math.max(0.62, 0.95 - (drives - 9) * 0.008) });
    drives++;
  }
  assert.ok(pos.grindPendingSince, 'the position went hot');
}

test('rescue: price recovers over the underwater bar inside the confirm — pending cancels, position held', async () => {
  const rig = pipelineRig({ cfgOver: { grindJudgeLive: true } });
  const { pos, v } = await openPop(rig);
  await grindToHot(rig, pos, v);
  await drive(rig, pos, v, { ratio: 1.0 });
  assert.equal(pos.grindPendingSince, null, 'pending cancelled');
  assert.equal(rig.bot.positions.length, 1, 'still held');
  assert.ok(grindRecords(rig).some(r => r.type === 'grindCancel' && r.why === 'not-underwater'));
});

test('rescue: one genuinely new buyer arriving inside the confirm cancels the fire', async () => {
  const rig = pipelineRig({ cfgOver: { grindJudgeLive: true } });
  const { pos, v } = await openPop(rig);
  await grindToHot(rig, pos, v);
  fold(rig, 'D');
  await drive(rig, pos, v, { ratio: 0.66 });
  assert.equal(pos.grindPendingSince, null);
  assert.equal(rig.bot.positions.length, 1, 'still held — a real bid showed up');
  assert.ok(grindRecords(rig).some(r => r.type === 'grindCancel' && r.why === 'new-arriving'));
});

test('shadow mode: with the live switch off the judge would-fires on the journal and sells nothing', async () => {
  const rig = pipelineRig({ cfgOver: { grindJudgeLive: false } });
  const { pos, v } = await openPop(rig);
  await grindToHot(rig, pos, v);
  for (let i = 0; i < 12 && !pos.grindWouldFired; i++) { fold(rig, 'A'); await drive(rig, pos, v, { ratio: 0.64 }); }
  assert.equal(pos.grindWouldFired, true, 'the would-fire stamped');
  assert.equal(rig.bot.positions.length, 1, 'nothing sold in shadow mode');
  assert.ok(grindRecords(rig).some(r => r.type === 'grindWouldFire'));
  assert.equal(rig.bot.grindState.fires, 0);
});

test('one witness is never enough: no census at all — a pure tape grind is held (the pre-census world)', async () => {
  const rig = pipelineRig({ cfgOver: { grindJudgeLive: true } });
  const { pos, v } = await openPop(rig);
  await drive(rig, pos, v, { ratio: 1.06 });
  for (let i = 0; i < 80; i++) await drive(rig, pos, v, { ratio: Math.max(0.6, 1.0 - i * 0.006) });
  assert.equal(rig.bot.positions.length, 1, 'held — census-dark means no evidence');
  assert.ok(!grindRecords(rig).some(r => r.type === 'grindHot'));
});

// ------------------------------------------------------------ kill rule at bot level
test('kill rule: 10 finalized judge exits with 6 bad bounces disables the judge, persisted', async () => {
  const rig = pipelineRig({ cfgOver: { grindJudgeLive: true } });
  await rig.bot.start();
  rig.bot.postExit.done = [
    ...Array.from({ length: 6 }, () => ({ reason: 'grind judge: x', peakMovePct: 40 })),
    ...Array.from({ length: 4 }, () => ({ reason: 'grind judge: x', peakMovePct: -30 })),
    { reason: 'take profit 1', peakMovePct: 99 },
  ];
  rig.bot._grindKillCheck();
  assert.equal(rig.bot.grindState.killChecked, true);
  assert.equal(rig.bot.grindState.disabled, true);
  assert.ok(grindRecords(rig).some(r => r.type === 'grindDisabled'));
  assert.equal(rig.bot.state().grindJudge.live, false, '/state reports the judge off');
});

test('kill rule: mostly-good exits keep the judge live, and the check is one-time', async () => {
  const rig = pipelineRig({ cfgOver: { grindJudgeLive: true } });
  await rig.bot.start();
  rig.bot.postExit.done = [
    ...Array.from({ length: 2 }, () => ({ reason: 'grind judge: x', peakMovePct: 40 })),
    ...Array.from({ length: 8 }, () => ({ reason: 'grind judge: x', peakMovePct: -30 })),
  ];
  rig.bot._grindKillCheck();
  assert.equal(rig.bot.grindState.killChecked, true);
  assert.equal(rig.bot.grindState.disabled, false);
});
