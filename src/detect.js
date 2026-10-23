// detect.js — pure entry detectors. No network, no clock (now is passed in), fully unit-testable.
//
//   eligible(view)  → list of reasons the coin is NOT tradable at all (empty = ok)
//   detect(view, samples, cfg, now) → null | { setup, strength, metrics }
//
// 'pop'   : price rose ≥popGainPct inside popWindowSec measured from the window LOW, is still near the
//           window high (not already dumping), isn't already absurdly extended, with real buy-side flow.
//           This is the flat→vertical move that the 30-minute-window detectors can never catch.
// 'trend' : a runner the market already ranks hot (multi-hour move + heavy volume) that is still green
//           over the last 5 minutes. Uses DexScreener's own priceChange so it works the moment a coin is
//           discovered — no warm-up history needed.
//
// SCAN EVALUATION STAMPS (user order 2026-10-16, RECORD-ONLY instrumentation):
// the detectors were pure and silent — a null left no trace of WHICH numbers
// rejected the coin, so scan-ledger sessions carried empty decisions/setups
// for everything that never fired. Each detector is now a thin wrapper over
// a leg-by-leg judge (judgePop / judgeTrend / judgeChurn / judgeLiftoff)
// that walks the SAME conditions in the SAME order and reports every leg as
// { metric, value, threshold, op } with its pass computed from the original
// expression. detect()/detectChurn()/detectLiftoff() return exactly what
// they always returned (the judge's signal when every leg passes, else
// null); judgeScan() exposes the verdicts for the ledger stamps. Nothing
// anywhere branches on a verdict — they exist to be read.

const buyRatio = (b, s) => (b + s > 0 ? b / (b + s) : null);
const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : x);

// ------------------------------------------------------------ legs + verdicts
// A leg is one judged condition: { metric, value, threshold, op, pass }.
// pass is ALWAYS computed from the detector's original expression; value /
// threshold are the stamp representation of that same comparison. A leg with
// value/threshold null is binary (a missing figure, a structural absence) —
// it has no numeric closeness, so its margin is a flat −1 when failed.
function leg(metric, value, threshold, op, pass) {
  return { metric, value, threshold, op, pass: !!pass };
}

function legMargin(l) {
  if (!l.pass && (l.value == null || l.threshold == null || l.op == null)) return -1;
  if (l.value == null || l.threshold == null || l.op == null) return 0;
  const scale = Math.abs(l.threshold) > 0 ? Math.abs(l.threshold) : 1;
  if (l.op === '>=' || l.op === '>') return (l.value - l.threshold) / scale;
  if (l.op === '<=' || l.op === '<') return (l.threshold - l.value) / scale;
  return l.pass ? 0 : -1;
}

// Stage ranks: how far through the gauntlet an evaluation got. A verdict
// stopped at the eligibility door is "less close" than one judged on the
// detector's own legs, whatever the door margin was — the legs verdict is
// the one that says what the coin's best moment actually scored.
const STAGE_RANK = { eligible: 0, window: 1, structure: 1, legs: 2 };

function makeVerdict(setup, stage, legs, failReason, signal = null) {
  const fails = legs.filter(l => !l.pass);
  const margin = legs.length ? r4(Math.min(...legs.map(legMargin))) : -1;
  return {
    setup, evaluated: true, passed: fails.length === 0, stage,
    legs, fails: fails.map(({ metric, value, threshold, op }) => ({ metric, value, threshold, op })),
    failReason: fails.length ? failReason : null,
    margin, signal,
  };
}

function eligibleVerdict(setup, eligFails) {
  const legs = eligFails.map(c => leg(c.metric, c.value, c.threshold, c.op, false));
  return makeVerdict(setup, 'eligible', legs, eligFails[0].reason);
}

function disabledVerdict(setup, reason) {
  return { setup, evaluated: false, passed: false, stage: null, legs: [], fails: [], failReason: null, margin: null, signal: null, reason };
}

/** Which of two verdicts is the better stamp for a session: a pass beats
 *  everything; an evaluated verdict beats an unevaluated one; then the
 *  further stage; then the tighter (higher) bottleneck margin. Ties keep
 *  the incumbent (the earlier evaluation). */
export function betterScanVerdict(cur, nxt) {
  if (!cur) return nxt;
  if (!nxt) return cur;
  if (nxt.passed && !cur.passed) return nxt;
  if (cur.passed) return cur;
  if (nxt.evaluated && !cur.evaluated) return nxt;
  if (!nxt.evaluated) return cur;
  const rs = (STAGE_RANK[nxt.stage] ?? 0) - (STAGE_RANK[cur.stage] ?? 0);
  if (rs !== 0) return rs > 0 ? nxt : cur;
  return (nxt.margin ?? -Infinity) > (cur.margin ?? -Infinity) ? nxt : cur;
}

/** The session's closest call: the setup that came nearest to firing.
 *  A passed verdict outranks every failure (the detector DID fire its side
 *  — if the session still shows signaled:false, the drop happened
 *  downstream: cooldown or the per-tick candidate slice). */
export function closestCall(verdicts) {
  if (!verdicts) return null;
  const entries = Object.entries(verdicts).filter(([, v]) => v);
  const passed = entries.find(([, v]) => v.passed);
  if (passed) return { setup: passed[0], passed: true, margin: passed[1].margin };
  const judged = entries.filter(([, v]) => v.evaluated);
  if (!judged.length) return null;
  let [bestSetup, best] = judged[0];
  for (const [setup, v] of judged.slice(1)) {
    if (betterScanVerdict(best, v) === v) { best = v; bestSetup = setup; }
  }
  return { setup: bestSetup, passed: false, stage: best.stage, margin: best.margin, failReason: best.failReason };
}

