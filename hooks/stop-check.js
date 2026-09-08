#!/usr/bin/env node
'use strict';

// Stop hook: once a session rotation is armed and the agent has finished
// writing the handoff file, schedule "/compact" for the next minute.

const path = require('path');
const rotation = require('../scripts/lib/rotation.js');

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
  });
}

function rel(cwd, file) {
  return './' + path.relative(cwd, file).split(path.sep).join('/');
}

async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || '{}');
  } catch {
    return;
  }
  if (input.hook_event_name !== 'Stop') return;
  const sessionId = input.session_id;
  const cwd = input.cwd || process.cwd();
  if (!sessionId) return;

  const state = rotation.readState(cwd, sessionId);
  const rot = state.rotation;
  if (!rot || !rot.armed) return;

  const now = new Date();
  if (now.getTime() - rot.armedAt > rotation.ARM_TTL_MS) {
    rotation.disarm(cwd, sessionId, { expired: true });
    return;
  }

  const file = rotation.findHandoffFile(cwd, rot);
  if (!file) return; // handoff not written yet — stay armed for the next stop

  const handoff = rel(cwd, file);

  if (rotation.schedulerOwnedBy(cwd, sessionId)) {
    const { task, label } = rotation.scheduleCompactTask(cwd, now);
    rotation.disarm(cwd, sessionId, { scheduled: 'file', taskId: task.id, at: label, handoff });
    process.stdout.write(
      JSON.stringify({
        systemMessage: `Session rotation: handoff saved to ${handoff}. /compact scheduled for ${label}; the session continues from the handoff afterwards.`,
      })
    );
    return;
  }

  // No active scheduler for this session: ask the agent to create the cron
  // itself, once. stop_hook_active means we are already inside such a
  // continuation, so never block twice.
  if (input.stop_hook_active || rot.fallbackIssued) {
    rotation.disarm(cwd, sessionId, { scheduled: 'agent', handoff });
    return;
  }
  const next = rotation.nextMinuteCron(now);
  rotation.disarm(cwd, sessionId, { fallbackIssued: true, armed: true });
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `Session rotation: the handoff file ${handoff} is saved. The plugin could not schedule /compact itself ` +
        `(no active scheduler for this session yet), so do it now: call CronCreate with ` +
        `recurring: false, cron: "${next.cron}", prompt: "/compact". Then reply exactly: ` +
        `"Session rotation scheduled: /compact fires at ${next.label}, then I read the handoff and continue." ` +
        `Do nothing else this turn.`,
    })
  );
}

main().catch(() => {});
