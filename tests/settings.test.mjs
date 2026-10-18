// SETTINGS TAB (owner order 2026-10-18 19:20 EDT, "only me being able to
// see it"): the whitelist schema + sanitizer, the disk overlay that
// re-applies at boot over the env config, and the /settings HTTP surface —
// key-gated for READS as well as writes (unlike the public dashboard GETs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_SCHEMA, SETTINGS_KEYS, sanitizeSettings, applySettings, settingsView, loadSettingsOverlay, saveSettingsOverlay } from '../src/settings.js';
import { startServer } from '../src/server.js';
import { testCfg, tmp } from './helpers.mjs';

test('settings schema: every key exists on the real config (a renamed cfg field can never strand a dial)', () => {
  const cfg = testCfg();
  for (const k of SETTINGS_KEYS) assert.ok(k in cfg, `cfg.${k} missing — the tab would write into the void`);
  assert.equal(new Set(SETTINGS_KEYS).size, SETTINGS_KEYS.length, 'no duplicate keys');
  for (const s of SETTINGS_SCHEMA) assert.ok(s.label && s.group && s.type, `${s.key} fully described`);
});

test('sanitize: unknown keys dropped, bad values reported not applied, good values in the same save still land', () => {
  const { values, errors } = sanitizeSettings({ maxPositions: 3, tradeSol: 99, hackerKey: 1, staircaseLive: true, tp1Pct: '0.25' });
  assert.deepEqual(values, { maxPositions: 3, staircaseLive: 1, tp1Pct: 0.25 });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /tradeSol/);
  assert.deepEqual(sanitizeSettings(null), { values: {}, errors: ['settings must be an object'] });
  assert.deepEqual(sanitizeSettings({ maxPositions: 2.6 }).values, { maxPositions: 3 }, 'ints round');
  assert.deepEqual(sanitizeSettings({ entryClip: 'off' }).values, {}, 'a toggle takes 0/1/true/false only');
});

test('apply: boolean cfg fields receive real booleans, numbers pass through raw', () => {
  const cfg = testCfg();
  applySettings(cfg, { preEntryCensus: 0, flowConfirmLive: 1, maxPositions: 2, tp1Frac: 0.5 });
  assert.equal(cfg.preEntryCensus, false);
  assert.equal(cfg.flowConfirmLive, true);
  assert.equal(cfg.maxPositions, 2);
  assert.equal(cfg.tp1Frac, 0.5);
});

test('view: live value, env baseline, and the override flag ride together', () => {
  const cfg = testCfg({ maxPositions: 1 });
  const baseline = { maxPositions: 5, staircaseLive: 0 };
  cfg.maxPositions = 3;
  const view = settingsView(cfg, baseline, { maxPositions: 3 });
  const mp = view.find(v => v.key === 'maxPositions');
  assert.deepEqual({ value: mp.value, envValue: mp.envValue, overridden: mp.overridden }, { value: 3, envValue: 5, overridden: true });
  const st = view.find(v => v.key === 'staircaseLive');
  assert.equal(st.overridden, false);
});

test('overlay: save/load round-trips through disk; a corrupt file degrades to no overrides, never a throw', () => {
  const dir = tmp();
  saveSettingsOverlay(dir, { maxPositions: 2, tradeSol: 0.1, bogusKey: 7, tp1Pct: 42 });
  assert.deepEqual(loadSettingsOverlay(dir, null), { maxPositions: 2, tradeSol: 0.1 }, 'unknown + out-of-range entries are dropped on load too');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
  assert.deepEqual(loadSettingsOverlay(dir, null), {});
  assert.deepEqual(loadSettingsOverlay(path.join(dir, 'missing'), null), {});
});