// ------------------------------------------------------------ eligibility
// The tradability floor, as structured checks. eligible() below is these
// checks' reason strings — the strings are the live contract (they surface
// in gate output), so they are built here once, verbatim.
export function eligibleChecks(v, cfg, now = Date.now()) {
  const out = [];
  const add = (metric, value, threshold, op, reason) => out.push({ metric, value, threshold, op, reason });
  if (!v || !(v.price > 0)) { add('price', v ? (v.price ?? null) : null, 0, '>', 'no price'); return out; }
  if (!(v.mc > 0)) add('mc', v.mc ?? null, 0, '>', 'no market cap');
  else {
    if (v.mc < cfg.minMc) add('mc', v.mc, cfg.minMc, '>=', `mc $${Math.round(v.mc)} < $${cfg.minMc}`);
    if (v.mc > cfg.maxMc) add('mc', v.mc, cfg.maxMc, '<=', `mc $${Math.round(v.mc)} > $${cfg.maxMc}`);
  }
  if (v.liq < cfg.minLiqUsd) add('liq', v.liq ?? null, cfg.minLiqUsd, '>=', `liq $${Math.round(v.liq)} < $${cfg.minLiqUsd}`);
  if (v.mc > 0 && v.liq / v.mc < cfg.minLiqToMc) add('liqToMc', r4(v.liq / v.mc), cfg.minLiqToMc, '>=', `liq is ${((v.liq / v.mc) * 100).toFixed(1)}% of mc < ${(cfg.minLiqToMc * 100).toFixed(0)}%`);
  // Fresh pools (just graduated from pump.fun / just launched): early holders dump into the first buyers.
  // Negative age (clock skew) is ignored rather than treated as young.
  if (cfg.minPairAgeMin > 0 && v.createdAt) {
    const ageMin = (now - v.createdAt) / 60000;
    if (ageMin >= 0 && ageMin < cfg.minPairAgeMin) add('pairAgeMin', r1(ageMin), cfg.minPairAgeMin, '>=', `pool only ${ageMin.toFixed(0)}m old < ${cfg.minPairAgeMin}m`);
  }
  // Don't buy dead coins bouncing: if it's down 50%+ in the last hour, it's a dump, not an opportunity
  if (v.chgH1 != null && v.chgH1 <= -50) add('chgH1', v.chgH1, -50, '>', `down ${Math.round(v.chgH1)}% in 1h — dead bounce`);
  return out;
}

export function eligible(v, cfg, now = Date.now()) {
  return eligibleChecks(v, cfg, now).map(c => c.reason);
}

// LIQ RE-CHECK family (owner order 2026-10-17): the eligibility legs that
// judge the liquidity READ itself — absolute depth ('liq') and depth
// against cap ('liqToMc'). On a seconds-old curve coin the view routinely
// prints liq $0 / missing for a pool that exists: a broken read, not a
// quality judgment. Bot defers a skip whose ONLY failures are these legs
// and re-reads (see bot.js _queueLiqRecheck). Every other leg (price, mc,
// pair age, dead bounce) is a real judgment and never defers.
export const LIQ_CHECK_METRICS = new Set(['liq', 'liqToMc']);
export function liqFamilyChecks(checks) {
  return (checks || []).filter(c => LIQ_CHECK_METRICS.has(c.metric));
}

// B3 wash reject (shared pop/trend leg): a small cap whose hourly volume is a
// multiple of its whole market cap is being churned, not accumulated (Urara:
// $71k volH1 on a $15.6k cap). Null when the rule doesn't apply (knob off, or
// the cap is at/above the "small" line) — an inapplicable leg is not a fail.
function washLeg(v, cfg) {
  if (!(cfg.trendMaxVolToMc > 0 && v.mc > 0 && v.mc < cfg.freshSmallMc)) return null;
  return leg('volH1ToMc', r2(v.volH1 / v.mc), cfg.trendMaxVolToMc, '<=', !(v.volH1 > cfg.trendMaxVolToMc * v.mc));
}

