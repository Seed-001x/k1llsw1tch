import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTailLines } from '../src/util.js';

test('readTailLines: small file returns all lines', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-')), 'a.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n{"a":3}\n');
  assert.deepEqual(readTailLines(f, 1024 * 1024), ['{"a":1}', '{"a":2}', '{"a":3}']);
});

test('readTailLines: huge file returns only complete tail lines within budget', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-')), 'b.jsonl');
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(JSON.stringify({ i, pad: 'x'.repeat(100) }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const out = readTailLines(f, 4096);
  assert.ok(out.length > 10 && out.length < 60, `tail size sane (${out.length})`);
  for (const l of out) assert.doesNotThrow(() => JSON.parse(l)); // no partial line
  assert.equal(JSON.parse(out[out.length - 1]).i, 4999); // ends at the true tail
});

test('readTailLines: missing file returns []', () => {
  assert.deepEqual(readTailLines('/nonexistent/nope.jsonl', 1024), []);
});
