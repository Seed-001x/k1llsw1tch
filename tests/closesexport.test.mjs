// CLOSES CSV EXPORT (owner order 2026-10-19, killswitch overhaul step 2):
// GET /export/closes.csv — one row per journal close, every close field
// plus the matching open's entry fields. TOKEN-PROTECTED, not public (the
// owner's explicit override of the brief's public export): gated by the
// admin key exactly like /settings — 401 without it, 200 with it.
// The record source is the ARCHIVE ∪ HOT union (allTradesForExport): the
// rotation (src/archive.js, live since 2026-10-18) files finalized records
// older than 7 days out of the hot file, so a hot-only export silently
// drops every archived close — that hole is the pin this file guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, buildClosesCsv, csvCell, readArchivedTrades, allTradesForExport } from '../src/server.js';
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

// ---- the archive ∪ hot union ----
const ARCH_OPEN = { type: 'open', id: 'a1', mint: 'OLDC', symbol: 'OLD', setup: 'pop', entrySol: 0.1, sig: 'old-sig', ts: 100 };
const ARCH_CLOSE = { type: 'close', id: 'a1', mint: 'OLDC', symbol: 'OLD', ts: 200, pnlSol: 0.02, reason: 'archived close' };
const HOT_OPEN = { type: 'open', id: 'h1', mint: 'NEWC', symbol: 'NEW', setup: 'pop', entrySol: 0.1, sig: 'new-sig', ts: 9000 };
const HOT_CLOSE = { type: 'close', id: 'h1', mint: 'NEWC', symbol: 'NEW', ts: 9500, pnlSol: 0.01, reason: 'hot close' };

// Write the archived pair as TWO concatenated gzip members (exactly how
// archive.js appends rotation runs onto trades.jsonl.gz).
function writeArchive(journalDir, lines) {
  const half = Math.ceil(lines.length / 2);
  const members = [lines.slice(0, half), lines.slice(half)];
  const gzDir = path.join(journalDir, 'archive');
  fs.mkdirSync(gzDir, { recursive: true });
  fs.writeFileSync(path.join(gzDir, 'trades.jsonl.gz'), Buffer.concat(members.map(m => zlib.gzipSync(m.map(l => JSON.stringify(l) + '\n').join('')))));
}

test('archive: multi-member trades.jsonl.gz reads back every record', () => {
  const dir = tmp();
  writeArchive(dir, [ARCH_OPEN, ARCH_CLOSE]);
  const recs = readArchivedTrades(dir);
  assert.equal(recs.length, 2, 'both gzip members read');
  assert.deepEqual(recs.map(r => r.id), ['a1', 'a1']);
});

test('archive: absent archive falls back to hot-only without erroring', () => {
  assert.deepEqual(readArchivedTrades(tmp()), []);
  assert.deepEqual(readArchivedTrades('/no/such/dir'), []);
});

test('union: hot + archived merge, de-duped, oldest first', () => {
  const dir = tmp();
  writeArchive(dir, [ARCH_OPEN, ARCH_CLOSE]);
  const journal = { dir, trades: [HOT_OPEN, HOT_CLOSE, { ...ARCH_CLOSE }] }; // ARCH_CLOSE also hot: a crash-recovery overlap
  const merged = allTradesForExport(journal);
  assert.equal(merged.length, 4, 'the archived close is not double-counted');
  assert.deepEqual(merged.map(r => r.id), ['a1', 'a1', 'h1', 'h1'], 'oldest first');
  // journal without a dir (older stubs) → hot-only
  assert.deepEqual(allTradesForExport({ trades: [HOT_CLOSE] }), [HOT_CLOSE]);
});

test('union: a close whose open+close pair lives ONLY in the archive exports with its entry fields', () => {
  const dir = tmp();
  writeArchive(dir, [ARCH_OPEN, ARCH_CLOSE]);
  const rows = [];
  const csv = buildClosesCsv(allTradesForExport({ dir, trades: [] }));
  for (const row of csv.trim().split('\r\n')) rows.push(row);
  const hdr = rows[0].split(',');
  assert.equal(rows.length, 2, 'the archive-only close is a row');
  const iSig = hdr.indexOf('entry.sig');
  assert.ok(iSig >= 0);
  const cells = rows[1].split(',');
  assert.equal(cells[hdr.indexOf('id')], 'a1');
  assert.equal(cells[iSig], 'old-sig', 'the archived open joins the archived close');
});

// ---- the HTTP surface ----
function stubBot(dir, journalDir) {
  return { cfg: testCfg({ dataDir: dir }), positions: [], journal: { dir: journalDir || dir, trades: TRADES, tradeReports: [] } };
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

test('GET /export/closes.csv includes closes filed in the archive (hot-only would miss them)', async () => {
  const dir = tmp();
  const journalDir = tmp();
  writeArchive(journalDir, [ARCH_OPEN, ARCH_CLOSE]);
  const bot = stubBot(dir, journalDir); // hot journal holds only TRADES; a1 lives solely in the archive
  process.env.ADMIN_KEY = 'test-key';
  const srv = startServer(bot, 0);
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const r = await fetch(base + '/export/closes.csv', { headers: { 'x-admin-key': 'test-key' } });
    assert.equal(r.status, 200);
    const rows = parseCsv(await r.text());
    assert.equal(rows.length, 5, 'header + 3 hot closes + the archived close');
    const archived = rows.find(x => x[rows[0].indexOf('id')] === 'a1');
    assert.ok(archived, 'archives-only close exported');
    assert.equal(archived[rows[0].indexOf('entry.sig')], 'old-sig', 'its archived open joins it over the wire');
  } finally { srv.close(); delete process.env.ADMIN_KEY; }
});
