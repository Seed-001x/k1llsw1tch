import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { rotateJsonlFile, rotateJournalSet, recordTs } from '../src/archive.js';

const NOW = 1800000000000;
const OLD = NOW - 10 * 24 * 3600 * 1000;
const NEW = NOW - 1 * 24 * 3600 * 1000;
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'arch-')); }
function gunzipAll(f) { return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'); }

test('recordTs: reads ts, nested ev.ts, and returns null when undatable', () => {
  assert.equal(recordTs(JSON.stringify({ ts: 123 })), 123);
  assert.equal(recordTs(JSON.stringify({ t: 'ev', ev: { ts: 456 } })), 456);
  assert.equal(recordTs(JSON.stringify({ id: 'x' })), null);
  assert.equal(recordTs('not json'), null);
});

test('rotate: old records filed to gz byte-exact, new + undated + corrupt stay hot', async () => {
  const dir = tmpdir(); const file = path.join(dir, 'signals.jsonl'); const archiveDir = path.join(dir, 'archive');
  const oldLine = JSON.stringify({ id: 'old', ts: OLD });
  const newLine = JSON.stringify({ id: 'new', ts: NEW });
  const undated = JSON.stringify({ id: 'mystery' });
  fs.writeFileSync(file, [oldLine, newLine, undated, '{corrupt'].join('\n') + '\n');
  const r = await rotateJsonlFile(file, { hotMs: 7 * 24 * 3600 * 1000, now: NOW, archiveDir });
  assert.deepEqual(r, { kept: 3, archived: 1 });
  const hot = fs.readFileSync(file, 'utf8');
  assert.ok(hot.includes('"new"') && hot.includes('"mystery"') && hot.includes('{corrupt'));
  assert.ok(!hot.includes('"old"'));
  assert.equal(gunzipAll(path.join(archiveDir, 'signals.jsonl.gz')).trim(), oldLine);
  assert.ok(!fs.existsSync(file + '.rot-old'));
});

test('rotate: second run appends to the same gz (multi-member) and archives nothing new', async () => {
  const dir = tmpdir(); const file = path.join(dir, 'a.jsonl'); const archiveDir = path.join(dir, 'archive');
  fs.writeFileSync(file, JSON.stringify({ ts: OLD }) + '\n');
  await rotateJsonlFile(file, { hotMs: 7 * 24 * 3600 * 1000, now: NOW, archiveDir });
  const older2 = JSON.stringify({ ts: OLD - 1000 });
  fs.writeFileSync(file, older2 + '\n' + JSON.stringify({ ts: NEW }) + '\n');
  const r2 = await rotateJsonlFile(file, { hotMs: 7 * 24 * 3600 * 1000, now: NOW, archiveDir });
  assert.deepEqual(r2, { kept: 1, archived: 1 });
  const all = gunzipAll(path.join(archiveDir, 'a.jsonl.gz')).trim().split('\n');
  assert.equal(all.length, 2);
  assert.ok(all.includes(older2));
});

test('rotate: crashed-run leftover .rot-old is recovered, nothing lost', async () => {
  const dir = tmpdir(); const file = path.join(dir, 'b.jsonl'); const archiveDir = path.join(dir, 'archive');
  fs.writeFileSync(file, JSON.stringify({ ts: NEW, id: 'live' }) + '\n');
  fs.writeFileSync(file + '.rot-old', JSON.stringify({ ts: OLD, id: 'crashed-old' }) + '\n' + JSON.stringify({ ts: NEW, id: 'crashed-new' }) + '\n');
  const r = await rotateJsonlFile(file, { hotMs: 7 * 24 * 3600 * 1000, now: NOW, archiveDir });
  assert.deepEqual(r, { kept: 1, archived: 1 });
  const hot = fs.readFileSync(file, 'utf8');
  assert.ok(hot.includes('"live"') && hot.includes('"crashed-new"'));
  assert.ok(gunzipAll(path.join(archiveDir, 'b.jsonl.gz')).includes('"crashed-old"'));
  assert.ok(!fs.existsSync(file + '.rot-old'));
});

test('rotateJournalSet: manifest carries lifetime totals; missing files are skipped', async () => {
  const dir = tmpdir(); const archiveDir = path.join(dir, 'archive');
  const f1 = path.join(dir, 'x.jsonl');
  fs.writeFileSync(f1, JSON.stringify({ ts: OLD }) + '\n' + JSON.stringify({ ts: NEW }) + '\n');
  const { summary, manifest } = await rotateJournalSet([f1, path.join(dir, 'missing.jsonl')], { hotDays: 7, now: NOW, archiveDir });
  assert.equal(summary.archived, 1);
  assert.equal(manifest.files['x.jsonl'].archivedTotal, 1);
  assert.ok(manifest.files['x.jsonl'].gzBytes > 0);
});
