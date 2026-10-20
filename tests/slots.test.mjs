// PER-SLOT SIZES, SLOTS 3..10 (owner order 2026-10-19 21:58 EDT: the
// shape setting simplifies to "select number of open positions" 1-10,
// with a size field for EVERY slot). Before this, sizing had exactly two
// buckets (risk.js sizeFor): slot 1 = tradeSol, every later slot =
// slot2Sol — which is why the Settings tab only had two size fields, and
// why his 4 slots × 0.025 could only be expressed by making the two
// buckets equal. Now each slot N has its own dial (SLOTN_SOL /
// slotNSol): dial > 0 prices that slot; 0/unset = "same as slot 1"
// (tradeSol — the convention slot 2's Settings hint already stated).
// Slot 2 is untouched: slot2Sol is still its dial, and slot2Sol <= 0
// still means slot 2 sizes at tradeSol exactly as before. The ONE
// behavioral change is inside slots >= 3: an unset dial used to inherit
// slot 2's size (the two-bucket rule); it now falls back to tradeSol.
// With slot2Sol == tradeSol (his live shape) the numbers are identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/bot.js';
import { Executor } from '../src/exec.js';
import { Risk } from '../src/risk.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { sanitizeSettings, applySettings, settingsView } from '../src/settings.js';
import { SOL_MINT } from '../src/util.js';
import { testCfg, view } from './helpers.mjs';

const T0 = 1_000_000_000_000;
let clock = Date.UTC(2026, 9, 19, 4, 0, 0);
const mkRisk = (over = {}) => { const cfg = testCfg(over); return new Risk(cfg, { dir: cfg.dataDir, now: () => clock }); };
const DEEP = 1_000_000, SOLUSD = 150;

// ------------------------------------------------------------ config
test('config: SLOT3_SOL..SLOT10_SOL default to 0 (unset), env reads, validation bounds them', () => {
  const d = loadConfig({});
  for (let n = 3; n <= 10; n++) assert.equal(d[`slot${n}Sol`], 0, `slot${n}Sol defaults unset`);
  assert.equal(loadConfig({ SLOT3_SOL: '0.04' }).slot3Sol, 0.04);
  assert.equal(loadConfig({ SLOT10_SOL: '0.01' }).slot10Sol, 0.01);
  assert.ok(validateConfig({ ...d, slot5Sol: -0.01 }).some(e => e.includes('SLOT5_SOL')));
  assert.ok(!validateConfig(d).some(e => e.includes('SLOT')));
});

// ------------------------------------------------------------ risk seam
test('ordinal picking: each slot sizes at its own dial when set, at tradeSol when unset', () => {
  const r = mkRisk({ tradeSol: 0.1, slot2Sol: 0.05, slot3Sol: 0.03, slot5Sol: 0.02, slot10Sol: 0.015 });
  // slotDialSol is the shared ordinal -> dial map (sizing + journal stamp)
  assert.equal(r.slotDialSol(1), 0.1);
  assert.equal(r.slotDialSol(2), 0.05);
  assert.equal(r.slotDialSol(3), 0.03);
  assert.equal(r.slotDialSol(4), 0, 'unset dial reads 0');
  assert.equal(r.slotDialSol(10), 0.015);
  // baseTradeSol(openCount): the entry becomes position #(openCount + 1)
  assert.equal(r.baseTradeSol(0), 0.1, 'slot 1 = tradeSol');
  assert.equal(r.baseTradeSol(1), 0.05, 'slot 2 = its dial');
  assert.equal(r.baseTradeSol(2), 0.03, 'slot 3 = its dial');
  assert.equal(r.baseTradeSol(3), 0.1, 'slot 4 unset -> tradeSol (same as slot 1), NOT slot 2');
  assert.equal(r.baseTradeSol(4), 0.02, 'slot 5 = its dial');
  assert.equal(r.baseTradeSol(5), 0.1, 'slot 6 unset -> tradeSol');
  assert.equal(r.baseTradeSol(9), 0.015, 'slot 10 = its dial');
  assert.equal(r.sizeFor(DEEP, SOLUSD, 2), 0.03, 'sizeFor routes the same ordinal');
});

