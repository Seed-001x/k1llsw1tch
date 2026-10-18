import { loadConfig, validateConfig } from './config.js';
import { Executor } from './exec.js';
import { Bot } from './bot.js';
import { startServer } from './server.js';
import { discover, fetchViews, fetchSolUsd, fetchCurve, fetchCurveLife } from './sources.js';
import { fetchRug, fetchHolderCount, ranRebuyCheck } from './gate.js';

const cfg = loadConfig();
const errs = validateConfig(cfg);
if (errs.length) { console.error('Config errors:\n - ' + errs.join('\n - ')); process.exit(1); }

const exec = new Executor(cfg);
const bot = new Bot(cfg, { discover, fetchViews, fetchSolUsd, fetchRug, fetchCurve: (mint) => fetchCurve(mint, cfg), fetchCurveLife, fetchHolderCount: (mint) => fetchHolderCount(mint, { rpcUrls: cfg.rpcUrls }), ranRebuyCheck, exec });

console.log(`[edgebot] mode=${cfg.realMode ? 'REAL' : 'SHADOW'}${cfg.modeWarning ? '  (' + cfg.modeWarning + ')' : ''}`);
console.log(`[edgebot] limits: ${cfg.tradeSol} SOL/trade, ${cfg.maxPositions} positions, daily loss cap ${cfg.dailyLossSol} SOL, kill at <${cfg.killEquityFrac * 100}% equity`);

const boot = await bot.start();
console.log(`[edgebot] wallet ${cfg.realMode ? await exec.address() : '(shadow)'} balance ${boot.solBalance} SOL, ${boot.openPositions} open positions restored`);
startServer(bot, cfg.port);

// Live new-coin feed (PumpPortal websocket): brand-new launches land in the
// watchlist within seconds, long before the REST APIs index them. Fail-open.
if (cfg.liveFeed) {
  const { LiveFeed } = await import('./liveFeed.js');
  const feed = new LiveFeed({
    url: cfg.liveFeedUrl,
    apiKey: cfg.pumpportalApiKey,
    onMint: (mint) => bot.noteMint(mint, 'live-ws'),
    onTrade: (cfg.fastPop || cfg.ratchetShadow) ? (mint, trade) => bot.noteTrade(mint, trade) : null,
    tradeWatch: (cfg.fastPop || cfg.ratchetShadow) ? () => bot.tradeWatchMints() : null,
    onStats: (s) => { bot.stats.liveFeed = s; },
  });
  feed.start();
  process.on('SIGTERM', () => feed.stop());
}

// Smart-wallet flow (user 2026-10-14): tracked wallets' buys fire 'flow' signals into
// the same onSignal pipeline. Polls the existing Helius RPC; inert unless FLOW_WALLETS
// or FLOW_SOLO_WALLETS is set. Fail-open.
if (cfg.flowEnabled && (cfg.flowWallets.length || cfg.flowSoloWallets.length)) {
  const { FlowWatch } = await import('./flowWatch.js');
  const flow = new FlowWatch({
    cfg,
    onTrigger: (mint, agg) => bot._evalFlow(mint, agg).catch(e => bot.err('flow', e)),
  });
  flow.start();
  process.on('SIGTERM', () => flow.stop());
  console.log(`[edgebot] flow watch: ${flow.wallets.length} wallets (${cfg.flowSoloWallets.length} solo), polling every ${cfg.flowPollSec}s`);
  if (cfg.flowLiveWallets) console.log(`[edgebot] flow live set: ${cfg.flowLiveWallets.length ? cfg.flowLiveWallets.map(a => flow.nameFor(a)).join(', ') : '(none — flow fully shadow-only)'} — every other flow trigger journals as shadow`);
}

// Wallet-task shadow detectors (user brief 2026-10-14 Phases 4–6; go 2026-10-15):
// dev launches + survivor confluence over the Phase 1–3 wallet sets. LOG-ONLY —
// events are gate-judged in shadow and outcome-tracked; promotion is a flag the
// user acts on. Polls the existing Helius RPC; fail-open.
if (cfg.walletWatchEnabled && bot.walletWatch) {
  bot.walletWatch.start();
  process.on('SIGTERM', () => bot.walletWatch.stop());
}

// Graduation watch (user 2026-10-14): polls pump.fun's v3 API for fresh
// completions every GRAD_POLL_SEC and feeds them into the watchlist through
// noteMint's reserved slice (source 'graduated'). The /reallists graduated list
// arrives empty and the scrape is 3-hourly — post-graduation runners like Plois
// were invisible without this. Fail-open.
if (cfg.gradWatchEnabled) {
  const { GradWatch } = await import('./gradWatch.js');
  const grad = new GradWatch({
    cfg,
    onAdd: (mint) => bot.noteMint(mint, 'graduated'),
    onStats: (s) => { bot.stats.gradWatch = s; },
  });
  grad.start();
  process.on('SIGTERM', () => grad.stop());
  console.log(`[edgebot] graduation watch: polling pump.fun completions every ${cfg.gradPollSec}s (fresh = last trade within ${cfg.gradFreshMin}m of first sighting)`);
}

const every = (sec, fn) => { fn(); return setInterval(fn, sec * 1000); };
every(cfg.discoverEverySec, () => bot.discoverTick());
every(cfg.pollEverySec, () => bot.pollTick());
every(cfg.positionEverySec, () => bot.positionTick());
every(60, () => bot.reconcilePositions());

process.on('unhandledRejection', (e) => console.error('[edgebot] unhandledRejection', e && e.message));
process.on('SIGTERM', () => { console.log('[edgebot] SIGTERM — positions are persisted; exiting'); process.exit(0); });
