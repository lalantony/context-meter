import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { carriedText, describe, nudge, resumeText } from './register'

const row = (name: string, tokens: number, kind: 'used' | 'free' | 'buffer' | 'deferred' = 'used') =>
  ({ name, tokens, kind, color: 'x', isDeferred: kind === 'deferred' }) as never

test('plain reading, no reply yet, and the breakdown', () => {
  expect(describe({ tokens: 245_000, window: 1_000_000, percent: 25 })).toBe('Context: 245k of 1000k tokens used (25%).')
  expect(describe({ window: 200_000 })).toBe('No reply yet this session, so no reading. Window: 200k tokens.')
  const text = describe({
    tokens: 300_000,
    window: 1_000_000,
    percent: 30,
    breakdown: {
      categories: [row('Free space', 500_000, 'free'), row('Messages', 250_000), row('System tools', 30_000), row('MCP tools', 90_000, 'deferred')],
      totalTokens: 280_000,
      isAutoCompactEnabled: true,
      autoCompactThreshold: 800_000,
    } as never,
  })
  expect(text).toContain('Auto-compact at 800k (520k left; estimate).')
  expect(text).toContain('Largest: Messages 250k · System tools 30k')
  expect(text).not.toContain('Free space')
})

function world(on: On, percent: number) {
  on('session.usage', async () => ({ value: { startedAt: 0, context: { tokens: percent * 2000, window: 200_000, percent }, rateLimits: [] } }) as never)
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('tool.register', async ($, e) => ({ value: { tool: `mcp__context-meter__${e.name}` } }) as never)
  const seen: { text: string; context?: readonly string[] }[] = []
  on('prompt.submit', async ($, e) => {
    seen.push({ text: e.text, context: e.context })
    return { text: e.text }
  })
  return seen
}
const start = (s: { session: { start: (x: never) => Promise<unknown> } }) =>
  s.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)

test('the size tool answers from session.usage; compact queues, and refuses a subagent', async ($, on) => {
  world(on, 25)
  await start($)
  const size = (await $.tool.call({ tool: 'mcp__context-meter__context_size' } as never)) as { result?: unknown }
  expect(String(size.result)).toBe('Context: 50k of 200k tokens used (25%).')
  const main = (await $.tool.call({ tool: 'mcp__context-meter__compact', instructions: 'keep the plan' } as never)) as { result?: unknown }
  expect(String(main.result)).toContain('Compaction queued')
  const sub = (await $.tool.call({ tool: 'mcp__context-meter__compact', agentId: 'a1' } as never)) as { result?: unknown }
  expect(String(sub.result)).toContain('a subagent cannot')
})

test('from 90% a prompt carries the hidden note', async ($, on) => {
  const seen = world(on, 91)
  await start($)
  await $.prompt.submit({ text: 'next step', origin: { kind: 'composer' }, wait: false } as never)
  expect(seen.at(-1)?.context).toEqual([nudge(91)])
})

test('below 90% nothing is added', async ($, on) => {
  const seen = world(on, 89)
  await start($)
  await $.prompt.submit({ text: 'next step', origin: { kind: 'composer' }, wait: false } as never)
  expect(seen.at(-1)?.context ?? []).toEqual([])
})

async function compactAndEndTurn($: never, on: On, answer: object, reason = 'answer', typed: string[] = [], typedAfter: string[] = []) {
  const clock = mock.clock(on, { now: 0 })
  const seen = world(on, 25)
  const asked: (string | undefined)[] = []
  on('session.compact', async (_, e) => {
    asked.push(e.instructions)
    // The person types while the compaction runs.
    for (const text of typed) {
      await (($ as unknown as { prompt: { submit: (x: never) => Promise<unknown> } }).prompt.submit({
        text,
        origin: { kind: 'composer' },
        wait: false,
      } as never))
    }
    return answer as never
  })
  on('turn.complete', async () => ({ text: 'done' }) as never)
  on('turn.start', async (_, e) => ({ turnId: e.turnId }) as never)
  const aborted: string[] = []
  on('turn.abort', async (_, e) => {
    aborted.push((e as { turnId: string }).turnId)
    return { value: undefined } as never
  })
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('session.messages', async () => ({ value: [] }) as never)
  const s = $ as unknown as {
    tool: { call: (x: never) => Promise<unknown> }
    turn: { complete: (x: never) => Promise<unknown>; start: (x: never) => Promise<unknown> }
    prompt: { submit: (x: never) => Promise<unknown> }
  }
  await start($)
  await s.tool.call({ tool: 'mcp__context-meter__compact', instructions: 'keep the plan', resume: 'Start phase 3' } as never)
  await s.turn.complete({ reason, answer: 'done', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1' } as never)
  await clock.settle()
  // Typed while compacting, but its prompt.submit raised once the compaction ended (as live).
  for (const text of typedAfter) await s.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  // Each queued prompt starts its turn, the typed ones ahead of ours.
  const order = [...seen.filter(x => !x.text.startsWith('[context-meter]')), ...seen.filter(x => x.text.startsWith('[context-meter]'))]
  for (const [i, x] of order.entries()) await s.turn.start({ text: x.text, turnId: `q${i}` } as never)
  return { seen, asked, aborted, s }
}

test('when the turn ends the compaction runs, then a prompt starts the next turn', async ($, on) => {
  const { seen, asked, aborted, s } = await compactAndEndTurn($ as never, on, { messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  expect(asked).toEqual(['keep the plan'])
  expect(seen.map(x => x.text)).toEqual([resumeText('Start phase 3')])
  expect(aborted).toEqual([])
  expect(resumeText('Start phase 3')).toContain('CLAUDE.md files were reloaded and are mandatory')
  expect(resumeText('Start phase 3')).toContain('then: Start phase 3')
  // Our turn started, so the next prompt typed carries nothing.
  await s.prompt.submit({ text: 'next step', origin: { kind: 'composer' }, wait: false } as never)
  expect(seen.at(-1)?.context ?? []).toEqual([])
})

test('a prompt typed during the compaction carries the resume, and our stale prompt behind it is ended', async ($, on) => {
  const summary = { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  const { seen, aborted } = await compactAndEndTurn($ as never, on, summary, 'answer', ['actually, stop', 'and wait'])
  expect(seen.map(x => x.text)).toEqual(['actually, stop', 'and wait', resumeText('Start phase 3')])
  expect(seen[0].context).toEqual([carriedText('Start phase 3')])
  expect(seen[1].context ?? []).toEqual([])
  expect(aborted).toEqual(['q2'])
  expect(carriedText('Start phase 3')).toContain('answer this message: it comes first')
})

test('a prompt whose hook fires after the compaction ends still carries the resume, and ours is ended', async ($, on) => {
  const summary = { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  const { seen, aborted } = await compactAndEndTurn($ as never, on, summary, 'answer', [], ['see if you get this'])
  expect(seen.map(x => x.text)).toEqual([resumeText('Start phase 3'), 'see if you get this'])
  expect(seen[1].context).toEqual([carriedText('Start phase 3')])
  expect(aborted).toEqual(['q1'])
})

test('a skipped compaction starts no turn', async ($, on) => {
  const { seen } = await compactAndEndTurn($ as never, on, { skip: 'cancelled' })
  expect(seen).toEqual([])
})

test('an interrupted turn drops the queued compaction', async ($, on) => {
  const { seen, asked } = await compactAndEndTurn($ as never, on, { messages: [] }, 'aborted')
  expect(asked).toEqual([])
  expect(seen).toEqual([])
})