// ------------------------------------------------------------ POP judge
function judgePop(v, samples, cfg, now, eligFails) {
  if (eligFails.length) return eligibleVerdict('pop', eligFails);
  const ratio5 = buyRatio(v.buysM5, v.sellsM5);
  const win = (samples || []).filter(s => now - s.ts <= cfg.popWindowSec * 1000);
  if (win.length < 3) {
    return makeVerdict('pop', 'window',
      [leg('windowSamples', win.length, 3, '>=', false)],
      `only ${win.length} sample(s) inside the ${cfg.popWindowSec}s pop window — need 3 spanning 45s+`);
  }
  const spanSec = (win[win.length - 1].ts - win[0].ts) / 1000;
  if (spanSec * 1000 < 45000) {
    return makeVerdict('pop', 'window',
      [leg('windowSpanSec', r1(spanSec), 45, '>=', false)],
      `pop window spans only ${r1(spanSec)}s — need 45s+ of sampled move`);
  }
  const last = win[win.length - 1].price;
  const low = Math.min(...win.map(s => s.price));
  const high = Math.max(...win.map(s => s.price));
  const gain = (last / low - 1) * 100;
  const draw = high > 0 ? (high - last) / high : 0;
  // the 5-minute window can't tell a breakout from a bounce off a crash, so also look at the last hour
  const hourHigh = Math.max(...(samples || []).filter(s => now - s.ts <= 3600000).map(s => s.price), last);
  const legs = [];
  const reasons = [];
  const add = (l, reason) => { legs.push(l); if (!l.pass) reasons.push(reason); };
  add(leg('gainPct', r1(gain), cfg.popGainPct, '>=', gain >= cfg.popGainPct),
    `window gain +${r1(gain)}% under the +${cfg.popGainPct}% pop floor`);
  add(leg('gainPct', r1(gain), cfg.popMaxGainPct, '<=', gain <= cfg.popMaxGainPct),
    `window gain +${r1(gain)}% over the +${cfg.popMaxGainPct}% chase cap — already ran too far inside the window`);
  add(leg('drawFromPeak', r3(draw), cfg.maxDrawFromPeak, '<=', draw <= cfg.maxDrawFromPeak),
    `price is ${r1(draw * 100)}% off the window high — over the ${r1(cfg.maxDrawFromPeak * 100)}% draw cap`);
  if (cfg.popMaxDropH6 > 0 && v.chgH6 != null) {
    add(leg('chgH6', v.chgH6, -cfg.popMaxDropH6, '>', !(v.chgH6 <= -cfg.popMaxDropH6)),
      `down ${v.chgH6}% over 6h — crash tape under the pop`);
  }
  if (v.chgH1 == null) {
    add(leg('chgH1', null, cfg.popMinChgH1, '>=', false),
      'no hourly change figure — the bounce check cannot pass');
  } else {
    add(leg('chgH1', v.chgH1, cfg.popMinChgH1, '>=', v.chgH1 >= cfg.popMinChgH1),
      `hourly change ${v.chgH1}% under the ${cfg.popMinChgH1}% pop floor — bounce territory`);
  }
  add(leg('pctBelowHourHigh', r1((1 - last / hourHigh) * 100), r1(cfg.popMaxBelowHigh * 100), '<=', last >= hourHigh * (1 - cfg.popMaxBelowHigh)),
    `price sits ${r1((1 - last / hourHigh) * 100)}% under its 1h high — over the ${r1(cfg.popMaxBelowHigh * 100)}% bounce line`);
  const wash = washLeg(v, cfg);
  if (wash) add(wash, `hourly volume is ${r2(v.volH1 / v.mc)}x the whole market cap — wash churn, not demand`);
  add(leg('volM5', v.volM5 ?? null, cfg.popMinVolM5, '>=', v.volM5 >= cfg.popMinVolM5),
    `5m volume $${Math.round(v.volM5 || 0)} under the $${cfg.popMinVolM5} pop floor`);
  add(leg('buysM5', v.buysM5 ?? null, cfg.popMinBuysM5, '>=', v.buysM5 >= cfg.popMinBuysM5),
    `only ${v.buysM5 ?? 0} buys in 5m — under the ${cfg.popMinBuysM5} pop floor`);
  if (ratio5 == null) {
    add(leg('buyRatioM5', null, cfg.minBuyRatioM5, '>=', false),
      'no 5m trades — no buy ratio to judge');
  } else {
    add(leg('buyRatioM5', r3(ratio5), cfg.minBuyRatioM5, '>=', ratio5 >= cfg.minBuyRatioM5),
      `buy ratio ${r2(ratio5)} under the ${cfg.minBuyRatioM5} pop floor`);
    if (cfg.maxBuyRatioM5 > 0) {
      add(leg('buyRatioM5', r3(ratio5), cfg.maxBuyRatioM5, '<', ratio5 < cfg.maxBuyRatioM5),
        `buy ratio ${r2(ratio5)} at/over the ${cfg.maxBuyRatioM5} cap — one bundled buyer, not a crowd`);
    }
  }
  const passed = legs.every(l => l.pass);
  const signal = passed ? { setup: 'pop', strength: gain, metrics: { gainPct: +gain.toFixed(1), drawFromPeak: +draw.toFixed(3), buyRatioM5: +ratio5.toFixed(2), volH1: v.volH1, volM5: v.volM5 } } : null;
  return makeVerdict('pop', 'legs', legs, reasons[0], signal);
}

