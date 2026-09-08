'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const rotation = require('../scripts/lib/rotation.js');
const { buildReminder, handoffFilename } = require('../scripts/lib/reminder.js');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-rot-'));
}

function runStopHook(cwd, input) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'stop-check.js')], {
    cwd,
    input: JSON.stringify(Object.assign({ hook_event_name: 'Stop', cwd }, input)),
    encoding: 'utf-8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('nextMinuteCron lands on a minute boundary at least leadMs away', () => {
  const now = new Date(2026, 8, 8, 14, 30, 45);
  const { cron, at } = rotation.nextMinuteCron(now, 90_000);
  assert.equal(cron, '32 14 8 9 *');
  assert.equal(at.getSeconds(), 0);
  assert.ok(at.getTime() - now.getTime() >= 60_000);
});

test('arm / readState / disarm round-trip and keep the bucket', () => {
  const cwd = tmpProject();
  rotation.writeState(cwd, 's1', { last_triggered_bucket: 3 });
  const now = new Date();
  rotation.arm(cwd, 's1', 'h.md', now);
  let st = rotation.readState(cwd, 's1');
  assert.equal(st.last_triggered_bucket, 3);
  assert.deepEqual(st.rotation, { armed: true, armedAt: now.getTime(), expectedFile: 'h.md' });
  rotation.disarm(cwd, 's1', { scheduled: 'file' });
  st = rotation.readState(cwd, 's1');
  assert.equal(st.rotation.armed, false);
  assert.equal(st.rotation.scheduled, 'file');
});

test('findHandoffFile prefers the expected file, else newest since arming', () => {
  const cwd = tmpProject();
  const dir = path.join(cwd, '.claude', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const armedAt = Date.now();
  assert.equal(rotation.findHandoffFile(cwd, { armedAt, expectedFile: 'x.md' }), null);
  fs.writeFileSync(path.join(dir, 'other.md'), 'notes');
  assert.equal(rotation.findHandoffFile(cwd, { armedAt, expectedFile: 'x.md' }), path.join(dir, 'other.md'));
  fs.writeFileSync(path.join(dir, 'x.md'), 'expected');
  assert.equal(rotation.findHandoffFile(cwd, { armedAt, expectedFile: 'x.md' }), path.join(dir, 'x.md'));
  // An old file (before arming) is ignored.
  const old = path.join(dir, 'old.md');
  fs.writeFileSync(old, 'old');
  const past = new Date(armedAt - 3_600_000);
  fs.utimesSync(old, past, past);
  assert.equal(rotation.findHandoffFile(cwd, { armedAt, expectedFile: 'nope.md' }), path.join(dir, 'x.md'));
});

test('schedulerOwnedBy requires our session id and a live pid', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  const lock = path.join(cwd, '.claude', 'scheduled_tasks.lock');
  assert.equal(rotation.schedulerOwnedBy(cwd, 's1'), false);
  fs.writeFileSync(lock, JSON.stringify({ sessionId: 's1', pid: process.pid, acquiredAt: 1 }));
  assert.equal(rotation.schedulerOwnedBy(cwd, 's1'), true);
  assert.equal(rotation.schedulerOwnedBy(cwd, 'other'), false);
  fs.writeFileSync(lock, JSON.stringify({ sessionId: 's1', pid: 999999999, acquiredAt: 1 }));
  assert.equal(rotation.schedulerOwnedBy(cwd, 's1'), false);
});

test('scheduleCompactTask appends a one-shot /compact task and keeps others', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  const file = path.join(cwd, '.claude', 'scheduled_tasks.json');
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'keep', cron: '0 9 * * *', prompt: 'hi', createdAt: 1, recurring: true }] }));
  const now = new Date(2026, 8, 8, 14, 30, 45);
  const { task, label } = rotation.scheduleCompactTask(cwd, now);
  assert.equal(label, '14:32');
  const on = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(on.tasks.length, 2);
  assert.equal(on.tasks[0].id, 'keep');
  assert.deepEqual(on.tasks[1], { id: task.id, cron: '32 14 8 9 *', prompt: '/compact', createdAt: now.getTime() });
  assert.ok(task.id.startsWith('handoff-compact-'));
  // Rescheduling replaces a previous pending compact task rather than stacking.
  rotation.scheduleCompactTask(cwd, now);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).tasks.length, 2);
});

test('stop hook: not armed -> silent; armed without file -> stays armed', () => {
  const cwd = tmpProject();
  assert.equal(runStopHook(cwd, { session_id: 's1' }), null);
  rotation.arm(cwd, 's1', 'h.md', new Date());
  assert.equal(runStopHook(cwd, { session_id: 's1' }), null);
  assert.equal(rotation.readState(cwd, 's1').rotation.armed, true);
});

test('stop hook: owned scheduler -> writes /compact task, disarms, systemMessage', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude', 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'scheduled_tasks.lock'), JSON.stringify({ sessionId: 's1', pid: process.pid, acquiredAt: 1 }));
  rotation.arm(cwd, 's1', 'h.md', new Date());
  fs.writeFileSync(path.join(cwd, '.claude', 'handoffs', 'h.md'), '# handoff');
  const out = runStopHook(cwd, { session_id: 's1' });
  assert.match(out.systemMessage, /\/compact scheduled for \d\d:\d\d/);
  assert.match(out.systemMessage, /\.\/\.claude\/handoffs\/h\.md/);
  assert.equal(out.decision, undefined);
  const tasks = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'scheduled_tasks.json'), 'utf-8')).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].prompt, '/compact');
  const st = rotation.readState(cwd, 's1').rotation;
  assert.equal(st.armed, false);
  assert.equal(st.scheduled, 'file');
});

test('stop hook: no scheduler -> blocks once with CronCreate args, then lets go', () => {
  const cwd = tmpProject();
  fs.mkdirSync(path.join(cwd, '.claude', 'handoffs'), { recursive: true });
  rotation.arm(cwd, 's1', 'h.md', new Date());
  fs.writeFileSync(path.join(cwd, '.claude', 'handoffs', 'h.md'), '# handoff');
  const first = runStopHook(cwd, { session_id: 's1' });
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /CronCreate/);
  assert.match(first.reason, /cron: "\d+ \d+ \d+ \d+ \*"/);
  assert.match(first.reason, /prompt: "\/compact"/);
  assert.equal(fs.existsSync(path.join(cwd, '.claude', 'scheduled_tasks.json')), false);
  const second = runStopHook(cwd, { session_id: 's1', stop_hook_active: true });
  assert.equal(second, null);
  assert.equal(rotation.readState(cwd, 's1').rotation.armed, false);
});

test('reminder: no cron steps, tells the agent the hook schedules /compact', () => {
  const now = new Date(2026, 8, 8, 14, 30, 0);
  const t = buildReminder(151000, 'sess', { manual: true, now });
  assert.equal(handoffFilename('sess', now), 'sess-2026-09-08-14-30-00.md');
  assert.match(t, /SESSION ROTATION/);
  assert.match(t, /sess-2026-09-08-14-30-00\.md/);
  assert.doesNotMatch(t, /CronCreate TWICE|compute-cron|line from step 3/);
  assert.match(t, /END YOUR TURN/);
  assert.match(t, /Stop hook feedback/);
});
