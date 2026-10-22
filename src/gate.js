// gate.js — "is this launch rigged / a copy?" gates. Pure functions + one cached RugCheck fetch.
//
// Built from the DOTF / QI pattern we analysed: whole bonding curve bought in one tx, holder count
// inflated with identical-balance wallets, creator stack far larger than pool depth, market cap with no
// relation to the SOL actually in the pool, and a brand-new coin copying the name of an established one.
//
// Policy: any single hard fail blocks entry. A missing RugCheck report blocks young coins (they are
// where rigging lives) and only warns for older, high-volume ones.

import { fetchJson } from './util.js';
import { fetchGtJson, recordGtOutcome } from './gtFetch.js';
import { rpc } from './curveChain.js';

const RC = 'https://api.rugcheck.xyz/v1';
const cache = new Map(); // mint -> { ts, report }
const TTL = 120000;

// Holder-count observation log (record-only, 2026-10-14): holder-count reads
// this process makes leave timestamped samples here, from TWO sources writing
// the same series — every RugCheck report read (fetchRug → noteHolders) and
// every Helius DAS count (fetchHolderCount → noteHolderCount). Holder counts
// are not in the DexScreener views the poll samples, so this log exists so
// signal records can carry a holder-growth field (src/signalFields.js)
// computed from reads the bot already made. Nothing reads this for a trading
// decision; fetchRug's return value and cache behavior are unchanged.
const holderLog = new Map(); // mint -> [{ ts, holders }] oldest first
const HOLDER_LOG_MAX = 288;
/** Append one holder-count sample. Implausible readings (non-finite, ≤ 0, no
 *  mint) are dropped; a re-read at the same timestamp replaces, never stacks. */
export function noteHolderCount(mint, ts, n) {
  const h = Number(n);
  if (!mint || !Number.isFinite(ts) || !Number.isFinite(h) || h <= 0) return;
  let a = holderLog.get(mint);
  if (!a) { a = []; holderLog.set(mint, a); }
  if (a.length && a[a.length - 1].ts === ts) { a[a.length - 1] = { ts, holders: h }; return; }
  a.push({ ts, holders: h });
  while (a.length > HOLDER_LOG_MAX) a.shift();
}
function noteHolders(mint, ts, report) {
  noteHolderCount(mint, ts, report ? Number(report.totalHolders) : NaN);
}
/** Timestamped holder-count samples from this process's own reads (RugCheck + DAS). */
export function holderSamples(mint) {
  const a = holderLog.get(mint);
  return a ? a.slice() : [];
}

export async function fetchRug(mint, now = Date.now()) {
  const c = cache.get(mint);
  if (c && now - c.ts < TTL) { noteHolders(mint, c.ts, c.report); return c.report; }
  const report = await fetchJson(`${RC}/tokens/${mint}/report`, { timeout: 10000 });
  cache.set(mint, { ts: now, report });
  noteHolders(mint, now, report);
  return report;
}

