// FAKE-ALIVE STAMP (owner insight 2026-10-18 ~03:26 EDT, build ordered
// ~03:37 "Let's do it"; clarified study-only: "Stamp not spam"): a coin can
// print a balanced tape (30 buys / 32 sells) while dying, when the buy side
// is a paid volume bot absorbing real exits at ever-lower prices. The stamp
// scores each position's ~10s samples: balanced tape + falling price +
// already >15% under the sampled peak = a fake-alive sample. RECORD-ONLY —
// these tests pin that it RECORDS faithfully and that NOTHING acts on it:
// the grind sequence below is judged by the ordinary exit stack exactly as
// before (it holds; only the stamp moves).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { loadConfig } from '../src/config.js';
import { SOL_MINT } from '../src/util.js';
import { sampleFakeAlive, fakeAliveStamp } from '../src/fakeAlive.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

// Full-pipeline rig (the basemode shape): real onSignal, healthy rug,
// working quotes, BASE_MODE=0 so a pop signal buys directly.
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

async function openPop(rig, mint = 'MINTP') {
  const v = view({ address: mint, symbol: 'GRIND', mc: 500_000, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  seedHistory(rig.bot, mint);
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { volM5: 100_000 } });
  await flush();
  assert.equal(rig.bot.positions.length, 1, 'pop position opened');
  // managePosition reads its view from bot.latest (the scan-loop cache in
  // production) — register the same mutable view object there so drives can
  // steer the tape the position loop sees.
  rig.bot.latest.set(mint, v);
  return { pos: rig.bot.positions[0], v };
}

// Drive one position check at a chosen realizable ratio with a chosen tape.
async function drive(rig, pos, v, { ratio, buys, sells }) {
  const basis = pos.entrySol * pos.remainingFrac;
  rig.bot.exec.markValue = async () => ratio * basis;
  v.buysM5 = buys; v.sellsM5 = sells;
  rig.clock.t += 15_000; // past the ~10s tick cadence, so every drive samples
  await rig.bot.managePosition(pos, 150);
  await flush();
}

// ------------------------------------------------------------ config
test('config: FAKE_ALIVE_STAMP defaults ON (record-only study), =0 turns it off', () => {
  assert.equal(loadConfig({}).fakeAliveStamp, true);
  assert.equal(loadConfig({ FAKE_ALIVE_STAMP: '1' }).fakeAliveStamp, true);
  assert.equal(loadConfig({ FAKE_ALIVE_STAMP: '0' }).fakeAliveStamp, false);
});

// ------------------------------------------------------------ the scorer
test('scorer: the first sample only seeds — it can never score or count as fake', () => {
  const pos = {};
  const fa = sampleFakeAlive(pos, { ratio: 0.5, buysM5: 30, sellsM5: 32 });
  assert.equal(fa.samples, 0);
  assert.equal(fa.fake, 0);
  assert.equal(fa.share, null);
  assert.equal(fa.peakRatio, 0.5);
});

test('scorer: balanced tape + falling + >15% under the sampled peak = fake-alive', () => {
  const pos = {};
  sampleFakeAlive(pos, { ratio: 1.10, buysM5: 30, sellsM5: 32 }); // seed at the peak
  sampleFakeAlive(pos, { ratio: 1.00, buysM5: 30, sellsM5: 32 }); // falling but not yet 15% under
  sampleFakeAlive(pos, { ratio: 0.93, buysM5: 30, sellsM5: 32 }); // 0.93 < 0.85 x 1.10 = 0.935: fake
  sampleFakeAlive(pos, { ratio: 0.88, buysM5: 31, sellsM5: 29 }); // fake
  const fa = sampleFakeAlive(pos, { ratio: 0.84, buysM5: 30, sellsM5: 32 }); // fake
  assert.equal(fa.samples, 4);
  assert.equal(fa.fake, 3);
  assert.equal(fa.share, 0.75);
  assert.deepEqual(fakeAliveStamp(pos), { samples: 4, fake: 3, share: 0.75 });
});

test('scorer: an honest dump does NOT read fake-alive — sells visibly crush buys', () => {
  const pos = {};
  sampleFakeAlive(pos, { ratio: 1.00, buysM5: 10, sellsM5: 280 });
  sampleFakeAlive(pos, { ratio: 0.60, buysM5: 8, sellsM5: 300 });
  const fa = sampleFakeAlive(pos, { ratio: 0.30, buysM5: 5, sellsM5: 260 });
  assert.equal(fa.samples, 2);
  assert.equal(fa.fake, 0);
  assert.equal(fa.share, 0);
});

