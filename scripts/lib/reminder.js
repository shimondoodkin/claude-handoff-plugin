'use strict';

const path = require('path');

function fmt(n) {
  return n.toLocaleString('en-US');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function localStamp(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`
  );
}

// Compute the cron string in local time. Aim for ~2 minutes from now; bump to
// +3 if we'd land on 0 or 30 to avoid common cron boundaries.
// Returns "<MM> <HH> <DD> <Mon> *". CronCreate interprets cron in local time,
// and Date.get* return local time, so timezones line up.
function computeCron(now) {
  const target = new Date(now.getTime() + 2 * 60_000);
  let mm = target.getMinutes();
  if (mm === 0 || mm === 30) {
    target.setTime(target.getTime() + 60_000);
    mm = target.getMinutes();
  }
  const hh = target.getHours();
  const dd = target.getDate();
  const mon = target.getMonth() + 1;
  return `${mm} ${hh} ${dd} ${mon} *`;
}

function buildReminder(tokens, sessionId, opts) {
  const manual = opts && opts.manual === true;
  const midTask = opts && opts.mid_task === true;
  const tokensK = Math.round(tokens / 1000);
  const now = opts && opts.now instanceof Date ? opts.now : new Date();
  const filename = `${sessionId}-${localStamp(now)}.md`;
  const pluginRoot =
    (opts && opts.pluginRoot) ||
    process.env.CLAUDE_PLUGIN_ROOT ||
    path.resolve(__dirname, '..', '..');
  const cronScript = path.join(pluginRoot, 'scripts', 'compute-cron.js');

  let intro;
  if (manual) {
    intro = `Manual handoff requested by the user. Token usage is ~${fmt(tokens)} (~${tokensK}k). Do exactly this:`;
  } else if (midTask) {
    intro = `Token usage is now ~${fmt(tokens)} (~${tokensK}k) — crossed a threshold mid-task. After your current tool call's results have been processed (don't abandon in-flight work), wrap up cleanly and then do exactly this before continuing:`;
  } else {
    intro = `Token usage is now ~${fmt(tokens)} (~${tokensK}k). Before responding to the user's next message, do exactly this:`;
  }

  let closing;
  if (manual) {
    closing = `User invoked /handoff explicitly. Don't ask for confirmation; do all five steps now.`;
  } else if (midTask) {
    closing = `This reminder fires once per 50k bucket above 150k (between tool calls, since mid_task_check is enabled). It will not repeat until the next 50k boundary.`;
  } else {
    closing = `This reminder fires once per 50k bucket above 150k. It will not repeat until the next 50k boundary.`;
  }

  let userReplyLine;
  if (manual) {
    userReplyLine = `   "Wrote handoff to ./.claude/handoffs/${filename}.`;
  } else if (midTask) {
    userReplyLine = `   "Crossed context threshold mid-task (~${tokensK}k). Wrote handoff to ./.claude/handoffs/${filename}.`;
  } else {
    userReplyLine = `   "Approaching context limit (~${tokensK}k tokens). Wrote handoff to ./.claude/handoffs/${filename}.`;
  }

  return [
    intro,
    ``,
    `1. Create ./.claude/handoffs/ if it does not exist.`,
    ``,
    `2. Write handoff file for yourself ./.claude/handoffs/${filename}.`,
    `   This is FORWARD-LOOKING — what the next session needs to finish the work,`,
    `   not a recap. Self-curate; rank what matters most. self check to not miss:`,
    `     - current task and goal (what the user is trying to accomplish)`,
    `     - list of all the important files you want to continue know about`,
    `     - decisions made (and rejected alternatives, with reasons)`,
    `     - user selections / preferences expressed this session`,
    `     - state of the work (what files have changed, what is done, in progress)`,
    `     - conventions you've established (naming, style, layout choices)`,
    `     - briefing patterns that worked (how the user prefers to be talked to)`,
    `     - loose ends (things noticed but not addressed)`,
    `     - what you need to know to continue (open questions, gotchas, constraints)`,
    `     - concrete next steps to complete the task`,
    ``,
    `3. Get a FRESH cron string by running this Bash command (do this AFTER step 2,`,
    `   not before — writing the handoff can take longer than the 2-minute schedule`,
    `   window, so we compute the cron at this moment using the system clock):`,
    `     node "${cronScript}"`,
    `   It prints a single line like "32 14 9 5 *". Use that exact string in step 4.`,
    ``,
    `4. Call CronCreate IMMEDIATELY after step 3 with these EXACT values:`,
    `     recurring: false`,
    `     cron: <the string printed by step 3>`,
    `     prompt: "/clear\\nRead ./.claude/handoffs/${filename} and continue the previous task."`,
    `   The leading /clear is required — CronCreate fires into the existing session,`,
    `   so the prompt must clear first or the resume runs on top of the old context.`,
    `   Verify the cron is still in the FUTURE before calling CronCreate. If more`,
    `   than ~30 seconds passed since step 3, or you did any other tool calls in`,
    `   between, re-run step 3 to get a fresh string — a cron in the past will not`,
    `   fire until next year. Don't compute the cron yourself; your clock estimate`,
    `   is unreliable. Keep the prompt short — long prompts hit Claude Code's`,
    `   paste-mode collapse.`,
    ``,
    `5. Reply to the user with exactly:`,
    userReplyLine,
    `    Scheduled auto-resume in ~60-120s — it will /clear and pick up automatically."`,
    ``,
    closing,
  ].join('\n');
}

module.exports = { buildReminder, computeCron, localStamp };
