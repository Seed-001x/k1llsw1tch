// BIRTH-VERDICT MEMORY (owner order 2026-10-16, the FMR hole): both birth
// gates FAIL OPEN on missing data — correct in isolation, fatal combined
// with amnesia. FMR (A6Gk99cY…pump, 2026-10-16): a TREND evaluation at pool
// age ~44m measured the truth — instantGrad fired, "bonding curve filled
// in 3 buy tx(s) (18 buys bundled into them) — bought out at launch" — and
// skipped. ~18 minutes later a POP evaluation of the same mint re-fetched:
// GeckoTerminal couldn't serve the curve history (instantGrad passed open
// as 'curve history unknown') and DexScreener stamped the curve and AMM
// pairs with the SAME pairCreatedAt second (lifespan degenerate -> unknown
// -> fastBond passed open). The bot bought a bought-out launch; the owner
// clipped it by hand 89 seconds later. The fix pinned here: a disqualifying
// birth verdict, once ESTABLISHED by any evaluation, is persisted per mint
// (birth-verdicts.json) and enforced from memory at the onSignal seam
// before any fresh fetch — knowledge is remembered, never re-fetched into
// oblivion. Enforcement follows FAST_BOND_BLOCK; writing is always-on
// bookkeeping. Boot backfills the memory from the journal's own gate
// stamps, so verdicts established before the fix are remembered too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { birthMemoryVerdict } from '../src/gate.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view, tmp } from './helpers.mjs';

const T0 = 1_000_000_000_000;
const FMR = 'A6Gk99cY86ir38nbL9WBZ67G3hyVjNx7jmx8oDcspump';
const IG_EVIDENCE = 'bonding curve filled in 3 buy tx(s) (18 buys bundled into them) — bought out at launch';
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function seedHistory(bot, mint, price = 1) {
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push({ ts: T0 - (11 - k) * 30000, price, mc: 500_000, volM5: 100_000, volH1: 500_000, buysM5: 900, sellsM5: 800, liq: 100_000 });
  bot.history.m.set(mint, samples);
}

// live.curve / live.curveLife are MUTABLE: a test flips them between
// evaluations to replay the incident (first eval measures, later evals
// find every source dark).
function rig({ cfgOver = {}, rug = healthyRug, dataDir = null } = {}) {
  const cfg = testCfg({ tradeSol: 0.02, baseMode: 0, ...(dataDir ? { dataDir } : {}), ...cfgOver });
  const clock = { t: T0 };
  const live = { curve: null, curveLife: null, curveLifeCalls: 0 };
  const q = { valueLam: 19_000_000 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: '1000000000', priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(q.valueLam * (Number(amount) / 1e9))) });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const deps = {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => rug, searchByName: async () => [],
    fetchCurve: async () => live.curve,
    fetchCurveLife: async () => { live.curveLifeCalls++; if (live.curveLife === 'throw') throw new Error('dexscreener unreachable'); return live.curveLife; },
  };
  const bot = new Bot(cfg, deps);
  return { bot, clock, views, live, cfg };
}

async function boot(r) { await r.bot.start(); }

async function fire(r, { mint, symbol, setup }) {
  const v = view({ address: mint, symbol, mc: 300_000, liq: 100_000, createdAt: T0 - 120 * 60000, dex: 'pumpswap' }); // 120m old: outside the blind fast-bond scope (60m) — these tests judge memory, not the blind block (fastbond.test.mjs owns that)
  r.views.set(mint, v);
  seedHistory(r.bot, mint);
  await r.bot.onSignal(v, { setup, metrics: setup === 'pop' ? { gainPct: 42, volM5: 100_000 } : { volM5: 100_000 } });
  return r.bot.journal.signals.at(-1);
}

