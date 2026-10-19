// Holder-count sampling, second source (user 2026-10-14, SCOPE step 1) —
// RECORD-ONLY. Holder samples used to come only from RugCheck reads, so
// mints with no RugCheck report (the young coins) accumulated zero samples
// and holderGrowthPerMin was null on ~100% of signals. A Helius DAS
// getTokenAccounts read now writes token-account counts into the
// SAME holder series at the same bot call points. Pins:
//  (1) a DAS success writes a sample that pairs with a RugCheck sample;
//  (2) two samples ≥5 min apart → non-null holderGrowthPerMin (math unchanged);
//  (3) DAS failure/timeout is silent and leaves behavior identical;
//  (4) HOLDER_DAS=0 → no DAS call is made;
//  (5) a single DAS sample alone still yields null growth;
//  (6) the count is the SUM of token_accounts over the cursor walk — the
//      response's `total` field is the page size, NOT the count (the
//      2026-10-19 pinned-at-1 bug: limit 1 → total 1 on every mint);
//  (7) a walk that cannot finish (cursor loop / page budget) reads null.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { fetchRug, fetchHolderCount, holderSamples } from '../src/gate.js';
import { computeSignalFields } from '../src/signalFields.js';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { SOL_MINT } from '../src/util.js';
import { tmp, testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const M = 60000;
const RPC = ['https://helius.test'];

// Install a global fetch stub for one test; `das` describes the DAS leg:
//   { accounts: N } → a cursor-paginated mint with N token accounts (pages
//     of ≤1000, result.total = the PAGE size, exactly like the live
//     endpoint; `totalField` overrides the total a page reports);
//   { total } → a malformed page carrying a total but no token_accounts;
//   { http: 500 } → not-ok · 'throw' → rejects · { rpcError: true } → 200
//   with a JSON-RPC error object · { loopCursor: true } → pages that never
//   advance the cursor. RugCheck answers come from `rugHolders`
//   (null → a report without holders).
function stubNet({ rugHolders = 500, das = { accounts: 432 } } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('rugcheck.xyz')) {
      calls.push({ kind: 'rug' });
      return { ok: true, json: async () => (rugHolders == null ? {} : { totalHolders: rugHolders }) };
    }
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ kind: 'das', body });
    if (das === 'throw') throw new Error('network down');
    if (das.http) return { ok: false, status: das.http, json: async () => ({}) };
    if (das.rpcError) return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }) };
    if (das.accounts == null) {
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { total: das.total, limit: 1, page: 1 } }) };
    }
    const totalAccounts = das.accounts;
    const limit = Math.min((body.params && body.params.limit) || 1000, 1000);
    const start = body.params && body.params.cursor ? Number(String(body.params.cursor).replace('cur-', '')) || 0 : 0;
    const n = Math.max(0, Math.min(limit, totalAccounts - start));
    const end = start + n;
    const cursor = das.loopCursor ? 'cur-0' : (end < totalAccounts ? `cur-${end}` : null);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: { total: das.totalField ?? n, limit, ...(cursor ? { cursor } : {}), token_accounts: Array.from({ length: n }, () => ({})) } }) };
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// ---------------------------------------------------------- gate level

test('DAS: a successful getTokenAccounts walk returns the account count and writes a holder sample', async () => {
  const net = stubNet({ das: { accounts: 432 } });
  try {
    const n = await fetchHolderCount('DASMINT1', { rpcUrls: RPC, now: T0 });
    assert.equal(n, 432);
    assert.deepEqual(holderSamples('DASMINT1'), [{ ts: T0, holders: 432 }]);
    const dasCall = net.calls.find(c => c.kind === 'das');
    assert.equal(dasCall.body.method, 'getTokenAccounts');
    assert.deepEqual(dasCall.body.params, { mint: 'DASMINT1', limit: 1000 });
    assert.equal(net.calls.filter(c => c.kind === 'das').length, 1, 'a sub-page mint costs exactly one call');
  } finally { net.restore(); }
});

