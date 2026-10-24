// memoryJudge.js — the memory loop's similarity judge, ported into the bot
// (phase 2, owner order 2026-10-23 21:04 EDT: "Let's fix it").
//
// WHAT THIS IS: a RECORD-ONLY shadow. On every taken entry and at every
// loss-side rule-fire moment, Bot stamps the judge's read of the situation
// — "coins that looked like this dumped / ground then ran / bled slowly" —
// onto the trade/signal record and into memory_stamps.jsonl. NOTHING in
// any entry, exit, sizing, or risk path reads these stamps. They exist so
// the phase-1 backtest (~/workspace/memory-loop) can be re-run on COMPLETE
// data and the judge can earn — or fail to earn — a vote per DOCTRINE.md.
// Kill switch: MEMORY_JUDGE=0 disables stamping entirely (default on).
//
// The maths is a faithful port of the phase-1 judge
// (~/workspace/memory-loop/src/judge.py), which itself mirrors the fleet's
// recall (median/IQR scaling, Gaussian kernel, 62-minute anti-lookahead,
// recency + importance neighbor weighting). The feature builder mirrors
// build_library.py's features_from() EXACTLY, so a live stamp and an
// offline library episode describe the same coin in the same numbers.
// The chart-shape channel is deliberately NOT blended here: the shipped
// library snapshot carries no shapes on its episodes (phase 1 could
// rebuild only 35/90), so a blend would compare against nothing. Shapes
// are persisted per signal from this build on (Journal shapeProvider),
// so the NEXT library rebuild can carry them and the blend can be
// enabled then — the same order SPEC §2 prescribes.
//
// Fail-open, always: thin memory (< 5 usable neighbors), a missing
// library, or any internal error yields verdict 'unknown' with null
// scores. The judge never guesses, and a judge fault can never disturb
// trading — every call site wraps in try/catch besides.

import fs from 'node:fs';
import path from 'node:path';

export const RESOLVE_MS = 62 * 60_000;      // fleet RESOLVE_MS: an outcome counts only once knowable
export const JUDGE_K = 25;                  // top-k neighbors (judge.py K)
export const MIN_NEIGHBORS = 5;             // below this the judge abstains (judge.py MIN_NEIGHBORS)
const HALF_LIFE_H = 48.0;

export const FEATURES = ['logMc', 'logLiq', 'logAgeMin', 'logVolM5', 'logVolH1',
  'buyRatioM5', 'buyRatioH1', 'chgM5', 'chgH1', 'chgH24',
  'logHolders', 'top10Pct', 'insiderWallets', 'linkedDrain', 'flowM5',
  'gatesFailed', 'buyVel', 'distFromPeak', 'logPeakAge', 'holderGrowth',
  'curveFill', 'chg1m', 'logPoolAge', 'gain', 'drawFromPeak', 'roundTrip'];

const isnum = (x) => typeof x === 'number' && Number.isFinite(x);
const num = (x) => (isnum(x) ? x : null);
const lg = (x) => (isnum(x) && x >= 0 ? Math.log10(1 + x) : null);   // build_library lg(): log10(1+x)
const log10 = (x) => (isnum(x) && x > 0 ? Math.log10(x) : null);
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;

// ------------------------------------------------------------------ shape
// The fleet's shapeFromSamples (k1llsw1tch-fleet/src/fingerprint.js),
// ported unchanged: the price path squashed to 16 resampled log-price
// points (relative to the last price) + a normalized volume profile,
// with slope and choppiness scalars. samples: [{ts, price, vol}]
// oldest→newest. Returns {vec, slope, vol} or null on thin samples.
export const SHAPE_POINTS = 16;