test('slot 2 legacy behavior unchanged: slot2Sol<=0 restores tradeSol for slot 2 exactly', () => {
  const off = mkRisk({ tradeSol: 0.1, slot2Sol: 0 });
  assert.equal(off.baseTradeSol(1), 0.1, 'kill switch: slot 2 sizes at tradeSol, as before');
  assert.equal(off.effectiveTradeSol(1), 0.1);
  assert.equal(off.sizeFor(DEEP, SOLUSD, 1), 0.1);
  // the slot-2 kill switch is slot 2's alone: a later slot's own dial still prices it
  const r = mkRisk({ tradeSol: 0.1, slot2Sol: 0, slot3Sol: 0.03 });
  assert.equal(r.baseTradeSol(2), 0.03, 'slot 3 dial honored even with slot2Sol=0');
  // and slot 2 set does not leak into unset later slots (the two-bucket rule is gone)
  const r2 = mkRisk({ tradeSol: 0.1, slot2Sol: 0.04 });
  assert.equal(r2.baseTradeSol(2), 0.1, 'slot 3 unset -> tradeSol, not slot2Sol');
  assert.equal(r2.baseTradeSol(6), 0.1, 'slot 7 unset -> tradeSol, not slot2Sol');
});

test('adjustments apply on top of any slot base: brake halving and the pool-fraction cap', () => {
  const r = mkRisk({ tradeSol: 0.1, slot3Sol: 0.04 });
  r.recordClose(-0.01, 'A', 0.1); r.recordClose(-0.01, 'B', 0.1); r.recordClose(-0.01, 'C', 0.1);
  assert.equal(r.s.sizeHalved, true);
  assert.equal(r.effectiveTradeSol(2), 0.02, 'slot 3 halved from its own base: 0.04 x 0.5');
  const f = r.cfg.maxPoolFraction;
  const r2 = mkRisk({ tradeSol: 0.1, slot3Sol: 0.04 });
  assert.ok(Math.abs(r2.sizeFor(60, SOLUSD, 2) - (60 * f) / SOLUSD) < 1e-9, 'shallow pool: slot 3 shrinks to the same pool fraction');
});

// ------------------------------------------------------------ settings
test('settings: sanitize accepts slot3Sol..slot10Sol and maxPositions up to 10; apply + view carry them', () => {
  const input = { maxPositions: 10 };
  for (let n = 3; n <= 10; n++) input[`slot${n}Sol`] = 0.01 * n;
  const { values, errors } = sanitizeSettings(input);
  assert.deepEqual(errors, []);
  assert.equal(values.maxPositions, 10);
  for (let n = 3; n <= 10; n++) assert.equal(values[`slot${n}Sol`], 0.01 * n);
  assert.equal(sanitizeSettings({ maxPositions: 7 }).values.maxPositions, 7, 'the old max of 6 no longer rejects 7');
  assert.equal(sanitizeSettings({ maxPositions: 11 }).errors.length, 1, '11 is out of range and reported, not applied');
  assert.deepEqual(sanitizeSettings({ maxPositions: 11 }).values, {});
  assert.equal(sanitizeSettings({ slot3Sol: -0.5 }).errors.length, 1, 'negative slot size rejected');
  const cfg = testCfg();
  applySettings(cfg, values);
  assert.equal(cfg.maxPositions, 10);
  assert.equal(cfg.slot4Sol, 0.04);
  const row = settingsView(cfg, {}, {}).find(v => v.key === 'maxPositions');
  assert.equal(row.label, 'Open positions');
  assert.equal(row.max, 10);
});

// ------------------------------------------------------------ pipeline rig
const healthyRug = { token: { supply: 1e15, decimals: 6 }, creatorBalance: 0, totalHolders: 2000, graphInsidersDetected: 0, markets: [{ pubkey: 'POOL', lp: { base: 1e8, quote: 1400, lpLockedUSD: 3e5, lpLockedPct: 100 } }], knownAccounts: { POOL: { type: 'AMM' } }, topHolders: Array.from({ length: 12 }, (_, i) => ({ owner: 'h' + i, address: 'h' + i, amount: 9e12 - i * 3.1e10, pct: 2 })), insiderNetworks: [] };

