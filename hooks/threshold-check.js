#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getCachedUsage } = require('../scripts/lib/cachedUsage.js');
const { buildReminder, handoffFilename } = require('../scripts/lib/reminder.js');
const rotation = require('../scripts/lib/rotation.js');

const BUCKET_SIZE = 50_000;
const MIN_BUCKET = 3; // 150k

function readSettings(cwd) {
  const file = path.join(cwd, '.claude', 'handoff.local.md');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { notifications: true, mid_task_check: false };
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const settings = { notifications: true, mid_task_check: false };
  if (!match) return settings;
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    settings[key] = val;
  }
  return settings;
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    process.exit(0);
  }

  const event = input.hook_event_name;
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id;
  const cwd = input.cwd || process.cwd();
  if (!transcriptPath || !sessionId) {
    process.exit(0);
  }

  if (event !== 'UserPromptSubmit' && event !== 'PostToolUse') {
    process.exit(0);
  }

  const settings = readSettings(cwd);
  if (settings.notifications === false) {
    process.exit(0);
  }
  if (event === 'PostToolUse' && settings.mid_task_check !== true) {
    process.exit(0);
  }

  const cacheDir = path.join(cwd, '.claude', 'handoffs', '.cache');
  const usage = getCachedUsage(transcriptPath, cacheDir, sessionId);
  const bucket = Math.floor(usage.total / BUCKET_SIZE);
  if (bucket < MIN_BUCKET) {
    process.exit(0);
  }

  const state = rotation.readState(cwd, sessionId);
  if (bucket <= state.last_triggered_bucket) {
    process.exit(0);
  }

  // Record the bucket and arm the rotation in one write: the Stop hook will
  // look for the handoff file named below and then schedule /compact.
  const now = new Date();
  const filename = handoffFilename(sessionId, now);
  state.last_triggered_bucket = bucket;
  state.rotation = { armed: true, armedAt: now.getTime(), expectedFile: filename };
  try {
    rotation.writeState(cwd, sessionId, state);
  } catch {
    process.exit(0);
  }

  const reminder = buildReminder(usage.total, sessionId, {
    mid_task: event === 'PostToolUse',
    now,
  });

  const output = {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

main().catch(() => process.exit(0));
