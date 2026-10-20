// Outcome-tracking fix + signal fields (user 2026-10-14, record-only):
//  (1) every journaled signal finalizes r5/r15/r60 + excursions — the outcome
//      observer polls pending mints independently of the watchlist, progress
//      survives restarts, and incomplete outcomes are flagged, not silent;
//  (2) every signal record carries the sampled-history fields block
//      (holder growth / curve fill speed / buy velocity), nulls on thin data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { fetchRug, holderSamples } from '../src/gate.js';
import { computeSignalFields, GRAD_MC_USD } from '../src/signalFields.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const M = 60000;

// ---------------------------------------------------------- signal fields
test('fields: buy velocity is the mean trailing-5m buy count per minute (txn-based)', () => {
  const samples = [0, 2, 4, 6, 8].map(k => ({ ts: T0 + k * M, price: 1, mc: 50000, buysM5: 50, sellsM5: 10 }));
  const f = computeSignalFields({ samples, view: view({ dex: 'pumpswap' }), holders: [], now: T0 + 8 * M });
  assert.equal(f.buyVelPerMin, 10); // mean buysM5 50 / 5 min
});

test('fields: buy velocity nulls on thin history', () => {
  const one = [{ ts: T0, price: 1, mc: 1, buysM5: 50 }];
  assert.equal(computeSignalFields({ samples: one, view: view({}), now: T0 }).buyVelPerMin, null);
  const tight = [0, 1].map(k => ({ ts: T0 + k * M, price: 1, mc: 1, buysM5: 50 }));
  assert.equal(computeSignalFields({ samples: tight, view: view({}), now: T0 + M }).buyVelPerMin, null); // span < 2m
});

test('fields: curve fill speed from sampled mc slope, curve coins only', () => {
  const samples = [0, 5, 10].map(k => ({ ts: T0 + k * M, price: 1, mc: 30000 + k * 900, buysM5: 0 }));
  const f = computeSignalFields({ samples, view: view({ dex: 'pumpfun' }), holders: [], now: T0 + 10 * M });
  assert.equal(f.curveFillPctPerMin, Math.round((900 / GRAD_MC_USD) * 100 * 1000) / 1000);
  const amm = computeSignalFields({ samples, view: view({ dex: 'pumpswap' }), holders: [], now: T0 + 10 * M });
  assert.equal(amm.curveFillPctPerMin, null); // post-graduation: no curve to fill
  const thin = computeSignalFields({ samples: samples.slice(0, 2), view: view({ dex: 'pumpfun' }), holders: [], now: T0 + 10 * M });
  assert.equal(thin.curveFillPctPerMin, null); // < 3 samples
});

test('fields: holder growth per minute and %/min from the holder series', () => {
  const holders = [{ ts: T0, holders: 1000 }, { ts: T0 + 10 * M, holders: 1300 }];
  const f = computeSignalFields({ samples: [], view: view({}), holders, now: T0 + 10 * M });
  assert.equal(f.holderGrowthPerMin, 30);
  assert.equal(f.holderGrowthPctPerMin, 3);
  const one = computeSignalFields({ samples: [], view: view({}), holders: holders.slice(0, 1), now: T0 + 10 * M });
  assert.equal(one.holderGrowthPerMin, null);
  const tight = computeSignalFields({ samples: [], view: view({}), holders: [{ ts: T0, holders: 100 }, { ts: T0 + 3 * M, holders: 160 }], now: T0 + 3 * M });
  assert.equal(tight.holderGrowthPerMin, null); // span < 5m minimum
});

test('fields: RugCheck reads accumulate into the holder series (cache-aware)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ totalHolders: 777 }) });
  try {
    await fetchRug('HOLDERMINT', T0);
    await fetchRug('HOLDERMINT', T0 + 60000); // cache hit (TTL 120s): same reading, no duplicate sample
    assert.equal(holderSamples('HOLDERMINT').length, 1);
    assert.deepEqual(holderSamples('HOLDERMINT')[0], { ts: T0, holders: 777 });
    await fetchRug('HOLDERMINT', T0 + 130000); // past TTL: a fresh read, a second sample
    assert.equal(holderSamples('HOLDERMINT').length, 2);
  } finally { globalThis.fetch = realFetch; }
});

// ---------------------------------------------------------- journal outcomes
test('outcomes: progress survives a restart — earned checkpoints are kept, tracking resumes', () => {
  const dir = tmp(); let t = T0;
  let j = new Journal(dir, { now: () => t });
  const id = j.signal({ mint: 'A', symbol: 'A', setup: 'pop', decision: 'taken', price: 1, mc: 1e6 });
  t = T0 + 6 * M; j.observe(view({ address: 'A', price: 1.2 })); // r5 = +0.2 earned pre-restart
  j.savePending();
  j = new Journal(dir, { now: () => t }); // restart
  const st = j.pending.get(id);
  assert.ok(st, 'signal must be re-registered after restart');
  assert.ok(Math.abs(st.got[5] - 0.2) < 1e-9, `r5 progress must be restored, got ${JSON.stringify(st.got)}`);
  assert.equal(st.max, 1.2, 'excursion progress must be restored');
  t = T0 + 16 * M; j.observe(view({ address: 'A', price: 1.5 }));
  t = T0 + 61 * M; j.observe(view({ address: 'A', price: 0.9 }));
  const rec = j.signals.find(s => s.id === id);
  assert.equal(rec.out.done, true);
  assert.ok(Math.abs(rec.out.r5 - 0.2) < 1e-9, 'r5 is the pre-restart reading, not a re-read');
  assert.ok(Math.abs(rec.out.r15 - 0.5) < 1e-9);
  assert.ok(Math.abs(rec.out.r60 - -0.1) < 1e-9);
  assert.equal(rec.out.partial, false);
  assert.deepEqual(rec.out.missing, []);
  assert.equal(rec.out.fillAgeMin.r5, 6);
});