function pipelineRig({ cfgOver = {} } = {}) {
  const cfg = testCfg({ tradeSol: 0.1, baseMode: 0, maxPositions: 3, slot2Sol: 0.025, ...cfgOver });
  const clock = { t: T0 };
  const quote = async (input, _o, amount) => (input === SOL_MINT
    ? { outAmount: String(Math.floor(Number(amount))), priceImpactPct: '0.01' }
    : { outAmount: String(Math.floor(Number(amount) * 0.95)), priceImpactPct: '0.01' });
  const exec = new Executor(cfg, { quote });
  const views = new Map();
  const deps = {
    now: () => clock.t, exec,
    discover: async () => Object.assign(new Map(), { counts: {} }),
    fetchViews: async (mints) => new Map(mints.filter(m => views.has(m)).map(m => [m, views.get(m)])),
    fetchSolUsd: async () => 150, fetchRug: async () => healthyRug, searchByName: async () => [],
    fetchCurveLife: async () => null,
  };
  const bot = new Bot(cfg, deps);
  return { bot, clock, views };
}

const S = (ts, mc) => ({ ts, price: mc / 1e6, mc, volM5: 50_000, volH1: 200_000, buysM5: 100, sellsM5: 60, liq: 100_000 });
const thin = (mc) => [S(T0 - 90000, mc - 20_000), S(T0 - 45000, mc - 10_000), S(T0 - 5000, mc)];

async function fire(rig, { mint, symbol, mc = 500_000 }) {
  const v = view({ address: mint, symbol, mc, price: mc / 1e6, liq: 100_000, createdAt: T0 - 10 * 3600e3, dex: 'pumpswap' });
  rig.views.set(mint, v);
  await rig.bot.start();
  rig.bot.history.m.set(mint, thin(mc));
  await rig.bot.onSignal(v, { setup: 'pop', strength: 42, metrics: { gainPct: 42, volM5: 100_000 } });
  return rig.bot.journal.signals.at(-1);
}

test('pipeline: a third concurrent entry sizes at slot3Sol and stamps its true ordinal', async () => {
  const rig = pipelineRig({ cfgOver: { slot3Sol: 0.03 } });
  const rec1 = await fire(rig, { mint: 'MINTAAA', symbol: 'FIRST' });
  assert.equal(rec1.decision, 'taken', JSON.stringify(rec1.reasons));
  assert.equal(rig.bot.positions[0].entrySol, 0.1);
  assert.equal(rig.bot.positions[0].slot, undefined, 'slot 1 unstamped, as before');
  const rec2 = await fire(rig, { mint: 'MINTBBB', symbol: 'SECOND' });
  assert.equal(rec2.decision, 'taken', JSON.stringify(rec2.reasons));
  assert.equal(rig.bot.positions[1].entrySol, 0.025, 'slot 2 still sizes at SLOT2_SOL');
  assert.equal(rig.bot.positions[1].slot, 2, 'slot 2 still stamps 2');
  const rec3 = await fire(rig, { mint: 'MINTCCC', symbol: 'THIRD' });
  assert.equal(rec3.decision, 'taken', JSON.stringify(rec3.reasons));
  assert.equal(rec3.metrics.sizeSol, 0.03, 'the third concurrent entry sizes at slot3Sol');
  assert.equal(rig.bot.positions.length, 3);
  assert.equal(rig.bot.positions[2].entrySol, 0.03);
  assert.equal(rig.bot.positions[2].slot, 3, 'the position carries its true ordinal');
  const open3 = rig.bot.journal.trades.find(t => t.type === 'open' && t.mint === 'MINTCCC');
  assert.equal(open3.slot, 3, 'the journal open record carries slot 3');
  assert.equal(open3.entrySol, 0.03);
  const rec4 = await fire(rig, { mint: 'MINTDDD', symbol: 'FOURTH' });
  assert.equal(rec4.decision, 'skipped', 'the cap still refuses beyond maxPositions');
  assert.equal(rig.bot.positions.length, 3);
});

test('pipeline: slot 3 dial unset — the third entry sizes at tradeSol and carries no stamp', async () => {
  const rig = pipelineRig();
  await fire(rig, { mint: 'MINTAAA', symbol: 'FIRST' });
  await fire(rig, { mint: 'MINTBBB', symbol: 'SECOND' });
  const rec3 = await fire(rig, { mint: 'MINTCCC', symbol: 'THIRD' });
  assert.equal(rec3.decision, 'taken', JSON.stringify(rec3.reasons));
  assert.equal(rig.bot.positions[2].entrySol, 0.1, 'unset slot-3 dial = same as slot 1');
  assert.equal(rig.bot.positions[2].slot, undefined, 'not priced by a slot dial -> no stamp, the pre-slot shape');
  const open3 = rig.bot.journal.trades.find(t => t.type === 'open' && t.mint === 'MINTCCC');
  assert.equal(open3.slot, undefined);
});
