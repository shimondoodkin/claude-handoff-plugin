'use strict';

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

// Name of the handoff file the agent is asked to write. The hooks arm the
// rotation with this exact name so the Stop hook can find it afterwards.
function handoffFilename(sessionId, now) {
  return `${sessionId}-${localStamp(now)}.md`;
}

function buildReminder(tokens, sessionId, opts) {
  const manual = opts && opts.manual === true;
  const midTask = opts && opts.mid_task === true;
  const tokensK = Math.round(tokens / 1000);
  const now = opts && opts.now instanceof Date ? opts.now : new Date();
  const filename = handoffFilename(sessionId, now);

  const rotation =
    `We are doing a SESSION ROTATION now. Here is the plan: you save everything ` +
    `you need to continue working on this to memory (a handoff file). When it is ` +
    `ready, /compact runs to clean up the context. After the compact you read the ` +
    `handoff file fully and continue working where you left off. Nothing is lost ` +
    `and the user does not need to do anything.`;

  let intro;
  if (manual) {
    intro = `Manual handoff requested by the user. Token usage is ~${fmt(tokens)} (~${tokensK}k).

${rotation}

Do exactly this:`;
  } else if (midTask) {
    intro = `Token usage is now ~${fmt(tokens)} (~${tokensK}k) — crossed a threshold mid-task.

${rotation}

After your current tool call's results have been processed (don't abandon in-flight work), wrap up cleanly and then do exactly this before continuing:`;
  } else {
    intro = `Token usage is now ~${fmt(tokens)} (~${tokensK}k).

${rotation}

Before responding to the user's next message, do exactly this:`;
  }

  let closing;
  if (manual) {
    closing = `User invoked /handoff explicitly. Don't ask for confirmation; do all three steps now.`;
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
    `   Use exactly this path — the plugin watches for it.`,
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
    `3. Reply to the user with exactly:`,
    userReplyLine,
    `    Session rotation armed: /compact runs automatically in about a minute, then I read the handoff and continue."`,
    `   Then END YOUR TURN. Do not schedule anything yourself and do not run`,
    `   /clear. When your turn ends, the plugin's Stop hook sees the saved`,
    `   handoff file and schedules /compact. If the plugin cannot schedule it,`,
    `   you will get a "Stop hook feedback" message with exact CronCreate`,
    `   arguments — follow that message exactly.`,
    ``,
    `After the compact, your first action is to read ./.claude/handoffs/${filename}`,
    `in full, then continue working on the task from it.`,
    ``,
    closing,
  ].join('\n');
}

module.exports = { buildReminder, handoffFilename, localStamp };
