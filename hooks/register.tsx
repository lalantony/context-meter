import type { EngineInterface, Register, SessionContextUsage } from 'claude-code'

const SIZE = 'mcp__context-meter__context_size'
const COMPACT = 'mcp__context-meter__compact'
/** Categories listed with `breakdown`; the rest are small. */
const TOP = 6
/** From this percentage of the window, every prompt carries a hidden note to plan for compaction. */
const NUDGE_AT = 90

const k = (n: number) => `${Math.round(n / 1000)}k`

// A compaction the agent asked for, run when its turn ends: $.session.compact rejects mid-turn.
// Session state, not a module variable: a reload drops the module's timers, and session.start
// then starts a compaction whose turn already ended.
const QUEUED = { plugin: 'context-meter', key: 'queued' } as const
// From the compaction's start until SETTLE_MS after it ends: its resume, and whether a prompt
// typed meanwhile carries it. Such a prompt raises prompt.submit only once the compaction ends.
// ponytail: module state, so a reload mid-compaction loses the resume prompt; the person asks the agent to go on.
let pending: { resume?: string; isCarried: boolean } | undefined
/** How long a prompt typed during the compaction has to reach prompt.submit before ours is sent. */
const SETTLE_MS = 1500

// The engine reloads CLAUDE.md after a compaction, so this asks for obedience, not a costly re-read.
const AFTER = 'Your CLAUDE.md files were reloaded and are mandatory: first do everything they require after a compaction (such as repeating rules or reloading skills), then'

/** The prompt that starts the first turn after a compaction: a between-turns compact leaves the session idle. */
export const resumeText = (resume?: string) =>
  `[context-meter] Compaction finished. ${AFTER}: ${resume ?? 'continue the task from the summary; if it was already done, tell the user in one line and stop.'}`

/** Rides on a prompt queued during the compaction, which runs before any prompt of ours would: it replaces ours. */
export const carriedText = (resume?: string) =>
  `[context-meter] The conversation was compacted while this message waited. ${AFTER} answer this message: it comes first. ` +
  `Afterwards, unless it changed the plan: ${resume ?? 'continue the task from the summary.'}`

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

/** Once the session is idle, takes the queued compaction and runs it, then sends its resume prompt. */
function compactQueued($: EngineInterface, resume?: string) {
  pending = { resume, isCarried: false }
  $.clock.after(0, () =>
    void run().catch(err => {
      pending = undefined
      return $.ui.toast(`context-meter: could not compact (${String(err).slice(0, 80)}); run /compact`)
    }),
  )
  async function run() {
    const { value: q, version } = await $.state.get(QUEUED)
    // ifVersion: of two takers, one compacts.
    if (!q?.isTurnDone || !(await $.state.set(QUEUED, null, { ifVersion: version })).isSet) {
      pending = undefined
      return
    }
    const r = await $.session.compact({ instructions: q.instructions })
    if (r.skip !== undefined) {
      pending = undefined
      return $.ui.toast(`context-meter: compaction skipped - ${r.skip}`)
    }
    // ponytail: a fixed wait for the engine to hand over a typed prompt; one later than this runs without the note, ours after it.
    $.clock.after(SETTLE_MS, () => {
      const isCarried = pending?.isCarried
      pending = undefined
      if (!isCarried)
        void $.prompt.submit({ text: resumeText(q.resume) }).catch(() => $.ui.toast('context-meter: could not send the resume prompt'))
    })
  }
}

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
    // session.start runs again on a reload, which dropped the timer of a compaction already due.
    const { value: q } = await $.state.get(QUEUED)
    if (q?.isTurnDone) compactQueued($, q.resume)
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
    await $.state.set(QUEUED, { instructions: instructions?.trim() || undefined, resume: resume?.trim() || undefined, isTurnDone: false })
    return { result: 'Compaction queued: it runs as soon as this turn ends, then a prompt starts your next turn. Finish your reply now.' }
  }).catch(() => ({ result: 'Could not queue the compaction; the user can run /compact.' }))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const { value: q } = await $.state.get(QUEUED)
    if (!q) return done
    // An interrupted or failed turn hands control back to the person: no compaction.
    if (e.reason !== 'answer') {
      await $.state.set(QUEUED, null)
      return done
    }
    await $.state.set(QUEUED, { ...q, isTurnDone: true })
    compactQueued($, q.resume)
    return done
  })

  // A hidden note beside the prompt (not the system prompt, so the prompt cache holds).
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined) return next(e)
    if (pending !== undefined) {
      // Typed (or delivered) around the compaction: the first carries the resume, and ours is not sent.
      if (pending.isCarried) return next(e)
      pending.isCarried = true
      return next({ ...e, context: [...(e.context ?? []), carriedText(pending.resume)] })
    }
    const { context } = await $.session.usage()
    if ((context.percent ?? 0) < NUDGE_AT) return next(e)
    return next({ ...e, context: [...(e.context ?? []), nudge(context.percent ?? NUDGE_AT)] })
  }).catch(($, e, next) => next(e))
}
