// sources.js — discovery + live data. Every call is fail-open (returns [] / null).
//
// Discovery is QUOTA-based: each source gets its own slice of the watchlist so a noisy source
// (new launches) can never crowd out the others (volume-ranked trending, movers, graduated runners).
// This is the fix for the old bot's addrs.slice(0,120) problem.

import { fetchJson, SOL_MINT } from './util.js';
import { relayRoutePump } from './relayFetch.js';
import { fetchGtJson } from './gtFetch.js';

const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2';
const PF = 'https://frontend-api-v3.pump.fun';

// ------------------------------------------------------------------ DexScreener
export function viewOf(pair) {
  if (!pair || !pair.baseToken || !pair.baseToken.address) return null;
  const price = Number(pair.priceUsd) || null;
  const fdv = Number(pair.fdv) || null;
  const mc = Number(pair.marketCap) || fdv;
  const tx = pair.txns || {};
  const vol = pair.volume || {};
  const pc = pair.priceChange || {};
  return {
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol || '???',
    name: pair.baseToken.name || 'Unknown',
    price, mc: mc || null,
    liq: Number(pair.liquidity && pair.liquidity.usd) || 0,
    volM5: Number(vol.m5) || 0, volH1: Number(vol.h1) || 0, volH6: Number(vol.h6) || 0, volH24: Number(vol.h24) || 0,
    buysM5: Number(tx.m5 && tx.m5.buys) || 0, sellsM5: Number(tx.m5 && tx.m5.sells) || 0,
    buysH1: Number(tx.h1 && tx.h1.buys) || 0, sellsH1: Number(tx.h1 && tx.h1.sells) || 0,
    chgM5: pc.m5 != null ? Number(pc.m5) : null, chgH1: pc.h1 != null ? Number(pc.h1) : null,
    chgH6: pc.h6 != null ? Number(pc.h6) : null, chgH24: pc.h24 != null ? Number(pc.h24) : null,
    createdAt: Number(pair.pairCreatedAt) || null,
    dex: pair.dexId || null, pairAddress: pair.pairAddress || null, quote: pair.quoteToken && pair.quoteToken.symbol,
  };
}

/**
 * Pure: pick the ONE view that represents a mint from all its DexScreener pairs.
 * Default rule (unchanged): the best-liquidity pair wins.
 *
 * Graduation exception: a graduated coin keeps a CORPSE bonding-curve pair beside
 * its live PumpSwap pair, and DexScreener can keep showing the corpse with phantom
 * liquidity for a while after the flip — a best-liq read then serves frozen curve
 * aggregates and the detectors go blind on exactly the coins that just graduated
 * (Plois, 2026-10-14). So when a non-curve (AMM) pair exists AND is actually
 * trading (5m txns > 0), the best-liquidity LIVE AMM pair wins over any curve
 * pair, whatever the corpse claims. A dead AMM pair (no 5m trades) never
 * displaces a live curve pair — a still-curving coin with a random empty pool
 * keeps its curve view, exactly as before.
 */
export function selectView(pairs) {
  let best = null, bestLiveAmm = null;
  for (const p of pairs || []) {
    const v = viewOf(p);
    if (!v) continue;
    if (!best || v.liq > best.liq) best = v;
    if (p.dexId && p.dexId !== 'pumpfun') {
      const tx = (p.txns && p.txns.m5) || {};
      const activeM5 = (Number(tx.buys) || 0) + (Number(tx.sells) || 0) > 0;
      if (activeM5 && (!bestLiveAmm || v.liq > bestLiveAmm.liq)) bestLiveAmm = v;
    }
  }
  return bestLiveAmm || best;
}

/** Latest view per mint (best-liquidity pair, via selectView). Chunks of 30, fetched with bounded
 *  concurrency — the sequential version made a full watchlist sweep take ~30s at
 *  700+ mints, so the "5s poll" was really a slow crawl and widening the watchlist
 *  made each scan SLOWER (user report 2026-10-12). 6 workers keep a sweep ~2s. */
export async function fetchViews(mints) {
  const uniq = [...new Set(mints)].filter(Boolean);
  const byMint = new Map(); // mint -> every pair DexScreener returned for it
  const chunks = [];
  for (let i = 0; i < uniq.length; i += 30) chunks.push(uniq.slice(i, i + 30));
  let idx = 0;
  const worker = async () => {
    while (idx < chunks.length) {
      const chunk = chunks[idx++];
      const pairs = await fetchJson(`${DS}/tokens/v1/solana/${chunk.join(',')}`);
      for (const p of pairs || []) {
        const mint = p && p.baseToken && p.baseToken.address;
        if (!mint) continue;
        if (!byMint.has(mint)) byMint.set(mint, []);
        byMint.get(mint).push(p);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(chunks.length, 1)) }, worker));
  const best = new Map();
  for (const [mint, pairs] of byMint) {
    const v = selectView(pairs);
    if (v) best.set(mint, v);
  }
  return best;
}

