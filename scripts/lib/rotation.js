'use strict';

// Session-rotation state machine shared by the hooks and the /handoff command.
//
// Flow:
//   1. arm()            — the reminder was injected; remember which handoff file
//                         we expect the agent to write.
//   2. Stop hook        — the agent ended its turn. If the handoff file exists,
//                         schedule "/compact" for the next minute:
//        a. primary:  this session owns .claude/scheduled_tasks.lock, so its
//                     cron scheduler is watching .claude/scheduled_tasks.json —
//                     append a one-shot task there. No agent involvement.
//        b. fallback: no scheduler for this session yet — block the stop once
//                     and hand the agent exact CronCreate arguments.
//   3. disarm()         — done (or expired after ARM_TTL_MS).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARM_TTL_MS = 30 * 60 * 1000;
const COMPACT_LEAD_MS = 90 * 1000; // fire 30-90s after the stop

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stateFile(cwd, sessionId) {
  return path.join(cwd, '.claude', 'handoffs', '.state', `${sessionId}.json`);
}

function readState(cwd, sessionId) {
  try {
    const obj = JSON.parse(fs.readFileSync(stateFile(cwd, sessionId), 'utf-8'));
    if (obj && typeof obj === 'object') {
      if (typeof obj.last_triggered_bucket !== 'number') obj.last_triggered_bucket = 0;
      return obj;
    }
  } catch {}
  return { last_triggered_bucket: 0 };
}

function writeState(cwd, sessionId, state) {
  const file = stateFile(cwd, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function arm(cwd, sessionId, expectedFile, now) {
  const state = readState(cwd, sessionId);
  state.rotation = {
    armed: true,
    armedAt: now.getTime(),
    expectedFile,
  };
  writeState(cwd, sessionId, state);
  return state;
}

function disarm(cwd, sessionId, extra) {
  const state = readState(cwd, sessionId);
  state.rotation = Object.assign({}, state.rotation, { armed: false }, extra || {});
  writeState(cwd, sessionId, state);
  return state;
}

// The handoff the agent wrote: the expected filename if present and non-empty,
// else the newest .md in .claude/handoffs/ modified since arming.
function findHandoffFile(cwd, rotation) {
  const dir = path.join(cwd, '.claude', 'handoffs');
  if (rotation && rotation.expectedFile) {
    const p = path.join(dir, rotation.expectedFile);
    try {
      if (fs.statSync(p).size > 0) return p;
    } catch {}
  }
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const since = (rotation && rotation.armedAt ? rotation.armedAt : 0) - 1000;
  let best = null;
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const p = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0 || st.mtimeMs < since) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { p, mtimeMs: st.mtimeMs };
  }
  return best ? best.p : null;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

// True when this session's process holds the scheduler lock, i.e. its cron
// scheduler is active and watching .claude/scheduled_tasks.json.
function schedulerOwnedBy(cwd, sessionId) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'scheduled_tasks.lock'), 'utf-8'));
  } catch {
    return false;
  }
  return (
    !!lock &&
    lock.sessionId === sessionId &&
    typeof lock.pid === 'number' &&
    isProcessRunning(lock.pid)
  );
}

// Cron string (local time, 5 fields) for the minute boundary >= now + leadMs.
function nextMinuteCron(now, leadMs) {
  const at = new Date(now.getTime() + (leadMs == null ? COMPACT_LEAD_MS : leadMs));
  at.setSeconds(0, 0);
  const cron = `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`;
  return { cron, at, label: `${pad2(at.getHours())}:${pad2(at.getMinutes())}` };
}

function tasksFile(cwd) {
  return path.join(cwd, '.claude', 'scheduled_tasks.json');
}

function readTasks(cwd) {
  try {
    const obj = JSON.parse(fs.readFileSync(tasksFile(cwd), 'utf-8'));
    if (obj && Array.isArray(obj.tasks)) return obj.tasks;
  } catch {}
  return [];
}

// Append a one-shot "/compact" task to .claude/scheduled_tasks.json.
// Shape matches Claude Code's CronTask: { id, cron, prompt, createdAt }.
function scheduleCompactTask(cwd, now, leadMs) {
  const next = nextMinuteCron(now, leadMs);
  const task = {
    id: `handoff-compact-${crypto.randomBytes(4).toString('hex')}`,
    cron: next.cron,
    prompt: '/compact',
    createdAt: now.getTime(),
  };
  const tasks = readTasks(cwd).filter((t) => !(t && typeof t.id === 'string' && t.id.startsWith('handoff-compact-')));
  tasks.push(task);
  fs.mkdirSync(path.dirname(tasksFile(cwd)), { recursive: true });
  fs.writeFileSync(tasksFile(cwd), JSON.stringify({ tasks }, null, 2) + '\n');
  return { task, at: next.at, label: next.label };
}

module.exports = {
  ARM_TTL_MS,
  COMPACT_LEAD_MS,
  readState,
  writeState,
  arm,
  disarm,
  findHandoffFile,
  isProcessRunning,
  schedulerOwnedBy,
  nextMinuteCron,
  scheduleCompactTask,
};
