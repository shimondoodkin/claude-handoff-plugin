# Handoff Plugin — Design

## Goal

Two related features:

1. **`/tokens`** — a slash command the agent runs to see how many tokens have been used in the current session.
2. **Auto-handoff** — at 150k tokens (then again at every +50k bucket), inject a reminder before the agent's next turn telling it to write a forward-looking handoff file and schedule an auto-resume prompt that survives `/clear`.

The handoff is *forward-looking* — it captures what the next session needs to **finish** the work, not a recap of what happened. The agent self-curates in its own language, ranking what matters. This is the key difference from `/compact`, which is automated summarization that drops critical nuance and can't be reviewed before it lands.

## User Stories

- As an agent, I want to run `/tokens` and see total tokens I've used so I can decide whether to cut scope, summarise, or keep going.
- As a user, when my agent crosses 150k tokens, I want it to automatically write a handoff and arrange a clean restart so I don't have to babysit context length.

---

## Feature 1: `/tokens` Command

### How it works

Claude Code writes session transcripts to:

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

Each assistant line contains a `message.usage` block with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`. Each line also has `message.id` and `sessionId`.

The `/tokens` command runs a Node script that:

1. Resolves the session directory by encoding `process.cwd()` (replace `\`, `/`, `:` with `-`).
2. Picks the most recently modified `.jsonl` in that directory — that is the current session.
3. Reads line by line. For each parseable JSON line whose `message.usage` exists, accumulates input/output/cache-read/cache-write.
4. **Dedupes by `message.id`** — when the model makes parallel tool calls, Claude Code splits one API response into multiple assistant records that share the same `message.id` and the same `usage`. Counting each `id` once matches Claude Code's logic in `src/utils/tokens.ts`.
5. Prints one line.

### Output

```
Session tokens: 1,234,567 (breakdown: input 12,345 · output 23,456 · cache-read 1,180,000 · cache-write 18,766)
```

Numbers formatted with `toLocaleString('en-US')`. Single line so it's cheap when read into context.

### Trade-offs

- **Off by one turn.** Transcript is written after each API response; the `/tokens` invocation itself isn't counted yet. Acceptable for self-awareness.
- **Most-recent-file heuristic.** Two simultaneous Claude sessions in the same directory would race. Rare.
- **Post-`/clear` behaviour.** `/clear` creates a new sessionId → new JSONL → that becomes the most-recent → `/tokens` shows the post-clear session count from zero. This is the correct behaviour.

---

## Feature 2: Auto-Handoff

### Trigger logic

On every `UserPromptSubmit`, a hook reads the current token count (same logic as `/tokens`) and computes:

```
bucket = floor(tokens / 50_000)
```

Threshold buckets: 3 (=150k), 4 (=200k), 5 (=250k), …

Per session, store `last_triggered_bucket` in:

```
./.claude/handoffs/.state/<sessionId>.json
```

If `current_bucket >= 3` AND `current_bucket > last_triggered_bucket`:

1. Inject the reminder (below) as `additionalContext`.
2. Update `last_triggered_bucket = current_bucket`.

This means: fires at 150k, 200k, 250k, … each exactly once per session. After `/clear` the new sessionId means a fresh state file — correct.

### Reminder content (injected)

```
Token usage is now ~[X]. Before responding to the user's next message, do exactly this:

1. Create ./.claude/handoffs/ if it does not exist.

2. Write ./.claude/handoffs/<sessionId>-<YYYY-MM-DD-HHmmss>.md.
   This is FORWARD-LOOKING — what the next session needs to finish the work,
   not a recap. Self-curate; rank what matters most. Cover:
     - current task and goal (what the user is trying to accomplish)
     - decisions made (and rejected alternatives, with reasons)
     - user selections / preferences expressed this session
     - state of the work (what files have changed, what is done, in progress)
     - conventions you've established (naming, style, layout choices)
     - briefing patterns that worked (how user prefers to be talked to)
     - loose ends (things noticed but not addressed)
     - what you need to know to continue (open questions, gotchas, constraints)
     - concrete next steps to complete the task

3. Call CronCreate with:
     recurring: false
     cron: "<MM> <HH> <DD> <Mon> *"
       MM = current minute + 2 (gives the user 60-119 seconds to /clear).
       If current+2 lands on 0 or 30, use current+3 instead (avoid those).
       HH/DD/Mon = whatever time current+2 lands on (handle hour/day rollover).
     prompt: "Read ./.claude/handoffs/<exact-path>.md and continue the
              previous task."
     (Keep the prompt short — long prompts hit Claude Code's paste-mode
     collapse and may not submit cleanly.)

4. Reply to the user with exactly:
   "Approaching context limit (~Xk tokens). Wrote handoff to <path>.
    Scheduled auto-resume in ~60s. Run /clear now and the new session
    will pick up automatically."

