/**
 * Prefill-first workspace context: one deterministic snapshot followed by
 * append-only updates that keep the request prefix cacheable.
 *
 * @module @deepseek-ai/dsh-prefill-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-working-directory'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedPrefillConfig } from './config.ts'
import { prepareBaseline, prepareDelta } from './prepare.ts'
import { PREFILL_GUIDANCE } from './render.ts'
import { scanWorkspace } from './scan.ts'
import {
  PREFILL_LEDGER_PROJECTION_KEY,
  PREFILL_PROJECTION_KEY,
  applyPrefillAccountingEvent,
  applyPrefillLedgerEvent,
  initPrefillAccountingState,
  initPrefillLedgerState,
  name,
  prefillLedgerView,
  prefillLedgerViewSchema,
  prefillSavingsSchema,
  prefillSavingsView,
  prefillAccountingStateSchema,
  prefillLedgerStateSchema,
  sameAccounting,
} from './state.ts'
import type {
  PrefillAccounting, PrefillContextSource, PrefillLedgerState,
} from './state.ts'
import type { PrefillLedgerView, PrefillSavingsView } from './types.ts'

export { Config, name }
export { PREFILL_GUIDANCE }
export type {
  PrefillAccounting, PrefillAccountingState, PrefillContextSource, PrefillFileEntry, PrefillLedgerState,
} from './state.ts'
export type { PrefillFileView, PrefillLedgerView, PrefillSavingsView } from './types.ts'

/** Services required to observe turns, resolve the workspace, and persist the ledger. */
export const inject = ['agents', 'workingDirectory', 'sessionProjections']

/**
 * Register the ledger and savings projections, the pre-step snapshot listener,
 * and the per-agent system-prompt guidance.
 *
 * The first eligible step injects a complete snapshot. Later turns append an
 * update when files changed, or every step with `refresh: 'step'`. A compaction
 * that shadows the baseline clears the visible ledger, and the next step
 * prepares a fresh snapshot.
 * @param ctx - plugin context; every registration and prompt section is disposed with it.
 * @param config - row configuration.
 * @throws TypeError when the configuration is invalid.
 * @returns when the plugin is ready.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  // Both view closures are shared by every session's view call, so compare
  // values or references rather than assuming consecutive calls share a state.
  let viewAccounting: PrefillAccounting | undefined
  let viewValue: PrefillSavingsView | undefined
  await ctx.sessionProjections.register({
    key: PREFILL_PROJECTION_KEY,
    stateVersion: 3,
    stateSchema: prefillAccountingStateSchema,
    init: initPrefillAccountingState,
    apply: (state, event) => applyPrefillAccountingEvent(state, event, resolved.charsPerToken),
    wire: {
      viewSchema: prefillSavingsSchema,
      view: (state) => {
        if (viewValue === undefined || viewAccounting === undefined || !sameAccounting(viewAccounting, state.accounting)) {
          viewAccounting = state.accounting
          viewValue = prefillSavingsView(state.accounting, resolved.promptTokensPerSecond)
        }
        return viewValue
      },
    },
  })

  let ledgerRoot: string | null | undefined
  let ledgerTurn: number | null | undefined
  let ledgerFiles: PrefillLedgerState['files'] | undefined
  let ledgerValue: PrefillLedgerView | undefined
  const ledger = await ctx.sessionProjections.register({
    key: PREFILL_LEDGER_PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: prefillLedgerStateSchema,
    init: initPrefillLedgerState,
    apply: applyPrefillLedgerEvent,
    wire: {
      viewSchema: prefillLedgerViewSchema,
      summary: false,
      view: (state) => {
        if (ledgerValue === undefined || ledgerRoot !== state.root
          || ledgerTurn !== state.lastScanTurn || ledgerFiles !== state.files) {
          ledgerRoot = state.root
          ledgerTurn = state.lastScanTurn
          ledgerFiles = state.files
          ledgerValue = prefillLedgerView(state)
        }
        return ledgerValue
      },
    },
  })

  const promptFibers = new Map<Agent, ReturnType<Context['inject']>>()
  const installGuidance = (agent: Agent): void => {
    if (!resolved.guidance || !isEligible(agent, resolved) || promptFibers.has(agent)) return
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'context:prefill',
        order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
        text: PREFILL_GUIDANCE,
      })
    })
    promptFibers.set(agent, fiber)
  }
  const disposeGuidance = (agent: Agent): void => {
    const fiber = promptFibers.get(agent)
    if (fiber === undefined) return
    promptFibers.delete(agent)
    void fiber.dispose().catch((error: unknown) => {
      ctx.logger.warn(`prefill-context: guidance cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  for (const agent of ctx.agents.list()) installGuidance(agent)
  ctx.on('agent/created', ({ agent }) => {
    installGuidance(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    disposeGuidance(agent)
  })
  ctx.effect(() => async () => {
    const fibers = [...promptFibers.values()]
    promptFibers.clear()
    await Promise.all(fibers.map(fiber => fiber.dispose()))
  }, 'prefill-context: guidance')

  ctx.on('agent/pre-step', async (
    { agent, messages, turn, signal },
    next,
  ): Promise<PreStepDecision> => {
    ctx.fiber.assertActive()
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    if (!isEligible(agent, resolved)) return decision
    const state = ledger.stateOf(agent.session)
    const refreshDue = state.baselineAt === null
      || resolved.refresh === 'step'
      || (resolved.refresh === 'turn' && state.lastScanTurn !== turn)
    if (!refreshDue) return decision
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return decision
    const directory = await ctx.workingDirectory.ensure(agent, signal)
    ctx.fiber.assertActive()
    const root = await fileSystem.resolve(directory, { signal })
    const scan = await scanWorkspace(fileSystem, root, resolved, signal)
    ctx.fiber.assertActive()
    const rebaseline = state.baselineAt === null || state.root !== directory
    const entries = new Map(state.files.map(entry => [entry.path, entry]))
    const prepared = rebaseline
      ? await prepareBaseline(fileSystem, scan, resolved, {
        turn,
        rootDisplay: root.displayPath,
      }, signal)
      : await prepareDelta(fileSystem, scan, resolved, entries, {
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
    const claimed = decision.messages.flatMap((message, index) => messages.includes(message) ? [index] : [])
    const lastClaimed = claimed.at(-1)
    const insertAt = resolved.position === 'before'
      ? claimed[0] ?? 0
      : lastClaimed === undefined ? decision.messages.length : lastClaimed + 1
    return { ...decision, messages: decision.messages.toSpliced(insertAt, 0, injected) }
  }, { prepend: true })
}

/**
 * Whether a session may receive snapshots and guidance under the configured scope.
 * @param agent - agent entering the step.
 * @param config - normalized configuration.
 * @returns false only for subagent sessions under the `main` scope.
 */
function isEligible(agent: Agent, config: ResolvedPrefillConfig): boolean {
  return config.agents === 'all' || agent.session.header.origin !== 'subagent'
}