// ------------------------------------------------------------ verdict helper
test('birthMemoryVerdict: no stored verdict passes silently; a stored verdict blocks with kind, evidence and humanized age', () => {
  assert.equal(birthMemoryVerdict(null, T0).pass, true);
  assert.equal(birthMemoryVerdict(undefined, T0).pass, true);
  const bv = { kind: 'fastBond', evidence: 'curve lifespan 27s < 120s — fast bonder blocked', firstSeenTs: T0 };
  const at = (dt) => birthMemoryVerdict(bv, T0 + dt);
  assert.equal(at(0).pass, false);
  assert.equal(at(30_000).reason, 'known fast bonder (fastBond: curve lifespan 27s < 120s — fast bonder blocked; verdict 30s old) — blocked from memory');
  assert.match(at(18 * 60000).reason, /verdict 18m old/);
  assert.match(at(3 * 3600000).reason, /verdict 3h old/);
  assert.match(at(3 * 86400000).reason, /verdict 3d old/);
  assert.equal(at(18 * 60000).kind, 'fastBond');
  assert.equal(at(18 * 60000).evidence, bv.evidence);
});

// ------------------------------------------------------------ the incident
test('THE INCIDENT (FMR): instantGrad fires on a trend eval -> verdict persisted; 18m later a pop eval with every fetch dark is blocked FROM MEMORY', async () => {
  const r = rig({});
  await boot(r);
  // Phase 1 — the trend evaluation measures the truth; the gate stack skips.
  r.live.curve = { buys: 3, buyIxs: 18 };
  const rec1 = await fire(r, { mint: FMR, symbol: 'FMR', setup: 'trend' });
  assert.equal(rec1.decision, 'skipped');
  assert.ok(rec1.reasons.some(x => x.startsWith(`instantGrad: ${IG_EVIDENCE}`)), JSON.stringify(rec1.reasons));
  // (i) the verdict was persisted the moment it was established — map + disk.
  const bv = r.bot.birthVerdicts.get(FMR);
  assert.equal(bv.kind, 'instantGrad');
  assert.equal(bv.evidence, IG_EVIDENCE);
  assert.equal(bv.firstSeenTs, T0);
  const onDisk = JSON.parse(fs.readFileSync(r.bot.birthFile, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].mint, FMR);
  assert.equal(onDisk[0].kind, 'instantGrad');
  assert.equal(r.bot.positions.length, 0);
  // Phase 2 — +18m: GeckoTerminal serves nothing (curve null -> instantGrad
  // 'curve history unknown' -> pass) and the lifespan read is dark too.
  r.clock.t += 18 * 60000;
  r.live.curve = null;
  r.live.curveLife = null;
  const rec2 = await fire(r, { mint: FMR, symbol: 'FMR', setup: 'pop' });
  // (ii) still blocked — from memory, with the memory reason.
  assert.equal(rec2.decision, 'skipped', JSON.stringify(rec2.reasons));
  assert.deepEqual(rec2.reasons, [`known fast bonder (instantGrad: ${IG_EVIDENCE}; verdict 18m old) — blocked from memory`]);
  assert.equal(rec2.gates.birthMemory.pass, false);
  assert.equal(rec2.gates.birthMemory.kind, 'instantGrad');
  assert.equal(rec2.gatePass, true, 'the fresh gate stack passed open — the memory is what stopped it');
  assert.equal(r.bot.positions.length, 0);
  assert.equal(r.bot.stats.entries, 0);
  assert.equal(r.bot.stats.birthMemory.blocked, 1);
  assert.equal(r.live.curveLifeCalls, 0, 'the memory answered before any fresh lifespan fetch was spent');
});