This reminder is one-shot per 50k bucket. It will not fire again until the
next 50k boundary.
```

### Auto-resume mechanics

- `CronCreate` jobs survive `/clear` because `/clear` doesn't exit the Claude Code process; in-memory cron jobs persist across the conversation reset.
- The cron payload carries the literal file path, so the new sessionId post-`/clear` is irrelevant.
- One-shot (`recurring: false`) means the job auto-deletes after firing — no cleanup needed.
- If the user doesn't `/clear` in time, the cron fires in the same session anyway: agent reads its own handoff, no harm. Worst case: one wasted turn.

### No cancel command

A `/handoff:cancel` was considered. Rejected:

- Cron is one-shot and self-cleans.
- User can simply not `/clear` if they want to keep working past 150k — cron fires once in-session and that's it.
- Adds complexity (need session-agnostic state lookup post-`/clear`).

---

## Plugin Layout

```
handoff-plugin/
├── .claude-plugin/
│   ├── plugin.json
│   └── hooks/hooks.json
├── commands/
│   └── tokens.md
├── hooks/
│   └── threshold-check.js     # UserPromptSubmit hook
└── scripts/
    ├── count-tokens.js        # /tokens command body
    └── lib/transcript.js      # shared: parse JSONL, dedupe, sum usage
```

### `.claude-plugin/plugin.json`

Manifest: name `handoff`, version, description.

### `.claude-plugin/hooks/hooks.json`

One entry — `UserPromptSubmit` → `node ${CLAUDE_PLUGIN_ROOT}/hooks/threshold-check.js`.

### `commands/tokens.md`

Frontmatter `description` + `allowed-tools: Bash`. Body executes `count-tokens.js`.

### `hooks/threshold-check.js`

- Reads stdin (Claude Code passes hook payload as JSON).
- Calls shared transcript lib to compute current tokens.
- Computes bucket; reads `./.claude/handoffs/.state/<sessionId>.json`.
- If new bucket reached, writes JSON to stdout with `hookSpecificOutput.additionalContext` containing the reminder text. Updates state file.
- Otherwise outputs `{}` (no-op).

### `scripts/count-tokens.js`

Imports `lib/transcript.js`, prints the one-line summary used by `/tokens`.

### `scripts/lib/transcript.js`

Pure Node, no deps. Exports:

- `findLatestSessionFile(cwd)` → path or null
- `sumUsage(jsonlPath)` → `{ total, input, output, cacheRead, cacheWrite }` (deduped by `message.id`)

Both `count-tokens.js` and `threshold-check.js` consume this.

---

## Trade-offs (summary)

- **Auto-resume depends on `CronCreate`.** It's a built-in tool, but the agent has to actually call it. The reminder is explicit; if the agent skips step 3 the auto-resume fails and the user has to type a kickoff message. Not catastrophic.
- **Off-by-one turn on token count.** Same as the `/tokens` command. The hook reads the transcript before the next API call, so the count is one turn behind reality.
- **Bucket triggers are coarse.** A turn that adds 50k tokens (e.g. a giant `Read`) could skip a bucket. We trigger on `current > last_triggered`, so a jump from bucket 2 → bucket 4 still fires (using bucket 4 as new floor). No double-fire risk.
- **State file accumulation.** `.state/<sessionId>.json` files accumulate over time. Not auto-cleaned. Easy follow-up: prune on hook startup if `> 30 days old`.

---

## Out of Scope

- Context-window percentage display
- Cost-in-dollars estimate
- Per-model breakdown
- A `/handoff:cancel` command
- A `/handoff:resume` command (cron-fired prompt does the job)
- Pruning of old `.state/` files

## Settings

User-configurable via `./.claude/handoff.local.md` (per the `plugin-dev:plugin-settings` convention):

```markdown
---
notifications: true
---
```

- `notifications: true` (default if file missing) — auto-handoff reminder fires.
- `notifications: false` — auto-handoff disabled. `/tokens` still works.

Read by the hook on every invocation (no restart needed). Default is enabled, so the feature works out of the box.

These can be added later without changing the architecture.

---

## Testing (manual)

1. Open a Claude Code session in a directory that has the plugin installed.
2. Run `/tokens` → expect a single line with non-zero total and a breakdown that sums (within rounding) to the total.
3. Generate enough tokens to cross 150k (or temporarily lower the threshold for the test):
   - Expect the reminder injected on next prompt.
   - Expect the agent to write a handoff file and call `CronCreate`.
   - Run `/clear` within 60s.
   - Expect the prompt `"Read … and continue …"` to fire automatically and the new session to act on it.
4. Continue past 200k → expect a second reminder fire, exactly once.

Edge cases:

- No transcripts directory → `/tokens` prints clear "no session transcript found"; hook silently no-ops.
- JSONL with no usage entries → total 0; hook never triggers.
- Parallel-tool-call duplicate IDs → total matches Claude Code's `/cost` (within rounding).
- User doesn't `/clear` → cron fires in-session, agent reads handoff, continues. No error.