// Holder-count sampling, second source (record-only, 2026-10-14): Helius DAS
// getTokenAccounts. It rides the SAME Helius endpoint + key the bot already
// uses (cfg.rpcUrls, via curveChain's rpc helper). Why it exists: RugCheck
// has no report at all for many young coins, so those mints accumulated zero
// holder samples and holderGrowth stayed null; DAS indexes Token-2022
// accounts from a mint's first buy, so every gated evaluation can leave a
// sample. The count is token ACCOUNTS, not unique owners (one ATA per
// owner per mint is the norm on pump.fun; curve/fee accounts add a small
// near-constant offset) — accepted, because the field is a growth DELTA over
// ≥5 min, where a constant offset cancels. FAIL-SILENT by contract: any RPC
// error, timeout, or implausible reading returns null and writes nothing —
// the caller never branches on the result. The HOLDER_DAS knob is enforced
// at the bot's call sites (cfg.holderDas), not here.
//
// PINNED-AT-1 BUG (diagnosed live 2026-10-19, the Structure Watch holder
// bug): the original read asked for limit 1 and trusted result.total as the
// mint's account count. On the live DAS endpoint `total` is the size of the
// RETURNED PAGE — limit 1 → total 1, limit 100 → total 100, no limit →
// total 1000 (default page), verified against USDC and a live runner — so
// every mint "had" exactly 1 holder, holder growth computed 0% forever and
// the Structure Watch's holderSplit classified every mark 'flat'. The
// endpoint is cursor-paginated (limit ≤ 1000): the true count is the SUM
// of token_accounts lengths over a full cursor walk. The walk is capped at
// DAS_MAX_PAGES pages; a walk that cannot finish inside the cap (or whose
// cursor stops advancing) returns null — unknown, never a pinned partial.
const DAS_PAGE_LIMIT = 1000; // the endpoint rejects larger limits
const DAS_MAX_PAGES = 20;     // ≤ 20,000 accounts per sample read
export async function fetchHolderCount(mint, { rpcUrls, now = Date.now(), timeout = 8000 } = {}) {
  if (!mint || !rpcUrls || !rpcUrls.length) return null;
  try {
    let count = 0, cursor = null;
    const seenCursors = new Set();
    for (let page = 0; ; page++) {
      const params = { mint, limit: DAS_PAGE_LIMIT };
      if (cursor) params.cursor = cursor;
      const result = await rpc(rpcUrls, 'getTokenAccounts', params, timeout);
      const accounts = result && Array.isArray(result.token_accounts) ? result.token_accounts : null;
      if (!accounts) return null;
      count += accounts.length;
      const next = result && typeof result.cursor === 'string' && result.cursor ? result.cursor : null;
      if (!next || accounts.length < DAS_PAGE_LIMIT) break; // last page reached — walk complete
      if (seenCursors.has(next) || page + 1 >= DAS_MAX_PAGES) return null; // no progress / over budget → unknown
      seenCursors.add(next);
      cursor = next;
    }
    if (!Number.isFinite(count) || count <= 0) return null;
    noteHolderCount(mint, now, count);
    return count;
  } catch { return null; }
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function poolOwnerSet(rug) {
  const s = new Set();
  for (const [addr, info] of Object.entries(rug.knownAccounts || {})) {
    if (info && (info.type === 'AMM' || info.type === 'LOCKER')) s.add(addr);
  }
  for (const m of rug.markets || []) { if (m && m.pubkey) s.add(m.pubkey); }
  return s;
}

// 1. Identical-balance holders: organic buyers never end up with the exact same token amount.
export function cloneHolderCheck(topHolders, skip, minCluster = 6) {
  const buckets = new Map();
  for (const h of topHolders || []) {
    if (!h || skip.has(h.owner) || skip.has(h.address)) continue;
    const amt = num(h.amount);
    if (amt > 0) buckets.set(amt, (buckets.get(amt) || 0) + 1);
  }
  const worst = Math.max(0, ...buckets.values());
  return { pass: worst < minCluster, reason: worst >= minCluster ? `${worst} wallets hold the exact same balance (one funder)` : 'balances distinct' };
}

// 1b. Near-identical balances in tiers (farm wallets): scripted buys with slightly different amounts after fees/rounding.
//     Exact-match (above) misses these. Sort holder balances and group those within `tol` (relative) of the tier's largest;
//     fail on many wallets in tiers of >= minCluster, or a large share of supply sitting in such tiers.
export function farmTiersCheck(topHolders, skip, { tol = 0.005, minCluster = 3, maxWallets = 8, maxSupplyPct = 10 } = {}) {
  const hs = (topHolders || []).filter(h => h && !skip.has(h.owner) && !skip.has(h.address) && num(h.amount) > 0)
    .map(h => ({ amt: num(h.amount), pct: num(h.pct) })).sort((a, b) => b.amt - a.amt);
  const clusters = [];
  let cur = [];
  for (const h of hs) {
    if (cur.length && (cur[0].amt - h.amt) / cur[0].amt <= tol) cur.push(h);
    else { if (cur.length >= minCluster) clusters.push(cur); cur = [h]; }
  }
  if (cur.length >= minCluster) clusters.push(cur);
  const wallets = clusters.reduce((a, c) => a + c.length, 0);
  const pct = clusters.reduce((a, c) => a + c.reduce((x, h) => x + h.pct, 0), 0);
  const bad = wallets >= maxWallets || pct >= maxSupplyPct;
  return { pass: !bad, reason: bad ? `${wallets} wallets in ${clusters.length} near-identical-balance tiers hold ${pct.toFixed(1)}% of supply (farm wallets)` : 'no farm tiers', wallets, tiers: clusters.length, pct };
}

// 1c. Dust volume: huge transaction count but tiny average trade = scripted spam / wash, not people.
export function dustVolumeCheck(view, { minTx = 300, maxAvgUsd = 1.5 } = {}) {
  const tx = (view.buysH1 || 0) + (view.sellsH1 || 0);
  if (!(maxAvgUsd > 0) || tx < minTx) return { pass: true, reason: 'enough real size or too few trades to judge' };
  const avg = (view.volH1 || 0) / tx;
  return { pass: avg >= maxAvgUsd, reason: avg >= maxAvgUsd ? 'avg trade size ok' : `${tx} trades in 1h averaging $${avg.toFixed(2)} (scripted dust, not buyers)`, avgUsd: avg };
}

// 1d. Instant graduation: the whole pump.fun bonding curve filled in a handful of buys.
//     A real launch has hundreds of buyers before it graduates; ≤3 buys means one party bought ~80% of
//     supply at launch, then spreads it across farm wallets and walks the price up (the "YouTube" pattern).
//     `curve` = { buys, sells } on the coin's pump.fun bonding-curve pair, or null if unknown.
//     Unknown never blocks (fail-open), so a data hiccup can't stop good entries.
export function instantGradCheck(curve, ageH, { maxBuys = 3, maxAgeH = 24 } = {}) {
  if (!curve || !(maxBuys > 0)) return { pass: true, reason: 'curve history unknown' };
  if (ageH > maxAgeH) return { pass: true, reason: 'too old to judge from 24h data' };
  const buys = num(curve.buys);
  if (buys <= 0) return { pass: true, reason: 'curve history unknown' };
  const bundled = num(curve.buyIxs) > buys ? ` (${num(curve.buyIxs)} buys bundled into them)` : '';
  return { pass: buys > maxBuys, reason: buys > maxBuys ? `${buys} buys on the curve` : `bonding curve filled in ${buys} buy tx(s)${bundled} — bought out at launch`, buys };
}

// 1e. Bot flow on a young coin: thousands of trades averaging a few dollars = volume bots walking
//     the price up (smooth staircase chart), not people. Wider than `dust` but limited to young coins,
//     where this pattern lives; older runners with lots of small retail trades are not touched.
export function botFlowCheck(view, ageH, { maxAgeH = 2, minTx = 1000, maxAvgUsd = 6 } = {}) {
  const tx = (view.buysH1 || 0) + (view.sellsH1 || 0);
  if (!(maxAvgUsd > 0) || ageH > maxAgeH || tx < minTx) return { pass: true, reason: 'not a young high-churn coin' };
  const avg = (view.volH1 || 0) / tx;
  return { pass: avg >= maxAvgUsd, reason: avg >= maxAvgUsd ? 'avg trade size ok' : `${tx} trades in 1h averaging $${avg.toFixed(2)} on a ${Math.round(ageH * 60)}m-old coin (volume bots)`, avgUsd: avg };
}

// 2. Pool depth vs market cap.
export function exitDepthCheck(liqUsd, mc, minRatio) {
  if (!(mc > 0)) return { pass: false, reason: 'no market cap' };
  const ratio = num(liqUsd) / mc;
  return { pass: ratio >= minRatio, reason: ratio >= minRatio ? 'pool depth ok' : `pool is ${(ratio * 100).toFixed(2)}% of market cap — cap is not exit value` };
}

// 3. Creator dump: constant-product sim of the creator selling their whole stack into the pool.
export function creatorDumpCheck({ creatorUi, poolBaseUi, poolQuoteUi, supplyUi }, maxDrain = 0.25) {
  const x = num(creatorUi);
  if (!(x > 0)) return { pass: true, reason: 'creator holds nothing' };
  const B = num(poolBaseUi), Q = num(poolQuoteUi);
  if (!(B > 0) || !(Q > 0)) return { pass: false, reason: 'creator holds tokens and pool data is missing' };
  const drain = x / (B + x);
  const pct = supplyUi > 0 ? (x / supplyUi) * 100 : null;
  return { pass: drain <= maxDrain, drain, pct, reason: drain <= maxDrain ? 'creator stack cannot drain the pool' : `creator holds ${pct != null ? pct.toFixed(1) + '% of supply, ' : ''}could pull ${(drain * 100).toFixed(1)}% of pool SOL` };
}

// 4. Linked-wallet networks.
export function insiderCheck(networks, supplyRaw, maxPct = 10) {
  const held = (networks || []).reduce((a, n) => a + num(n.currentHolding), 0);
  const pct = supplyRaw > 0 ? (held / supplyRaw) * 100 : 0;
  return { pass: pct <= maxPct, reason: pct > maxPct ? `${pct.toFixed(1)}% of supply in linked wallets` : 'no large linked network' };
}

// 4b. Insider-COUNT block verdict (owner order 2026-10-16, off the last-50
// separation study). Distinct from the insiders gate above, which caps the
// supply SHARE held by linked networks — this judges the raw COUNT of
// graph-detected insider wallets on the RugCheck report
// (rug.graphInsidersDetected — the same number Bot's entry snapshot records
// as insiderWallets via learn.js). The study found it the cleanest separator
// in the bot's own fields (winner median 0, loser median 4). A report that
// doesn't carry the count yields insiders: null + unknown: the caller
// proceeds and the record says so — unknown never blocks and is never
// rounded into an invented number.
export function insiderCountVerdict(rug, max) {
  const raw = rug ? Number(rug.graphInsidersDetected) : NaN;
  const insiders = Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (insiders == null) return { pass: true, insiders: null, unknown: true, reason: 'insider count unavailable on the RugCheck report — not judged' };
  if (max > 0 && insiders >= max) return { pass: false, insiders, unknown: false, reason: `insiders ${insiders} >= ${max} — blocked` };
  return { pass: true, insiders, unknown: false, reason: `${insiders} insider wallets — under the block line ${max}` };
}

// 4c. Fast-bonder block verdict (owner order 2026-10-16, "live gate now:
// block sub-2-minute bonders"). Judges a DURATION, not a count: how many
// seconds a graduated coin's bonding curve lived (curve start -> graduation,
// from DexScreener pairCreatedAt on the curve pair vs the first AMM pair —
// see sources.js curveLifeFromPairs). Distinct from instantGrad above (1d),
// which counts curve BUY TXS inside 24h: the camouflaged-bundle species
// splits its graduation slam across 100+ wallets and pads the tape with
// micro-buys (TRUMARS, 2026-10-16: 201 curve buys, median $10.76), so the
// count reads organic — but the whole curve still filled in 78 seconds,
// and elapsed time is the one number that pattern cannot fake. Only a
// MEASURED lifespan judges: null / non-numeric / negative is unknown, and
// unknown never blocks (a non-graduated coin has no lifespan at all).
export function fastBondVerdict(lifeSec, maxSec, opts = {}) {
  const raw = lifeSec == null ? NaN : Number(lifeSec);
  const life = Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (life == null) {
    // Blind block (owner order 2026-10-21, CYBERCAT): unknown still never
    // judges a MEASUREMENT — but on a YOUNG pool (opts.poolAgeMin at or
    // under opts.unknownBlockPoolAgeMin) an unreadable lifespan blocks
    // the buy instead of passing it. Scoped to young pools on purpose:
    // old coins' stamps rot (DexScreener rotates to the AMM pair) and
    // their survival is evidence; a fresh pool with no readable birth
    // record is exactly the fast-bonder habitat. Without opts (every
    // pre-2026-10-21 caller) the read is the historical fail-open one.
    const poolAgeMin = opts.poolAgeMin == null ? NaN : Number(opts.poolAgeMin);
    const blindMax = Number(opts.unknownBlockPoolAgeMin) || 0;
    if (blindMax > 0 && Number.isFinite(poolAgeMin) && poolAgeMin >= 0 && poolAgeMin <= blindMax) {
      return { pass: false, lifeSec: null, unknown: true, blindBlock: true, reason: `curve lifespan unavailable on a ${Math.round(poolAgeMin)}m-old pool — not bought blind (blind fast-bond block)` };
    }
    return { pass: true, lifeSec: null, unknown: true, reason: 'curve lifespan unavailable — not judged' };
  }
  if (maxSec > 0 && life < maxSec) return { pass: false, lifeSec: life, unknown: false, reason: `curve lifespan ${life}s < ${maxSec}s — fast bonder blocked` };
  return { pass: true, lifeSec: life, unknown: false, reason: `curve lived ${life}s — at or over the ${maxSec}s fast-bond line` };
}

/** Birth-burst verdict (owner order 2026-10-21, the OA hole): pair-age lies
 *  about HOW a coin bonded. OA's curve pair "lived" 507s — but 11 of its 18
 *  curve txs landed within 15 SECONDS of creation: the curve was bought out
 *  at birth, sat full-but-ungraduated for 8 minutes, then got pushed over
 *  the line. The lifespan judge read the graduation lag and passed a coin
 *  that insta-bonded in every way that matters. This judge reads the SHAPE
 *  of the curve's own signature history (sources.curveBurstFromSigTimes):
 *  when at least `minFrac` of all curve txs landed within `windowSec` of
 *  the first one, the bonding was a burst at birth — blocked, whatever the
 *  graduation lag says. Only ever consulted on a MEASURED lifespan pass;
 *  missing/truncated signature history judges nothing (returns unblocked). */
export function burstBondVerdict(burst, opts = {}) {
  if (!burst || !(burst.total > 0) || burst.inWindow == null) return { blocked: false };
  const minFrac = Number(opts.minFrac) || 0;
  const frac = burst.inWindow / burst.total;
  if (minFrac > 0 && frac >= minFrac) {
    return { blocked: true, frac, reason: `insta-bond burst: ${burst.inWindow} of ${burst.total} curve txs landed within ${opts.windowSec}s of creation — curve bought out at birth (graduation only lagged)` };
  }
  return { blocked: false, frac };
}

// 4d. Birth-verdict memory (owner order 2026-10-16, the FMR hole): both birth
// gates above FAIL OPEN on missing data — correct in isolation, fatal in
// combination with amnesia. FMR (2026-10-16): a trend evaluation measured
// the truth and instantGrad fired ("bonding curve filled in 3 buy tx(s) (18
// buys bundled into them) — bought out at launch"), but the knowledge lived
// only in that one journal record; ~18 minutes later a pop evaluation of
// the same mint re-fetched, GeckoTerminal 429'd the curve history away
// ('curve history unknown' -> pass) and DexScreener stamped both pairs
// with the same pairCreatedAt second (degenerate -> lifespan unknown ->
// pass), and the bot bought a bought-out launch. The fix is memory, not
// guessing: whenever ANY evaluation ESTABLISHES a disqualifying birth
// verdict — an instantGrad bought-out fire (1d) or a measured fastBond
// block (4c) — Bot persists it per mint (birth-verdicts.json) and this
// verdict blocks every later evaluation of that mint at the onSignal seam
// BEFORE any fresh fetch is consulted. A mint with no stored verdict is
// not judged here at all: the fresh-fetch gates keep their fail-open
// behavior exactly. A PASSING measurement never creates a verdict (a
// lifespan >= the line is permanent truth too, but the curve-life cache
// already keeps it — memory is only for the disqualified).
export function birthMemoryVerdict(verdict, now) {
  if (!verdict || !verdict.kind) return { pass: true, reason: 'no stored birth verdict — not judged' };
  const ageMs = Math.max(0, (Number(now) || 0) - (Number(verdict.firstSeenTs) || 0));
  const age = ageMs < 60000 ? `${Math.floor(ageMs / 1000)}s` : ageMs < 3600000 ? `${Math.floor(ageMs / 60000)}m` : ageMs < 48 * 3600000 ? `${Math.floor(ageMs / 3600000)}h` : `${Math.floor(ageMs / 86400000)}d`;
  return { pass: false, kind: verdict.kind, evidence: verdict.evidence || null, firstSeenTs: verdict.firstSeenTs || null, reason: `known fast bonder (${verdict.kind}: ${verdict.evidence}; verdict ${age} old) — blocked from memory` };
}

// 4e. Top guard (owner order 2026-10-16, "Do not buy a coin if it's at the
// literal fucking top"): the live paths' triggers peak exactly when the
// vertical peaks, so the fill lands on the tip — blocus (confluence taken
// at $56,844, the exact top tick of a single vertical candle out of a
// day-long range, out -9.7%), MM (confluence taken with the entry minute
// already -13.6% off a seconds-old high), 'long' (pop taken at $50,158,
// $33.9K three minutes later). This verdict judges the SHAPE of arrival
// from the bot's OWN sampled history only (per-mint mc samples — the same
// history the chg1m sampler maintains): where the trailing high sits, how
// old it is, and whether it was MADE by a vertical surge. No external
// fetch is consulted, so the guard can never fail open on a GeckoTerminal
// 429 or a DexScreener stamp collapse. BLOCK when ALL hold: the candidate
// is within distPct of the trailing-lookback high, that high was reached
// by a surge of >= surgePct from the lowest sample inside the
// surgeWindowSec before the high printed, and the high is no older than
// highMaxAgeSec. A high that was GROUND out (no 2-minute surge — the
// staircase-runner shape) or HELD (the surge is old — the coin has based
// at the top, a different animal) passes: this blocks the fresh vertical
// tip, not strength. UNKNOWN never blocks: too few samples in the
// lookback, no current mc, or no sample inside the surge-base window (the
// surge's base was never measured — e.g. the coin was discovered already
// at its high) all stamp unknown and the entry proceeds.
export function topGuardVerdict(samples, now, { currentMc = null, lookbackMin = 30, surgeWindowSec = 120, maxDistPct = 10, minSurgePct = 20, highMaxAgeSec = 300 } = {}) {
  const round1 = (x) => Math.round(x * 10) / 10;
  const win = (samples || []).filter(s => s && Number.isFinite(s.mc) && s.mc > 0 && s.ts <= now && now - s.ts <= lookbackMin * 60000);
  if (win.length < 5) return { pass: true, unknown: true, distPct: null, surgePct: null, highAgeSec: null, reason: `top guard: only ${win.length} sampled mc prints in the trailing ${lookbackMin}m — not judged` };
  let high = 0, highTs = null;
  for (const s of win) { if (s.mc > high) { high = s.mc; highTs = s.ts; } } // strict > : the high's age runs from the print that MADE it
  let cur = Number.isFinite(currentMc) && currentMc > 0 ? currentMc : null;
  if (cur == null) { let newest = win[0]; for (const s of win) if (s.ts >= newest.ts) newest = s; cur = newest.mc; }
  if (!(cur > 0) || !(high > 0)) return { pass: true, unknown: true, distPct: null, surgePct: null, highAgeSec: null, reason: 'top guard: no current market cap to judge — not judged' };
  const distPct = round1(Math.max(0, (high - cur) / high * 100));
  const highAgeSec = Math.max(0, Math.round((now - highTs) / 1000));
  const baseWin = win.filter(s => s.ts >= highTs - surgeWindowSec * 1000 && s.ts < highTs);
  if (!baseWin.length) return { pass: true, unknown: true, distPct, surgePct: null, highAgeSec, reason: `top guard: no sample inside the ${surgeWindowSec}s window before the high — surge unmeasured, not judged` };
  let base = Infinity;
  for (const s of baseWin) if (s.mc < base) base = s.mc;
  const surgePct = round1((high - base) / base * 100);
  const blocked = distPct <= maxDistPct && surgePct >= minSurgePct && highAgeSec <= highMaxAgeSec;
  if (blocked) {
    const age = highAgeSec < 120 ? `${highAgeSec}s` : `${Math.round(highAgeSec / 60)}m`;
    const winLabel = surgeWindowSec % 60 === 0 ? `${surgeWindowSec / 60}-minute` : `${surgeWindowSec}s`;
    return { pass: false, unknown: false, distPct, surgePct, highAgeSec, reason: `at the local top: within ${distPct}% of a high made ${age} ago by a +${surgePct}% ${winLabel} surge — not buying the tip` };
  }
  return { pass: true, unknown: false, distPct, surgePct, highAgeSec, reason: `no fresh vertical top: ${distPct}% under a ${highAgeSec}s-old high reached by a +${surgePct}% surge — outside the top-guard lines (${maxDistPct}% / +${minSurgePct}% / ${highMaxAgeSec}s)` };
}

// 5. Vertical launch: a huge move on a coin minutes old is the pool being pushed, not demand.
export function verticalLaunchCheck(ageMin, chgPct, maxPct = 5000, maxAgeMin = 120) {
  const bad = ageMin <= maxAgeMin && num(chgPct) >= maxPct;
  return { pass: !bad, reason: bad ? `+${Math.round(chgPct).toLocaleString()}% in ${Math.round(ageMin)}m` : 'move not vertical' };
}

// 6. Concentration of non-pool top-10 holders.
export function concentrationCheck(topHolders, skip, maxPct = 60) {
  const real = (topHolders || []).filter(h => h && !skip.has(h.owner) && !skip.has(h.address)).slice(0, 10);
  const pct = real.reduce((a, h) => a + num(h.pct), 0);
  return { pass: pct <= maxPct, reason: pct > maxPct ? `top-10 non-pool holders own ${pct.toFixed(0)}%` : 'distribution ok' };
}

// 7b. Name block: whole-word match against the token's name ("Crypto Inu", "Super Crypto Inu").
//     Whole words only, so names that merely contain the letters ("Continuum", "Minute") still pass.
export function blockedNameWord(name, words) {
  if (!name || !words || !words.length) return null;
  const parts = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    const word = String(w || '').toLowerCase();
    if (word && parts.includes(word)) return word;
  }
  return null;
}

