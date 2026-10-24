/** A compaction the agent asked for; `isTurnDone` once the turn that asked has ended. */
export type Queued = { instructions?: string; resume?: string; isTurnDone: boolean }

declare module 'claude-code' {
  interface PluginState {
    'context-meter': { queued: Queued | null }
  }
}