test('outcomes: a signal past the horizon at boot finalizes at boot with its saved progress', () => {
  const dir = tmp(); let t = T0;
  let j = new Journal(dir, { now: () => t });
  const id = j.signal({ mint: 'B', symbol: 'B', setup: 'pop', decision: 'skipped', reasons: ['x: y'], price: 1, mc: 1 });
  t = T0 + 6 * M; j.observe(view({ address: 'B', price: 1.1 }));
  j.savePending();
  t = T0 + 200 * M;
  j = new Journal(dir, { now: () => t }); // boot long after the 90m horizon
  const rec = j.signals.find(s => s.id === id);
  assert.equal(rec.out.done, true, 'must finalize at boot, not return to limbo');
  assert.equal(rec.out.partial, true);
  assert.deepEqual(rec.out.missing, ['r15', 'r60']);
  assert.ok(Math.abs(rec.out.r5 - 0.1) < 1e-9, 'the earned r5 survives');
  assert.equal(j.pending.size, 0);
});

test('outcomes: never-observed signals finalize flagged partial + unobserved, not silent', () => {
  let t = T0; const j = new Journal(tmp(), { now: () => t });
  const id = j.signal({ mint: 'C', symbol: 'C', setup: 'pop', decision: 'skipped', reasons: ['x: y'], price: 1, mc: 1 });
  t = T0 + 100 * M; j.observe(view({ address: 'ZZZ', price: 1 })); // any view drives the expire sweep
  const rec = j.signals.find(s => s.id === id);
  assert.equal(rec.out.done, true);
  assert.equal(rec.out.expired, true);
  assert.equal(rec.out.partial, true);
  assert.deepEqual(rec.out.missing, ['r5', 'r15', 'r60']);
  assert.equal(rec.out.unobserved, true);
  assert.equal(rec.out.r15, null);
  assert.equal(j.pending.size, 0);
});

test('outcomes: partially-observed expiry names exactly what is missing', () => {
  let t = T0; const j = new Journal(tmp(), { now: () => t });
  const id = j.signal({ mint: 'D', symbol: 'D', setup: 'pop', decision: 'skipped', reasons: ['x: y'], price: 1, mc: 1 });
  t = T0 + 6 * M; j.observe(view({ address: 'D', price: 1.1 }));
  t = T0 + 100 * M; j.observe(view({ address: 'ZZZ', price: 1 }));
  const rec = j.signals.find(s => s.id === id);
  assert.equal(rec.out.partial, true);
  assert.deepEqual(rec.out.missing, ['r15', 'r60']);
  assert.equal(rec.out.unobserved, false);
  assert.ok(Math.abs(rec.out.r5 - 0.1) < 1e-9);
  assert.equal(rec.out.fillAgeMin.r5, 6);
  assert.equal(rec.out.fillAgeMin.r15, null);
});

test('outcomes: peakMin stamps the age of the LAST max improvement, not the first', () => {
  let t = T0; const j = new Journal(tmp(), { now: () => t });
  const id = j.signal({ mint: 'P', symbol: 'P', setup: 'pop', decision: 'skipped', reasons: ['x: y'], price: 1, mc: 1 });
  t = T0 + 10 * M; j.observe(view({ address: 'P', price: 1.2 })); // first improvement, age 10
  t = T0 + 25 * M; j.observe(view({ address: 'P', price: 1.1 })); // no improvement
  t = T0 + 40 * M; j.observe(view({ address: 'P', price: 1.6 })); // LAST improvement, age 40
  t = T0 + 61 * M; j.observe(view({ address: 'P', price: 0.9 })); // r60 fills -> finalize
  const rec = j.signals.find(s => s.id === id);
  assert.equal(rec.out.done, true);
  assert.ok(Math.abs(rec.out.maxRet - 0.6) < 1e-9, `maxRet ${rec.out.maxRet}`);
  assert.equal(rec.out.peakMin, 40, 'peakMin is present on the finalized record and names the last improvement');
});

