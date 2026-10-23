// CURL WATCH (owner design 2026-10-23 01:03-01:15 EDT, from his MEOWE
// chart; built the same night on his order "build the package AND the
// curl door together — let's see how it does").
//
// The shape, in the owner's words: a coin "retracing to go up again
// from a low", or already going up — "in between only if it truly
// follows thru with vol that can push the price". Pop's replacement
// as the momentum door: where pop chased the FIRST vertical spike
// (and bled all day 2026-10-22 on pops with no follow-through), curl
// demands the first run already happened — a real sampled peak is the
// entry ticket — then a hard retrace, a base whose lows stop falling,
// and a lift off that base carrying follow-through tape (volume
// at/above the floor AND expanding against the hour's pace, buyers
// in control of the tape).
//
// Fed observe() from the poll + outcome-observer view streams like
// the sibling watches (bottom/range) — no sampler of its own.
// Per-mint state is scalars (peak / retrace low / timestamps), so an
// arc can span hours even though the bot's sampled history spans 90
// minutes; the rising-lows proof reads those recent samples at fire
// time. One fire per retrace episode (an episode is keyed by its
// low); a new post-peak low starts a new episode. Fires route
// through the bot's onFire seam into the ordinary onSignal pipeline
// — gates, risk, census, exits all unchanged. CURL_LIVE=0 shadows
// the door in Bot.shadowedSetup; the watch keeps tracking either way.

/** Split [fromTs, toTs] into 3 equal windows; the min price of each.
 *  ok=false when any window holds fewer than 2 samples — the base is
 *  not sampled well enough to prove its lows. */
export function bucketLows(samples, fromTs, toTs) {
  if (!(toTs > fromTs)) return { ok: false, lows: [] };
  const w = (toTs - fromTs) / 3;
  const lows = [Infinity, Infinity, Infinity];
  const counts = [0, 0, 0];
  for (const s of samples || []) {
    if (!s || !(s.price > 0) || s.ts < fromTs || s.ts > toTs) continue;
    const i = Math.min(2, Math.floor((s.ts - fromTs) / w));
    counts[i]++;
    if (s.price < lows[i]) lows[i] = s.price;
  }
  if (counts.some(c => c < 2) || lows.some(l => !Number.isFinite(l))) return { ok: false, lows: [] };
  return { ok: true, lows, counts };
}

/** The curl judgment, pure. st = the watch's per-mint state
 *  {peakPrice, peakMc, peakTs, lowPrice, lowTs}; tapeVolUsd = the
 *  stream tape's trailing-5m USD volume when covered, else null. */
