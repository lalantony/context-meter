import type { Register, SessionContextUsage } from 'claude-code'

const SIZE = 'mcp__context-meter__context_size'
const COMPACT = 'mcp__context-meter__compact'
/** Categories listed with `breakdown`; the rest are small. */
const TOP = 6
/** From this percentage of the window, every prompt carries a hidden note to plan for compaction. */
const NUDGE_AT = 90

const k = (n: number) => `${Math.round(n / 1000)}k`

// A compaction the agent asked for, run when its turn ends: $.session.compact rejects mid-turn.
// Module state, so a mod reload drops a queued one; the agent can ask again.
let queued: { instructions?: string; resume?: string } | undefined

/** The prompt that starts the first turn after a compaction: a between-turns compact leaves the session idle. */
// The engine reloads CLAUDE.md after a compaction, so this asks for obedience, not a costly re-read.
export const resumeText = (resume?: string) =>
  '[context-meter] Compaction finished. Your CLAUDE.md files were reloaded and are mandatory: first do everything they ' +
  `require after a compaction (such as repeating rules or reloading skills), then: ${resume ?? 'continue the task from the summary; if it was already done, tell the user in one line and stop.'}`

/** The tool's answer: the status line's figures, plus /context's local estimate when asked. */
export function describe(c: SessionContextUsage): string {
  if (c.tokens === undefined) return `No reply yet this session, so no reading. Window: ${k(c.window)} tokens.`
  const lines = [`Context: ${k(c.tokens)} of ${k(c.window)} tokens used (${c.percent ?? Math.round((c.tokens / c.window) * 100)}%).`]
  const b = c.breakdown
  if (b === undefined) return lines.join('\n')
  lines.push(
    b.isAutoCompactEnabled && b.autoCompactThreshold !== undefined
      ? `Auto-compact at ${k(b.autoCompactThreshold)} (${k(Math.max(0, b.autoCompactThreshold - b.totalTokens))} left; estimate).`
      : 'Auto-compact is off.',
  )
  const used = b.categories.filter(r => r.kind === 'used').sort((x, y) => y.tokens - x.tokens)
  lines.push(`Largest: ${used.slice(0, TOP).map(r => `${r.name} ${k(r.tokens)}`).join(' · ')}`)
  return lines.join('\n')
}

export const nudge = (percent: number) =>
  `[context-meter] ${percent}% of the context window is used. Plan for compaction: reach a clean break, ` +
  'tell the user, then call mcp__context-meter__compact with what the summary must keep.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'context_size',
      description:
        "Reports how full this session's context window is: tokens used, the window, the percentage. " +
        'Pass breakdown: true to add where auto-compaction starts and the largest categories (a free local estimate).',
      inputSchema: {
        type: 'object',
        properties: { breakdown: { type: 'boolean', description: 'Add the auto-compact point and the largest categories' } },
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'compact',
      description:
        'Compacts this conversation when your current turn ends: the same as the person typing /compact. Call it only at ' +
        'a clean break (the work is finished or written down, nothing is mid-edit) and say so to the user in the same reply. ' +
        'Pass instructions: what the summary must keep (the task, files changed, commits, open questions, standing constraints). ' +
        'Afterwards a prompt starts your next turn: resume, or by default "continue the task from the summary".',
      inputSchema: {
        type: 'object',
        properties: {
          instructions: { type: 'string', description: 'What the summary must keep or stress' },
          resume: { type: 'string', description: 'What to do first after the compaction, e.g. "Start phase 3: the API tests"' },
        },
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: SIZE }, async ($, e) => {
    // The tool's arguments arrive spread beside `tool` on the event.
    const { breakdown } = e as unknown as { breakdown?: boolean }
    const { context } = await $.session.usage(breakdown ? { breakdown: 'summary' } : undefined)
    return { result: describe(context) }
  }).catch(() => ({ result: 'Could not read the context size; carry on.' }))

  on('tool.call', { tool: COMPACT }, async ($, e) => {
    const { instructions, resume, agentId } = e as unknown as { instructions?: string; resume?: string; agentId?: string }
    if (agentId !== undefined) return { result: 'Only the main session can compact; a subagent cannot.' }
    queued = { instructions: instructions?.trim() || undefined, resume: resume?.trim() || undefined }
    return { result: 'Compaction queued: it runs as soon as this turn ends, then a prompt starts your next turn. Finish your reply now.' }
  }).catch(() => ({ result: 'Could not queue the compaction; the user can run /compact.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && queued !== undefined) {
      const { instructions, resume } = queued
      queued = undefined
      // An interrupted or failed turn hands control back to the person: no compaction.
      if (e.reason !== 'answer') return done
      $.clock.after(0, () =>
        void $.session
          .compact({ instructions })
          .then(async r => {
            if (r.skip !== undefined) return $.ui.toast(`context-meter: compaction skipped - ${r.skip}`)
            await $.prompt.submit({ text: resumeText(resume) })
          })
          .catch(err => $.ui.toast(`context-meter: could not compact (${String(err).slice(0, 80)}); run /compact`)),
      )
    }
    return done
  })

  // A hidden note beside the prompt (not the system prompt, so the prompt cache holds).
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    const { context } = await $.session.usage()
    if ((context.percent ?? 0) < NUDGE_AT) return next(e)
    return next({ ...e, context: [...(e.context ?? []), nudge(context.percent ?? NUDGE_AT)] })
  }).catch(($, e, next) => next(e))
}