// ------------------------------------------------------------ TREND judge
function judgeTrend(v, samples, cfg, now, eligFails) {
  if (!cfg.trendEnabled) return disabledVerdict('trend', 'trend detector is disabled (TREND_ENABLED=0)');
  if (eligFails.length) return eligibleVerdict('trend', eligFails);
  const ratio5 = buyRatio(v.buysM5, v.sellsM5);
  const legs = [];
  const reasons = [];
  const add = (l, reason) => { legs.push(l); if (!l.pass) reasons.push(reason); };
  // B2: the whole hour must be buy-dominated (a 0.75 ratio from 14 trades is not demand),
  // and the 5m window must hold enough trades for any ratio to mean anything.
  const ratioH1 = buyRatio(v.buysH1, v.sellsH1);
  if (v.chgH1 == null) add(leg('chgH1', null, cfg.trendMinH1, '>=', false), 'no hourly change figure — trend cannot be judged');
  else {
    add(leg('chgH1', v.chgH1, cfg.trendMinH1, '>=', v.chgH1 >= cfg.trendMinH1),
      `hourly change ${v.chgH1}% under the ${cfg.trendMinH1}% trend floor`);
    add(leg('chgH1', v.chgH1, cfg.trendMaxH1, '<=', v.chgH1 <= cfg.trendMaxH1),
      `hourly change ${v.chgH1}% over the ${cfg.trendMaxH1}% trend cap — too extended`);
  }
  if (v.chgM5 == null) add(leg('chgM5', null, cfg.trendMinM5, '>=', false), 'no 5m change figure — trend cannot be judged');
  else add(leg('chgM5', v.chgM5, cfg.trendMinM5, '>=', v.chgM5 >= cfg.trendMinM5),
    `5m change ${v.chgM5}% under the ${cfg.trendMinM5}% trend floor — not green right now`);
  // Volume freshness (user 2026-10-14, UNTXED): the runner must still be trading
  // heavily right now; missing volume = not fresh.
  if (cfg.trendFreshMinVolM5 > 0) {
    add(leg('volM5', v.volM5 ?? null, cfg.trendFreshMinVolM5, '>=', (v.volM5 || 0) >= cfg.trendFreshMinVolM5),
      `5m volume $${Math.round(v.volM5 || 0)} under the $${cfg.trendFreshMinVolM5} freshness floor — the move is not trading now`);
  }
  add(leg('volH1', v.volH1 ?? null, cfg.trendMinVolH1, '>=', v.volH1 >= cfg.trendMinVolH1),
    `hourly volume $${Math.round(v.volH1 || 0)} under the $${cfg.trendMinVolH1} trend floor`);
  add(leg('buysM5', v.buysM5 ?? null, cfg.trendMinBuysM5, '>=', v.buysM5 >= cfg.trendMinBuysM5),
    `only ${v.buysM5 ?? 0} buys in 5m — under the ${cfg.trendMinBuysM5} trend floor`);
  if (ratio5 == null) {
    add(leg('buyRatioM5', null, cfg.trendMinBuyRatio, '>=', false), 'no 5m trades — no buy ratio to judge');
  } else {
    add(leg('buyRatioM5', r3(ratio5), cfg.trendMinBuyRatio, '>=', ratio5 >= cfg.trendMinBuyRatio),
      `buy ratio ${r2(ratio5)} under the ${cfg.trendMinBuyRatio} trend floor`);
    if (cfg.maxBuyRatioM5 > 0) {
      add(leg('buyRatioM5', r3(ratio5), cfg.maxBuyRatioM5, '<', ratio5 < cfg.maxBuyRatioM5),
        `buy ratio ${r2(ratio5)} at/over the ${cfg.maxBuyRatioM5} cap — one bundled buyer, not a crowd`);
    }
  }
  if (cfg.trendMinMc > 0) {
    add(leg('mc', v.mc ?? null, cfg.trendMinMc, '>=', !(v.mc < cfg.trendMinMc)),
      `market cap $${Math.round(v.mc || 0)} under the $${cfg.trendMinMc} trend floor`);
  }
  if (cfg.trendMinBuyRatioH1 > 0) {
    if (ratioH1 == null) add(leg('buyRatioH1', null, cfg.trendMinBuyRatioH1, '>=', false), 'no hourly trades — the hour cannot be judged buy-dominated');
    else add(leg('buyRatioH1', r3(ratioH1), cfg.trendMinBuyRatioH1, '>=', ratioH1 >= cfg.trendMinBuyRatioH1),
      `hourly buy ratio ${r2(ratioH1)} under ${cfg.trendMinBuyRatioH1} — the hour is not buy-dominated`);
  }
  if (cfg.trendMinTxnsM5 > 0) {
    const tx = (v.buysM5 || 0) + (v.sellsM5 || 0);
    add(leg('txnsM5', tx, cfg.trendMinTxnsM5, '>=', tx >= cfg.trendMinTxnsM5),
      `only ${tx} trades in 5m — under the ${cfg.trendMinTxnsM5} needed for the ratio to mean anything`);
  }
  const wash = washLeg(v, cfg);
  if (wash) add(wash, `hourly volume is ${r2(v.volH1 / v.mc)}x the whole market cap — wash churn, not demand`);
  // B5: dead-coin revival — an old pool suddenly up huge over 6h is a zombie pump, not a runner.
  const ageD = v.createdAt ? (now - v.createdAt) / 86400000 : 0;
  if (cfg.revivalMinAgeD > 0 && ageD >= cfg.revivalMinAgeD && v.chgH6 != null) {
    add(leg('chgH6', v.chgH6, cfg.revivalMaxChgH6, '<', v.chgH6 < cfg.revivalMaxChgH6),
      `pool is ${r1(ageD)}d old and up ${v.chgH6}% in 6h — dead-coin revival, not a runner`);
  }
  // don't buy a coin that already rolled over from a recent high
  const recent = (samples || []).filter(s => now - s.ts <= 15 * 60 * 1000);
  const high = recent.length ? Math.max(...recent.map(s => s.price)) : v.price;
  add(leg('pctOfRecentHigh', high > 0 ? r1(v.price / high * 100) : null, 85, '>=', v.price >= high * 0.85),
    `price is ${high > 0 ? r1(v.price / high * 100) : '?'}% of its 15m high — already rolled over`);
  const passed = legs.every(l => l.pass);
  const signal = passed ? { setup: 'trend', strength: v.chgH1 / 10, metrics: { chgH1: v.chgH1, chgM5: v.chgM5, buyRatioM5: +ratio5.toFixed(2), volH1: v.volH1 } } : null;
  return makeVerdict('trend', 'legs', legs, reasons[0], signal);
}

export function detect(v, samples, cfg, now) {
  const eligFails = eligibleChecks(v, cfg, now);
  if (eligFails.length) return null;
  const pop = judgePop(v, samples, cfg, now, []);
  if (pop.passed) return pop.signal;
  // PAUSED by default (B1, user 2026-10-13): tonight's trend went 0-for-9 (−0.091) while pop
  // produced the day's wins. TREND_ENABLED=1 revives it — with the B2–B5 guards below standing.
  if (cfg.trendEnabled) {
    const trend = judgeTrend(v, samples, cfg, now, []);
    if (trend.passed) return trend.signal;
  }
  return null;
}

