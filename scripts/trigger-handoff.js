#!/usr/bin/env node
'use strict';

const path = require('path');
const { findLatestSessionFile, sumUsage } = require('./lib/transcript.js');
const { buildReminder } = require('./lib/reminder.js');

const cwd = process.cwd();
const file = findLatestSessionFile(cwd);
if (!file) {
  console.log('No session transcript found for this project — cannot generate handoff.');
  process.exit(0);
}

const sessionId = path.basename(file, '.jsonl');
const usage = sumUsage(file);
console.log(buildReminder(usage.total, sessionId, { manual: true }));