export function shapeFromSamples(samples, n = SHAPE_POINTS) {
  const s = (samples || []).filter(x => x && isnum(x.price) && x.price > 0);
  if (s.length < 4) return null;
  const t0 = s[0].ts, t1 = s[s.length - 1].ts, span = Math.max(1, t1 - t0);
  const last = s[s.length - 1].price;
  const px = [], vx = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + (span * i) / (n - 1);
    while (j < s.length - 2 && s[j + 1].ts < t) j++;
    const a = s[j], b = s[Math.min(j + 1, s.length - 1)];
    const w = b.ts === a.ts ? 0 : (t - a.ts) / (b.ts - a.ts);
    const p = a.price + (b.price - a.price) * Math.max(0, Math.min(1, w));
    px.push(Math.log(p / last));
    vx.push(isnum(a.vol) ? a.vol : 0);
  }
  const vmax = Math.max(...vx, 1e-9);
  const vn = vx.map(v => v / vmax);
  const diffs = px.slice(1).map((x, i) => x - px[i]);
  const slope = px[n - 1] - px[0];
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const std = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length);
  const vol = std * Math.sqrt(diffs.length);
  return { vec: [...px, ...vn], slope, vol };
}

// ------------------------------------------------------- feature building
// Mirror of build_library.py features_from(entry, sig): entry = the
// learn.js snapshotFeatures object; fields = the signalFields.js record;
// metrics = the signal record's metrics. Identical transforms, identical
// null discipline — unknown never masquerades as a value.
export function featuresFromSnapshot(entry, fields, metrics) {
  const e = entry || {};
  const f = fields || {};
  const m = metrics || {};
  const buys = num(e.buysM5), sells = num(e.sellsM5);
  const bH = num(e.buysH1), sH = num(e.sellsH1);
  let gatesFailed = null;
  if (e.gates && typeof e.gates === 'object') {
    const vals = Object.values(e.gates).filter(g => g && typeof g === 'object' && 'pass' in g);
    if (vals.length) gatesFailed = vals.filter(g => g.pass === false).length;
  }
  const chg24 = num(e.chgH24);
  const buyVel = num(f.buyVelPerMin) != null ? num(f.buyVelPerMin) : num(f.buyVel);
  const chg1mPct = num(f.chg1mPct);
  const gainPct = num(m.gainPct);
  return {
    logMc: log10(e.mc),
    logLiq: log10(e.liq),
    logAgeMin: lg(e.ageMin),
    logVolM5: lg(num(e.volM5) != null ? num(e.volM5) : num(m.volM5)),
    logVolH1: lg(num(e.volH1) != null ? num(e.volH1) : num(m.volH1)),
    buyRatioM5: buys != null && sells != null && buys + sells > 0 ? buys / (buys + sells) : num(m.buyRatioM5),
    buyRatioH1: bH != null && sH != null && bH + sH > 0 ? bH / (bH + sH) : null,
    chgM5: num(e.chgM5),
    chgH1: num(e.chgH1),
    chgH24: chg24 != null ? Math.max(-1.0, Math.min(10.0, chg24 / 100.0)) : null,
    logHolders: log10(e.holders),
    top10Pct: num(e.top10Pct),
    insiderWallets: num(e.insiderWallets),
    linkedDrain: num(e.linkedDrain),
    flowM5: num(e.flowM5),
    gatesFailed,
    buyVel,
    distFromPeak: num(f.distFromPeakPct),
    logPeakAge: lg(f.peakAgeSec),
    holderGrowth: num(f.holderGrowthPctPerMin),
    curveFill: num(f.curveFillPctPerMin),
    chg1m: chg1mPct != null ? chg1mPct / 100.0 : null,
    logPoolAge: lg(f.poolAgeMin),
    gain: gainPct != null ? gainPct / 100.0 : null,
    drawFromPeak: num(m.drawFromPeak),
    roundTrip: num(m.roundTrip),
  };
}

// ----------------------------------------------------------------- scaler
function quantile(sortedVals, q) {
  if (!sortedVals.length) return null;
  const i = (sortedVals.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sortedVals[i];
  return sortedVals[lo] + (sortedVals[hi] - sortedVals[lo]) * (i - lo);
}

export function fitScaler(episodes, names = FEATURES) {
  const sc = {};
  for (const k of names) {
    const vals = episodes.map(e => (e.features || {})[k]).filter(isnum).sort((a, b) => a - b);
    if (vals.length < 10) continue;
    const med = quantile(vals, 0.5);
    let iqr = quantile(vals, 0.75) - quantile(vals, 0.25);
    if (iqr <= 1e-9) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const varr = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      iqr = Math.sqrt(varr) || 1.0;
    }
    sc[k] = { med, scale: iqr };
  }
  return sc;
}