// ---- CHURN (dumped coin basing at its lows, user 2026-10-14) ----
// The Vwhale shape: a coin dumped hard, then sat at its lows while trade COUNT stayed
// hot (~180 tx/5m of two-way flow at support) — accumulation before any pop. Pop never
// fired: its buy ratio sat ~0.50 the whole recovery and price hadn't moved yet. This
// detector reads the bot's own samples and asks the opposite question of pop: not "did
// it just move?" but "did it stop falling while people kept trading it?"
//   dropped ≥ churnMinDropPct from the sampled peak to an ESTABLISHED low (set before
//   the stable window), no (materially) new low inside churnStableMin, current price
//   within churnLowBandPct of that low, the trailing-5m trade count sustained at/above
//   churnMinTxM5 across the last 3 samples, buy share ≥ churnMinBuyShare (two-way, not
//   a stampede out), and average trade size ≥ churnMinAvgUsd — the avg floor sits above
//   the botflow/dust hard-gate floors so wash churn can't qualify by construction.
function judgeChurn(v, samples, cfg, now, eligFails) {
  if (!cfg.churnEnabled) return disabledVerdict('churn', 'churn detector is disabled (CHURN_ENABLED=0)');
  if (eligFails.length) return eligibleVerdict('churn', eligFails);
  const a = (samples || []).filter(s => s && s.price > 0);
  if (a.length < 4) {
    return makeVerdict('churn', 'structure',
      [leg('samples', a.length, 4, '>=', false)],
      `only ${a.length} usable sample(s) — too few to judge a basing pattern`);
  }
  const last = a[a.length - 1];

  let peak = 0, peakTs = 0;
  for (const s of a) if (s.price > peak) { peak = s.price; peakTs = s.ts; }
  if (!(peak > 0)) return makeVerdict('churn', 'structure', [], 'no positive sampled price — nothing to judge');

  // The low must be ESTABLISHED: set before the stable window, and not materially
  // undercut inside it. A low printed minutes ago means it's still falling.
  const cutoff = now - cfg.churnStableMin * 60000;
  const before = a.filter(s => s.ts <= cutoff);
  if (!before.length) {
    return makeVerdict('churn', 'structure',
      [leg('preStableSamples', 0, 1, '>=', false)],
      `no samples older than the ${cfg.churnStableMin}m stable window — no established low yet`);
  }
  let low = Infinity, lowTs = 0;
  for (const s of before) if (s.price < low) { low = s.price; lowTs = s.ts; }
  if (!(low > 0) || peakTs > lowTs) { // the drop must run peak → low, in that order
    return makeVerdict('churn', 'structure',
      [leg('dropOrder', null, null, null, false)],
      'the sampled peak printed after the low — not a dump-then-base shape');
  }
  const recent = a.filter(s => s.ts > cutoff);
  if (!recent.length) {
    return makeVerdict('churn', 'structure',
      [leg('stableWindowSamples', 0, 1, '>=', false)],
      'no samples inside the stable window — the base cannot be confirmed');
  }
  const recentLow = Math.min(...recent.map(s => s.price));
  const dropPct = (peak - low) / peak * 100;
  const legs = [];
  const reasons = [];
  const add = (l, reason) => { legs.push(l); if (!l.pass) reasons.push(reason); };
  add(leg('recentLowVsLow', r4(recentLow / low), 0.999, '>=', !(recentLow < low * 0.999)),
    'a new low printed inside the stable window — still falling, not basing');
  add(leg('dropPct', r1(dropPct), cfg.churnMinDropPct, '>=', dropPct >= cfg.churnMinDropPct),
    `peak-to-low drop is only ${r1(dropPct)}% — under the ${cfg.churnMinDropPct}% "dumped" line`);
  add(leg('pctAboveLow', r1((last.price / low - 1) * 100), cfg.churnLowBandPct, '<=', last.price <= low * (1 + cfg.churnLowBandPct / 100)),
    `price is ${r1((last.price / low - 1) * 100)}% above the low — outside the ${cfg.churnLowBandPct}% basing band (recovering away or gone)`);
  // Sustained count: each of the last 3 samples carries a hot trailing-5m count
  // (rolling snapshots — sustained elevation is the intent, not disjoint windows).
  const last3 = a.slice(-3);
  const minTx3 = Math.min(...last3.map(s => (s.buysM5 || 0) + (s.sellsM5 || 0)));
  add(leg('txM5Min3', minTx3, cfg.churnMinTxM5, '>=', last3.every(s => (s.buysM5 || 0) + (s.sellsM5 || 0) >= cfg.churnMinTxM5)),
    `trailing-5m trade count dips to ${minTx3} across the last 3 samples — under the sustained ${cfg.churnMinTxM5}`);
  const tx = (last.buysM5 || 0) + (last.sellsM5 || 0);
  if (tx <= 0) {
    add(leg('txM5', 0, 1, '>=', false), 'no trades in the latest 5m window at all');
    return makeVerdict('churn', 'legs', legs, reasons[0]);
  }
  const share = (last.buysM5 || 0) / tx;
  add(leg('buyShare', r3(share), cfg.churnMinBuyShare, '>=', share >= cfg.churnMinBuyShare),
    `buy share ${r2(share)} under ${cfg.churnMinBuyShare} — an exit stampede, not two-way accumulation`);
  const avgUsd = (last.volM5 || 0) / tx;
  add(leg('avgTradeUsd', r2(avgUsd), cfg.churnMinAvgUsd, '>=', avgUsd >= cfg.churnMinAvgUsd),
    `average trade $${r2(avgUsd)} under the $${cfg.churnMinAvgUsd} floor — dust/wash-sized flow`);
  const passed = legs.every(l => l.pass);
  let signal = null;
  if (passed) {
    const lowAgeMin = (now - lowTs) / 60000;
    const metrics = { dropPct: +dropPct.toFixed(1), txM5: tx, buyShare: +share.toFixed(2), avgUsd: +avgUsd.toFixed(2), lowAgeMin: +lowAgeMin.toFixed(1) };
    signal = {
      setup: 'churn',
      strength: dropPct,
      metrics,
      label: `churn: -${Math.round(dropPct)}% off peak, basing ${Math.round(lowAgeMin)}m, ${tx} tx/5m, share ${share.toFixed(2)}`,
    };
  }
  return makeVerdict('churn', 'legs', legs, reasons[0], signal);
}

