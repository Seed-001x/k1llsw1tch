import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';

/**
 * Journal archive rotation (owner order 2026-10-18, after the boot-OOM
 * outage): finalized records older than the hot window are gzip-filed
 * into <dataDir>/archive/ so the hot .jsonl files the bot boots from
 * and serves stay lean. NOTHING is deleted — archived lines are the
 * exact original bytes, concatenated into <name>.jsonl.gz (multi-member
 * gzip; `gunzip -c` reads the whole history), and a manifest keeps the
 * lifetime counts. Records whose timestamp cannot be read STAY hot —
 * rotation never files what it cannot date.
 *
 * Mechanism (logrotate-style, safe against live appends): the hot file
 * is renamed to <file>.rot-old and a fresh empty file takes its place,
 * so appends continue uninterrupted; the .rot-old is then streamed line
 * by line — old lines to a temp gzip, kept lines appended back onto the
 * fresh hot file. A crash anywhere leaves either the untouched original
 * or a .rot-old that the next run finishes processing. Memory stays
 * bounded (one line at a time) no matter how large the file grew.
 */

export function recordTs(line) {
  try {
    const r = JSON.parse(line);
    if (!r || typeof r !== 'object') return null;
    const t = r.ts ?? r.time ?? (r.ev && r.ev.ts) ?? null;
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

async function processOldFile(oldFile, hotFile, gzTmp, cutoff) {
  let kept = 0, archived = 0;
  const keptOut = fs.createWriteStream(hotFile, { flags: 'a' });
  const gzOut = zlib.createGzip({ level: 6 });
  const gzFile = fs.createWriteStream(gzTmp);
  gzOut.pipe(gzFile);
  const rl = readline.createInterface({ input: fs.createReadStream(oldFile), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const ts = recordTs(line);
    if (ts !== null && ts < cutoff) { gzOut.write(line + '\n'); archived++; }
    else { keptOut.write(line + '\n'); kept++; }
  }
  await new Promise((res, rej) => { keptOut.end(() => res()); keptOut.on('error', rej); });
  await new Promise((res, rej) => { gzOut.end(() => res()); gzOut.on('error', rej); });
  await new Promise((res, rej) => { gzFile.on('finish', res); gzFile.on('error', rej); if (gzFile.writableFinished) res(); });
  return { kept, archived };
}

/**
 * Rotate one jsonl file. Returns { kept, archived } or null when there
 * was nothing to do / on failure (original left recoverable).
 */
export async function rotateJsonlFile(file, { hotMs, now = Date.now(), archiveDir } = {}) {
  try {
    if (!file || !archiveDir) return null;
    fs.mkdirSync(archiveDir, { recursive: true });
    const oldFile = file + '.rot-old';
    const gzTmp = path.join(archiveDir, path.basename(file) + '.tmp.gz');
    const cutoff = now - hotMs;
    // Recover a leftover from a crashed run first (its kept lines append
    // back onto the current hot file, its old lines join the archive).
    if (fs.existsSync(oldFile)) {
      const r = await processOldFile(oldFile, file, gzTmp, cutoff);
      await appendGz(gzTmp, path.join(archiveDir, path.basename(file) + '.gz'));
      fs.rmSync(oldFile, { force: true });
      return r;
    }
    if (!fs.existsSync(file)) return null;
    if (fs.statSync(file).size === 0) return { kept: 0, archived: 0 };
    fs.renameSync(file, oldFile);
    fs.writeFileSync(file, ''); // fresh hot file so appends never block
    try {
      const r = await processOldFile(oldFile, file, gzTmp, cutoff);
      await appendGz(gzTmp, path.join(archiveDir, path.basename(file) + '.gz'));
      fs.rmSync(oldFile, { force: true });
      return r;
    } catch (e) {
      // Leave .rot-old in place — the next run recovers it. The fresh
      // hot file already carries any kept lines processed so far plus
      // all new appends; nothing is lost.
      return null;
    }
  } catch { return null; }
}

async function appendGz(gzTmp, gzFinal) {
  try {
    if (!fs.existsSync(gzTmp)) return;
    if (fs.statSync(gzTmp).size === 0) { fs.rmSync(gzTmp, { force: true }); return; }
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(gzTmp);
      const ws = fs.createWriteStream(gzFinal, { flags: 'a' });
      rs.on('error', rej); ws.on('error', rej); ws.on('finish', res);
      rs.pipe(ws);
    });
    fs.rmSync(gzTmp, { force: true });
  } catch { /* temp stays for the next run to retry */ }
}

/**
 * Rotate a set of files and maintain archive/manifest.json with the
 * lifetime totals (records ever archived per file, archive bytes), so
 * scorecards and audits can account for the filed history.
 */
export async function rotateJournalSet(files, { hotDays = 7, now = Date.now(), archiveDir, log = () => {} } = {}) {
  const hotMs = hotDays * 24 * 3600 * 1000;
  const manifestFile = path.join(archiveDir, 'manifest.json');
  let manifest = { files: {} };
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) || manifest; } catch { /* first run */ }
  if (!manifest.files) manifest.files = {};
  const summary = { files: 0, archived: 0, kept: 0 };
  for (const file of files) {
    if (!file) continue;
    const r = await rotateJsonlFile(file, { hotMs, now, archiveDir });
    if (!r) continue;
    summary.files++; summary.archived += r.archived; summary.kept += r.kept;
    const name = path.basename(file);
    const m = manifest.files[name] || { archivedTotal: 0, runs: 0 };
    m.archivedTotal += r.archived; m.runs++; m.lastRunTs = now; m.lastArchived = r.archived;
    const gz = path.join(archiveDir, name + '.gz');
    try { m.gzBytes = fs.statSync(gz).size; } catch { m.gzBytes = 0; }
    manifest.files[name] = m;
    if (r.archived) log(`[archive] ${name}: filed ${r.archived} records older than ${hotDays}d (${r.kept} kept hot)`);
  }
  manifest.updatedTs = now;
  try { fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1)); } catch { /* manifest is bookkeeping */ }
  return { summary, manifest };
}
