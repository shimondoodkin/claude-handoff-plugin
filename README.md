# claude-handoff-plugin

A Claude Code plugin that gives the agent **awareness of session token usage** and an **automatic handoff workflow** before the context window fills up.

Two features:

- **`/tokens`** — slash command that prints how many tokens the current session has used.
- **Auto-handoff** — at 150k tokens (and again at every +50k boundary), a hook injects a one-shot reminder telling the agent to write a forward-looking handoff file and schedule an auto-resume prompt. After you `/clear`, the next session picks up automatically.

## Why

The status bar shows token usage to the user, but the agent itself can't see it. As context grows, agents stay correct longer than they stay fast — so a clean restart at 150k beats limping toward 200k+. A *forward-looking* handoff (what's needed to **finish**) preserves more useful information than `/compact`'s automated summary.

## Install

```text
/plugin install shimondoodkin/claude-handoff-plugin
```

Or clone and point Claude Code at the directory:

```bash
git clone https://github.com/shimondoodkin/claude-handoff-plugin.git
```

…then add it to your Claude Code plugin sources.

## Usage

### `/tokens`

```text
> /tokens
Session tokens: 1,234,567 (breakdown: input 12,345 · output 23,456 · cache-read 1,180,000 · cache-write 18,766)
```

### Auto-handoff

When session tokens cross a 50k bucket boundary at or above 150k, the next prompt you send will trigger a hook that injects this instruction to the agent:

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
---
```

- `notifications: true` (default if file missing) — auto-handoff fires.
- `notifications: false` — auto-handoff disabled. `/tokens` still works.

Changes take effect on the next prompt — no restart needed.

Add to your project's `.gitignore`:

```gitignore
.claude/*.local.md
.claude/handoffs/
```

## How it works

- **Token count.** Claude Code writes session transcripts as JSONL at `~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. Each assistant line has a `message.usage` block. The plugin sums these, deduping by `message.id` to handle parallel-tool-call splits.
- **Threshold detection.** A `UserPromptSubmit` hook computes `bucket = floor(tokens / 50_000)` and fires once per bucket ≥ 3. State is kept in `.claude/handoffs/.state/<sessionId>.json`.
- **Auto-resume.** `CronCreate` jobs are session-level (process), not conversation-level — they survive `/clear`. The cron prompt carries the literal handoff path, so the new sessionId after `/clear` doesn't matter.

## Trade-offs

- Token count is one turn behind reality (transcript is written *after* each API response).
- The auto-resume depends on the agent actually calling `CronCreate` when reminded. The reminder is explicit; if the agent skips it, you just type a kickoff message manually.
- The bucket trigger is coarse: a single huge tool call could skip a bucket. The hook still fires on the next bucket reached, so no double-fire risk.

## Cross-platform

Pure Node.js using cross-platform APIs (`os.homedir()`, `path.join`). Runs on Windows, macOS, Linux — anywhere Claude Code runs.

## License

MIT — see [LICENSE](LICENSE).
