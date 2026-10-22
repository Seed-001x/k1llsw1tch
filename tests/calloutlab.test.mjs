// calloutlab.test.mjs — Callout Shadow Lab (user 2026-10-15, RECORD-ONLY) +
// the CALLOUTS_ENABLED live gate at the Bot level. Pins: config default OFF,
// would-call recording + dedupe (incl. boot rebuild from the journal itself),
// thesis failure never blocking a record, tailer scoring math on synthetic
// candles, staged scoring + 72h age-out, the readiness rule incl. its
// trailing-14-day leg, first-3-per-day simulation, NY-day grouping, the
// walletWatch event seams, the bot's entry/TP/graduation seams, and the
// GET /callouts shape on an empty journal. The lab must never post or trade:
// the bot-level tests spy on global fetch to prove no live callout is
// attempted while disabled, and that one IS attempted when enabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CalloutLab, computeTailerScore, calloutScorecard, foldCalloutJournal, nyDay } from '../src/calloutLab.js';
import { Journal } from '../src/journal.js';
import { Bot } from '../src/bot.js';
import { WalletWatch } from '../src/walletWatch.js';
import { Executor } from '../src/exec.js';
import { startServer } from '../src/server.js';
import { SOL_MINT } from '../src/util.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = Date.UTC(2026, 9, 14, 14, 0, 0); // Wed Oct 14 2026, 10:00 EDT
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 25)); };

// ---- config ----
test('config: CALLOUTS_ENABLED defaults to 0 (live callouts OFF), 1 arms, junk rejected', () => {
  assert.equal(loadConfig({}).calloutsEnabled, 0);
  assert.equal(loadConfig({ CALLOUTS_ENABLED: '1' }).calloutsEnabled, 1);
  assert.equal(validateConfig(loadConfig({})).length, 0);
  assert.ok(validateConfig(loadConfig({ CALLOUTS_ENABLED: '2' })).some(e => e.includes('CALLOUTS_ENABLED')));
});

// ---- scoring math (pure) ----
// Price path: flat 1.0; +30m prints a 2.0 high; +60m closes 1.5; +240m closes
// 0.5; +1000m prints a 4.0 high; +1440m closes 3.0.
function pathCandles(skip = new Set(), extra = []) {
  const out = [];
  for (let m = 0; m <= 1440; m++) {
    if (skip.has(m)) continue;
    let o = 1, h = 1, l = 1, c = 1;
    if (m === 30) { h = 2.0; }
    if (m === 60) { o = h = l = c = 1.5; }
    if (m === 240) { o = h = l = c = 0.5; }
    if (m === 1000) { h = 4.0; }
    if (m === 1440) { o = h = l = c = 3.0; }
    out.push([T0 / 1000 + m * 60, o, h, l, c, 0]);
  }
  return out.concat(extra).sort((a, b) => a[0] - b[0]);
}

test('computeTailerScore: entryRef = +2m close; r/peaks at 1h/4h/24h match the tailer method', () => {
  const s = computeTailerScore(pathCandles(), T0);
  assert.equal(s.entryRef, 1.0);
  assert.ok(Math.abs(s.r1h - 0.5) < 1e-9, `r1h ${s.r1h}`);
  assert.ok(Math.abs(s.peak1h - 1.0) < 1e-9, `peak1h ${s.peak1h}`);
  assert.ok(Math.abs(s.r4h - -0.5) < 1e-9, `r4h ${s.r4h}`);
  assert.ok(Math.abs(s.peak4h - 1.0) < 1e-9, `peak4h ${s.peak4h}`);
  assert.ok(Math.abs(s.r24h - 2.0) < 1e-9, `r24h ${s.r24h}`);
  assert.ok(Math.abs(s.peak24h - 3.0) < 1e-9, `peak24h ${s.peak24h}`);
  assert.deepEqual(s.notes, []);
});

