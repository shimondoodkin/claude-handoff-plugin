#!/usr/bin/env node
'use strict';

const path = require('path');
const { findLatestSessionFile, sumUsage } = require('./lib/transcript.js');
const { buildReminder, handoffFilename } = require('./lib/reminder.js');
const rotation = require('./lib/rotation.js');

const cwd = process.cwd();
const file = findLatestSessionFile(cwd);
if (!file) {
  console.log('No session transcript found for this project — cannot generate handoff.');
  process.exit(0);
}

const sessionId = path.basename(file, '.jsonl');
const usage = sumUsage(file);
const now = new Date();

// Arm the rotation so the Stop hook schedules /compact once the handoff
// file exists. Best-effort: the reminder is still useful without it.
try {
  rotation.arm(cwd, sessionId, handoffFilename(sessionId, now), now);
} catch {}

console.log(buildReminder(usage.total, sessionId, { manual: true, now }));
