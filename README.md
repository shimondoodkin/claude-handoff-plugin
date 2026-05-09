# claude-handoff-plugin

A Claude Code plugin that gives the agent **awareness of session token usage** and an **automatic handoff workflow** before the context window fills up.

**The difference from /compact is that this command is forward looking takes all information needed to complete the tasks** 

Three features:

- **`/tokens`** — slash command that prints how many tokens the current session has used.
- **Auto-handoff** — at 150k tokens (and again at every +50k boundary), a hook injects a one-shot reminder telling the agent to write a forward-looking handoff file and schedule an auto-resume prompt. After you `/clear`, the next session picks up automatically.
- **`/handoff`** — manually trigger the same handoff workflow at any token count (e.g. before lunch, before swapping projects, mid-task when you notice things slowing down).

## Why

The status bar shows token usage to the user, but the agent itself can't see it. As context grows, agents stay correct longer than they stay fast — so a clean restart at 150k beats limping toward 200k+. A *forward-looking* handoff (what's needed to **finish**) preserves more useful information than `/compact`'s automated summary.

## Install

In Claude Code, run:

```text
/plugin marketplace add shimondoodkin/claude-handoff-plugin
/plugin install handoff@claude-handoff-plugin
```

Or do it in one step (Claude Code will auto-add the marketplace and prompt you to install):

```text
/plugin install handoff@shimondoodkin/claude-handoff-plugin
```

Or clone and point Claude Code at the directory:

```bash
git clone https://github.com/shimondoodkin/claude-handoff-plugin.git
```

…then add it via `/plugin marketplace add /path/to/claude-handoff-plugin`.

## Usage

### `/handoff:tokens`

```text
> /handoff:tokens
Session tokens: 1,234,567 (breakdown: input 12,345 · output 23,456 · cache-read 1,180,000 · cache-write 18,766)
```

### `/handoff:handoff`

Trigger the handoff workflow manually at any time. Same instructions as the auto-handoff below, but invoked on demand (no token threshold required).

```text
> /handoff:handoff
```

### Auto-handoff

First fire at 150k tokens, then once at every additional 50k — i.e. 150k, 200k, 250k, 300k, … (never below 150k). When a threshold is crossed, the next prompt you send triggers a hook that injects this instruction to the agent:

1. Write a forward-looking handoff to `./.claude/handoffs/<sessionId>-<timestamp>.md`. Cover decisions made, user preferences, conventions established, loose ends, and concrete next steps to finish the work.
2. Schedule a one-shot `CronCreate` job for ~60–120 seconds out, with prompt `Read ./.claude/handoffs/<file>.md and continue the previous task.`
3. Tell you to `/clear`.

You run `/clear`. The cron job survives `/clear` (it lives in the Claude Code process, not the conversation), fires shortly after, and the new session picks up automatically — reading its own handoff and continuing.

If you don't `/clear` in time, the cron fires in the same session anyway. The agent reads its handoff and continues. No harm done.

## Configuration

Create `./.claude/handoff.local.md` in any project:

```markdown
---
notifications: true
mid_task_check: false
---
```

- `notifications: true` (default if file missing) — auto-handoff fires.
- `notifications: false` — auto-handoff disabled. `/tokens` and `/handoff` still work.
- `mid_task_check: false` (default) — check thresholds **only at the seam** between user prompts.
- `mid_task_check: true` — **also** check after every tool call. Catches threshold crossings during long autonomous chains, but may interrupt in-flight work. Cached so the per-tool-call cost is negligible (~150 ms node startup; actual work O(new bytes since last call)).

Changes take effect on the next prompt — no restart needed.

Add to your project's `.gitignore`:

```gitignore
.claude/*.local.md
.claude/handoffs/
```

## How it works

- **Token count.** Claude Code writes session transcripts as JSONL at `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. Each assistant line has a `message.usage` block. The plugin sums these, deduping by `message.id` to handle parallel-tool-call splits.
- **Threshold detection.** A `UserPromptSubmit` hook (and optionally `PostToolUse` if `mid_task_check: true`) computes `bucket = floor(tokens / 50_000)` and fires once per bucket ≥ 3. State is kept in `.claude/handoffs/.state/<sessionId>.json`.
- **Incremental cache.** When `mid_task_check` is on, the hook would re-parse the JSONL on every tool call. Instead it caches `(byte_offset, totals, seen_ids)` in `.claude/handoffs/.cache/<sessionId>.json` and reads only the new bytes since last invocation, deduping `message.id` across batches. Cost per call: a `stat`, a small read of new bytes (typically a few KB), a small JSON write.
- **Auto-resume.** `CronCreate` jobs are session-level (process), not conversation-level — they survive `/clear`. The cron prompt carries the literal handoff path, so the new sessionId after `/clear` doesn't matter.

## Trade-offs

- Token count is one turn behind reality (transcript is written *after* each API response).
- The auto-resume depends on the agent actually calling `CronCreate` when reminded. The reminder is explicit; if the agent skips it, you just type a kickoff message manually.
- The bucket trigger is coarse: a single huge tool call could skip a bucket. The hook still fires on the next bucket reached, so no double-fire risk.

## Cross-platform

Pure Node.js using cross-platform APIs (`os.homedir()`, `path.join`). Runs on Windows, macOS, Linux — anywhere Claude Code runs.

## License

MIT — see [LICENSE](LICENSE).