test('scorer: rising through a balanced tape is not fake; missing flow can score but never counts fake', () => {
  const pos = {};
  sampleFakeAlive(pos, { ratio: 0.90, buysM5: 30, sellsM5: 32 });
  sampleFakeAlive(pos, { ratio: 1.05, buysM5: 30, sellsM5: 32 }); // rising: not falling
  const fa = sampleFakeAlive(pos, { ratio: 0.80, buysM5: null, sellsM5: null }); // falling + below peak, but no flow read
  assert.equal(fa.samples, 2);
  assert.equal(fa.fake, 0);
});

test('scorer: a null ratio is ignored entirely (no sample, no crash)', () => {
  const pos = {};
  assert.equal(sampleFakeAlive(pos, { ratio: null, buysM5: 30, sellsM5: 32 }), null);
  assert.equal(pos.fakeAlive, undefined);
  assert.equal(fakeAliveStamp(pos), null);
  assert.equal(fakeAliveStamp(null), null);
});

// ------------------------------------------------------------ live path
test('live path: a balanced-tape grind stamps samples/fake/share on the position, ticks, /state and the close — and the stack still just holds', async () => {
  const rig = pipelineRig();
  const { pos, v } = await openPop(rig);
  await drive(rig, pos, v, { ratio: 1.10, buys: 30, sells: 32 }); // seed sample at the peak
  await drive(rig, pos, v, { ratio: 1.00, buys: 30, sells: 32 });
  await drive(rig, pos, v, { ratio: 0.93, buys: 30, sells: 32 });
  await drive(rig, pos, v, { ratio: 0.88, buys: 31, sells: 29 });
  await drive(rig, pos, v, { ratio: 0.84, buys: 30, sells: 32 });
  // record-only: five checks into a -16% grind with a live tape, nothing sold it
  assert.equal(rig.bot.positions.length, 1, 'the stamp never acts — the position is still held');
  assert.deepEqual(fakeAliveStamp(pos), { samples: 4, fake: 3, share: 0.75 });
  // /state carries the stamp
  const st = rig.bot.state();
  assert.deepEqual(st.positions.find(p => p.id === pos.id).fakeAlive, { samples: 4, fake: 3, share: 0.75 });
  // the tick journal carries the running share
  const ticks = fs.readFileSync(rig.bot.journal.f.ticks, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(t => t.id === pos.id);
  assert.ok(ticks.length >= 5, 'ticks were written');
  assert.equal(ticks.at(-1).fakeAlive, 0.75);
  // the close record (through the one funnel) carries the final stamp
  rig.bot.ensureClose(pos, { ts: rig.clock.t, reason: 'test close', entrySol: pos.entrySol, exitSol: 0.016, pnlSol: -0.004 });
  const close = rig.bot.journal.trades.filter(t => t.type === 'close').at(-1);
  assert.deepEqual(close.fakeAlive, { samples: 4, fake: 3, share: 0.75 });
});

test('kill switch: FAKE_ALIVE_STAMP=0 — no stamp is sampled, ticks and closes carry null', async () => {
  const rig = pipelineRig({ env: { FAKE_ALIVE_STAMP: '0' } });
  assert.equal(rig.cfg.fakeAliveStamp, false);
  const { pos, v } = await openPop(rig);
  await drive(rig, pos, v, { ratio: 1.10, buys: 30, sells: 32 });
  await drive(rig, pos, v, { ratio: 0.80, buys: 30, sells: 32 });
  assert.equal(pos.fakeAlive, undefined, 'nothing sampled while the switch is off');
  const ticks = fs.readFileSync(rig.bot.journal.f.ticks, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(t => t.id === pos.id);
  assert.ok(ticks.length >= 1);
  assert.equal(ticks.at(-1).fakeAlive, null);
  rig.bot.ensureClose(pos, { ts: rig.clock.t, reason: 'test close', entrySol: pos.entrySol, exitSol: 0.016, pnlSol: -0.004 });
  const close = rig.bot.journal.trades.filter(t => t.type === 'close').at(-1);
  assert.equal(close.fakeAlive, null);
});