// ------------------------------------------------------------ fastBond writes
test('(iii) a measured fastBond block writes a verdict; a later eval whose stamps are degenerate is blocked from memory', async () => {
  const r = rig({});
  await boot(r);
  r.live.curveLife = 27;
  const rec1 = await fire(r, { mint: 'MINTFB', symbol: 'FB', setup: 'pop' });
  assert.deepEqual(rec1.reasons, ['curve lifespan 27s < 180s — fast bonder blocked']);
  const bv = r.bot.birthVerdicts.get('MINTFB');
  assert.equal(bv.kind, 'fastBond');
  assert.match(bv.evidence, /curve lifespan 27s/);
  // Later eval: DexScreener stamps degenerate (same second) -> lifespan
  // unknown; cold measurement cache (a fresh process would start cold too).
  r.live.curveLife = null;
  r.bot.curveLifeCache.clear();
  const callsBefore = r.live.curveLifeCalls;
  const rec2 = await fire(r, { mint: 'MINTFB', symbol: 'FB', setup: 'pop' });
  assert.equal(rec2.decision, 'skipped', JSON.stringify(rec2.reasons));
  assert.match(rec2.reasons[0], /^known fast bonder \(fastBond: curve lifespan 27s < 180s — fast bonder blocked; verdict .* old\) — blocked from memory$/);
  assert.equal(rec2.gates.birthMemory.kind, 'fastBond');
  assert.equal(r.live.curveLifeCalls, callsBefore, 'the memory answered before the fresh fetch');
  assert.equal(r.bot.stats.fastBond.blocked, 1, 'the fresh gate blocked only the first evaluation');
  assert.equal(r.bot.stats.birthMemory.blocked, 1);
  assert.equal(r.bot.positions.length, 0);
});

// ------------------------------------------------------------ fail open preserved
test('(iv) FAIL OPEN preserved: no verdict + every birth fetch unknown still buys, and the memory stays silent', async () => {
  const r = rig({});
  await boot(r);
  const rec = await fire(r, { mint: 'MINTU', symbol: 'U', setup: 'pop' }); // curve null, curveLife null
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.fastBond.unknown, true);
  assert.equal(rec.gates.birthMemory, undefined, 'no verdict -> no stamp -> record exactly as before the memory existed');
  assert.equal(r.bot.birthVerdicts.size, 0);
  assert.equal(r.bot.positions.length, 1);
});

// ------------------------------------------------------------ restart survival
test('(v) a verdict survives a restart via birth-verdicts.json alone (journal wiped — backfill cannot be the source)', async () => {
  const dir = tmp();
  const r1 = rig({ dataDir: dir });
  await boot(r1);
  r1.live.curveLife = 27;
  const rec1 = await fire(r1, { mint: 'MINTFB', symbol: 'FB', setup: 'pop' });
  assert.equal(rec1.decision, 'skipped');
  assert.ok(fs.existsSync(path.join(dir, 'birth-verdicts.json')));
  fs.rmSync(path.join(dir, 'signals.jsonl'), { force: true }); // the journal forgets; the memory must not
  const r2 = rig({ dataDir: dir });
  await boot(r2);
  assert.equal(r2.bot.birthVerdicts.get('MINTFB').kind, 'fastBond', 'rebuilt from the persisted verdict file');
  const rec2 = await fire(r2, { mint: 'MINTFB', symbol: 'FB', setup: 'pop' }); // r2 fetches: curve null, curveLife null
  assert.equal(rec2.decision, 'skipped', JSON.stringify(rec2.reasons));
  assert.match(rec2.reasons[0], /blocked from memory/);
  assert.equal(r2.bot.positions.length, 0);
});