function zvector(features, scaler) {
  const z = {};
  for (const k of Object.keys(scaler)) {
    z[k] = isnum((features || {})[k]) ? (features[k] - scaler[k].med) / scaler[k].scale : null;
  }
  return z;
}

function featureSim(za, zb) {
  let numr = 0, den = 0;
  for (const k of Object.keys(za)) {
    const a = za[k], b = zb[k];
    if (a == null && b == null) continue;
    den += 1.0;
    if (a == null || b == null) { numr += 0.15; continue; }
    const d = a - b;
    numr += Math.exp(-d * d / 2);
  }
  return den ? numr / den : 0.0;
}

// ------------------------------------------------------------------ judge
export class MemoryJudge {
  constructor(episodes) {
    this.episodes = (episodes || []).filter(e => e && e.label);
    this.scaler = fitScaler(this.episodes);
    for (const e of this.episodes) e._z = zvector(e.features, this.scaler);
  }

  /** Load the shipped phase-1 library snapshot from a directory holding
   *  library_bot.jsonl + library_fleet.jsonl (+ optional library_meta.json). */
  static fromDir(dir) {
    const read = (name) => {
      try {
        return fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    };
    const bot = read('library_bot.jsonl');
    const fleet = read('library_fleet.jsonl');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'library_meta.json'), 'utf8')); } catch { /* meta is descriptive only */ }
    const judge = new MemoryJudge([...bot, ...fleet]);
    return {
      judge,
      meta: {
        version: meta.version || 'phase1-2026-10-23',
        builtTs: meta.builtTs || null,
        botEpisodes: bot.length,
        fleetEpisodes: fleet.length,
        labeled: judge.episodes.length,
      },
    };
  }

  /** The judge's read of one situation. NEVER throws: any internal fault
   *  degrades to the fail-open 'unknown' verdict. */
  judge(features, ts, { lane = null, mint = null, excludeId = null, k = JUDGE_K } = {}) {
    try {
      return this._judge(features || {}, ts, { lane, mint, excludeId, k });
    } catch {
      return { verdict: 'unknown', reason: 'judge-error', dumpRisk: null, grindScore: null, slowdownScore: null, neighbors: 0, evidence: [] };
    }
  }

  _judge(features, ts, { lane, mint, excludeId, k }) {
    const zq = zvector(features, this.scaler);
    const scored = [];
    for (const ep of this.episodes) {
      if (ep.id === excludeId) continue;
      if (ep.ts + RESOLVE_MS > ts) continue;                    // outcome not knowable yet at query time
      if (mint && ep.mint === mint && Math.abs(ep.ts - ts) < 15 * 60_000) continue;
      let sim = featureSim(zq, ep._z);
      if (ep.lane && lane && ep.lane === lane) sim = Math.min(1.0, sim + 0.05);
      const ageH = Math.max(0.0, (ts - ep.ts) / 3.6e6);
      const rec = 0.5 ** (ageH / HALF_LIFE_H);
      const score = sim * (0.8 + 0.12 * rec + 0.08 * ((ep.importance ?? 3) / 10)) * (ep.weight ?? 1.0);
      scored.push({ score, sim, ep });
    }
    scored.sort((a, b) => b.score - a.score);
    const usable = scored.slice(0, k).filter(t => t.score > 0);
    if (usable.length < MIN_NEIGHBORS) {
      return {
        verdict: 'unknown', reason: `only ${usable.length} usable neighbors (< ${MIN_NEIGHBORS})`,
        dumpRisk: null, grindScore: null, slowdownScore: null,
        neighbors: usable.length, evidence: [],
      };
    }
    const w = usable.reduce((a, t) => a + t.score, 0);
    const share = (flag) => usable.reduce((a, t) => a + (t.ep.flags && t.ep.flags[flag] ? t.score : 0), 0) / w;
    const evidence = usable.slice(0, 8).map(({ sim, ep }) => ({
      id: ep.id, symbol: ep.symbol, mint: ep.mint, ts: ep.ts, label: ep.label, sim: r3(sim),
      maxRet: ep.outcome ? ep.outcome.maxRet : null,
      minRet: ep.outcome ? ep.outcome.minRet : null,
      peakMin: ep.outcome ? ep.outcome.peakMin : null,
    }));
    return {
      verdict: 'scored',
      dumpRisk: r3(share('dump')),
      grindScore: r3(share('grind')),
      slowdownScore: r3(share('bleed')),
      runnerShare: r3(share('run')),
      popShare: r3(share('pop')),
      neighbors: usable.length,
      avgSim: r3(usable.reduce((a, t) => a + t.sim, 0) / usable.length),
      evidence,
    };
  }
}