export function detectChurn(v, samples, cfg, now) {
  if (!cfg.churnEnabled) return null;
  const j = judgeChurn(v, samples, cfg, now, eligibleChecks(v, cfg, now));
  return j.passed ? j.signal : null;
}

// ---- LIFTOFF (coin lifting off a flat base, user 2026-10-14) ----
// The BEGINNING of an uptrend, not the move after it ran. UNTXED and CODE ground up
// for an hour (+121% / +73% on the hour in ~+1.5% price steps): pop waits for a
// vertical burst and trend's freshness is volume-based but its gain is hourly, so
// the first leg of a grind belonged to nobody. This detector reads the bot's own
// samples for that first leg: a tight flat BASE, then a stepped climb off it with
// rising lows, building buy pressure and picking-up trade activity — fired while
// the price is still within liftoffMaxGainPct of the base low (early by
// construction; beyond that band pop/trend own the coin). Churn is the sibling:
// it fires at the lows BEFORE any move, liftoff fires on the first confirmed leg up.
//   windows (all inside the last liftoffLookbackMin): base = samples older than
//   liftoffClimbMin; climb = the last liftoffClimbMin. Base range (high−low)/low
//   must be ≤ liftoffBaseRangePct; current price must sit between liftoffMinGainPct
//   and liftoffMaxGainPct above the base low; the climb's lows must rise (below);
//   the latest view's 5m buy share must be ≥ liftoffMinBuyShare; and the climb
//   window's average per-sample trade count (buysM5+sellsM5 snapshots — the same
//   fields churn reads) must be ≥ liftoffTxnBoost × the base window's average.
//   The latest view's 5m volume must also clear liftoffMinVolM5: trade COUNT
//   alone lets a dozen dust trades fake a crowd (user 2026-10-14 — STUDIO
//   fired on ~$543 of 5m volume), so the twitch needs dollars behind it too.
function judgeLiftoff(v, samples, cfg, now, eligFails) {
  if (!cfg.liftoffEnabled) return disabledVerdict('liftoff', 'liftoff detector is disabled (LIFTOFF_ENABLED=0)');
  if (eligFails.length) return eligibleVerdict('liftoff', eligFails);
  const a = (samples || []).filter(s => s && s.price > 0);
  if (a.length < 6) {
    return makeVerdict('liftoff', 'structure',
      [leg('samples', a.length, 6, '>=', false)],
      `only ${a.length} usable sample(s) — too few to judge a base`);
  }
  const last = a[a.length - 1];

  const look = a.filter(s => now - s.ts <= cfg.liftoffLookbackMin * 60000);
  if (look.length < 6) {
    return makeVerdict('liftoff', 'structure',
      [leg('lookbackSamples', look.length, 6, '>=', false)],
      `only ${look.length} sample(s) inside the ${cfg.liftoffLookbackMin}m lookback — no base to judge`);
  }
  // Not enough sampled history to call anything a "base" (fail closed, like the
  // fresh-history guard: thin history lies).
  if (last.ts - look[0].ts < cfg.liftoffMinHistoryMin * 60000) {
    return makeVerdict('liftoff', 'structure',
      [leg('historyMin', r1((last.ts - look[0].ts) / 60000), cfg.liftoffMinHistoryMin, '>=', false)],
      `sampled history spans only ${r1((last.ts - look[0].ts) / 60000)}m — under the ${cfg.liftoffMinHistoryMin}m needed before a base can be judged`);
  }
  const climbStart = now - cfg.liftoffClimbMin * 60000;
  const base = look.filter(s => s.ts < climbStart);
  const climb = look.filter(s => s.ts >= climbStart);
  if (base.length < 3 || climb.length < 3) {
    const l = base.length < 3
      ? leg('baseSamples', base.length, 3, '>=', false)
      : leg('climbSamples', climb.length, 3, '>=', false);
    return makeVerdict('liftoff', 'structure', [l],
      base.length < 3 ? `only ${base.length} base sample(s) — need 3` : `only ${climb.length} climb sample(s) — need 3`);
  }

  // BASE: the pre-climb range must be tight — sideways, not a slow bleed or a ramp.
  let baseLow = Infinity, baseHigh = 0;
  for (const s of base) { if (s.price < baseLow) baseLow = s.price; if (s.price > baseHigh) baseHigh = s.price; }
  if (!(baseLow > 0)) return makeVerdict('liftoff', 'structure', [], 'no positive base price — nothing to judge');
  const baseRangePct = (baseHigh - baseLow) / baseLow * 100;

  // CLIMB: off the base low, but still early.
  const gainPct = (last.price / baseLow - 1) * 100;

  // RISING STRUCTURE: the climb window is split into 3 consecutive equal time
  // chunks; each chunk's minimum price must be >= the previous chunk's minimum,
  // allowing a 0.5% tolerance for print noise (chunkMin[i+1] >= chunkMin[i] * 0.995).
  // A single wick up fails here — its later chunks dip back to the earlier lows —
  // even when the net gain passes. An empty chunk can't be judged: fail closed.
  const third = (cfg.liftoffClimbMin * 60000) / 3;
  const chunkMin = [Infinity, Infinity, Infinity];
  for (const s of climb) {
    const i = Math.min(2, Math.floor((s.ts - climbStart) / third));
    if (s.price < chunkMin[i]) chunkMin[i] = s.price;
  }
  const legs = [];
  const reasons = [];
  const add = (l, reason) => { legs.push(l); if (!l.pass) reasons.push(reason); };
  add(leg('baseRangePct', r1(baseRangePct), cfg.liftoffBaseRangePct, '<=', baseRangePct <= cfg.liftoffBaseRangePct),
    `base range is ${r1(baseRangePct)}% — over the ${cfg.liftoffBaseRangePct}% "flat base" line (a bleed or a ramp, not a base)`);
  add(leg('gainPct', r1(gainPct), cfg.liftoffMinGainPct, '>=', gainPct >= cfg.liftoffMinGainPct),
    `climb is only +${r1(gainPct)}% off the base low — under the +${cfg.liftoffMinGainPct}% liftoff line`);
  add(leg('gainPct', r1(gainPct), cfg.liftoffMaxGainPct, '<=', gainPct <= cfg.liftoffMaxGainPct),
    `climb is already +${r1(gainPct)}% off the base low — past the +${cfg.liftoffMaxGainPct}% early band (pop/trend territory)`);
  if (chunkMin.some(m => !isFinite(m))) {
    add(leg('climbChunks', null, 3, '>=', false), 'a third of the climb window has no samples — rising structure cannot be judged');
  } else {
    const TOL = 0.005;
    const worstRatio = Math.min(chunkMin[1] / chunkMin[0], chunkMin[2] / chunkMin[1]);
    add(leg('chunkMinRatio', r4(worstRatio), 1 - TOL, '>=', chunkMin[1] >= chunkMin[0] * (1 - TOL) && chunkMin[2] >= chunkMin[1] * (1 - TOL)),
      'climb lows are not rising — a wick, not a stepped climb');
  }

  // BUY PRESSURE: the latest view's trailing-5m buy share.
  const ratio5 = buyRatio(v.buysM5 || 0, v.sellsM5 || 0);
  if (ratio5 == null) add(leg('buyRatioM5', null, cfg.liftoffMinBuyShare, '>=', false), 'no 5m trades — no buy pressure to judge');
  else add(leg('buyRatioM5', r3(ratio5), cfg.liftoffMinBuyShare, '>=', ratio5 >= cfg.liftoffMinBuyShare),
    `buy share ${r2(ratio5)} under the ${cfg.liftoffMinBuyShare} liftoff floor`);

  // DOLLAR VOLUME (user 2026-10-14): the twitch must carry real money — the
  // legs above count trades, and a dozen dust trades pass them (STUDIO fired
  // on ~$543 of 5m volume). Same shape as trend's volume-freshness leg:
  // missing volume does not clear the floor.
  if (cfg.liftoffMinVolM5 > 0) {
    add(leg('volM5', v.volM5 ?? null, cfg.liftoffMinVolM5, '>=', (v.volM5 || 0) >= cfg.liftoffMinVolM5),
      `5m volume $${Math.round(v.volM5 || 0)} under the $${cfg.liftoffMinVolM5} liftoff floor — no crowd behind the twitch`);
  }

  // ACTIVITY PICKUP: the climb must be trading harder than the base did.
  const txAvg = (arr) => arr.reduce((acc, s) => acc + (s.buysM5 || 0) + (s.sellsM5 || 0), 0) / arr.length;
  const baseTx = txAvg(base), climbTx = txAvg(climb);
  if (!(baseTx > 0)) {
    add(leg('txnBoost', null, cfg.liftoffTxnBoost, '>=', false), 'the base window shows no trades — no activity baseline to boost from');
  } else {
    add(leg('txnBoost', r2(climbTx / baseTx), cfg.liftoffTxnBoost, '>=', climbTx >= cfg.liftoffTxnBoost * baseTx),
      `climb activity is ${r2(climbTx / baseTx)}x the base — under the ${cfg.liftoffTxnBoost}x pickup line`);
  }

  const passed = legs.every(l => l.pass);
  let signal = null;
  if (passed) {
    const baseMin = Math.round((base[base.length - 1].ts - base[0].ts) / 60000);
    const metrics = { gainPct: +gainPct.toFixed(1), baseRangePct: +baseRangePct.toFixed(1), buyRatioM5: +ratio5.toFixed(2), volM5: v.volM5, txnBoost: +(climbTx / baseTx).toFixed(2), baseMin };
    signal = {
      setup: 'liftoff',
      // Strength is the gain off the base low itself (10–35 by construction) — the
      // same scale as pop's window gain, so a liftoff roughly ties a weak pop and
      // never outranks a strong one when candidates compete for the per-tick slots.
      // It is the earliest, softest signal by design.
      strength: gainPct,
      metrics,
      label: `liftoff: +${Math.round(gainPct)}% off ${baseMin}m base, ratio ${ratio5.toFixed(2)}`,
    };
  }
  return makeVerdict('liftoff', 'legs', legs, reasons[0], signal);
}