/** The view of ONE pair by address — the wrong-pool guard's re-price of the
 *  pool a buy will actually execute against (bot.js, owner order
 *  2026-10-19). Same source family as the graded views (DexScreener), so
 *  the two prices are commensurate. Fail-open like every read here: any
 *  error or an unknown pair returns null, and the caller treats null as
 *  "execution pool cannot be priced" (pass-through, stamped unknown). */
export async function fetchPairView(pairAddress) {
  if (!pairAddress) return null;
  try {
    const j = await fetchJson(`${DS}/latest/dex/pairs/solana/${pairAddress}`);
    const pair = j && Array.isArray(j.pairs) ? j.pairs[0] : null;
    return pair ? viewOf(pair) : null;
  } catch { return null; }
}

let solCache = { ts: 0, price: 150 };
export async function fetchSolUsd(now = Date.now()) {
  if (now - solCache.ts < 60000) return solCache.price;
  const pairs = await fetchJson(`${DS}/tokens/v1/solana/${SOL_MINT}`);
  const p = Number(pairs && pairs[0] && pairs[0].priceUsd);
  if (p > 0) solCache = { ts: now, price: p };
  return solCache.price;
}

/**
 * Trade counts on the coin's pump.fun bonding-curve pair (for the instant-graduation gate).
 * Returns { buys, sells } from the last 24h, or null if the coin has no curve pair / data is missing.
 *
 * DexScreener's curve-pair counts cannot be trusted around graduation: it zeroes the pair
 * (0/0) some minutes AFTER the coin graduates, and before that its count is computed its
 * own way (CATBOT, 2026-10-12: curve filled in 3 buy txs / 12 bundled instructions and
 * the gate passed it). So for a FRESH graduation (<36h) the true curve history is read
 * from chain FIRST (src/curveChain.js) and DexScreener is only the fallback; older coins
 * keep the DexScreener read (the gate passes them on age anyway). The chain is also
 * consulted when the AMM pair hasn't been indexed yet — indexer lag must not read as
 * "history unknown". Any chain failure falls back — never block on unfetched evidence.
 */
export async function resolveCurve(pairs, cfg, chainFn, nowMs = Date.now()) {
  const list = Array.isArray(pairs) ? pairs : [];
  const curve = list.find(p => p && p.dexId === 'pumpfun');
  const amm = list.find(p => p && p.dexId && p.dexId !== 'pumpfun');
  if (!curve && !amm) return null;
  const h24 = (curve && curve.txns && curve.txns.h24) || {};
  const ds = curve ? { buys: Number(h24.buys) || 0, sells: Number(h24.sells) || 0 } : null;
  const gradAgeMs = amm && amm.pairCreatedAt ? nowMs - Number(amm.pairCreatedAt) : Infinity;
  const fresh = gradAgeMs < 36 * 3600 * 1000;
  const canChain = !!(cfg && cfg.rpcUrls && cfg.rpcUrls.length && chainFn);
  if (canChain && (fresh || !amm)) {
    try {
      const hist = await chainFn({ rpcUrls: cfg.rpcUrls, maxBuys: cfg.instantGradMaxBuys ?? 5 });
      if (hist && hist.buys > 0) return hist;
    } catch { /* fall through to the DexScreener result */ }
  }
  if (!amm) return null; // still on the curve (or unindexed) and chain had nothing — nothing to judge
  return ds;
}

export async function fetchCurve(mint, cfg) {
  const pairs = await fetchJson(`${DS}/token-pairs/v1/solana/${mint}`);
  let chainFn = null;
  try {
    const { fetchChainCurveHistory } = await import('./curveChain.js');
    chainFn = (opts) => fetchChainCurveHistory(mint, opts);
  } catch { /* chain reader unavailable — DexScreener only */ }
  return resolveCurve(pairs, cfg, chainFn);
}

/**
 * Pure: a graduated coin's bonding-curve lifespan in whole seconds, from the
 * DexScreener pair set of one mint — graduation time (the EARLIEST non-curve
 * pair's pairCreatedAt: the first AMM pool appears at migration) minus curve
 * start (the pumpfun pair's pairCreatedAt). Returns null whenever the
 * lifespan is not measurable: no curve pair (never a pump launch, or DS
 * dropped it), no AMM pair (not graduated / not indexed yet), a missing or
 * non-positive timestamp on either side, or an AMM stamp at/before —
 * or within the same second as — the curve stamp (a sub-second reading is
 * indexer noise, not a measurable duration). Callers must treat null as
 * UNKNOWN — never as zero, never as a block (see gate.js fastBondVerdict).
 * For TRUMARS (2026-10-16) the two stamps read 78s apart, matching the
 * GeckoTerminal first-curve-trade -> graduation read exactly.
 */