// 7d. Extension above the breakout base (user 2026-10-13): how far the current price sits
//     above the lowest price sampled in the trailing hour — the base the move launched from.
//     An entry at extreme extension (OTTO: bought the top of a long range after a +162%/5m
//     print, stopped 23s later by the range's own chop) has a full retracement to the base
//     waiting under it — the same wobble that means nothing at the base is a stop-out at the
//     top. Judged on the bot's OWN samples; too little history = no base to judge = pass.
export function extensionCheck(samples, price, now, { maxExt = 1.5, windowMin = 60, minSamples = 10, minSpanSec = 180 } = {}) {
  if (!(maxExt > 0) || !(price > 0)) return { pass: true, reason: 'extension check off' };
  const win = (samples || []).filter(s => s && s.price > 0 && now - s.ts <= windowMin * 60000);
  if (win.length < minSamples) return { pass: true, reason: 'too few samples to judge the base' };
  const tsList = win.map(s => s.ts);
  const spanSec = (Math.max(...tsList) - Math.min(...tsList)) / 1000;
  if (spanSec < minSpanSec) return { pass: true, reason: 'sample span too short to judge the base' };
  const base = Math.min(...win.map(s => s.price));
  if (!(base > 0)) return { pass: true, reason: 'no base price in samples' };
  const ext = price / base - 1;
  const over = ext > maxExt;
  return {
    pass: !over, ext, base,
    reason: over
      ? `extended: price is +${Math.round(ext * 100)}% above the trailing ${windowMin}m base (cap +${Math.round(maxExt * 100)}%)`
      : `extension +${Math.round(ext * 100)}% above the trailing ${windowMin}m base — within the cap`,
  };
}