// ---- the HTTP surface, with a stub bot (only the surface /settings touches) ----
function stubBot(dir) {
  const cfg = testCfg({ dataDir: dir, maxPositions: 1, tradeSol: 0.1 });
  const baseline = {}; for (const k of SETTINGS_KEYS) baseline[k] = cfg[k];
  const risk = {
    s: { dayPnlSol: -0.05, day: '2026-10-18', startEquitySol: 0.0261, haltBalBaseline: 0.0261, killed: false, downHalted: false },
    state() { return { dayPnlSol: this.s.dayPnlSol, startEquitySol: this.s.startEquitySol, haltBalBaseline: this.s.haltBalBaseline, lossStreak: 0 }; },
    clearBrake() {}, clearStreakPause() {},
    clearDownHalt() { this.s.downHalted = false; this.s.haltBalBaseline = null; },
    clearKill() { this.s.killed = false; this.s.startEquitySol = null; },
    initEquity(bal) { if (this.s.startEquitySol == null) this.s.startEquitySol = bal; },
    save() {},
  };
  return { cfg, settingsBaseline: baseline, settingsOverlay: {}, positions: [], risk, exec: { solBalance: async () => 0.42 } };
}

async function withServer(fn) {
  const dir = tmp();
  const bot = stubBot(dir);
  process.env.ADMIN_KEY = 'test-key';
  const srv = startServer(bot, 0);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    await fn(base, bot, dir);
  } finally { srv.close(); delete process.env.ADMIN_KEY; }
}
const H = { 'x-admin-key': 'test-key', 'content-type': 'application/json' };

test('GET /settings refuses without the key (even reads are owner-only) and answers with it', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + '/settings')).status, 401);
    assert.equal((await fetch(base + '/settings', { headers: { 'x-admin-key': 'wrong' } })).status, 401);
    const r = await fetch(base + '/settings', { headers: H });
    assert.equal(r.status, 200);
    const j = await r.json();
    const mp = j.settings.find(s => s.key === 'maxPositions');
    assert.equal(mp.value, 1); assert.equal(mp.envValue, 1); assert.equal(mp.overridden, false);
    assert.equal(j.halted, false);
    assert.equal(j.balanceSol, 0.42);
  });
});

test('POST /settings applies live, persists the overlay, and reset returns a dial to its env baseline', async () => {
  await withServer(async (base, bot, dir) => {
    assert.equal((await fetch(base + '/settings', { method: 'POST', body: JSON.stringify({ values: { maxPositions: 3 } }) })).status, 401, 'writes are guarded');
    const r = await fetch(base + '/settings', { method: 'POST', headers: H, body: JSON.stringify({ values: { maxPositions: 3, tradeSol: 5 } }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.applied, ['maxPositions'], 'the out-of-range size is refused, the good dial still lands');
    assert.equal(j.errors.length, 1);
    assert.equal(bot.cfg.maxPositions, 3, 'live cfg moved');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), { maxPositions: 3 }, 'overlay persisted for the next boot');
    const rr = await fetch(base + '/settings', { method: 'POST', headers: H, body: JSON.stringify({ reset: ['maxPositions'] }) });
    assert.equal(rr.status, 200);
    assert.equal(bot.cfg.maxPositions, 1, 'reset restores the env baseline');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), {});
    const bad = await fetch(base + '/settings', { method: 'POST', headers: H, body: JSON.stringify({ values: { tradeSol: 5 } }) });
    assert.equal(bad.status, 400, 'a save with nothing valid is a 400');
  });
});

test('POST /settings rearm: counters zero and both balance anchors re-base at the live wallet, HALT untouched', async () => {
  await withServer(async (base, bot, dir) => {
    const r = await fetch(base + '/settings', { method: 'POST', headers: H, body: JSON.stringify({ action: 'rearm' }) });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.rearmed, true);
    assert.equal(j.balanceSol, 0.42);
    assert.equal(bot.risk.s.dayPnlSol, 0);
    assert.equal(bot.risk.s.startEquitySol, 0.42, 'equity-kill anchor re-based');
    assert.equal(bot.risk.s.haltBalBaseline, 0.42, 'drop-halt anchor re-based at wallet + open cost (none open)');
    assert.equal(fs.existsSync(path.join(dir, 'HALT')), false, 'rearm never touches the HALT file');
  });
});