test('outcomes: peakMin is ~0 when the max never improves past the signal price', () => {
  let t = T0; const j = new Journal(tmp(), { now: () => t });
  const id = j.signal({ mint: 'Q', symbol: 'Q', setup: 'pop', decision: 'skipped', reasons: ['x: y'], price: 1, mc: 1 });
  t = T0 + 6 * M; j.observe(view({ address: 'Q', price: 0.9 }));
  t = T0 + 16 * M; j.observe(view({ address: 'Q', price: 0.95 })); // still under the signal price
  t = T0 + 61 * M; j.observe(view({ address: 'Q', price: 0.8 }));
  const rec = j.signals.find(s => s.id === id);
  assert.equal(rec.out.done, true);
  assert.ok(Math.abs(rec.out.maxRet - 0) < 1e-9);
  assert.equal(rec.out.peakMin, 0); // the max IS the first observation (the signal price)
});

test('outcomes: peakMin survives a restart through the persisted pending state', () => {
  const dir = tmp(); let t = T0;
  let j = new Journal(dir, { now: () => t });
  const id = j.signal({ mint: 'R', symbol: 'R', setup: 'pop', decision: 'taken', price: 1, mc: 1 });
  t = T0 + 10 * M; j.observe(view({ address: 'R', price: 1.3 })); // peak at age 10, pre-restart
  j.savePending();
  j = new Journal(dir, { now: () => t }); // restart
  assert.equal(j.pending.get(id).peakAgeMin, 10, 'the stamp must restore, not reset');
  t = T0 + 30 * M; j.observe(view({ address: 'R', price: 1.2 })); // no improvement after restart
  t = T0 + 61 * M; j.observe(view({ address: 'R', price: 0.9 }));
  const rec = j.signals.find(s => s.id === id);
  assert.equal(rec.out.done, true);
  assert.equal(rec.out.peakMin, 10);
});

test('journal: signal records carry the fields block when computed', () => {
  const j = new Journal(tmp(), { now: () => T0 });
  const fields = { holderGrowthPerMin: null, holderGrowthPctPerMin: null, curveFillPctPerMin: null, buyVelPerMin: 10 };
  j.signal({ mint: 'F', symbol: 'F', setup: 'pop', decision: 'skipped', reasons: [], price: 1, mc: 1, fields });
  assert.deepEqual(j.signals[0].fields, fields);
});

// ---------------------------------------------------------- outcome observer (bot)
function observerRig() {
  const cfg = testCfg({});
  const clock = { t: T0 };
  const priceAt = (t) => (t >= T0 + 60 * M ? 1.3 : t >= T0 + 15 * M ? 1.2 : t >= T0 + 5 * M ? 1.1 : 1.0);
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map((mints || []).map(m => [m, view({ address: m, price: priceAt(clock.t) })])),
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  return { bot, clock };
}

test('observer: a skipped coin that left the watchlist still finalizes every checkpoint', async () => {
  const { bot, clock } = observerRig();
  const v = view({ address: 'GONE', price: 1.0 });
  bot.skip(v, { setup: 'pop', strength: 1, metrics: {} }, ['report: no RugCheck report for a young coin']);
  const rec = bot.journal.signals[0];
  assert.ok(rec.fields, 'skip record carries the fields block');
  assert.equal(bot.watch.has('GONE'), false, 'the coin is NOT on the watchlist — the old tracker would starve here');
  clock.t = T0 + 5 * M; await bot.pollTick(); // empty watch: the poll's observer hook still runs
  clock.t = T0 + 15 * M; await bot.outcomeTick(clock.t);
  clock.t = T0 + 60 * M; await bot.outcomeTick(clock.t);
  assert.equal(rec.out.done, true);
  assert.ok(Math.abs(rec.out.r5 - 0.1) < 1e-9, `r5 ${rec.out.r5}`);
  assert.ok(Math.abs(rec.out.r15 - 0.2) < 1e-9, `r15 ${rec.out.r15}`);
  assert.ok(Math.abs(rec.out.r60 - 0.3) < 1e-9, `r60 ${rec.out.r60}`);
  assert.ok(Math.abs(rec.out.maxRet - 0.3) < 1e-9);
  assert.equal(rec.out.partial, false);
  assert.equal(rec.out.unobserved, false);
  // the observer must not leak into the detector surface
  assert.equal(bot.latest.has('GONE'), false, 'observer views never enter latest');
  assert.equal(bot.history.get('GONE').length, 0, 'observer views never enter history');
  assert.equal(bot.watch.has('GONE'), false, 'observer never touches the watchlist');
});

test('observer: unobtainable price (no view ever returns) finalizes flagged at the horizon', async () => {
  const cfg = testCfg({});
  const clock = { t: T0 };
  const exec = new Executor(cfg, { quote: async () => ({ outAmount: '1000000000', priceImpactPct: '0.01' }) });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(), // the pair is gone: no view for any mint
    fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [],
  });
  bot.skip(view({ address: 'DEAD', price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} }, ['x: y']);
  const rec = bot.journal.signals[0];
  clock.t = T0 + 30 * M; await bot.outcomeTick(clock.t);
  clock.t = T0 + 95 * M; await bot.outcomeTick(clock.t); // the observer's own expire sweep closes it out
  assert.equal(rec.out.done, true);
  assert.equal(rec.out.partial, true);
  assert.equal(rec.out.unobserved, true);
  assert.deepEqual(rec.out.missing, ['r5', 'r15', 'r60']);
});