// 7f. Shallow dip under the recent top (user 2026-10-14): a classic entry may be taken at
//     the trailing window's sampled top, breaking above it, or on a REAL dip (maxPct or
//     more under the top — deep dips included) — but NOT a few percent under the top
//     (his example: -5%), which is the rollover spot: the top just failed and the entry
//     catches the first leg down. Deep dips pass THIS check untouched; each setup's own
//     volume / buy-inflow legs still judge them. This replaces the stale-pop veto
//     (removed earlier today, 2026-10-14, CODE): no age/distance path may veto a signal
//     maxPct+ under its sampled top anymore. Judged on the bot's OWN samples; too little
//     history = no real top to judge = pass.
export function shallowDipCheck(samples, price, now, { maxPct = 0.10, windowMin = 60, minSamples = 3, minSpanSec = 60 } = {}) {
  if (!(maxPct > 0) || !(price > 0)) return { pass: true, reason: 'shallow-dip check off' };
  const win = (samples || []).filter(s => s && s.price > 0 && now - s.ts <= windowMin * 60000);
  if (win.length < minSamples) return { pass: true, reason: 'too few samples to judge the top' };
  const tsList = win.map(s => s.ts);
  const spanSec = (Math.max(...tsList) - Math.min(...tsList)) / 1000;
  if (spanSec < minSpanSec) return { pass: true, reason: 'sample span too short to judge the top' };
  const top = Math.max(...win.map(s => s.price));
  if (!(top > 0)) return { pass: true, reason: 'no top price in samples' };
  const dist = (top - price) / top;
  const inZone = dist > 0 && dist < maxPct;
  return {
    pass: !inZone, dist, top,
    reason: inZone
      ? `-${(dist * 100).toFixed(1)}% under the trailing ${windowMin}m top — the rollover zone (0 to ${Math.round(maxPct * 100)}% under); buy the top, a new high, or a real dip`
      : dist <= 0
        ? 'at or above the recent top — no shallow dip'
        : `-${(dist * 100).toFixed(1)}% under the trailing ${windowMin}m top — a real dip, judged by the setup's demand legs`,
  };
}

