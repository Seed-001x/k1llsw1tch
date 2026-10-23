import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { CurlWatch, curlVerdict, bucketLows } from '../src/curlWatch.js';

// CURL DOOR (owner design 2026-10-23, from his MEOWE chart): a coin
// that already ran once, retraced hard, based with rising lows, and
// is lifting off the base on follow-through tape. Fixtures are built
// on the MEOWE arc from his screenshot: peak ~$350K, base ~$100K,
// curling through ~$130-170K.
const CFG = loadConfig({});
const T0 = 1_000_000_000_000;
const MIN = 60000;

// samples every 30s across [fromMin, toMin] with a price path fn
function path(fromMin, toMin, fn) {
  const out = [];
  for (let m = fromMin; m <= toMin; m += 0.5) out.push({ ts: T0 + m * MIN, price: fn(m) });
  return out;
}
// the base: low 1.00 at minute 0, rising lows after (1.00 -> 1.04 -> 1.09 across thirds)
const baseSamples = () => path(0, 60, (m) => 1.0 + (m / 60) * 0.09 + Math.sin(m * 1.7) * 0.008);
const goodState = () => ({ peakPrice: 3.5, peakMc: 350000, peakTs: T0 - 120 * MIN, lowPrice: 1.0, lowTs: T0, firedLowTs: null });
const goodView = () => ({ address: 'CURL1', symbol: 'MEOWE', price: 1.3, mc: 130000, volM5: 20000, volH1: 60000, buysM5: 40, sellsM5: 25, chgM5: 8, liq: 40000 });
const NOW = T0 + 60 * MIN;

test('bucketLows: rising base passes, falling or thin bases fail', () => {
  const rising = bucketLows(baseSamples(), T0, NOW);
  assert.equal(rising.ok, true);
  assert.ok(rising.lows[2] > rising.lows[0]);
  const falling = bucketLows(path(0, 60, (m) => 1.1 - (m / 60) * 0.09), T0, NOW);
  assert.equal(falling.ok, true);
  assert.ok(falling.lows[2] < falling.lows[0]);
  assert.equal(bucketLows([{ ts: T0 + MIN, price: 1 }], T0, NOW).ok, false);
});

test('curlVerdict: the textbook MEOWE curl passes with a full stamp', () => {
  const r = curlVerdict(goodState(), goodView(), baseSamples(), null, CFG, NOW);
  assert.equal(r.pass, true, r.reason);
  assert.equal(r.stamp.peakMc, 350000);
  assert.ok(Math.abs(r.stamp.depth - 0.714) < 0.01);
  assert.ok(Math.abs(r.stamp.lift - 0.3) < 0.01);
});

test('curlVerdict: no prior run, no curl — a shallow dip is not a retrace', () => {
  const st = { ...goodState(), peakMc: 100000 }; // first run too small to be proof
  assert.equal(curlVerdict(st, goodView(), baseSamples(), null, CFG, NOW).pass, false);
  const shallow = { ...goodState(), lowPrice: 2.8 }; // only -20% off the peak
  const r = curlVerdict(shallow, { ...goodView(), price: 3.1, mc: 310000 }, baseSamples(), null, CFG, NOW);
  assert.equal(r.pass, false);
  assert.match(r.reason, /shallower/);
});

test('curlVerdict: a corpse (too deep) and a still-falling base both fail', () => {
  const corpse = { ...goodState(), lowPrice: 0.5 }; // -86% off the peak
  assert.match(curlVerdict(corpse, { ...goodView(), price: 0.62, mc: 62000 }, baseSamples(), null, CFG, NOW).reason, /corpse/);
  const falling = path(0, 60, (m) => 1.1 - (m / 60) * 0.09);
  assert.match(curlVerdict(goodState(), goodView(), falling, null, CFG, NOW).reason, /not rising/);
  const young = { ...goodState(), lowTs: T0 + 55 * MIN }; // low printed 5m ago
  assert.match(curlVerdict(young, goodView(), baseSamples(), null, CFG, NOW).reason, /has not held/);
});

