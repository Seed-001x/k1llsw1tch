// WALLET CENSUS (owner design 2026-10-18; route picked by the owner:
// "Websocket" — a Helius RPC websocket, one logsSubscribe per open
// position's mint, each trade's transaction fetched and parsed). The
// census counts WHO is trading: distinct buyers, first-seen buyers, wash
// overlap. These tests pin the parser against REAL captured transactions
// (fixtures), the accumulator's window semantics, and the feed's
// subscribe/fetch/parse plumbing through a fake socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig, validateConfig } from '../src/config.js';
import { wsUrlFor, parseCensusTrade, newCensus, censusFold, censusWindow, censusStamp, CensusFeed } from '../src/census.js';

const MINTER = '3NxfWMHmfQg8NJFW5AG1ti2xACdczWz24e9SKyk1pump'; // PumpSwap coin the buy/sell fixtures came from
const HUG = '7rwLENa5Mkx1PRbLzSARQ3Gd9X3AzdeH4oR97RYnpump';     // curve coin the curve fixtures came from
const BOT_WALLET = '4NsKGzUXtS2p7UTpWgDZZimY9Eq6jhUJdtjEica6RWv4';
const load = (n) => JSON.parse(fs.readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8'));
const payer = (tx) => tx.transaction.message.accountKeys[0].pubkey;
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };

// ------------------------------------------------------------ config
test('config: census defaults ON (record-only witness), CENSUS_WATCH=0 turns it off', () => {
  assert.equal(loadConfig({}).censusWatch, true);
  assert.equal(loadConfig({ CENSUS_WATCH: '0' }).censusWatch, false);
  assert.equal(loadConfig({}).censusWindowMin, 10);
});

test('wsUrlFor: https RPC becomes wss, key preserved, junk rejected', () => {
  assert.equal(wsUrlFor('https://mainnet.helius-rpc.com/?api-key=abc'), 'wss://mainnet.helius-rpc.com/?api-key=abc');
  assert.equal(wsUrlFor('wss://x.example/'), 'wss://x.example/');
  assert.equal(wsUrlFor(''), null);
  assert.equal(wsUrlFor(null), null);
});

// ------------------------------------------------------------ parser (real fixtures)
test('parser: a real PumpSwap buy — trader is the fee payer, side buy, tokens sized', () => {
  const tx = load('census-buy.json');
  const t = parseCensusTrade(tx, MINTER);
  assert.ok(t, 'parsed');
  assert.equal(t.trader, payer(tx));
  assert.equal(t.side, 'buy');
  assert.ok(t.tokens > 1 && t.tokens < 1e6, 'token amount in whole tokens (12.5 in this fixture)');
  assert.ok(t.ts > 0, 'blockTime carried');
});

test('parser: a real PumpSwap sell — side sell', () => {
  const tx = load('census-sell.json');
  const t = parseCensusTrade(tx, MINTER);
  assert.ok(t, 'parsed');
  assert.equal(t.trader, payer(tx));
  assert.equal(t.side, 'sell');
});

test("parser: the bot's own curve buy — trader is the bot wallet", () => {
  const tx = load('census-curve-buy.json');
  const t = parseCensusTrade(tx, HUG);
  assert.ok(t, 'parsed');
  assert.equal(t.trader, BOT_WALLET);
  assert.equal(t.side, 'buy');
});

test('parser: a multi-party curve transaction (migration-class) is never guessed', () => {
  const tx = load('census-curve.json');
  assert.equal(parseCensusTrade(tx, HUG), null);
});

test('parser: failed transactions and other mints parse to null', () => {
  const tx = load('census-buy.json');
  const failed = JSON.parse(JSON.stringify(tx));
  failed.meta.err = { InstructionError: [0, 'Custom'] };
  assert.equal(parseCensusTrade(failed, MINTER), null);
  assert.equal(parseCensusTrade(tx, HUG), null, 'wrong mint: the payer holds no balance in it');
  assert.equal(parseCensusTrade(null, MINTER), null);
  assert.equal(parseCensusTrade({}, MINTER), null);
});

// ------------------------------------------------------------ accumulator
test('accumulator: window counts, unique buyers, first-seen "new" and wash overlap', () => {
  const c = newCensus(0);
  censusFold(c, { trader: 'A', side: 'buy', tokens: 10, ts: 1000 }, 1000);
  censusFold(c, { trader: 'B', side: 'buy', tokens: 10, ts: 2000 }, 2000);
  censusFold(c, { trader: 'A', side: 'buy', tokens: 10, ts: 3000 }, 3000);
  censusFold(c, { trader: 'A', side: 'sell', tokens: 10, ts: 4000 }, 4000);
  const w = censusWindow(c, 5000, 10000);
  assert.equal(w.buys, 3); assert.equal(w.sells, 1);
  assert.equal(w.uniqBuyers, 2);
  assert.equal(w.newBuyers, 2, 'both wallets first seen inside the window');
  assert.equal(w.wash, 1, 'A bought AND sold inside the window');
  assert.equal(w.uniqBuyersTotal, 2);
  // far later: the early trades fall out of the window entirely
  const w2 = censusWindow(c, 100000, 10000);
  assert.equal(w2.buys, 0); assert.equal(w2.uniqBuyers, 0); assert.equal(w2.newBuyers, 0);
  // a genuinely new wallet arriving late reads as new; the old hands do not
  censusFold(c, { trader: 'C', side: 'buy', tokens: 10, ts: 96000 }, 96000);
  censusFold(c, { trader: 'A', side: 'buy', tokens: 10, ts: 97000 }, 97000);
  const w3 = censusWindow(c, 100000, 10000);
  assert.equal(w3.uniqBuyers, 2);
  assert.equal(w3.newBuyers, 1, 'only C is first-seen inside the window');
});