test('computeTailerScore: a missing target candle falls back to the nearest within ±3m — and says so', () => {
  const near62 = [T0 / 1000 + 62 * 60, 1.8, 1.8, 1.8, 1.8, 0];
  const s = computeTailerScore(pathCandles(new Set([57, 58, 59, 60, 61, 62]), [near62]), T0);
  assert.ok(Math.abs(s.r1h - 0.8) < 1e-9, `r1h ${s.r1h}`);
  assert.ok(s.notes.includes('r1h:nearest'));
});

test('computeTailerScore: no candle within ±3m → the horizon stays null, never fabricated', () => {
  const s = computeTailerScore(pathCandles(new Set([237, 238, 239, 240, 241, 242, 243])), T0);
  assert.equal(s.r4h, null);
  assert.ok(Math.abs(s.r1h - 0.5) < 1e-9); // other horizons unaffected
  const empty = computeTailerScore([], T0);
  assert.equal(empty.entryRef, null);
  assert.equal(empty.r1h, null);
});

// ---- lab recording: dedupe, restore, thesis failure ----
function labRig({ thesis = 'cute cat. looks good.', candles = null } = {}) {
  const dir = tmp();
  const journal = new Journal(dir, { now: () => T0 });
  const clock = { t: T0 };
  const mk = () => new CalloutLab({
    cfg: {}, journal: new Journal(dir, { now: () => clock.t }), now: () => clock.t,
    buildThesisFn: typeof thesis === 'function' ? thesis : async () => thesis,
    fetchCandles: async () => candles, resolvePool: async () => 'POOL1',
  });
  const lab = mk();
  const lines = () => { try { return fs.readFileSync(path.join(dir, 'callout_shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { dir, lab, mk, clock, lines };
}

test('lab.record: one would-call per mint per trigger, ever — dedupe survives a rebuild from the journal', async () => {
  const r = labRig();
  const a = await r.lab.record({ trigger: 'entry', ts: T0, mint: 'M1', symbol: 'ONE', mc: 50000, liquidity: 12000, setup: 'pop', holding: true, linkId: 'p1' });
  assert.ok(a && a.kind === 'would-call');
  assert.equal(a.thesis, 'cute cat. looks good.');
  assert.equal(a.thesisSource, 'buildThesis');
  assert.equal(a.liquidity, 12000);
  assert.equal(await r.lab.record({ trigger: 'entry', ts: T0 + 1000, mint: 'M1' }), null); // same trigger+mint: deduped
  assert.ok(await r.lab.record({ trigger: 'tp1', ts: T0 + 2000, mint: 'M1', linkId: 'p1' })); // different trigger: recorded
  assert.equal(r.lines().filter(l => l.kind === 'would-call').length, 2);
  const lab2 = r.mk(); // fresh instance over the same journal — seen set rebuilt by scanning would-call lines
  assert.equal(await lab2.record({ trigger: 'entry', ts: T0 + 3000, mint: 'M1' }), null);
  assert.equal(await lab2.record({ trigger: 'tp1', ts: T0 + 3000, mint: 'M1' }), null);
  assert.ok(await lab2.record({ trigger: 'tp2', ts: T0 + 3000, mint: 'M1' }));
});

test('lab.record: thesis generation failure records thesis:null with a source note — never throws', async () => {
  const r = labRig({ thesis: async () => { throw new Error('llm down'); } });
  const rec = await r.lab.record({ trigger: 'graduation', ts: T0, mint: 'M9' });
  assert.ok(rec);
  assert.equal(rec.thesis, null);
  assert.equal(rec.thesisSource, 'buildThesis-failed');
  const r2 = labRig({ thesis: null });
  const rec2 = await r2.lab.record({ trigger: 'graduation', ts: T0, mint: 'M9' });
  assert.equal(rec2.thesis, null);
  assert.equal(rec2.thesisSource, 'buildThesis-empty');
  assert.equal(rec2.liquidity, null); // unknown liquidity stays null — never invented
});

// ---- lab scoring flow: staged horizons, then final ----
test('lab.tick: scores +1h at +62m, +4h at +242m, finalizes at +1442m with the full tailer line', async () => {
  const r = labRig({ candles: pathCandles() });
  await r.lab.record({ trigger: 'entry', ts: T0, mint: 'M1', symbol: 'ONE' });
  const scores = () => r.lines().filter(l => l.kind === 'score');

  r.clock.t = T0 + 30 * 60000; await r.lab.tick(r.clock.t);
  assert.equal(scores().length, 0); // nothing due yet

  r.clock.t = T0 + 62 * 60000; await r.lab.tick(r.clock.t);
  assert.equal(scores().length, 1);
  assert.ok(Math.abs(scores()[0].r1h - 0.5) < 1e-9);
  assert.equal(scores()[0].r4h, null); // not due, not fabricated
  assert.equal(scores()[0].final, false);

  r.clock.t = T0 + 242 * 60000; await r.lab.tick(r.clock.t);
  assert.equal(scores().length, 2);
  assert.ok(Math.abs(scores()[1].r4h - -0.5) < 1e-9);
  assert.ok(Math.abs(scores()[1].r1h - 0.5) < 1e-9); // carried on the same entryRef basis

  r.clock.t = T0 + 1442 * 60000; await r.lab.tick(r.clock.t);
  const last = scores().at(-1);
  assert.equal(last.final, true);
  assert.equal(last.partial, false);
  assert.ok(Math.abs(last.r24h - 2.0) < 1e-9);
  assert.ok(Math.abs(last.peak24h - 3.0) < 1e-9);

  r.clock.t = T0 + 3000 * 60000; await r.lab.tick(r.clock.t);
  assert.equal(scores().length, 3); // final records are never rescored
});

test('lab.tick: no candles at all → retries without burning stages, then the 72h age-out finalizes partial', async () => {
  const r = labRig({ candles: [] });
  await r.lab.record({ trigger: 'entry', ts: T0, mint: 'DEAD' });
  r.clock.t = T0 + 62 * 60000; await r.lab.tick(r.clock.t);
  assert.equal(r.lines().filter(l => l.kind === 'score').length, 0); // no data: nothing appended, stage intact
  r.clock.t = T0 + 73 * 3600e3; await r.lab.tick(r.clock.t);
  const s = r.lines().filter(l => l.kind === 'score');
  assert.equal(s.length, 1);
  assert.equal(s[0].final, true);
  assert.equal(s[0].partial, true);
  assert.equal(s[0].entryRef, null);
  assert.ok(s[0].notes.includes('no-candles'));
});

// ---- scorecard (pure) ----
const NOW = Date.UTC(2026, 9, 15, 16, 0, 0); // Oct 15 2026, 12:00 EDT
function mkPairs(specs) {
  const recs = [];
  specs.forEach((s, i) => {
    recs.push({ kind: 'would-call', id: 'w' + i, ts: s.ts, trigger: s.trigger || 'entry', mint: 'M' + i, symbol: 'S' + i, thesis: 't', mc: 1, liquidity: 1, holding: false, linkId: null });
    if (s.r1h !== undefined) recs.push({ kind: 'score', id: 'w' + i, ts: s.ts + 1000, entryRef: 1, r1h: s.r1h, r4h: s.r4h != null ? s.r4h : null, r24h: s.r24h != null ? s.r24h : null, peak1h: null, peak4h: null, peak24h: null, final: true, partial: false });
  });
  return foldCalloutJournal(recs);
}

test('scorecard ready: n>=30 with positive medians overall AND in the trailing 14 days', () => {
  const specs = Array.from({ length: 30 }, (_, i) => ({ ts: NOW - i * 3600e3, r1h: 0.2, r4h: 0.1, r24h: 0.3 }));
  const card = calloutScorecard(mkPairs(specs), NOW);
  const e = card.perTrigger.entry;
  assert.equal(e.n, 30);
  assert.equal(e.pending, 0);
  assert.equal(e.medianR1h, 0.2);
  assert.equal(e.sharePositive1h, 1);
  assert.equal(e.ready, true);
  assert.equal(e.last14n, 30);
  assert.equal(card.perTrigger.tp1.ready, false); // empty trigger types are present and not ready
});

test('scorecard ready: 29 scored is not enough', () => {
  const specs = Array.from({ length: 29 }, (_, i) => ({ ts: NOW - i * 3600e3, r1h: 0.2, r4h: 0.1 }));
  assert.equal(calloutScorecard(mkPairs(specs), NOW).perTrigger.entry.ready, false);
});

test('scorecard ready: the trailing-14d leg can veto an otherwise-green book', () => {
  const old = Array.from({ length: 15 }, (_, i) => ({ ts: NOW - (20 + i) * 86400e3, r1h: 0.5, r4h: 0.5 }));
  const recent = Array.from({ length: 15 }, (_, i) => ({ ts: NOW - i * 3600e3, r1h: -0.3, r4h: 0.4 }));
  const e = calloutScorecard(mkPairs([...old, ...recent]), NOW).perTrigger.entry;
  assert.equal(e.n, 30);
  assert.ok(e.medianR1h > 0); // the all-time median is green…
  assert.equal(e.last14n, 15);
  assert.equal(e.last14MedianR1h, -0.3);
  assert.equal(e.ready, false); // …but the last two weeks are not
});

test('scorecard: pending counts unscored calls; daily groups by America/New_York day', () => {
  const pairs = mkPairs([
    { ts: Date.UTC(2026, 9, 15, 3, 30, 0), r1h: 0.1, r4h: 0.2 },  // 23:30 EDT Oct 14
    { ts: Date.UTC(2026, 9, 15, 5, 30, 0), r1h: 0.3, r4h: -0.1 }, // 01:30 EDT Oct 15
    { ts: Date.UTC(2026, 9, 15, 6, 0, 0) },                        // unscored → pending
  ]);
  assert.equal(nyDay(Date.UTC(2026, 9, 15, 3, 30, 0)), '2026-10-14');
  const card = calloutScorecard(pairs, NOW);
  assert.equal(card.perTrigger.entry.n, 2);
  assert.equal(card.perTrigger.entry.pending, 1);
  const d14 = card.daily.find(d => d.day === '2026-10-14' && d.trigger === 'entry');
  const d15 = card.daily.find(d => d.day === '2026-10-15' && d.trigger === 'entry');
  assert.equal(d14.n, 1); assert.equal(d14.medianR4h, 0.2);
  assert.equal(d15.n, 1); assert.equal(d15.pending, 1);
});

test('scorecard first3: chronologically first 3 would-calls per NY day across ALL triggers', () => {
  const day = Date.UTC(2026, 9, 14, 14, 0, 0); // Oct 14 10:00 EDT
  const specs = [
    { ts: day + 0 * 60000, trigger: 'entry', r1h: 0.1, r4h: 0.1 },
    { ts: day + 1 * 60000, trigger: 'tp1', r1h: 0.2, r4h: 0.2 },
    { ts: day + 2 * 60000, trigger: 'graduation', r1h: 0.3, r4h: 0.3 },
    { ts: day + 3 * 60000, trigger: 'entry', r1h: 9, r4h: 99 },   // 4th call of the day: excluded
    { ts: day + 4 * 60000, trigger: 'entry', r1h: 9, r4h: 99 },   // 5th: excluded
    { ts: day + 86400e3, trigger: 'entry', r1h: 0.4, r4h: 0.4 },  // next day: counts again
    { ts: day + 86400e3 + 60000, trigger: 'entry', r1h: 0.5, r4h: 0.5 },
  ];
  const card = calloutScorecard(mkPairs(specs), NOW);
  assert.equal(card.first3.callsConsidered, 7);
  assert.equal(card.first3.days, 2);
  assert.equal(card.first3.n, 5);
  assert.equal(card.first3.medianR4h, 0.3);
  assert.equal(card.first3.bestR4h, 0.5); // the 99s never made the simulated book
  assert.match(card.first3Basis, /first 3 would-calls/);
  assert.match(card.first3Basis, /No liquidity floor/);
});

test('scorecard recent: newest 15 would-calls, scores attached where present', () => {
  const specs = Array.from({ length: 20 }, (_, i) => ({ ts: NOW - (20 - i) * 60000, r1h: 0.1, r4h: 0.1 }));
  const card = calloutScorecard(mkPairs(specs), NOW);
  assert.equal(card.recent.length, 15);
  assert.ok(card.recent[0].ts > card.recent[14].ts);
  assert.equal(card.recent[0].score.r1h, 0.1);
});

// ---- walletWatch seams: the event-log site taps onEvent ----
test('walletWatch: dev-launch and confluence events fire the onEvent tap as they are journaled', async () => {
  const dir = tmp();
  const seen = [];
  const ww = new WalletWatch({
    cfg: testCfg({}), dir, now: () => T0, log: () => {},
    fetchViews: async () => new Map(),
    fetchCoin: async () => ({ creator: 'DEVWALLET', createdTs: T0 - 30 * 60000, symbol: 'DEV' }),
    onEvent: (ev) => seen.push(ev),
    sets: {
      devs: [{ address: 'DEVWALLET', name: 'devone' }],
      survivors: [
        { entity: 'e1', cluster: 'c1', name: 'Alice', wallets: ['W1'] },
        { entity: 'e2', cluster: 'c2', name: 'Bob', wallets: ['W2'] },
      ],
      baseline: null,
    },
  });
  await ww.onDevBuy('DEVWALLET', { mint: 'MINTD', sol: 2 }, T0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'dev');
  assert.equal(seen[0].mint, 'MINTD');
  ww.onSurvivorBuy('W1', { mint: 'MINTC', sol: 1 }, T0);
  ww.onSurvivorBuy('W2', { mint: 'MINTC', sol: 2 }, T0 + 60000);
  await flush();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, 'confluence');
  assert.equal(seen[1].mint, 'MINTC');
});

// ---- bot-level seams (light rig) ----
function lightBot(over = {}) {
  const cfg = testCfg({ fastPop: 0, dipStopPct: 0, baseMode: 0, ...over });
  const clock = { t: T0 };
  const exec = { solBalance: async () => 5, markValue: async () => 0, sell: async () => ({ tokensSold: '0', solOut: 0, sig: null, simulated: true }), closeEmptyAccounts: async () => {} };
  const bot = new Bot(cfg, { now: () => clock.t, exec, discover: async () => new Map(), fetchViews: async () => new Map(), fetchSolUsd: async () => 150, fetchRug: async () => null, searchByName: async () => [] });
  const lines = () => { try { return fs.readFileSync(path.join(cfg.dataDir, 'callout_shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { cfg, bot, clock, lines };
}

function fetchSpy404() {
  const calls = [];
  const fn = async (url) => { calls.push(String(url)); return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; };
  fn.calls = calls;
  return fn;
}

async function withCleanEnv(fn) {
  const realFetch = globalThis.fetch;
  const saved = {};
  for (const k of ['OPENAI_API_KEY', 'WALLET_PRIVATE_KEY', 'CALLOUTS_ENABLED']) { saved[k] = process.env[k]; delete process.env[k]; }
  try { return await fn(); }
  finally { globalThis.fetch = realFetch; for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('bot seams: graduation via noteMint source and wallet events via noteCalloutEvent journal would-calls', async () => {
  await withCleanEnv(async () => {
    globalThis.fetch = fetchSpy404();
    const { bot, lines } = lightBot();
    bot.noteMint('MINTG', 'graduated');
    bot.noteMint('MINTX', 'live-ws'); // not a graduation: no record
    bot.noteCalloutEvent({ kind: 'dev', id: 'dev-1', ts: T0, mint: 'MINTD', symbol: 'DEV', mc: 50000, pool: 'POOLX' });
    bot.noteCalloutEvent({ kind: 'confluence', id: 'cnf-1', ts: T0, mint: 'MINTC', symbol: 'CNF', mc: 80000, pool: 'POOLY' });
    bot.noteCalloutEvent({ kind: 'something-else', id: 'x-1', ts: T0, mint: 'MINTZ' });
    await flush();
    const wc = lines().filter(l => l.kind === 'would-call');
    assert.deepEqual(wc.map(l => l.trigger).sort(), ['confluence', 'devlaunch', 'graduation']);
    const grad = wc.find(l => l.trigger === 'graduation');
    assert.equal(grad.mint, 'MINTG');
    assert.equal(grad.thesis, null); // no view, no research, no key — recorded anyway
    assert.equal(grad.thesisSource, 'buildThesis-empty');
    const dev = wc.find(l => l.trigger === 'devlaunch');
    assert.equal(dev.linkId, 'dev-1');
    assert.equal(dev.pool, 'POOLX');
    assert.equal(dev.thesis, 'dev. looks good.');
    bot.noteMint('MINTG', 'graduated'); // dedupe: still one graduation record for this mint, ever
    await flush();
    assert.equal(lines().filter(l => l.kind === 'would-call' && l.trigger === 'graduation').length, 1);
  });
});

test('GET /callouts: full scorecard shape on an empty journal', async () => {
  const { bot } = lightBot();
  const srv = startServer(bot, 0);
  try {
    const resp = await fetch(`http://127.0.0.1:${srv.address().port}/callouts`);
    assert.equal(resp.status, 200);
    const s = await resp.json();
    assert.equal(s.enabled, true);
    assert.equal(s.liveCallouts, false);
    assert.equal(s.wouldCalls, 0);
    for (const t of ['entry', 'tp1', 'tp2', 'tp3', 'confluence', 'devlaunch', 'graduation']) {
      assert.equal(s.perTrigger[t].n, 0, t);
      assert.equal(s.perTrigger[t].ready, false, t);
      assert.match(s.perTrigger[t].readyBasis, /n>=30/);
    }
    assert.deepEqual(s.daily, []);
    assert.equal(s.first3.n, 0);
    assert.match(s.first3Basis, /first 3 would-calls/);
    assert.deepEqual(s.recent, []);
  } finally { srv.close(); }
});

// ---- bot entry lifecycle (e2e-style rig): the live gate + tp1/tp2/tp3 records ----
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };
const TE0 = 1_000_000_000_000;

function entryRig(cfgOver = {}) {
  const cfg = testCfg({ tradeSol: 0.02, tp1Frac: 0.4, baseMode: 0, bagTrailConfirmSec: 0, bagSmallHold: 0, ...cfgOver }); // trail timer off here: the lifecycle pins the trail's final close, the timer is pinned in bagtrailconfirm.test.mjs; bagSmallHold 0: the trail lives in the closeted big-bag mode since 2026-10-17 ~04:38
  const clock = { t: TE0 };
  const market = { price: 1, liq: 100_000, buysM5: 30, sellsM5: 10 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const bot = new Bot(cfg, {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map([['MINT1', 'jup-trending']]), { counts: {} }),
    fetchViews: async () => new Map([['MINT1', view({ price: market.price, mc: market.price * 1e6, liq: market.liq, buysM5: market.buysM5, sellsM5: market.sellsM5, createdAt: TE0 - 10 * 3600e3 })]]),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
  });
  const tick = async (price, n = 1) => { for (let i = 0; i < n; i++) { clock.t += 10000; if (price != null) market.price = price; await bot.pollTick(); } };
  const lines = () => { try { return fs.readFileSync(path.join(cfg.dataDir, 'callout_shadow.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { cfg, bot, clock, q, tick, lines };
}
const RAMP = [1.1, 1.2, 1.3, 1.4, 1.5];
// driveEntry holds each level for 7 ticks (~70s) — see e2e.test.mjs: the
// climb must build over minutes or the top guard (owner rule 2026-10-16)
// refuses the entry as a fresh vertical top.
async function driveEntry(r) {
  await r.bot.start(); await r.bot.discoverTick();
  await r.tick(1, 12);
  for (const p of RAMP) await r.tick(p, 7);
  assert.equal(r.bot.positions.length, 1, 'rig should have opened a position');
  await flush();
  return r.bot.positions[0];
}

test('bot gate: CALLOUTS_ENABLED off (default) → entry journals a shadow would-call and makes NO live post attempt', async () => {
  await withCleanEnv(async () => {
    const spy = fetchSpy404();
    globalThis.fetch = spy;
    const r = entryRig();
    const pos = await driveEntry(r);
    const wc = r.lines().filter(l => l.kind === 'would-call');
    assert.equal(wc.length, 1);
    assert.equal(wc[0].trigger, 'entry');
    assert.equal(wc[0].mint, 'MINT1');
    assert.equal(wc[0].thesis, 'test coin. looks good.');
    assert.equal(wc[0].holding, true);
    assert.equal(wc[0].linkId, pos.id);
    assert.equal(r.bot.lastCallout, undefined); // the live path never even ran
    assert.ok(!spy.calls.some(u => u.includes('/callout/create') || u.includes('/auth/')), `live callout attempted while disabled: ${spy.calls.join(', ')}`);
    assert.ok(!spy.calls.some(u => u.includes('api.openai.com')), 'live-thesis LLM spend while disabled');
  });
});

test('bot gate: CALLOUTS_ENABLED=1 → the live post IS attempted (and the shadow record still lands)', async () => {
  await withCleanEnv(async () => {
    globalThis.fetch = fetchSpy404();
    const r = entryRig({ calloutsEnabled: 1 });
    await driveEntry(r);
    assert.ok(r.bot.lastCallout, 'enabled: lastCallout should be set by the attempted post');
    assert.equal(r.bot.lastCallout.ok, false); // no wallet key in the test env — the attempt itself is the pin
    assert.equal(r.lines().filter(l => l.kind === 'would-call' && l.trigger === 'entry').length, 1);
  });
});

test('bot lifecycle: TP1 bank, TP2 bank and the final close each journal their would-call (tp3 only after TP2)', async () => {
  await withCleanEnv(async () => {
    globalThis.fetch = fetchSpy404();
    const r = entryRig();
    const pos = await driveEntry(r);
    const triggers = () => r.lines().filter(l => l.kind === 'would-call').map(l => l.trigger);

    r.q.valueLam = 34_000_000; await r.bot.positionTick(); await flush(); // adaptive TP1 banks
    assert.equal(r.bot.positions[0].tp1Done, true);
    assert.deepEqual(triggers(), ['entry', 'tp1']);
    const tp1 = r.lines().find(l => l.trigger === 'tp1');
    assert.equal(tp1.linkId, pos.id);
    assert.equal(tp1.holding, true);

    r.q.valueLam = 36_000_000; await r.bot.positionTick(); await flush(); // middle-stage print ABOVE the TP1 fire level: holds, no new records (since 2026-10-22 the TP1 guard owns any dip back under the fire gain — a sub-fire pullback would trim there, tp1guard.test.mjs)
    assert.deepEqual(triggers(), ['entry', 'tp1']);

    r.q.valueLam = 44_000_000; await r.bot.positionTick(); await flush(); // TP2 banks
    assert.equal(r.bot.positions[0].tp2Done, true);
    assert.deepEqual(triggers(), ['entry', 'tp1', 'tp2']);

    r.q.valueLam = 36_000_000; await r.bot.positionTick(); await flush(); // moonbag trail closes it
    assert.equal(r.bot.positions.length, 0);
    assert.deepEqual(triggers(), ['entry', 'tp1', 'tp2', 'tp3']);
    const tp3 = r.lines().find(l => l.trigger === 'tp3');
    assert.equal(tp3.linkId, pos.id);
    assert.equal(tp3.holding, false); // the final close: the bot no longer holds it
  });
});