test('curlVerdict: the lift band — too early, too extended, back at the highs, or vertical all fail', () => {
  assert.match(curlVerdict(goodState(), { ...goodView(), price: 1.05, mc: 105000 }, baseSamples(), null, CFG, NOW).reason, /lift 5%/);
  assert.match(curlVerdict(goodState(), { ...goodView(), price: 1.7, mc: 170000 }, baseSamples(), null, CFG, NOW).reason, /already extended/);
  assert.match(curlVerdict(goodState(), { ...goodView(), chgM5: 45 }, baseSamples(), null, CFG, NOW).reason, /vertical/);
});

test('curlVerdict: follow-through is a condition — thin, non-expanding, or seller-led tape fails', () => {
  assert.match(curlVerdict(goodState(), { ...goodView(), volM5: 3000 }, baseSamples(), null, CFG, NOW).reason, /follow-through floor/);
  assert.match(curlVerdict(goodState(), { ...goodView(), volM5: 8000 }, baseSamples(), null, CFG, NOW).reason, /not expanding/); // 8000 < 60000/6
  assert.match(curlVerdict(goodState(), { ...goodView(), buysM5: 20, sellsM5: 40 }, baseSamples(), null, CFG, NOW).reason, /not in control/);
  // the stream tape can carry the volume leg when the view is stale
  const r = curlVerdict(goodState(), { ...goodView(), volM5: 3000 }, baseSamples(), 21000, CFG, NOW);
  assert.equal(r.pass, true, r.reason);
  assert.equal(r.stamp.tapeVolM5, 21000);
});

test('CurlWatch: fires once per episode, and a new low starts a new episode', () => {
  const fires = [];
  let samples = baseSamples();
  const watch = new CurlWatch({ cfg: CFG, now: () => NOW, log: () => {}, samples: () => samples, tape: () => null, onFire: (rec) => fires.push(rec) });
  const v = (price, mc, over = {}) => ({ address: 'CURL1', symbol: 'MEOWE', price, mc, volM5: 20000, volH1: 60000, buysM5: 40, sellsM5: 25, chgM5: 8, liq: 40000, ...over });
  watch.observe(v(3.5, 350000), T0 - 120 * MIN);       // the first run's peak
  watch.observe(v(1.0, 100000), T0);                    // the retrace low
  watch.observe(v(1.3, 130000), NOW);                   // the curl — should fire
  assert.equal(fires.length, 1);
  assert.equal(fires[0].metrics.curl.peakMc, 350000);
  watch.observe(v(1.32, 132000), NOW + MIN);            // same episode: no refire
  assert.equal(fires.length, 1);
  // a fresh dump to a new low, a new base, a new curl: a second episode fires
  const T1 = NOW + 180 * MIN;
  samples = path(0, 60, (m) => 0.95 + (m / 60) * 0.06 + Math.sin(m * 1.7) * 0.006).map(s => ({ ts: T1 - 60 * MIN + (s.ts - T0), price: s.price }));
  watch.observe(v(0.95, 95000), T1 - 60 * MIN);         // new low (episode 2; depth vs the $350K peak = 73%)
  watch.observe(v(1.2, 120000, { volM5: 22000 }), T1);  // +26% off the new low on tape
  assert.equal(fires.length, 2);
  assert.equal(watch.stats().fired, 2);
});

test('CurlWatch: a coin that never ran is never even judged', () => {
  const fires = [];
  const watch = new CurlWatch({ cfg: CFG, now: () => NOW, log: () => {}, samples: () => baseSamples(), tape: () => null, onFire: (rec) => fires.push(rec) });
  watch.observe({ address: 'FLAT1', symbol: 'FLAT', price: 0.5, mc: 50000, volM5: 30000, volH1: 60000, buysM5: 40, sellsM5: 20, chgM5: 5 }, NOW);
  watch.observe({ address: 'FLAT1', symbol: 'FLAT', price: 0.65, mc: 65000, volM5: 30000, volH1: 60000, buysM5: 40, sellsM5: 20, chgM5: 5 }, NOW + MIN);
  assert.equal(fires.length, 0);
});