test('BOOT BACKFILL (the FMR record): an instantGrad fire journaled before the fix becomes a verdict at boot and blocks', async () => {
  const dir = tmp();
  const ts = T0 - 18 * 60000;
  const old = { id: `${ts}-1`, ts, mint: FMR, symbol: 'FMR', setup: 'trend', decision: 'skipped', reasons: [`instantGrad: ${IG_EVIDENCE}`], price: 0.001, mc: 300_000, metrics: {}, warnings: [], label: null, gates: { instantGrad: { pass: false, reason: IG_EVIDENCE } }, gatePass: false, fields: null };
  fs.writeFileSync(path.join(dir, 'signals.jsonl'), JSON.stringify(old) + '\n');
  const r = rig({ dataDir: dir }); // the constructor backfill runs here
  const bv = r.bot.birthVerdicts.get(FMR);
  assert.ok(bv, 'backfill seeded the verdict from the journal record');
  assert.equal(bv.kind, 'instantGrad');
  assert.equal(bv.firstSeenTs, ts, 'provenance is the original evaluation, not the boot');
  assert.ok(fs.existsSync(path.join(dir, 'birth-verdicts.json')), 'the backfill persisted what it recovered');
  await boot(r);
  const rec = await fire(r, { mint: FMR, symbol: 'FMR', setup: 'pop' }); // every fetch dark in this rig
  assert.equal(rec.decision, 'skipped', JSON.stringify(rec.reasons));
  assert.match(rec.reasons[0], /verdict 18m old\) — blocked from memory/);
  assert.equal(r.bot.positions.length, 0);
});

// ------------------------------------------------------------ kill switch
test('(vi) kill switch FAST_BOND_BLOCK=0: the verdict is still WRITTEN (bookkeeping) but never ENFORCED — the pop buys', async () => {
  const r = rig({ cfgOver: { fastBondBlock: false } });
  await boot(r);
  r.live.curve = { buys: 3, buyIxs: 18 };
  const rec1 = await fire(r, { mint: 'MINTK', symbol: 'K', setup: 'trend' });
  assert.equal(rec1.decision, 'skipped', 'the gate stack itself still skips on the fire');
  assert.equal(r.bot.birthVerdicts.get('MINTK').kind, 'instantGrad', 'writing is always-on, independent of the enforcement switch');
  r.live.curve = null;
  r.live.curveLife = null;
  const rec2 = await fire(r, { mint: 'MINTK', symbol: 'K', setup: 'pop' });
  assert.equal(rec2.decision, 'taken', JSON.stringify(rec2.reasons));
  assert.equal(rec2.gates.birthMemory, undefined, 'no stamp while enforcement is off — records exactly as before');
  assert.equal(r.bot.stats.birthMemory.blocked, 0);
  assert.equal(r.bot.positions.length, 1);
});

// ------------------------------------------------------------ passes never verdict
test('(vii) a PASSING birth never writes a verdict: fat curve-buy count + long lifespan buy clean, memory stays empty', async () => {
  const r = rig({});
  await boot(r);
  r.live.curve = { buys: 400, buyIxs: 400 };
  r.live.curveLife = 5000;
  const rec = await fire(r, { mint: 'MINTG', symbol: 'G', setup: 'pop' });
  assert.equal(rec.decision, 'taken', JSON.stringify(rec.reasons));
  assert.equal(rec.gates.fastBond.pass, true);
  assert.equal(rec.gates.fastBond.curveLifeSec, 5000);
  assert.equal(r.bot.birthVerdicts.size, 0, 'a pass is permanent truth too — but it lives in the curve-life cache, never in the verdict memory');
  assert.ok(!fs.existsSync(r.bot.birthFile) || JSON.parse(fs.readFileSync(r.bot.birthFile, 'utf8')).length === 0);
});

// ------------------------------------------------------------ shadow write tap
test('shadow evaluations write verdicts too: a shadowGateRecord instantGrad fire is remembered (knowledge is knowledge)', async () => {
  const r = rig({});
  await boot(r);
  r.live.curve = { buys: 2, buyIxs: 9 };
  const v = view({ address: 'MINTS', symbol: 'S', mc: 300_000, liq: 100_000, createdAt: T0 - 3600e3, dex: 'pumpswap' });
  seedHistory(r.bot, 'MINTS');
  const sg = await r.bot.shadowGateRecord(v, { setup: 'trend', metrics: {} }, r.clock.t);
  assert.equal(sg.gates.instantGrad.pass, false);
  assert.equal(r.bot.birthVerdicts.get('MINTS').kind, 'instantGrad');
  assert.match(r.bot.birthVerdicts.get('MINTS').evidence, /bonding curve filled in 2 buy tx\(s\)/);
});
