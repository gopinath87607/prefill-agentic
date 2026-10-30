/**
 * Prefill-first workspace context: one deterministic snapshot followed by
 * append-only updates that keep the request prefix cacheable.
 *
 * @module @deepseek-ai/dsh-prefill-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Config, resolveConfig } from './config.ts'
import { prepareBaseline, prepareDelta } from './prepare.ts'
import { scanWorkspace } from './scan.ts'
import {
  PREFILL_PROJECTION_KEY,
  applyPrefillEvent,
  initPrefillState,
  name,
  prefillStateSchema,
} from './state.ts'
import type { PrefillContextSource } from './state.ts'

export { Config, name }
export type { PrefillContextState, PrefillContextSource, PrefillFileEntry } from './state.ts'

/** Services required to observe turns, resolve the workspace, and persist the ledger. */
export const inject = ['agents', 'workingDirectory', 'sessionProjections']

/**
 * Register the ledger projection and the pre-step snapshot listener.
 *
 * The first eligible step injects a complete snapshot. Later turns append an
 * update when files changed. A compaction that shadows the baseline clears the
 * ledger, and the next step prepares a fresh snapshot.
 * @param ctx - plugin context; both registrations are disposed with it.
 * @param config - row configuration.
 * @throws TypeError when the configuration is invalid.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const projection = await ctx.sessionProjections.register({
    key: PREFILL_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: prefillStateSchema,
    init: initPrefillState,
    apply: applyPrefillEvent,
  })
  ctx.on('agent/pre-step', async (
    { agent, messages, turn, signal },
    next,
  ): Promise<PreStepDecision> => {
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const state = projection.stateOf(agent.session)
    if (state.baselineAt !== null
      && (resolved.refresh === 'never' || state.lastScanTurn === turn)) return decision
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return decision
    const directory = await ctx.workingDirectory.ensure(agent, signal)
    ctx.fiber.assertActive()
    const root = await fileSystem.resolve(directory, { signal })
    const scan = await scanWorkspace(fileSystem, root, resolved, signal)
    ctx.fiber.assertActive()
    const rebaseline = state.baselineAt === null || state.root !== directory
    const ledger = new Map(state.files.map(entry => [entry.path, entry]))
    const prepared = rebaseline
      ? await prepareBaseline(fileSystem, scan, resolved, {
        turn,
        rootDisplay: root.displayPath,
      }, signal)
      : await prepareDelta(fileSystem, scan, resolved, ledger, {
        turn,
        rootDisplay: root.displayPath,
      }, signal)
    ctx.fiber.assertActive()
    if (prepared === undefined) return decision
    const source: PrefillContextSource = {
      kind: name,
      scannedTurn: turn,
      root: directory,
      ...(rebaseline ? { baseline: true } : {}),
      changes: prepared.changes,
    }
    const injected = createUserMessage({
      content: [{ type: 'text', text: prepared.text }],
      source,
    })
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const insertAt = lastClaimedIndex < 0 ? decision.messages.length : lastClaimedIndex + 1
    return { ...decision, messages: decision.messages.toSpliced(insertAt, 0, injected) }
  }, { prepend: true })
}
