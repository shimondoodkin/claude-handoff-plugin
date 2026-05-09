'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_SANITIZED_LENGTH = 200;

function djb2Hash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitizePath(name) {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${djb2Hash(name)}`;
}

function findLatestSessionFile(cwd) {
  const dir = path.join(os.homedir(), '.claude', 'projects', sanitizePath(cwd));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) candidates.push({ full, mtime: stat.mtimeMs });
    } catch {}
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].full;
}

function sumUsage(jsonlPath) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf-8');
  } catch {
    return { ...totals, total: 0 };
  }
  const seenIds = new Set();
  for (const line of raw.split('\n')) {
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
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    totals.input += usage.input_tokens || 0;
    totals.output += usage.output_tokens || 0;
    totals.cacheRead += usage.cache_read_input_tokens || 0;
    totals.cacheWrite += usage.cache_creation_input_tokens || 0;
  }
  const total = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return { ...totals, total };
}

module.exports = { sanitizePath, findLatestSessionFile, sumUsage };
