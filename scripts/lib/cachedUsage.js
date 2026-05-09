'use strict';

const fs = require('fs');
const path = require('path');

const EMPTY_TOTALS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function loadCache(cacheFile) {
  try {
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.byte_offset === 'number' && obj.totals && Array.isArray(obj.seen_ids)) {
      return obj;
    }
  } catch {}
  return { byte_offset: 0, totals: EMPTY_TOTALS(), seen_ids: [] };
}

function saveCache(cacheFile, cache) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
}

function readBytesFromOffset(filePath, offset, size) {
  const length = size - offset;
  if (length <= 0) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseAndAccumulate(text, cache) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry && entry.message && entry.message.usage;
    if (!usage) continue;
    const id = entry.message.id;
    if (id) {
      if (cache.seen_ids.includes(id)) continue;
      cache.seen_ids.push(id);
    }
    cache.totals.input += usage.input_tokens || 0;
    cache.totals.output += usage.output_tokens || 0;
    cache.totals.cacheRead += usage.cache_read_input_tokens || 0;
    cache.totals.cacheWrite += usage.cache_creation_input_tokens || 0;
  }
}

function getCachedUsage(transcriptPath, cacheDir, sessionId) {
  const cacheFile = path.join(cacheDir, `${sessionId}.json`);
  const cache = loadCache(cacheFile);

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return totalsToResult(cache.totals);
  }
  const size = stat.size;

  if (size <= cache.byte_offset) {
    return totalsToResult(cache.totals);
  }

  const text = readBytesFromOffset(transcriptPath, cache.byte_offset, size);
  if (!text) return totalsToResult(cache.totals);

  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    return totalsToResult(cache.totals);
  }

  const completePart = text.slice(0, lastNewline);
  const newOffset = cache.byte_offset + Buffer.byteLength(completePart, 'utf-8') + 1;

  parseAndAccumulate(completePart, cache);

  const MAX_SEEN = 5000;
  if (cache.seen_ids.length > MAX_SEEN) {
    cache.seen_ids = cache.seen_ids.slice(-MAX_SEEN);
  }

  cache.byte_offset = newOffset;
  try {
    saveCache(cacheFile, cache);
  } catch {}

  return totalsToResult(cache.totals);
}

function totalsToResult(t) {
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    total: t.input + t.output + t.cacheRead + t.cacheWrite,
  };
}

module.exports = { getCachedUsage };