/** The compact stamp that rides the trade/signal records (the full stamp,
 *  with evidence detail + the feature vector, lives in memory_stamps.jsonl). */
export function compactStamp(full, meta) {
  if (!full) return null;
  return {
    v: meta ? meta.version : null,
    verdict: full.verdict,
    dumpRisk: full.dumpRisk ?? null,
    grindScore: full.grindScore ?? null,
    slowdownScore: full.slowdownScore ?? null,
    neighbors: full.neighbors ?? 0,
    evidenceIds: (full.evidence || []).map(e => e.id),
  };
}

// -------------------------------------------------------- rule-fire kinds
// Loss-side exit reasons (exits.js / bot.js decision.reason prefixes) →
// stable rule names for the fire stamps. Profit-side reasons (TP1/TP2,
// TP1 guard, moonbag, trails, profit lock, kill zone) are deliberately
// ABSENT: profit protection is doctrine, never graded (SPEC §5), and the
// base-break exit was removed from the live path on 2026-10-17, so it can
// never fire to be stamped.
export function lossRuleOf(reason) {
  if (typeof reason !== 'string') return null;
  if (reason.startsWith('entry clip')) return 'entry-clip';
  if (reason.startsWith('stall exit')) return 'stall-exit';
  if (reason.startsWith('stall (') || reason.startsWith('probation expired')) return 'stall-exit';
  if (reason.startsWith('liquidity death')) return 'liquidity-death';
  if (reason.startsWith('death detector:')) return 'death-detector';
  if (reason.startsWith('dead-flow exit')) return 'dead-flow-exit';
  if (reason.startsWith('volume decay')) return 'volume-decay';
  if (reason.startsWith('time stop')) return 'time-stop';
  if (reason.startsWith('max hold')) return 'max-hold';
  if (reason.startsWith('no sell quote')) return 'no-quote';
  if (reason.startsWith('dip stop') || reason.startsWith('stop-loss')) return 'stop';
  return null;
}

// -------------------------------------------------- episode trajectory
// Compact a position's in-hold tick series ([secOffset, ratio] pairs,
// ratio = realizable value / remaining basis, as _tickJournal computes
// it) into the durable per-episode trajectory that rides the close
// record (SPEC §4(d)): the 16-point in-hold log-ratio shape (fleet
// representation, price-only — the volume profile is all zeros because
// the series is ratios, not tape) + the drawdown / underwater marks the
// hold-time grading needs. Null on an empty series — never invented.
export function compactTrajectory(traj, { underwaterMin = null } = {}) {
  if (!Array.isArray(traj) || !traj.length) return null;
  const ratios = traj.map(p => p[1]).filter(isnum);
  if (!ratios.length) return null;
  const samples = traj.filter(p => isnum(p[1]) && p[1] > 0).map(p => ({ ts: p[0] * 1000, price: p[1], vol: 0 }));
  const sh = samples.length >= 4 ? shapeFromSamples(samples) : null;
  return {
    n: traj.length,
    peakRatio: r4(Math.max(...ratios)),
    minRatio: r4(Math.min(...ratios)),
    lastRatio: r4(ratios[ratios.length - 1]),
    underwaterMin: underwaterMin != null ? Math.round(underwaterMin * 100) / 100 : null,
    shape16: sh ? sh.vec.slice(0, SHAPE_POINTS).map(r4) : null,
    slope: sh ? r4(sh.slope) : null,
    chop: sh ? r4(sh.vol) : null,
  };
}