export function detectLiftoff(v, samples, cfg, now) {
  if (!cfg.liftoffEnabled) return null;
  const j = judgeLiftoff(v, samples, cfg, now, eligibleChecks(v, cfg, now));
  return j.passed ? j.signal : null;
}

// ------------------------------------------------------------ scan stamps
/** Stamp-shaped verdicts for all four scan detectors at one evaluation —
 *  the signal is stripped (the ledger records verdicts, not candidates).
 *  Pure: the same (view, samples, cfg, now) the poll loop just judged. */
export function judgeScan(v, samples, cfg, now) {
  const eligFails = eligibleChecks(v, cfg, now);
  const strip = (j) => ({
    evaluated: j.evaluated, passed: j.passed, stage: j.stage,
    fails: j.fails, failReason: j.failReason, margin: j.margin,
    ...(j.evaluated ? {} : { reason: j.reason }),
  });
  return {
    pop: strip(judgePop(v, samples, cfg, now, eligFails)),
    trend: strip(judgeTrend(v, samples, cfg, now, eligFails)),
    churn: strip(judgeChurn(v, samples, cfg, now, eligFails)),
    liftoff: strip(judgeLiftoff(v, samples, cfg, now, eligFails)),
  };
}

// ---- FAST POP (live trade stream) ----
// Samples are individual stream trades: { ts, price, sol, side: 'buy'|'sell' } with
// price in SOL per token as printed by the trade itself. Judged over a short rolling
// window (default 90s): a real move must be big from the window low, still printing
// (recent trades), buy-dominated in LIVE flow (not a trailing average), and not
// already rolling over from the window peak. Returns the same signal shape as the
// classic pop so the whole downstream pipeline (gates, risk, journal) is shared.
export function fastPop(samples, cfg, now) {
  const win = (samples || []).filter(s => now - s.ts <= cfg.fastPopWindowSec * 1000 && s.price > 0);
  if (win.length < cfg.fastPopMinTrades) return null;
  const last = win[win.length - 1];
  if (now - last.ts > cfg.fastPopRecentSec * 1000) return null; // the stream went quiet — the moment passed
  const recent = win.filter(s => now - s.ts <= cfg.fastPopRecentSec * 1000);
  if (recent.length < cfg.fastPopMinRecent) return null;
  const low = Math.min(...win.map(s => s.price));
  const high = Math.max(...win.map(s => s.price));
  if (!(low > 0) || !(high > 0)) return null;
  const gain = (last.price / low - 1) * 100;
  const draw = (high - last.price) / high;
  const buys = win.filter(s => s.side === 'buy').length;
  const sells = win.length - buys;
  const share = buys + sells > 0 ? buys / (buys + sells) : null;
  const volSol = win.reduce((a, s) => a + (s.sol || 0), 0);
  if (
    gain >= cfg.fastPopGainPct &&
    !(cfg.fastPopMaxGainPct > 0 && gain > cfg.fastPopMaxGainPct) &&
    draw <= cfg.fastPopMaxDrop &&
    volSol >= cfg.fastPopMinVolSol &&
    buys >= cfg.fastPopMinBuys &&
    share != null && share >= cfg.fastPopMinBuyShare &&
    !(cfg.fastPopMaxBuyShare > 0 && share >= cfg.fastPopMaxBuyShare)
  ) {
    return {
      setup: 'pop',
      strength: gain,
      metrics: {
        gainPct: +gain.toFixed(1),
        drawFromPeak: +draw.toFixed(3),
        buyRatioM5: +share.toFixed(2),
        volM5: Math.round(volSol), // stream SOL volume in the window (solUsd not known here; bot converts for the journal)
        fastStream: 1,
        windowSec: cfg.fastPopWindowSec,
        trades: win.length,
      },
    };
  }
  return null;
}