// 7e. Fresh-history fail-closed (user 2026-10-13, entry-fixes A3): coins discovered mid-run
//     from the trending/movers lists arrive with little or no sampled history, and the
//     sample-judged guard above (extension) fails OPEN on thin data — it waved
//     BORING through (+41.6% in 5m against +13.8% on the hour at a $14.5k cap, a 3-hour-old
//     corpse mid-bounce). When there isn't enough history to judge, DexScreener's own
//     aggregates decide instead: a 5-minute move that has ALREADY printed beyond the cap is
//     a chase, and a small cap whose entire hourly move is one 5-minute candle is a blip.
//     With enough samples this check passes untouched — the sampled guard does the judging.
export function freshHistoryCheck(samples, view, now, { maxChgM5 = 25, smallMc = 30000, m5ShareH1 = 0.7, windowMin = 60, minSamples = 10, minSpanSec = 180, bypassMinVolM5 = 0, bypassMinBuyRatio = 0.65, bypassMaxBuyRatio = 0.85 } = {}) {
  if (!(maxChgM5 > 0) && !(m5ShareH1 > 0)) return { pass: true, reason: 'fresh check off' };
  const win = (samples || []).filter(s => s && s.price > 0 && now - s.ts <= windowMin * 60000);
  if (win.length >= minSamples) {
    const tsList = win.map(s => s.ts);
    if ((Math.max(...tsList) - Math.min(...tsList)) / 1000 >= minSpanSec) {
      return { pass: true, judged: true, reason: 'enough sampled history — sampled guards judge this one' };
    }
  }
  const chgM5 = view ? view.chgM5 : null;
  const chgH1 = view ? view.chgH1 : null;
  const mc = view ? view.mc : null;
  // FLOW BYPASS (user 2026-10-14, "Flow — heavy 5m volume, buyers dominating"): the move-cap
  // leg below exists to stop blind chases of coins the bot cannot judge yet — but a fresh coin
  // printing heavy 5m volume with buyers clearly dominating is not a blind chase: its flow IS
  // the evidence the missing history would have given. When BOTH flow legs hold on the coin's
  // own numbers (the same fields the detectors judge: volM5, and the 5m buy share — read off
  // the view, or derived from its buy/sell counts), the move-cap skip lifts. The small-cap
  // blip leg further down is NEVER bypassed (a small cap's "flow" is the wash itself), and
  // at/above the D1 bundle-bait ceiling there is no bypass either — that share is one bundled
  // buyer, not a crowd. Missing flow numbers = no bypass; the skip stands.
  const volM5 = view && view.volM5 != null ? view.volM5 : null;
  const buyRatioM5 = view
    ? (view.buyRatioM5 != null ? view.buyRatioM5
      : (view.buysM5 != null && view.sellsM5 != null && view.buysM5 + view.sellsM5 > 0 ? view.buysM5 / (view.buysM5 + view.sellsM5) : null))
    : null;
  const bypass = bypassMinVolM5 > 0 && volM5 != null && volM5 >= bypassMinVolM5
    && buyRatioM5 != null && buyRatioM5 >= bypassMinBuyRatio && buyRatioM5 < bypassMaxBuyRatio ? 'flow' : null;
  const moveCapHit = maxChgM5 > 0 && chgM5 != null && chgM5 > maxChgM5;
  if (moveCapHit && !bypass) {
    return { pass: false, reason: `fresh coin, no sampled history, and already +${Math.round(chgM5)}% in 5m (cap +${Math.round(maxChgM5)}%) — the move already happened` };
  }
  if (m5ShareH1 > 0 && mc != null && mc < smallMc && chgM5 != null && chgH1 != null && chgH1 > 0 && chgM5 >= m5ShareH1 * chgH1) {
    return { pass: false, reason: `fresh small cap ($${Math.round(mc)}): the whole hourly move (+${Math.round(chgH1)}%) is one 5m candle (+${Math.round(chgM5)}%) — a blip, not a trend` };
  }
  if (moveCapHit && bypass) {
    return { pass: true, judged: false, bypass, reason: `fresh coin already +${Math.round(chgM5)}% in 5m (cap +${Math.round(maxChgM5)}%) — flow bypass: $${Math.round(volM5)} 5m volume, ${Math.round(buyRatioM5 * 100)}% buys — heavy flow, buyers dominating` };
  }
  return { pass: true, judged: false, reason: 'thin history, but aggregates are not extended' };
}

