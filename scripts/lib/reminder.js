'use strict';

function fmt(n) {
  return n.toLocaleString('en-US');
}

function buildReminder(tokens, sessionId, opts) {
  const manual = opts && opts.manual === true;
  const tokensK = Math.round(tokens / 1000);
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
  const filename = `${sessionId}-${stamp}.md`;

  const intro = manual
    ? `Manual handoff requested by the user. Token usage is ~${fmt(tokens)} (~${tokensK}k). Do exactly this:`
    : `Token usage is now ~${fmt(tokens)} (~${tokensK}k). Before responding to the user's next message, do exactly this:`;

  const closing = manual
    ? `User invoked /handoff explicitly. Don't ask for confirmation; do all four steps now.`
    : `This reminder fires once per 50k bucket above 150k. It will not repeat until the next 50k boundary.`;

  return [
    intro,
    ``,
    `1. Create ./.claude/handoffs/ if it does not exist.`,
    ``,
    `2. Write ./.claude/handoffs/${filename}.`,
    `   This is FORWARD-LOOKING — what the next session needs to finish the work,`,
    `   not a recap. Self-curate; rank what matters most. Cover:`,
    `     - current task and goal (what the user is trying to accomplish)`,
    `     - decisions made (and rejected alternatives, with reasons)`,
    `     - user selections / preferences expressed this session`,
    `     - state of the work (what files have changed, what is done, in progress)`,
    `     - conventions you've established (naming, style, layout choices)`,
    `     - briefing patterns that worked (how the user prefers to be talked to)`,
    `     - loose ends (things noticed but not addressed)`,
    `     - what you need to know to continue (open questions, gotchas, constraints)`,
    `     - concrete next steps to complete the task`,
    ``,
    `3. Call CronCreate with:`,
    `     recurring: false`,
    `     cron: "<MM> <HH> <DD> <Mon> *"`,
    `       MM = current minute + 2 (gives the user 60-119s to /clear).`,
    `       If current+2 lands on 0 or 30, use current+3 instead (avoid those).`,
    `       HH/DD/Mon = whatever time current+2 lands on (handle hour/day rollover).`,
    `     prompt: "Read ./.claude/handoffs/${filename} and continue the previous task."`,
    `     (Keep the prompt short — long prompts hit Claude Code's paste-mode collapse.)`,
    ``,
    `4. Reply to the user with exactly:`,
    manual
      ? `   "Wrote handoff to ./.claude/handoffs/${filename}.`
      : `   "Approaching context limit (~${tokensK}k tokens). Wrote handoff to ./.claude/handoffs/${filename}.`,
    `    Scheduled auto-resume in ~60-120s. Run /clear now and the new session will pick up automatically."`,
    ``,
    closing,
  ].join('\n');
}

module.exports = { buildReminder };