export function curveLifeFromPairs(pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  let curveTs = null, ammTs = null;
  for (const p of list) {
    if (!p || !p.dexId) continue;
    const ts = Number(p.pairCreatedAt);
    if (!(ts > 0)) continue;
    if (p.dexId === 'pumpfun') { if (curveTs == null) curveTs = ts; }
    else if (ammTs == null || ts < ammTs) ammTs = ts;
  }
  if (curveTs == null || ammTs == null) return null;
  const lifeSec = Math.floor((ammTs - curveTs) / 1000);
  return lifeSec > 0 ? lifeSec : null;
}

/** Curve lifespan for one mint via the same DexScreener token-pairs read
 *  fetchCurve uses (fail-open: any fetch error resolves to null = unknown).
 *  The timeout is bounded tighter than the 8s house default on purpose:
 *  this is fetched lazily at the entry seam, and a slow read must degrade
 *  to unknown (entry proceeds) rather than hold a fill hostage. */
export async function fetchCurveLife(mint) {
  const pairs = await fetchJson(`${DS}/token-pairs/v1/solana/${mint}`, { timeout: 5000 });
  return curveLifeFromPairs(pairs);
}

// ------------------------------------------------------------------ discovery lists
async function jupList(cfg, path) {
  const headers = cfg.jupApiKey ? { 'x-api-key': cfg.jupApiKey } : {};
  const j = await fetchJson(`${cfg.jupTokensBase}/${path}`, { headers });
  const arr = Array.isArray(j) ? j : (j && (j.data || j.tokens)) || [];
  return arr.map(t => t && (t.id || t.address || t.mint)).filter(x => typeof x === 'string');
}

async function pumpMovers(limit = 50) {
  // Via the pump relay when configured (2026-10-16 fix — same disease as
  // gradWatch): this direct v3 call was Cloudflare-403'd from the bot's host,
  // so the pump-movers-api source silently returned 0 in every cycle while
  // its relay-routed siblings returned 50-100.
  const { url, headers } = relayRoutePump(`${PF}/coins?offset=0&limit=${limit}&sort=last_trade_timestamp&order=DESC&includeNsfw=false`);
  const j = await fetchJson(url, { headers: { origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', ...headers } });
  return (Array.isArray(j) ? j : []).filter(c => c && c.mint && !c.is_banned).map(c => c.mint);
}

async function gtPools(path) {
  const j = await fetchGtJson(`${GT}/${path}`, { consumer: 'discover' });
  const out = [];
  for (const p of (j && j.data) || []) {
    const id = p.relationships && p.relationships.base_token && p.relationships.base_token.data && p.relationships.base_token.data.id;
    if (id && id.startsWith('solana_')) out.push(id.slice(7));
  }
  return out;
}

async function dsBoosts() {
  const j = await fetchJson(`${DS}/token-boosts/top/v1`);
  return (Array.isArray(j) ? j : []).filter(t => t.chainId === 'solana' && t.tokenAddress).map(t => t.tokenAddress);
}

/**
 * Returns Map(mint -> source). Quotas keep every source represented.
 * NOTE: the Jupiter token-list and GeckoTerminal sort params were written from documentation and
 * could not be verified from the build sandbox; each is fail-open and /state shows per-source counts
 * so you can see immediately if one returns nothing.
 */
export async function discover(cfg) {
  // Import pump.fun lists (the exact lists the user sees on pump.fun)
  const { fetchPumpLists } = await import('./pumpLists.js');
  const [jupTrend, jupTraded, movers, boosts, pumpLists] = await Promise.all([
    jupList(cfg, 'toptrending/1h?limit=150'),
    jupList(cfg, 'toptraded/1h?limit=150'),
    pumpMovers(80),
    dsBoosts(),
    fetchPumpLists().catch(() => ({})),
  ]);
  // Extract mints from pump.fun lists
  const pfTrending = (pumpLists.trending || []).map(c => c.address);
  const pfMovers = (pumpLists.movers || []).map(c => c.address);
  const pfGraduated = (pumpLists.graduated || []).map(c => c.address);
  const pfNew = (pumpLists.new || []).map(c => c.address);
  // Note: GeckoTerminal sources removed 2026-10-10 — API fails silently from Render.
  const plan = [
    ['pump-trending', pfTrending, 60], ['pump-movers', pfMovers, 60],
    ['pump-graduated', pfGraduated, 40], ['pump-new', pfNew, 40],
    ['jup-trending', jupTrend, 80], ['jup-traded', jupTraded, 60], ['pump-movers-api', movers, 40],
    ['boosts', boosts, 20],
  ];
  const out = new Map();
  const counts = {};
  for (const [name, list, quota] of plan) {
    let taken = 0;
    for (const m of list) {
      if (taken >= quota) break;
      if (m === SOL_MINT) continue;
      if (!out.has(m)) { out.set(m, name); taken++; }
    }
    counts[name] = { returned: list.length, taken };
  }
  out.counts = counts;
  return out;
}