// 7f. Flow-entry snapshot collapse check (user 2026-10-15, from the DACITY forensic):
//     the downside mirror of the fresh check's move cap, for the one entry path that
//     carries no detector shape of its own. Pop/trend/liftoff/fast-pop entries can only
//     exist when their detector's price-shape legs already hold (a positive gain band, a
//     draw-from-peak cap, a chgM5 floor, a near-high rule) — a coin mid-collapse never
//     produces those signals. A flow entry fires on a tracked wallet's buy instead, and
//     the shared stack judged it without ever reading the downside of its own snapshot:
//     the fresh check caps only the UPSIDE (+chgM5) and only while sampled history is
//     thin (DACITY had history by its second signal, so even that stood down), and the
//     shallow-dip veto names pop/trend/liftoff only. This leg judges the flow entry on
//     the same field DACITY's snapshot carried: the view's own chgM5. At/below the floor
//     the coin is not dipping, it is collapsing — skip. Missing chgM5 = no print to judge
//     (pass; the tradability/gate legs still apply). No volume bypass: heavy flow is
//     evidence on the way UP (the fresh bypass), never a reason to follow a wallet into
//     a crash. Wired for setup 'flow' only in bot.js — other setups are byte-identical.
export function flowSnapshotCheck(view, { minChgM5 = -20 } = {}) {
  if (!(minChgM5 < 0)) return { pass: true, reason: 'flow snapshot check off' };
  const chgM5 = view ? view.chgM5 : null;
  if (chgM5 == null || !Number.isFinite(chgM5)) return { pass: true, reason: 'no 5m print in the flow snapshot — nothing to judge' };
  if (chgM5 <= minChgM5) {
    return { pass: false, reason: `coin collapsing (chgM5 ${chgM5.toFixed(1)}% — at/below the ${minChgM5}% floor)` };
  }
  return { pass: true, reason: `chgM5 ${chgM5.toFixed(1)}% — above the ${minChgM5}% collapse floor` };
}

// 7h. Ran-rebuy block (user 2026-10-15, "for tonight" — knobbed so it lifts
//     without a code change): if the bot has ALREADY TRADED a mint and the coin
//     has since printed >= RAN_REBUY_MULT x that trade's entry price at ANY
//     point from the entry onward — including after the bot sold — a rebuy of
//     that mint is blocked until RAN_REBUY_HOURS after that trade's close.
//     Tonight's exhibit is BOOT: ridden 2026-10-14 (+64.69% via the ladder),
//     then re-bought the next night after its run was already over. The anchor
//     is the MOST RECENT prior closed trade in the mint (mint-exact; names are
//     never judged here). Once the wait expires the rebuy is allowed again
//     regardless of the run; a coin that never printed the multiple is never
//     blocked by this rule (the ordinary cooldowns still apply as always).
//     The peak is measured on GeckoTerminal minute candles over the mint's top
//     pool (the wallet detectors' / callout scorer's pool discipline: GT top
//     pool, DexScreener-deepest fallback). GT candle prices are USD per token
//     (verified 2026-10-15 against DexScreener priceUsd on the same pool),
//     which is what makes the division unit-consistent: the journal's entry
//     price is entryFillUsd — the actual per-token fill in USD, carried on the
//     open record and filled onto the close record by ensureClose — with the
//     close record's entry snapshot price (the signal-time DexScreener USD
//     price) as fallback for records that predate the fill fields.
//     FAIL-OPEN by contract: a failed/unmeasurable peak passes the candidate
//     and reports lookupFailed — a GeckoTerminal hiccup must never become an
//     entry blocker. One exception: a peak >= the multiple found in a PARTIAL
//     candle window (the series doesn't reach back to the entry) is a true
//     positive — those candles are all since-entry — and still blocks.
const GT_RAN = 'https://api.geckoterminal.com/api/v2';
export const RAN_REBUY_TTL_MS = 300000; // per-mint peak-measurement cache (5 min); failures are NOT cached
const ranPeakCache = new Map(); // mint -> { ts, peakRatio, covered }

const fmtX = (x) => `${Number.isInteger(x) ? String(x) : (+x.toFixed(2)).toString()}x`;
const fmtUntil = (ts) => `${new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' })} ET`;

/**
 * Pure: fold journal trade records (the same open/close pairs /trades serves)
 * into the most recent CLOSED trade per mint: { mint, id, symbol, entryTs,
 * closeTs, entryPriceUsd }. Open/close pair by position id; the entry price
 * resolves open.entryFillUsd -> close.entryFillUsd -> close.entry.price (the
 * entry snapshot's signal-time USD price), else null (the check then fails
 * open on that prior). A close with no surviving open still anchors the wait
 * (entryTs null — unmeasurable, fail-open at check time).
 */
export function foldLastTrades(trades) {
  const opens = new Map();
  const last = new Map();
  for (const t of trades || []) {
    if (!t || !t.mint) continue;
    if (t.type === 'open') { if (t.id) opens.set(t.id, t); continue; }
    if (t.type !== 'close') continue;
    const closeTs = Number(t.ts);
    if (!Number.isFinite(closeTs) || closeTs <= 0) continue;
    const o = t.id ? opens.get(t.id) : null;
    let entryPriceUsd = null;
    for (const cand of [o && o.entryFillUsd, t.entryFillUsd, t.entry && t.entry.price]) {
      const p = Number(cand);
      if (Number.isFinite(p) && p > 0) { entryPriceUsd = p; break; }
    }
    const prev = last.get(t.mint);
    if (!prev || closeTs >= prev.closeTs) {
      last.set(t.mint, {
        mint: t.mint, id: t.id || null, symbol: t.symbol || (o && o.symbol) || null,
        entryTs: o && Number(o.ts) > 0 ? Number(o.ts) : null, closeTs, entryPriceUsd,
      });
    }
  }
  return last;
}

/**
 * Pure: the peak since entry from ascending GT minute candles
 * [[tsSec, o, h, l, c, v], ...] against the prior trade's entry price (USD —
 * the candles' own denomination). A candle counts when its minute ends after
 * the entry (the entry minute's own high included, the house candle
 * convention — cf. walletWatch computeOutcome). `covered` is true when the
 * fetched series reaches back to the entry minute; a series that starts later
 * (pool migration, GT history limits) still yields true positives but cannot
 * prove a negative. Returns null when nothing usable overlaps the window or
 * the entry price is unusable.
 */
export function judgeRanPeak(candles, entryTs, entryPriceUsd) {
  const entry = Number(entryPriceUsd);
  if (!(entry > 0) || !Number.isFinite(entryTs) || !(entryTs > 0)) return null;
  let peak = 0, firstStart = null;
  for (const c of candles || []) {
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[2])) continue;
    const start = c[0] * 1000;
    if (start + 60000 <= entryTs) continue; // the minute ended before the entry — not since-entry
    if (firstStart == null) firstStart = start;
    if (c[2] > peak) peak = c[2];
  }
  if (!(peak > 0) || firstStart == null) return null;
  return { peakRatio: peak / entry, covered: firstStart <= entryTs + 60000 };
}

