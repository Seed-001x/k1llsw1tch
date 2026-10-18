// FAKE-ALIVE STAMP (owner insight 2026-10-18 ~03:26 EDT, build ordered
// ~03:37 "Let's do it", clarified ~03:37 "Stamp not spam" / study-only):
// the owner's read on the grind deaths — a coin can print a balanced tape
// (30 buys / 32 sells) and still be dying, because the buy side is a paid
// volume bot absorbing real exits at ever-lower prices. Counts alone call
// that tape alive; it isn't. This stamp scores, per position, the share of
// its ~10s samples where the tape LOOKED balanced while the price was
// falling and already well under its peak — "fake-alive" samples.
//
// RECORD-ONLY. Nothing in the bot reads this back: no exit, no veto, no
// sizing, no gate consumes it. It rides the position, the tick journal,
// /state and the close record purely so the study can be judged later
// (the pilot read on the last 7 retained positions, 2026-10-18: the
// collapse death scored 45% fake-alive, the healthy hold 13%, the honest
// dump 0%). Promotion to any live use needs the sample AND the owner's
// explicit order, like every shadow before it. FAKE_ALIVE_STAMP=0 off.
//
// Definition (identical to the 2026-10-18 pilot, so forward data compares
// to it): a sample SCORES once a previous sample exists. It is fake-alive
// when ALL of: buys >= 0.7 x max(sells, 1) in the 5m window (the tape
// looks balanced), the realizable ratio FELL vs the previous sample, and
// the ratio sits below 85% of the position's own sampled peak. A sample
// with missing flow fields can score but can never be fake-alive.

const RING_CAP = 240; // scored samples remembered for trailing-window reads (~40 min at the 10s cadence)

export function sampleFakeAlive(pos, { ratio, buysM5, sellsM5, ts }) {
  if (ratio == null || !Number.isFinite(ratio)) return pos.fakeAlive || null;
  const fa = pos.fakeAlive || (pos.fakeAlive = { samples: 0, fake: 0, share: null, lastRatio: null, peakRatio: null, ring: [] });
  if (!Array.isArray(fa.ring)) fa.ring = []; // positions persisted before the ring existed
  fa.peakRatio = fa.peakRatio == null ? ratio : Math.max(fa.peakRatio, ratio);
  if (fa.lastRatio == null) { fa.lastRatio = ratio; return fa; }
  fa.samples++;
  const balanced = buysM5 != null && sellsM5 != null && buysM5 >= 0.7 * Math.max(sellsM5, 1);
  const falling = ratio < fa.lastRatio;
  const belowPeak = ratio < 0.85 * fa.peakRatio;
  const isFake = balanced && falling && belowPeak;
  if (isFake) fa.fake++;
  fa.share = fa.samples ? +(fa.fake / fa.samples).toFixed(3) : null;
  fa.lastRatio = ratio;
  if (ts != null) {
    fa.ring.push({ ts, f: isFake ? 1 : 0 });
    if (fa.ring.length > RING_CAP) fa.ring.splice(0, fa.ring.length - RING_CAP);
  }
  return fa;
}

/**
 * Trailing-window fake-alive read (the grind judge's input): share over
 * scored samples with ts inside the last `windowMs`. Null when the
 * position carries no ring (pre-ring positions, kill switch off).
 */
export function fakeAliveWindow(pos, now, windowMs) {
  const fa = pos && pos.fakeAlive;
  if (!fa || !Array.isArray(fa.ring)) return null;
  const since = now - windowMs;
  let samples = 0, fake = 0;
  for (const r of fa.ring) {
    if (r.ts < since) continue;
    samples++; fake += r.f || 0;
  }
  return { samples, fake, share: samples ? +(fake / samples).toFixed(3) : null };
}

// The compact stamp carried on /state positions and close records.
export function fakeAliveStamp(pos) {
  const fa = pos && pos.fakeAlive;
  if (!fa) return null;
  return { samples: fa.samples, fake: fa.fake, share: fa.share };
}
