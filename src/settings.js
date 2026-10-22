// settings.js — the owner Settings tab's backend (owner order 2026-10-18
// 19:20 EDT: "add a settings tab where I could toggle diff things and
// select how many slots & value I want active etc. but only me being able
// to see it"). A WHITELIST of live-readable cfg keys the owner can change
// from his dashboard: schema + sanitize + a disk overlay
// (<dataDir>/settings.json) that re-applies at every boot ON TOP of the
// env config, so a tab change needs no redeploy and survives restarts,
// while the Render env stays the fallback baseline underneath.
//
// Discipline: only schema keys can ever be written or applied; every
// value is coerced and range-checked here (ranges mirror validateConfig);
// a corrupt or hand-mangled settings.json degrades to "no overrides" with
// a log line, never a boot failure. The HTTP layer (server.js) gates both
// the read and the write behind the ADMIN_KEY — unlike the public GETs,
// GET /settings refuses without the key: nobody else even sees the dials.

import fs from 'node:fs';
import path from 'node:path';

// type: 'int' | 'num' | 'toggle'. bool: the cfg field itself is a boolean
// (env-derived with !== '0' / === 1), so the overlay stores 0/1 and the
// apply step converts. group drives the tab's sections.
export const SETTINGS_SCHEMA = [
  // Shape — how the bot trades
  { key: 'maxPositions', label: 'Open positions', group: 'Shape', type: 'int', min: 1, max: 10, hint: 'concurrent positions' },
  { key: 'tradeSol', label: 'Slot 1 size (SOL)', group: 'Shape', type: 'num', min: 0.005, max: 1 },
  { key: 'slot2Sol', label: 'Slot 2 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot3Sol', label: 'Slot 3 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot4Sol', label: 'Slot 4 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot5Sol', label: 'Slot 5 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot6Sol', label: 'Slot 6 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot7Sol', label: 'Slot 7 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot8Sol', label: 'Slot 8 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot9Sol', label: 'Slot 9 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'slot10Sol', label: 'Slot 10 size (SOL)', group: 'Shape', type: 'num', min: 0, max: 1, hint: '0 = same as slot 1' },
  { key: 'flowConfirmSol', label: 'Flow-lane stake (SOL)', group: 'Shape', type: 'num', min: 0.005, max: 0.5 },
  // Safety — the fail-safes
  { key: 'dailyLossSol', label: 'Daily loss cap (SOL)', group: 'Safety', type: 'num', min: 0, max: 1, hint: '0 = off' },
  { key: 'haltDownSol', label: 'Balance-drop halt (SOL)', group: 'Safety', type: 'num', min: 0, max: 0.5, hint: 'halt if equity falls this far below the armed baseline; 0 = off' },
  { key: 'streakPauseN', label: 'Loss-streak pause', group: 'Safety', type: 'int', min: 0, max: 50, hint: 'straight losses that pause entries; 0 = off' },
  // Doors & guards — toggles
  { key: 'staircaseLive', label: 'Staircase entries', group: 'Doors & guards', type: 'toggle' },
  { key: 'bottomLive', label: 'Bottom entries', group: 'Doors & guards', type: 'toggle' },
  { key: 'rangeLive', label: 'Range entries', group: 'Doors & guards', type: 'toggle' },
  { key: 'flowConfirmLive', label: 'Flow-confirmation lane', group: 'Doors & guards', type: 'toggle', bool: true },
  { key: 'trendEntryLive', label: 'Trend entries (early signals)', group: 'Doors & guards', type: 'toggle' },
  { key: 'enrollSignals', label: 'Signal enrollment (base watch)', group: 'Doors & guards', type: 'toggle', hint: 'on = signals only watch-list the coin for base entries; off = signals buy directly' },
  { key: 'entryClip', label: 'Entry clip (−7% at 3m)', group: 'Doors & guards', type: 'toggle' },
  { key: 'preEntryCensus', label: 'Pre-entry census', group: 'Doors & guards', type: 'toggle', bool: true },
  { key: 'preEntryVeto', label: 'Pre-entry census veto', group: 'Doors & guards', type: 'toggle', bool: true, hint: 'off = watch + stamp only' },
  { key: 'structureTrendSeed', label: 'Trending seeding (structure watch)', group: 'Doors & guards', type: 'toggle' },
  // Entry numbers
  { key: 'baseMinVolM5', label: 'Pulse floor — bottom/range ($)', group: 'Entry numbers', type: 'num', min: 0, max: 100000, hint: 'min 5m volume at entry; 0 = off' },
  { key: 'baseStaircaseMinVolM5', label: 'Pulse floor — staircase ($)', group: 'Entry numbers', type: 'num', min: 0, max: 100000, hint: '0 = exempt' },
  { key: 'structureSeedMinMc', label: 'Trending-seed MC floor ($)', group: 'Entry numbers', type: 'num', min: 0, max: 1000000 },
  { key: 'minMc', label: 'Min market cap ($)', group: 'Entry numbers', type: 'num', min: 0, max: 500000 },
  { key: 'maxMc', label: 'Max market cap ($)', group: 'Entry numbers', type: 'num', min: 0, max: 100000000, hint: 'no buys above this cap on any door' },
  { key: 'trendEntryMaxSignals', label: 'Trend entry max signals', group: 'Entry numbers', type: 'int', min: 1, max: 20, hint: 'a trend signal may buy directly only while it is among the mint’s first N trend signals' },
  { key: 'maxCoinAgeDays', label: 'Max coin age (days)', group: 'Entry numbers', type: 'int', min: 0, max: 365, hint: 'no buys on coins already this old; 0 = off' },
  { key: 'requireReportBelowAgeH', label: 'Report required below age (hrs)', group: 'Entry numbers', type: 'num', min: 0, max: 72, hint: 'coins younger than this need a RugCheck report to buy' },
  // Exits
  { key: 'tp1Pct', label: 'TP1 arm (gain fraction)', group: 'Exits', type: 'num', min: 0.01, max: 3, hint: '0.19 = +19%' },
  { key: 'tp1Frac', label: 'TP1 bank fraction', group: 'Exits', type: 'num', min: 0.05, max: 1, hint: 'share of the position banked at TP1' },
  { key: 'tp2Pct', label: 'TP2 arm (gain fraction)', group: 'Exits', type: 'num', min: 0.05, max: 5, hint: '0.8 = +80%' },
  { key: 'tp2Frac', label: 'TP2 bank fraction', group: 'Exits', type: 'num', min: 0, max: 1, hint: 'share of the ORIGINAL position; 0 = off' },
  { key: 'tp1Guard', label: 'TP1 guard (middle-stage give-back)', group: 'Exits', type: 'num', min: 0, max: 1, hint: '1 = on: falling back under the TP1 line trims the remainder' },
  { key: 'tp1GuardTrimFrac', label: 'TP1 guard trim (fraction of remainder)', group: 'Exits', type: 'num', min: 0.05, max: 0.95, hint: '0.5 = sell half the remaining bag at the cross-down' },
  { key: 'tp1GuardFloorPct', label: 'TP1 guard floor (net gain)', group: 'Exits', type: 'num', min: -0.5, max: 1, hint: '0 = the last slice exits in full at entry' },
  { key: 'entryClipSec', label: 'Entry clip timer (sec)', group: 'Exits', type: 'int', min: 0, max: 3600 },
  { key: 'entryClipPct', label: 'Entry clip line (fraction)', group: 'Exits', type: 'num', min: 0, max: 0.9, hint: '0.07 = −7%' },
  { key: 'entryClipConfirmSec', label: 'Entry clip confirm (sec)', group: 'Exits', type: 'int', min: 0, max: 3600, hint: 'breach must hold this long before the clip sells; 0 = instant' },
];

const BY_KEY = new Map(SETTINGS_SCHEMA.map(s => [s.key, s]));
export const SETTINGS_KEYS = SETTINGS_SCHEMA.map(s => s.key);
export const SETTINGS_FILE = 'settings.json';

function coerce(spec, raw) {
  if (spec.type === 'toggle') {
    if (raw === true || raw === 1 || raw === '1') return 1;
    if (raw === false || raw === 0 || raw === '0') return 0;
    return null;
  }
  const v = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
  if (!Number.isFinite(v)) return null;
  if (v < spec.min || v > spec.max) return null;
  return spec.type === 'int' ? Math.round(v) : v;
}

/** Sanitize an arbitrary object into { key: value } overlay values.
 *  Unknown keys are dropped silently (a tab can only ever move its own
 *  dials); known keys with un-coercible or out-of-range values are
 *  reported in errors and NOT applied — one bad value never blocks the
 *  good ones in the same save. */
export function sanitizeSettings(input) {
  const values = {};
  const errors = [];
  if (!input || typeof input !== 'object') return { values, errors: ['settings must be an object'] };
  for (const [k, raw] of Object.entries(input)) {
    const spec = BY_KEY.get(k);
    if (!spec) continue;
    const v = coerce(spec, raw);
    if (v == null) { errors.push(`${k}: ${JSON.stringify(raw)} is not a valid ${spec.type} in [${spec.min ?? 0}, ${spec.max ?? 1}]`); continue; }
    values[k] = v;
  }
  return { values, errors };
}

/** Apply overlay values onto a cfg object (mutates cfg). Boolean cfg
 *  fields receive real booleans. Returns the keys applied. */
export function applySettings(cfg, values) {
  const applied = [];
  for (const [k, v] of Object.entries(values || {})) {
    const spec = BY_KEY.get(k);
    if (!spec) continue;
    cfg[k] = spec.bool ? !!v : v;
    applied.push(k);
  }
  return applied;
}

/** The effective settings view for the tab: every schema key with its
 *  live value (as 0/1 for toggles), its env-boot baseline, and whether
 *  the overlay currently overrides the baseline. */
export function settingsView(cfg, baseline, overlay) {
  return SETTINGS_SCHEMA.map(spec => {
    const raw = cfg[spec.key];
    const value = spec.type === 'toggle' ? (raw ? 1 : 0) : raw;
    const baseRaw = baseline ? baseline[spec.key] : undefined;
    const envValue = spec.type === 'toggle' ? (baseRaw ? 1 : 0) : baseRaw;
    return {
      key: spec.key, label: spec.label, group: spec.group, type: spec.type,
      min: spec.min ?? null, max: spec.max ?? null, hint: spec.hint || null,
      value, envValue, overridden: !!(overlay && spec.key in overlay),
    };
  });
}

/** Read + sanitize the on-disk overlay. Never throws: a missing file is
 *  an empty overlay; a corrupt one is an empty overlay plus a log line. */
export function loadSettingsOverlay(dataDir, log = console.log) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, SETTINGS_FILE), 'utf8');
    const { values, errors } = sanitizeSettings(JSON.parse(raw));
    if (errors.length && log) log(`[settings] ignored invalid overlay values: ${errors.join('; ')}`);
    return values;
  } catch (e) {
    if (e && e.code !== 'ENOENT' && log) log(`[settings] overlay unreadable (${e.message}) — starting from env`);
    return {};
  }
}

/** Persist the full overlay (write-then-rename so a crash mid-write can
 *  never leave a torn file for the next boot). */
export function saveSettingsOverlay(dataDir, values) {
  const file = path.join(dataDir, SETTINGS_FILE);
  const tmpFile = file + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(values, null, 2));
  fs.renameSync(tmpFile, file);
}