async function resolveRanPool(mint) {
  // GT top pool first (the wallet detectors'/callout scorer's discipline);
  // DexScreener's deepest pair as the fallback for mints GT hasn't ranked.
  try {
    const j = await fetchGtJson(`${GT_RAN}/networks/solana/tokens/${mint}`, { consumer: 'ranRebuy', timeout: 12000 });
    const pools = j && j.data && j.data.relationships && j.data.relationships.top_pools && j.data.relationships.top_pools.data;
    if (pools && pools.length) {
      const id = String(pools[0].id || '');
      const p = id.startsWith('solana_') ? id.slice('solana_'.length) : id;
      if (p) return p;
    }
  } catch { /* fall through to DexScreener */ }
  try {
    const j = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 12000 });
    const pairs = ((j && j.pairs) || []).filter(p => p && p.chainId === 'solana' && p.pairAddress);
    pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    if (pairs.length) return pairs[0].pairAddress;
  } catch { /* no pool anywhere */ }
  return null;
}

/** Default candle source: the mint's minute candles from its entry to now
 *  (paged backwards from now, the callout scorer's fetch shape). Returns
 *  ascending rows, or null on any failure. */
async function defaultRanCandles(mint, entryTs, now) {
  const pool = await resolveRanPool(mint);
  if (!pool) return null;
  const byTs = new Map();
  let before = Math.floor(now / 1000) + 60;
  for (let page = 0; page < 4; page++) {
    const j = await fetchGtJson(`${GT_RAN}/networks/solana/pools/${pool}/ohlcv/minute?limit=1000&before_timestamp=${before}`, { consumer: 'ranRebuy', timeout: 15000, expect: 'ohlcv' });
    const list = j && j.data && j.data.attributes && j.data.attributes.ohlcv_list;
    if (!list || !list.length) break;
    let oldest = Infinity;
    for (const row of list) { byTs.set(row[0], row); if (row[0] < oldest) oldest = row[0]; }
    if (oldest * 1000 <= entryTs || list.length < 1000) break;
    before = oldest - 1;
  }
  if (!byTs.size) return null;
  return [...byTs.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * The gate verdict for one candidate whose mint has a prior closed trade
 * (`prior` from foldLastTrades, or null). Window discipline: a prior whose
 * close is already RAN_REBUY_HOURS old can't block, and the candle fetch is
 * skipped entirely in that case — the measurement only happens inside the
 * window. Successful measurements are cached per mint for RAN_REBUY_TTL_MS
 * in `cache` (module-level by default); failures are never cached. NEVER
 * throws — every failure path resolves to a fail-open pass with
 * lookupFailed set.
 */
export async function ranRebuyCheck(prior, { mult = 5, hours = 3, now = Date.now(), candlesImpl = null, cache = null } = {}) {
  const base = { peakRatio: null, blockedUntil: prior ? prior.closeTs + hours * 3600000 : null, priorCloseTs: prior ? prior.closeTs : null };
  if (!prior) return { ...base, pass: true, lookupFailed: false, reason: 'no prior trade in this mint' };
  if (!(now < base.blockedUntil)) return { ...base, pass: true, lookupFailed: false, reason: `prior close is outside the ${hours}h rebuy window` };
  if (!(prior.entryTs > 0)) return { ...base, pass: true, lookupFailed: true, reason: 'prior entry time missing — passed open (fail-open)' };
  if (!(prior.entryPriceUsd > 0)) return { ...base, pass: true, lookupFailed: true, reason: 'prior entry price missing — passed open (fail-open)' };
  const store = cache || ranPeakCache;
  let meas = null;
  const hit = store.get(prior.mint);
  if (hit && now - hit.ts < RAN_REBUY_TTL_MS) meas = hit;
  else {
    let judged = null;
    try {
      const candles = candlesImpl ? await candlesImpl(prior.mint, prior.entryTs, now) : await defaultRanCandles(prior.mint, prior.entryTs, now);
      if (candles) judged = judgeRanPeak(candles, prior.entryTs, prior.entryPriceUsd);
    } catch { judged = null; }
    if (!judged) return { ...base, pass: true, lookupFailed: true, reason: 'peak since our entry could not be measured — passed open (fail-open)' };
    meas = { ts: now, peakRatio: judged.peakRatio, covered: judged.covered };
    store.set(prior.mint, meas);
  }
  const peakTxt = `${meas.peakRatio.toFixed(1)}x`;
  if (!meas.covered) recordGtOutcome('ranRebuy', 'partialCoverage');
  if (meas.peakRatio >= mult) {
    return { ...base, pass: false, lookupFailed: false, partialCoverage: !meas.covered, peakRatio: +meas.peakRatio.toFixed(3), reason: `already ran ${fmtX(mult)}+ since our entry (peak ${peakTxt}), rebuy blocked until ${fmtUntil(base.blockedUntil)}` };
  }
  if (!meas.covered) {
    // Partial coverage is a DATA-SHAPE outcome, not a failed lookup (the
    // candles arrived; they just start after the entry — pool migration).
    // Since 2026-10-16 it books as partialCoverage, NOT lookupFailed, so the
    // failure counter measures network truth only (GT investigation).
    return { ...base, pass: true, lookupFailed: false, partialCoverage: true, peakRatio: +meas.peakRatio.toFixed(3), reason: `peak since our entry only partly measurable (candles start after the entry; saw ${peakTxt}) — passed open (fail-open)` };
  }
  return { ...base, pass: true, lookupFailed: false, peakRatio: +meas.peakRatio.toFixed(3), reason: `peaked ${peakTxt} since our entry — under the ${fmtX(mult)} ran line` };
}

// One-go dump simulation: ALL linked supply (creator + linked networks) sold into the pool at once.
// drain = share of the pool's SOL they could pull.
export function linkedDumpCheck({ creatorUi, networks, dec, poolBaseUi, poolQuoteUi }, maxDrain = 0.35) {
  const netUi = (networks || []).reduce((a, n) => a + num(n.currentHolding), 0) / 10 ** dec;
  const x = num(creatorUi) + netUi;
  if (!(x > 0)) return { pass: true, reason: 'no linked stack' };
  const B = num(poolBaseUi), Q = num(poolQuoteUi);
  if (!(B > 0) || !(Q > 0)) return { pass: true, unknown: true, reason: 'pool data missing' };
  const drain = x / (B + x);
  return { pass: drain <= maxDrain, drain, reason: drain <= maxDrain ? `linked stack could pull ${(drain * 100).toFixed(0)}% of pool SOL` : `linked wallets could dump in one go and pull ${(drain * 100).toFixed(0)}% of pool SOL` };
}





/** Gates that no feedback, "contested" count or pace keeper may override. They describe how the coin is built, not how it looks. */
export const HARD_GATES = new Set(['rugged', 'mintAuthority', 'freezeAuthority', 'creator', 'insiders', 'clones', 'farm', 'dust', 'linkedDump', 'instantGrad', 'botflow']);
/** `fails` are strings like "insiders: 13.1% …". True if ANY failing gate is a hard gate. */
export const hasHardFail = (fails) => (fails || []).some(f => HARD_GATES.has(String(f).split(':')[0]));

/**
 * Run every gate. `rug` may be null.
 * Returns { pass, fails[], warnings[], checks }.
 */
export function runGates({ view, rug, curve = null, cfg, now = Date.now() }) {
  const checks = {};
  const warnings = [];
  const ageH = view.createdAt ? (now - view.createdAt) / 3600000 : 0;
  const ageMin = ageH * 60;

  checks.vertical = verticalLaunchCheck(ageMin, view.chgH1 ?? view.chgM5 ?? 0);
  checks.dust = dustVolumeCheck(view, { minTx: cfg.dustMinTx, maxAvgUsd: cfg.dustMaxAvgUsd });
  checks.botflow = botFlowCheck(view, ageH, { maxAgeH: cfg.botflowMaxAgeH ?? 2, minTx: cfg.botflowMinTx ?? 1000, maxAvgUsd: cfg.botflowMaxAvgUsd ?? 6 });
  checks.instantGrad = instantGradCheck(curve, ageH, { maxBuys: cfg.instantGradMaxBuys ?? 3 });

  if (!rug) {
    if (ageH < cfg.requireReportBelowAgeH) checks.report = { pass: false, reason: 'no RugCheck report for a young coin' };
    else warnings.push('no RugCheck report (older coin — allowed)');
  } else {
    const dec = num(rug.token && rug.token.decimals, 6);
    const supplyRaw = num(rug.token && rug.token.supply);
    const supplyUi = supplyRaw / 10 ** dec;
    const skip = poolOwnerSet(rug);
    const markets = (rug.markets || []).filter(m => m && m.lp);
    const top = markets.sort((a, b) => num(b.lp.lpLockedUSD) - num(a.lp.lpLockedUSD))[0];
    const lp = (top && top.lp) || {};

    if (rug.rugged === true) checks.rugged = { pass: false, reason: 'RugCheck flags RUGGED' };
    const mintAuth = rug.token && rug.token.mintAuthority, freezeAuth = rug.token && rug.token.freezeAuthority;
    if (mintAuth) checks.mintAuthority = { pass: false, reason: 'mint authority is open (dev can print tokens)' };
    if (freezeAuth) checks.freezeAuthority = { pass: false, reason: 'freeze authority is open (dev can freeze your tokens)' };

    checks.clones = cloneHolderCheck(rug.topHolders, skip);
    checks.farm = farmTiersCheck(rug.topHolders, skip, { tol: cfg.farmTolPct, minCluster: cfg.farmMinCluster, maxWallets: cfg.farmMaxWallets, maxSupplyPct: cfg.farmMaxSupplyPct });
    checks.creator = creatorDumpCheck({ creatorUi: num(rug.creatorBalance) / 10 ** dec, poolBaseUi: lp.base, poolQuoteUi: lp.quote, supplyUi }, cfg.creatorMaxDrain ?? 0.25);
    // Creator-veto volume bypass (user 2026-10-14, Eikon): the veto exists because the dev can
    // dump their stack — but when 5m volume is deep, real flow is already absorbing sells, and
    // the veto only delayed entry into the top (Eikon: skipped at $53K with $39.1K of 5m volume,
    // bought later at $307K, lost). Above CREATOR_VOL_BYPASS_USD the holdings veto becomes a
    // warning; the stack stays visible on the signal record. Only the computed-drain fail can be
    // bypassed — a missing-pool-data fail still blocks (we could not judge the stack at all).
    const creatorBypassUsd = cfg.creatorVolBypassUsd ?? 25000;
    if (!checks.creator.pass && checks.creator.drain != null && creatorBypassUsd > 0 && num(view.volM5) >= creatorBypassUsd) {
      const volTxt = Math.round(num(view.volM5)).toLocaleString('en-US');
      const barTxt = Number(creatorBypassUsd).toLocaleString('en-US');
      warnings.push(`creator: holds ${checks.creator.pct != null ? checks.creator.pct.toFixed(1) + '%' : 'a large stack'} — veto bypassed by 5m volume $${volTxt} (>= $${barTxt})`);
      checks.creator = { ...checks.creator, pass: true, bypassed: true };
    }
    checks.insiders = insiderCheck(rug.insiderNetworks, supplyRaw, cfg.insiderMaxPct);
    checks.linkedDump = linkedDumpCheck({ creatorUi: num(rug.creatorBalance) / 10 ** dec, networks: rug.insiderNetworks, dec, poolBaseUi: lp.base, poolQuoteUi: lp.quote }, cfg.linkedDumpMaxDrain);
    checks.concentration = concentrationCheck(rug.topHolders, skip);
    if (lp.lpLockedPct != null && num(lp.lpLockedPct) < 80) checks.lp = { pass: false, reason: `LP only ${num(lp.lpLockedPct)}% locked/burned — dev can pull` };
    else if (lp.lpLockedPct == null) warnings.push('LP lock unknown');
    const holders = rug.totalHolders;
    if (holders != null && ageH < cfg.requireReportBelowAgeH && holders < (cfg.minHolders ?? 100)) checks.holders = { pass: false, reason: `only ${holders} holders` };
  }

  checks.depth = exitDepthCheck(view.liq, view.mc, cfg.minLiqToMc);
  const fails = Object.entries(checks).filter(([, c]) => !c.pass).map(([k, c]) => `${k}: ${c.reason}`);
  return { pass: fails.length === 0, fails, warnings, checks };
}

/**
 * One-trade temporary rules, set by the user for the NEXT executed entry only
 * (bot clears them the moment a buy lands). Pure check over the signal view:
 *   maxMc       — refuse coins above this market cap
 *   maxDropPct  — refuse coins down this much (from the 1h high, or over 6h)
 * Returns a skip reason string, or null when the coin is allowed.
 */
export function tempRuleViolation(v, metrics, rules) {
  if (!rules || !v) return null;
  if (rules.maxMc > 0 && v.mc != null && v.mc > rules.maxMc) {
    return `temp: market cap $${Math.round(v.mc).toLocaleString('en-US')} over one-trade cap $${Number(rules.maxMc).toLocaleString('en-US')}`;
  }
  if (rules.maxDropPct > 0) {
    const dd = metrics && metrics.drawFromPeak; // 0..1 below the recent high
    if (dd != null && dd >= rules.maxDropPct / 100) return `temp: down ${(dd * 100).toFixed(0)}% from its high — one-trade crash ban (${rules.maxDropPct}%)`;
    if (v.chgH6 != null && v.chgH6 <= -rules.maxDropPct) return `temp: down ${Math.abs(v.chgH6).toFixed(0)}% over 6h — one-trade crash ban (${rules.maxDropPct}%)`;
  }
  return null;
}

/**
 * D1 (record-only): compact per-gate summary for journaling — each gate's
 * pass/fail and its reason text, nothing else. The full check objects carry
 * solver internals (drains, tiers, raw amounts); the summary is the shape
 * signal/close records persist so analysis can split by WHICH gate failed.
 */
export function summarizeGateChecks(checks) {
  if (!checks) return null;
  const out = {};
  for (const [k, c] of Object.entries(checks)) {
    if (!c) continue;
    const s = { pass: !!c.pass, reason: c.reason != null ? String(c.reason) : null };
    if (c.bypassed) s.bypassed = true;
    out[k] = s;
  }
  return out;
}
