#!/usr/bin/env node
'use strict';

const { findLatestSessionFile, sumUsage } = require('./lib/transcript.js');

function fmt(n) {
  return n.toLocaleString('en-US');
}

const file = findLatestSessionFile(process.cwd());
if (!file) {
  console.log('Session tokens: no transcript found for this project directory.');
  process.exit(0);
}

const u = sumUsage(file);
console.log(
  `Session tokens: ${fmt(u.total)} (breakdown: input ${fmt(u.input)} · output ${fmt(u.output)} · cache-read ${fmt(u.cacheRead)} · cache-write ${fmt(u.cacheWrite)})`
);