test('DAS: the count sums every cursor page — result.total (the page size) is never trusted', async () => {
  // 2,500 accounts over 3 pages; page 1 reports total=1000, page 3 total=500.
  const net = stubNet({ das: { accounts: 2500 } });
  try {
    const n = await fetchHolderCount('PAGEDMINT', { rpcUrls: RPC, now: T0 });
    assert.equal(n, 2500);
    assert.deepEqual(holderSamples('PAGEDMINT'), [{ ts: T0, holders: 2500 }]);
    const dasCalls = net.calls.filter(c => c.kind === 'das');
    assert.equal(dasCalls.length, 3, 'one call per page');
    assert.equal(dasCalls[1].body.params.cursor, 'cur-1000', 'the walk follows the returned cursor');
    assert.equal(dasCalls[2].body.params.cursor, 'cur-2000');
  } finally { net.restore(); }
  // The pinned-at-1 regression shape: a page whose total SAYS 1 while it
  // actually carries 3 accounts must count 3, not 1.
  const net2 = stubNet({ das: { accounts: 3, totalField: 1 } });
  try {
    assert.equal(await fetchHolderCount('LYINGTOTAL', { rpcUrls: RPC, now: T0 }), 3);
  } finally { net2.restore(); }
});

test('DAS: a DAS sample pairs with a RugCheck sample in the same series', async () => {
  const net = stubNet({ rugHolders: 500, das: { accounts: 800 } });
  try {
    await fetchRug('PAIRMINT', T0); // RugCheck read at T0 → sample { T0, 500 }
    const n = await fetchHolderCount('PAIRMINT', { rpcUrls: RPC, now: T0 + 6 * M });
    assert.equal(n, 800);
    assert.deepEqual(holderSamples('PAIRMINT'), [{ ts: T0, holders: 500 }, { ts: T0 + 6 * M, holders: 800 }]);
    const f = computeSignalFields({ samples: [], view: view({}), holders: holderSamples('PAIRMINT'), now: T0 + 6 * M });
    assert.equal(f.holderGrowthPerMin, 50); // (800-500) / 6 min
    assert.equal(f.holderGrowthPctPerMin, 10);
  } finally { net.restore(); }
});

test('DAS: two samples ≥5 min apart produce holder growth (signal-fields math unchanged)', async () => {
  const das = { accounts: 1000 };
  const net = stubNet({ das });
  try {
    await fetchHolderCount('GROWTHMINT', { rpcUrls: RPC, now: T0 });
    das.accounts = 1300; // the stub reads das.accounts at call time
    await fetchHolderCount('GROWTHMINT', { rpcUrls: RPC, now: T0 + 10 * M });
    const f = computeSignalFields({ samples: [], view: view({}), holders: holderSamples('GROWTHMINT'), now: T0 + 10 * M });
    assert.equal(f.holderGrowthPerMin, 30);
    assert.equal(f.holderGrowthPctPerMin, 3);
  } finally { net.restore(); }
});

test('DAS: a single sample alone still yields null growth (two points required)', async () => {
  const net = stubNet({ das: { accounts: 250 } });
  try {
    await fetchHolderCount('SOLOMINT', { rpcUrls: RPC, now: T0 });
    assert.equal(holderSamples('SOLOMINT').length, 1);
    const f = computeSignalFields({ samples: [], view: view({}), holders: holderSamples('SOLOMINT'), now: T0 + 30 * M });
    assert.equal(f.holderGrowthPerMin, null);
    assert.equal(f.holderGrowthPctPerMin, null);
  } finally { net.restore(); }
});

test('DAS: every failure mode is silent — null returned, nothing written, nothing thrown', async () => {
  for (const [mint, das] of [['FAILHTTP', { http: 500 }], ['FAILTHROW', 'throw'], ['FAILRPC', { rpcError: true }], ['FAILZERO', { accounts: 0 }], ['FAILNAN', { total: 'abc' }], ['FAILLOOP', { accounts: 5000, loopCursor: true }], ['FAILHUGE', { accounts: 25000 }]]) {
    const net = stubNet({ das });
    try {
      const n = await fetchHolderCount(mint, { rpcUrls: RPC, now: T0 });
      assert.equal(n, null, `${mint}: failure must return null`);
      assert.deepEqual(holderSamples(mint), [], `${mint}: failure must write no sample`);
    } finally { net.restore(); }
  }
  // no RPC configured / no mint: null without any network call at all
  const net = stubNet({});
  try {
    assert.equal(await fetchHolderCount('NORPC', { rpcUrls: [], now: T0 }), null);
    assert.equal(await fetchHolderCount(null, { rpcUrls: RPC, now: T0 }), null);
    assert.equal(net.calls.filter(c => c.kind === 'das').length, 0);
  } finally { net.restore(); }
});