export function curlVerdict(st, v, samples, tapeVolUsd, cfg, n) {
  const fail = (reason) => ({ pass: false, reason });
  if (!st || !v || !(v.price > 0)) return fail('no state or view');
  if (!(st.peakMc >= cfg.curlMinPeakMc)) return fail(`peak mc $${Math.round(st.peakMc)} under the $${cfg.curlMinPeakMc} proof floor`);
  const depth = 1 - st.lowPrice / st.peakPrice;
  if (depth < cfg.curlMinDepth) return fail(`retrace only ${(depth * 100).toFixed(0)}% — shallower than the ${(cfg.curlMinDepth * 100).toFixed(0)}% curl band`);
  if (depth > cfg.curlMaxDepth) return fail(`retrace ${(depth * 100).toFixed(0)}% — deeper than the ${(cfg.curlMaxDepth * 100).toFixed(0)}% band, a corpse not a base`);
  const baseMin = (n - st.lowTs) / 60000;
  if (baseMin < cfg.curlMinBaseMin) return fail(`low only ${baseMin.toFixed(0)}m old — the base has not held yet`);
  if (baseMin > 12 * 60) return fail('retrace low is over 12h old — episode is stale');
  const bl = bucketLows(samples, Math.max(st.lowTs, n - 90 * 60000), n);
  if (!bl.ok) return fail('base not sampled well enough to prove its lows');
  const [l1, l2, l3] = bl.lows;
  if (!(l2 >= l1 * 0.99 && l3 >= l2 * 0.99 && l3 > l1 * 1.02)) return fail('lows are not rising across the base');
  if (l1 < st.lowPrice * 0.97) return fail('price broke under the retrace low inside the window — still falling');
  const lift = v.price / st.lowPrice - 1;
  if (lift < cfg.curlMinLift) return fail(`lift ${(lift * 100).toFixed(0)}% off the low — under the ${(cfg.curlMinLift * 100).toFixed(0)}% curl trigger`);
  if (lift > cfg.curlMaxLift) return fail(`lift ${(lift * 100).toFixed(0)}% off the low — past the ${(cfg.curlMaxLift * 100).toFixed(0)}% band, the curl is already extended`);
  if (v.price > st.peakPrice * 0.8) return fail('price is back at the old highs — no retrace left to curl from');
  if (v.chgM5 != null && v.chgM5 > cfg.curlMaxChgM5) return fail(`chgM5 +${v.chgM5}% — vertical right now, that is the old pop trap`);
  const vol = Math.max(v.volM5 || 0, tapeVolUsd || 0);
  if (vol < cfg.curlMinVolM5) return fail(`volM5 $${Math.round(vol)} under the $${cfg.curlMinVolM5} follow-through floor`);
  if (v.volH1 > 0 && vol < v.volH1 / 6) return fail(`volM5 $${Math.round(vol)} is not expanding — under 2x the hour's average 5m pace ($${Math.round(v.volH1 / 6)})`);
  const buys = v.buysM5 || 0, sells = v.sellsM5 || 0;
  if (buys + sells > 0) {
    const ratio = buys / (buys + sells);
    if (ratio < cfg.curlMinBuyRatio) return fail(`buy ratio ${ratio.toFixed(2)} under ${cfg.curlMinBuyRatio} — buyers are not in control`);
  } else if (!(tapeVolUsd > 0)) return fail('no measurable m5 tape — follow-through unproven');
  if (!(v.mc >= cfg.curlMinMc)) return fail(`mc $${Math.round(v.mc || 0)} under the $${cfg.curlMinMc} curl floor`);
  if (v.mc > cfg.curlMaxMc) return fail(`mc $${Math.round(v.mc)} over the $${cfg.curlMaxMc} curl ceiling`);
  return {
    pass: true,
    reason: `curl: peaked $${Math.round(st.peakMc)}, retraced ${(depth * 100).toFixed(0)}% to a base that held ${baseMin.toFixed(0)}m, lifting +${(lift * 100).toFixed(0)}% off the low on $${Math.round(vol)} of fresh 5m tape`,
    stamp: { peakMc: Math.round(st.peakMc), peakTs: st.peakTs, lowPrice: st.lowPrice, lowTs: st.lowTs, depth: +depth.toFixed(3), lift: +lift.toFixed(3), bucketLows: bl.lows, volM5: Math.round(vol), tapeVolM5: tapeVolUsd ?? null },
  };
}

export class CurlWatch {
  constructor({ cfg, now, log, onFire, samples, tape } = {}) {
    this.cfg = cfg;
    this.now = now || Date.now;
    this.log = log || (() => {});
    this.onFire = onFire || (() => {});
    this.samplesFn = samples || (() => []);
    this.tapeFn = tape || (() => null);
    this.state = new Map(); // mint -> {peakPrice, peakMc, peakTs, lowPrice, lowTs, lastTs, firedLowTs}
    this.fired = 0;
    this.episodes = 0;
  }

  observe(v, n = this.now()) {
    if (!v || !v.address || !(v.price > 0)) return;
    const mint = v.address;
    let st = this.state.get(mint);
    if (!st) {
      st = { peakPrice: v.price, peakMc: v.mc || 0, peakTs: n, lowPrice: v.price, lowTs: n, lastTs: n, firedLowTs: null };
      this.state.set(mint, st);
    }
    if (v.price > st.peakPrice) {
      st.peakPrice = v.price; st.peakMc = v.mc || st.peakMc; st.peakTs = n;
      st.lowPrice = v.price; st.lowTs = n;
    } else if (v.price < st.lowPrice) {
      st.lowPrice = v.price; st.lowTs = n;
    }
    st.lastTs = n;
    if (this.state.size > 4000) {
      for (const [k, s] of this.state) if (n - s.lastTs > 12 * 3600000) this.state.delete(k);
    }
    if (st.firedLowTs === st.lowTs) return; // this episode already fired
    if (!(st.peakMc >= this.cfg.curlMinPeakMc)) return; // cheap prefilter before the sample scan
    let tapeVol = null;
    try { const t = this.tapeFn(mint, n); if (t && t.covered) tapeVol = t.volUsd; } catch { /* the tape is a bonus ruler */ }
    const verdict = curlVerdict(st, v, this.samplesFn(mint), tapeVol, this.cfg, n);
    if (!verdict.pass) return;
    st.firedLowTs = st.lowTs;
    this.fired++; this.episodes++;
    this.log(`[curl] ${v.symbol || mint}: ${verdict.reason}`);
    this.onFire({ mint, symbol: v.symbol || null, ts: n, metrics: { curl: verdict.stamp }, reason: verdict.reason });
  }

  stats() { return { watching: this.state.size, fired: this.fired, episodes: this.episodes }; }
}