test('accumulator: stamp shape carries totals + window reads; null without a census', () => {
  const pos = { census: newCensus(0) };
  censusFold(pos.census, { trader: 'A', side: 'buy', tokens: 5, ts: 1000 }, 1000);
  const s = censusStamp(pos, 5000, 600000);
  assert.equal(s.trades, 1); assert.equal(s.uniqBuyers, 1); assert.equal(s.buysW, 1); assert.equal(s.newBuyersW, 1);
  assert.equal(censusStamp({}, 5000, 600000), null);
  assert.equal(censusWindow(null, 0, 1000), null);
});

// ------------------------------------------------------------ feed plumbing
class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.handlers = {}; this.sent = []; FakeWS.instances.push(this); }
  on(ev, cb) { (this.handlers[ev] ||= []).push(cb); return this; }
  emit(ev, ...a) { for (const cb of this.handlers[ev] || []) cb(...a); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.emit('close'); }
}

test('feed: subscribes per desired mint, fetches + parses notifications, unsubscribes on shrink', async () => {
  FakeWS.instances = [];
  const buyTx = load('census-buy.json');
  const got = [];
  const feed = new CensusFeed({
    rpcUrls: ['https://mainnet.helius-rpc.com/?api-key=test'],
    rpcFn: async () => buyTx,
    onTrade: (mint, trade) => got.push({ mint, trade }),
    wsImpl: FakeWS,
  });
  feed.setDesired([MINTER]);
  feed.start();
  const ws = FakeWS.instances[0];
  assert.equal(ws.url, 'wss://mainnet.helius-rpc.com/?api-key=test');
  ws.emit('open');
  const sub = ws.sent.find(m => m.method === 'logsSubscribe');
  assert.ok(sub, 'logsSubscribe sent on open');
  assert.deepEqual(sub.params[0], { mentions: [MINTER] });
  ws.emit('message', JSON.stringify({ id: 'sub-' + MINTER, result: 777 }));
  // a failed tx notification is ignored before any fetch
  ws.emit('message', JSON.stringify({ method: 'logsNotification', params: { subscription: 777, result: { value: { signature: 'FAILED', err: { x: 1 } } } } }));
  ws.emit('message', JSON.stringify({ method: 'logsNotification', params: { subscription: 777, result: { value: { signature: 'SIG1', err: null } } } }));
  ws.emit('message', JSON.stringify({ method: 'logsNotification', params: { subscription: 777, result: { value: { signature: 'SIG1', err: null } } } })); // duplicate: deduped
  await flush();
  assert.equal(got.length, 1, 'one parsed trade delivered');
  assert.equal(got[0].mint, MINTER);
  assert.equal(got[0].trade.side, 'buy');
  assert.equal(got[0].trade.trader, payer(buyTx));
  assert.equal(feed.stats.parsed, 1);
  feed.setDesired([]);
  const unsub = ws.sent.find(m => m.method === 'logsUnsubscribe');
  assert.ok(unsub, 'logsUnsubscribe sent when the mint leaves the desired set');
  feed.stop();
});

test('feed: no RPC url = inert and honest about it', () => {
  const feed = new CensusFeed({ rpcUrls: [], rpcFn: async () => null });
  feed.start();
  assert.equal(feed.stats.connected, false);
  assert.equal(feed.stats.lastError, 'no ws url');
  feed.stop();
});

// ------------------------------------------------- endpoint override
// CENSUS ENDPOINT OVERRIDE (owner order 2026-10-23, after the
// 2026-10-22 blindness): the census socket derived its URL from
// RPC_URLS[0] and nothing else, so a halted primary plan darkened the
// whole deep-check layer for hours. CENSUS_RPC_URL gives the socket its
// own endpoint; empty restores the historical derivation.
test('config: CENSUS_RPC_URL defaults empty, passes through, junk fails validation', () => {
  assert.equal(loadConfig({}).censusRpcUrl, '');
  assert.equal(loadConfig({ CENSUS_RPC_URL: 'https://api.mainnet-beta.solana.com' }).censusRpcUrl, 'https://api.mainnet-beta.solana.com');
  assert.ok(validateConfig(loadConfig({ CENSUS_RPC_URL: 'notaurl' })).some(e => e.includes('CENSUS_RPC_URL')));
  assert.deepEqual(validateConfig(loadConfig({ CENSUS_RPC_URL: 'wss://example.com' })), []);
});

test('feed: the override wins over RPC_URLS[0] and the stats stamp the endpoint host only', () => {
  FakeWS.instances = [];
  const feed = new CensusFeed({
    rpcUrls: ['https://mainnet.helius-rpc.com/?api-key=<redacted>'],
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    rpcFn: async () => null,
    wsImpl: FakeWS,
  });
  feed.start();
  assert.equal(FakeWS.instances[0].url, 'wss://api.mainnet-beta.solana.com');
  assert.equal(feed.stats.endpoint, 'api.mainnet-beta.solana.com');
  feed.stop();
});

test('feed: without the override the socket derives from RPC_URLS[0] exactly as before', () => {
  FakeWS.instances = [];
  const feed = new CensusFeed({
    rpcUrls: ['https://mainnet.helius-rpc.com/?api-key=<redacted>'],
    rpcFn: async () => null,
    wsImpl: FakeWS,
  });
  feed.start();
  assert.equal(FakeWS.instances[0].url, 'wss://mainnet.helius-rpc.com/?api-key=<redacted>');
  assert.equal(feed.stats.endpoint, 'mainnet.helius-rpc.com');
  feed.stop();
});