test('DAS: a dark DAS leaves the RugCheck path untouched', async () => {
  const net = stubNet({ rugHolders: 777, das: 'throw' });
  try {
    assert.equal(await fetchHolderCount('AFTERMINT', { rpcUrls: RPC, now: T0 }), null);
    const rug = await fetchRug('AFTERMINT', T0);
    assert.equal(rug.totalHolders, 777, 'RugCheck fetch still returns its report');
    assert.deepEqual(holderSamples('AFTERMINT'), [{ ts: T0, holders: 777 }], 'the RugCheck sample is the only one written');
  } finally { net.restore(); }
});

// ---------------------------------------------------------- config knob

test('config: HOLDER_DAS defaults on; HOLDER_DAS=0 turns DAS sampling off', () => {
  assert.equal(loadConfig({ DATA_DIR: tmp() }).holderDas, true);
  assert.equal(loadConfig({ DATA_DIR: tmp(), HOLDER_DAS: '0' }).holderDas, false);
  assert.equal(loadConfig({ DATA_DIR: tmp(), HOLDER_DAS: '1' }).holderDas, true);
});

// ---------------------------------------------------------- bot wiring

const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function rig(cfgOver = {}, depOver = {}) {
  const cfg = testCfg({ tradeSol: 0.02, ...cfgOver });
  const clock = { t: T0 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(19_000_000 * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const das = { calls: [] };
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async () => new Map(),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
    fetchHolderCount: async (mint) => { das.calls.push(mint); return 1234; },
    ...depOver,
  });
  return { cfg, bot, clock, das };
}

test('bot: the DAS sample rides the shadow gate evaluation on a risk-preempted signal', async () => {
  const { cfg, bot, das } = rig();
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(T0));
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.ok(das.calls.length >= 1, 'DAS sampled during the preempted evaluation');
  assert.equal(das.calls[0], 'MINT1');
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.deepEqual(rec.reasons, ['risk: HALT file present'], 'live decision untouched');
  assert.equal(rec.shadowGatePass, true, 'shadow verdict still computed');
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.entries, 0);
});

test('bot: the DAS sample also rides the live gate evaluation', async () => {
  const { bot, das } = rig();
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.ok(das.calls.length >= 1, 'DAS sampled during gate evaluation');
  assert.equal(das.calls[0], 'MINT1');
  assert.equal(bot.journal.signals.length, 1, 'exactly one signal record — the sample added none');
});

test('bot: HOLDER_DAS off → the dep is never called, records unchanged', async () => {
  const { cfg, bot, das } = rig({ holderDas: false });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(T0));
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  assert.equal(das.calls.length, 0, 'knob off means no DAS call');
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.deepEqual(rec.reasons, ['risk: HALT file present']);
  assert.equal(rec.shadowGatePass, true);
});

test('bot: a throwing DAS dep leaves the signal path identical (fail-silent end to end)', async () => {
  const { cfg, bot } = rig({}, { fetchHolderCount: async () => { throw new Error('DAS dark'); } });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(T0));
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.deepEqual(rec.reasons, ['risk: HALT file present']);
  assert.equal(rec.shadowGatePass, true, 'shadow verdict computed despite DAS being down');
  assert.equal(bot.positions.length, 0);
  assert.equal(bot.stats.entries, 0);
});

test('bot: a bot without the DAS dep wired behaves exactly as before', async () => {
  const { cfg, bot } = rig({}, { fetchHolderCount: undefined });
  fs.writeFileSync(path.join(cfg.dataDir, 'HALT'), String(T0));
  await bot.start();
  await bot.onSignal(view({ price: 1.0 }), { setup: 'pop', strength: 1, metrics: {} });
  const rec = bot.journal.signals.find(s => s.decision === 'skipped');
  assert.deepEqual(rec.reasons, ['risk: HALT file present']);
  assert.equal(rec.shadowGatePass, true);
});

test('bot: the manual-exit snapshot read also leaves a DAS sample', async () => {
  const { bot, das } = rig();
  const pos = {
    mint: 'SNAPMINT', entrySol: 0.02, remainingFrac: 1, ticks: [], peakRatio: 1.1,
    entry: { holders: 1900 }, entryTs: T0,
  };
  const snap = await bot._manualSnapshot(pos, 0.021, T0 + 5 * M, 0.001);
  assert.ok(snap, 'snapshot built');
  assert.equal(snap.holdersNow, 2000, 'snapshot still reads the RugCheck count');
  assert.deepEqual(das.calls, ['SNAPMINT'], 'DAS sampled alongside the snapshot RugCheck read');
});