// ---- STREAM TAPE WINDOW (owner order 2026-10-23, the yagi lag fix) ----
// The trailing-5-minute tape from the bot's OWN trade stream (streamBuf):
// first-party, per-trade, no aggregator cache between the tape and the
// judge. DexScreener's m5 bucket answered nine clustered staircase
// fetches with the identical $4,113 while the pool really traded ~$8.6K
// in that window (2026-10-22 21:49 EDT) — when the stream is watching a
// mint, its sum is the honest ruler. covered = enough recent trades
// that the stream demonstrably sees this mint's tape right now.
export function tapeWindow(buf, now, { windowMs = 300000, solUsd = null, minTrades = 3, maxAgeMs = 90000 } = {}) {
  const empty = { covered: false, volUsd: null, volSol: 0, buys: 0, sells: 0, trades: 0, newestTs: null };
  if (!buf || !buf.length || !(solUsd > 0)) return empty;
  let volSol = 0, buys = 0, sells = 0, trades = 0, newestTs = null;
  for (const t of buf) {
    if (!t || !(t.ts > 0) || now - t.ts > windowMs || t.ts > now + 5000) continue;
    trades++; volSol += t.sol || 0;
    if (t.side === 'buy') buys++; else sells++;
    if (newestTs == null || t.ts > newestTs) newestTs = t.ts;
  }
  if (!trades) return empty;
  return { covered: trades >= minTrades && newestTs != null && now - newestTs <= maxAgeMs, volUsd: Math.round(volSol * solUsd), volSol, buys, sells, trades, newestTs };
}

// ---- FAST POP FLOORS (user 2026-10-15) ----
// Qualification floors judged in bot._evalFastPop AFTER the detector fires:
// the fire's USD volume figure (metrics.volM5) and the raw burst size
// (metrics.streamVolSol) must each clear a floor, or the burst was dust —
// tonight's fast losers (NEXA $511 / 5 SOL, BISCUIT $1,121 / 11 SOL,
// H2O $1,432 / 14 SOL) all fired on flow the classic pop's volume floor
// would never have let through. Fail-closed: a missing value does not clear
// its floor, and the verdict says so distinctly. Each knob at 0 = floor off.
export function fastPopFloors({ volM5Usd = null, streamVolSol = null } = {}, cfg) {
  const reasons = [];
  let missing = false;
  const usd = (x) => '$' + Math.round(x).toLocaleString('en-US');
  if (cfg.fastPopMinVolM5 > 0) {
    if (volM5Usd == null || !Number.isFinite(volM5Usd)) { missing = true; reasons.push(`5m volume missing — cannot verify the ${usd(cfg.fastPopMinVolM5)} floor`); }
    else if (volM5Usd < cfg.fastPopMinVolM5) reasons.push(`5m volume ${usd(volM5Usd)} under ${usd(cfg.fastPopMinVolM5)} floor`);
  }
  if (cfg.fastPopMinStreamVolSol > 0) {
    if (streamVolSol == null || !Number.isFinite(streamVolSol)) { missing = true; reasons.push(`burst volume missing — cannot verify the ${cfg.fastPopMinStreamVolSol} SOL floor`); }
    else if (streamVolSol < cfg.fastPopMinStreamVolSol) reasons.push(`burst ${streamVolSol} SOL under ${cfg.fastPopMinStreamVolSol} SOL floor`);
  }
  return { pass: reasons.length === 0, missing, reasons };
}
