// CLOSES CSV EXPORT (owner order 2026-10-19, killswitch overhaul step 2):
// GET /export/closes.csv — one row per journal close, every close field
// plus the matching open's entry fields. TOKEN-PROTECTED, not public (the
// owner's explicit override of the brief's public export): gated by the
// admin key exactly like /settings — 401 without it, 200 with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, buildClosesCsv, csvCell } from '../src/server.js';
import { testCfg, tmp } from './helpers.mjs';

// Minimal RFC-4180 reader for assertions (quoted cells, "" escapes,
// embedded commas/newlines).
function parseCsv(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const TRADES = [
  { type: 'open', id: 'p1', mint: 'MINTA', symbol: 'AAA', setup: 'pop', entrySol: 0.1, ts: 1000, sig: 'sig-1', stamp: { cfg: 'x,y', digest: 'd1' }, tokensRaw: '123456' },
  { type: 'sell', id: 'p1', mint: 'MINTA', fraction: 0.6, solOut: 0.07, ts: 2000 }, // partial bank — NOT a close, never a row
  { type: 'close', id: 'p1', mint: 'MINTA', symbol: 'AAA', setup: 'pop', ts: 3000, pnlSol: 0.0123, pnlPct: 12.3, reason: 'tp ladder, final', heldMin: 5, entry: { mc: 42000, holders: 300 }, gates: { rug: { pass: true } }, manual: false },
  { type: 'open', id: 'p2', mint: 'MINTB', symbol: 'BBB', setup: 'bottom', entrySol: 0.1, ts: 4000, stamp: null },
  { type: 'close', id: 'p2', mint: 'MINTB', symbol: 'BBB', ts: 5000, pnlSol: -0.05, reason: 'death "quote" collapse', entry: null },
  { type: 'close', id: 'pX', mint: 'MINTZ', symbol: 'ZZZ', ts: 6000, pnlSol: 0.001, reason: 'reconcile: sold outside bot' }, // no open anywhere — entry cells stay empty
];

test('csvCell: scalars pass through, objects JSON-encode, quoting is exact', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(0.1), '0.1');
  assert.equal(csvCell(false), 'false');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.equal(csvCell([1, 2]), '"[1,2]"');
});

test('buildClosesCsv: one row per close, entry fields joined by position id, no duplicate columns', () => {
  const rows = parseCsv(buildClosesCsv(TRADES));
  const header = rows[0];
  assert.equal(new Set(header).size, header.length, 'no column appears twice');
  assert.ok(!header.includes('entry'), 'the close\'s nested entry snapshot is not a raw column');
  for (const k of ['type', 'id', 'mint', 'pnlSol', 'reason', 'gates', 'entry.entrySol', 'entry.sig', 'entry.stamp', 'entry.tokensRaw']) {
    assert.ok(header.includes(k), `header carries ${k}`);
  }
  assert.equal(rows.length, 4, 'header + exactly 3 closes (the sell record is not a row)');
  const at = (row, k) => row[header.indexOf(k)];
  const r1 = rows[1];
  assert.equal(at(r1, 'id'), 'p1');
  assert.equal(at(r1, 'reason'), 'tp ladder, final', 'comma-bearing reason survives the round-trip');
  assert.equal(at(r1, 'gates'), '{"rug":{"pass":true}}', 'nested close objects ride as JSON');
  assert.equal(at(r1, 'entry.entrySol'), '0.1');
  assert.equal(at(r1, 'entry.sig'), 'sig-1');
  assert.equal(at(r1, 'entry.stamp'), '{"cfg":"x,y","digest":"d1"}', 'nested entry objects ride as JSON');
  const r2 = rows[2];
  assert.equal(at(r2, 'reason'), 'death "quote" collapse', 'quote-bearing reason survives the round-trip');
  assert.equal(at(r2, 'entry.entrySol'), '0.1');
  assert.equal(at(r2, 'entry.stamp'), '', 'a null entry field exports empty');
  const r3 = rows[3];
  assert.equal(at(r3, 'id'), 'pX');
  assert.equal(at(r3, 'entry.entrySol'), '', 'an unmatched close exports with empty entry cells');
});

test('buildClosesCsv: a close whose id drifted still joins the latest open of its mint', () => {
  const rows = parseCsv(buildClosesCsv([
    { type: 'open', id: 'o1', mint: 'M', entrySol: 0.2, ts: 1 },
    { type: 'close', id: 'drifted', mint: 'M', pnlSol: 0.01, ts: 2 },
  ]));
  assert.equal(rows[1][rows[0].indexOf('entry.entrySol')], '0.2');
  assert.equal(buildClosesCsv([]), '\r\n', 'no closes → header-only document');
  assert.equal(buildClosesCsv([{ type: 'open', id: 'o', mint: 'M', ts: 1 }]), '\r\n');
});

// ---- the HTTP surface ----
function stubBot(dir) {
  return { cfg: testCfg({ dataDir: dir }), positions: [], journal: { trades: TRADES, tradeReports: [] } };
}

test('GET /export/closes.csv refuses without the admin key and serves CSV with it', async () => {
  const bot = stubBot(tmp());
  process.env.ADMIN_KEY = 'test-key';
  const srv = startServer(bot, 0);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    assert.equal((await fetch(base + '/export/closes.csv')).status, 401, 'no key → 401');
    assert.equal((await fetch(base + '/export/closes.csv', { headers: { 'x-admin-key': 'wrong' } })).status, 401, 'wrong key → 401');
    const r = await fetch(base + '/export/closes.csv', { headers: { 'x-admin-key': 'test-key' } });
    assert.equal(r.status, 200, 'the key opens it');
    assert.match(r.headers.get('content-type') || '', /text\/csv/);
    const rows = parseCsv(await r.text());
    assert.equal(rows.length, 4, 'header + 3 closes over the wire');
    assert.equal(rows[1][rows[0].indexOf('id')], 'p1');
  } finally { srv.close(); delete process.env.ADMIN_KEY; }
});
