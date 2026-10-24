# context-meter

A Claude Code mod that lets the agent see how full its context window is and compact itself at a clean break.

- **`context_size` tool** — tokens used, the window and the percentage; with `breakdown: true`, where auto-compaction starts and the largest categories.
- **`compact` tool** — queues a compaction for when the current turn ends (the same as typing `/compact`), with what the summary must keep. Afterwards a prompt starts the next turn, telling the agent to follow its CLAUDE.md post-compaction rules and then resume.
- **Nudge from 90%** — every prompt carries a hidden note asking the agent to plan for compaction. It rides beside the prompt, not in the system prompt, so the prompt cache holds.

Only the main session can compact; a subagent's call is refused. An interrupted turn drops a queued compaction.

## Install

At the prompt of a terminal session:

```
/plugin install context-meter --marketplace lalantony/context-meter
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install context-meter --marketplace lalantony/context-meter
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `lalantony/context-meter`, then Add plugin.

Mods use Claude Code's early-access function-hooks API, so use a recent Claude Code build.
