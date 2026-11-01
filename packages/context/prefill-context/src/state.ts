/**
 * Durable prefill ledger and its host-only session projection.
 *
 * @module @deepseek-ai/dsh-prefill-context/state
 */

import { z as zod } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PrefillSavingsView } from './types.ts'

/** Cordis plugin name and durable source kind. */
export const name = 'prefill-context'

/** Projection key holding the current workspace ledger. */
export const PREFILL_PROJECTION_KEY = 'prefillContext'

/** One file tracked by the current snapshot. */
export interface PrefillFileEntry {
  /** Workspace-relative path with `/` separators. */
  readonly path: string
  /** Opaque backend freshness token, or null when the backend omits it. */
  readonly version: string | null
  /** Content fingerprint used to detect real changes. */
  readonly digest: string
  /** UTF-8 byte length of the tracked content. */
  readonly bytes: number
}

/** One ledger transition committed with a prefill message. */
export type PrefillChange =
  | { readonly action: 'set'; readonly entry: PrefillFileEntry }
  | { readonly action: 'remove'; readonly path: string }

/** Durable source record for one baseline or append-only update. */
export interface PrefillContextSource {
  kind: 'prefill-context'
  /** Turn whose pre-step produced this scan. */
  readonly scannedTurn: number
  /** Absolute working directory the paths are relative to. */
  readonly root: string
  /** Marks the complete baseline rather than an update. */
  readonly baseline?: true | undefined
  /** Ledger transitions committed by this message. */
  readonly changes: readonly PrefillChange[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prefill-context': PrefillContextSource
  }
}

/** Cumulative prefill token accounting folded from durable events. */
export interface PrefillAccounting {
  /** Estimated tokens of prefill messages currently visible on the surface. */
  readonly visibleTokens: number
  /** Estimated tokens every visible prefill message introduced, each paid uncached once. */
  readonly injectedTokens: number
  /** Prompt tokens served from cache and attributed to visible prefill content. */
  readonly reusedTokens: number
}

/** Projection state: the ledger plus the identity of the visible baseline. */
export interface PrefillContextState {
  /** Absolute working directory of the tracked paths, or null before the first scan. */
  readonly root: string | null
  /** Sequence of the baseline message while it remains on the surface. */
  readonly baselineSeq: number | null
  /** Commit time of the baseline, or null when no baseline is visible. */
  readonly baselineAt: number | null
  /** Turn of the latest committed scan. */
  readonly lastScanTurn: number | null
  /** Sequence of every committed prefill message still on the surface. */
  readonly messageSeqs: readonly number[]
  /** Files currently represented in the visible snapshot and its updates. */
  readonly files: readonly PrefillFileEntry[]
  /** Cumulative cache savings; survives compaction, which resets only the ledger. */
  readonly accounting: PrefillAccounting
}

const entrySchema = zod.object({
  path: zod.string().min(1),
  version: zod.string().nullable(),
  digest: zod.string().min(1),
  bytes: zod.number().int().nonnegative(),
})

const changeSchema = zod.discriminatedUnion('action', [
  zod.object({ action: zod.literal('set'), entry: entrySchema }),
  zod.object({ action: zod.literal('remove'), path: zod.string().min(1) }),
])

const sourceSchema = zod.object({
  kind: zod.literal(name),
  scannedTurn: zod.number().int().positive(),
  root: zod.string().min(1),
  baseline: zod.literal(true).optional(),
  changes: zod.array(changeSchema),
})

const accountingSchema = zod.object({
  visibleTokens: zod.number().int().nonnegative(),
  injectedTokens: zod.number().int().nonnegative(),
  reusedTokens: zod.number().int().nonnegative(),
})

/** Persisted-state validation for the host-only projection. */
export const prefillStateSchema: zod.ZodType<PrefillContextState> = zod.object({
  root: zod.string().nullable(),
  baselineSeq: zod.number().int().nonnegative().nullable(),
  baselineAt: zod.number().nullable(),
  lastScanTurn: zod.number().int().positive().nullable(),
  messageSeqs: zod.array(zod.number().int().nonnegative()),
  files: zod.array(entrySchema),
  accounting: accountingSchema,
})

/** Savings schema served to clients; the wire boundary validates every view. */
export const prefillSavingsSchema: zod.ZodType<PrefillSavingsView> = zod.object({
  injectedTokens: zod.number().int().nonnegative(),
  reusedTokens: zod.number().int().nonnegative(),
  savedTokens: zod.number().int().nonnegative(),
  savedMs: zod.number().int().nonnegative(),
  tokensPerSecond: zod.number().positive(),
}).strict()

/** Accounting of a session whose prefill messages are all shadowed. */
const EMPTY_ACCOUNTING: PrefillAccounting = { visibleTokens: 0, injectedTokens: 0, reusedTokens: 0 }

/**
 * Validate one durable prefill source read back from the session log.
 * @param source - message source value from a committed user message.
 * @returns the validated source, or undefined when it is not a complete ledger record.
 */
export function parsePrefillSource(source: unknown): PrefillContextSource | undefined {
  const parsed = sourceSchema.safeParse(source)
  return parsed.success ? parsed.data : undefined
}

/**
 * State for a session with no visible prefill message.
 * @returns an empty ledger and zero savings.
 */
export function initPrefillState(): PrefillContextState {
  return {
    root: null,
    baselineSeq: null,
    baselineAt: null,
    lastScanTurn: null,
    messageSeqs: [],
    files: [],
    accounting: EMPTY_ACCOUNTING,
  }
}

/** Drop the ledger while keeping cumulative savings across a baseline replacement. */
function clearLedger(state: PrefillContextState): PrefillContextState {
  return {
    ...initPrefillState(),
    accounting: { ...state.accounting, visibleTokens: 0 },
  }
}

/** Estimated tokens of one prefill message, using the configured density. */
function textTokens(content: readonly ContentBlock[], charsPerToken: number): number {
  let chars = 0
  for (const block of content) if (block.type === 'text') chars += block.text.length
  return chars === 0 ? 0 : Math.ceil(chars / charsPerToken)
}

/**
 * Attribute one settled request's cache reads to the prefill prefix.
 *
 * A prompt prefix is cached in order, so at most the visible prefill content
 * could have been served from cache on that request; anything further is
 * conversation. Counting the minimum keeps the estimate a lower bound.
 */
function applyAssistantUsage(
  state: PrefillContextState,
  event: SessionEvent<'assistant/message'>,
): PrefillContextState {
  const cacheRead = event.data.usage?.cacheReadTokens ?? 0
  const visible = state.accounting.visibleTokens
  if (cacheRead <= 0 || visible <= 0) return state
  return {
    ...state,
    accounting: {
      ...state.accounting,
      reusedTokens: state.accounting.reusedTokens + Math.min(cacheRead, visible),
    },
  }
}

/**
 * Fold one committed session event into the prefill ledger and its savings.
 *
 * A baseline replaces the ledger and records its own sequence. An update
 * applies its transitions. A surface replacement that shadows the baseline
 * message clears the ledger, so the next pre-step prepares a new baseline after
 * compaction; cumulative savings survive that reset. Each committed assistant
 * settlement credits cache reads to the prefill content visible at that point.
 * @param state - state covering every earlier event.
 * @param event - next committed event.
 * @param charsPerToken - fixed density used to estimate prefill message tokens.
 * @returns the next state, or the same reference when the event is unrelated.
 */
export function applyPrefillEvent(
  state: PrefillContextState,
  event: SessionEvent,
  charsPerToken: number,
): PrefillContextState {
  if (event.type === 'assistant/message') return applyAssistantUsage(state, event)
  if (event.type !== 'user/message') return state
  if (event.data.source.kind === name) {
    const source = parsePrefillSource(event.data.source)
    if (source === undefined) return state
    const tokens = textTokens(event.data.content, charsPerToken)
    const accounting: PrefillAccounting = {
      visibleTokens: state.accounting.visibleTokens + tokens,
      injectedTokens: state.accounting.injectedTokens + tokens,
      reusedTokens: state.accounting.reusedTokens,
    }
    if (source.baseline === true) {
      return {
        root: source.root,
        baselineSeq: event.seq,
        baselineAt: event.time,
        lastScanTurn: source.scannedTurn,
        messageSeqs: [event.seq],
        files: sortEntries(source.changes.flatMap(change => change.action === 'set' ? [change.entry] : [])),
        accounting: { ...accounting, visibleTokens: tokens },
      }
    }
    if (state.root !== source.root || state.baselineAt === null) return clearLedger(state)
    return {
      ...state,
      lastScanTurn: source.scannedTurn,
      messageSeqs: [...state.messageSeqs, event.seq],
      files: sortEntries(applyChanges(state.files, source.changes)),
      accounting,
    }
  }
  const operation = event.surfaceOp
  if (operation !== 'append'
    && state.messageSeqs.some(seq => operation.startSeq <= seq && seq <= operation.endSeq)) {
    return clearLedger(state)
  }
  return state
}

/**
 * Whether two accounting snapshots hold the same cumulative counts.
 * @param left - one accounting snapshot.
 * @param right - another accounting snapshot.
 * @returns true when every count is equal.
 */
export function sameAccounting(left: PrefillAccounting, right: PrefillAccounting): boolean {
  return left.visibleTokens === right.visibleTokens
    && left.injectedTokens === right.injectedTokens
    && left.reusedTokens === right.reusedTokens
}

/**
 * Client view of the cumulative prefill accounting.
 * @param accounting - folded prefill token counts.
 * @param tokensPerSecond - configured uncached prompt throughput.
 * @returns net saved tokens and their estimated processing time.
 */
export function prefillSavingsView(accounting: PrefillAccounting, tokensPerSecond: number): PrefillSavingsView {
  const savedTokens = Math.max(0, accounting.reusedTokens - accounting.injectedTokens)
  return {
    injectedTokens: accounting.injectedTokens,
    reusedTokens: accounting.reusedTokens,
    savedTokens,
    savedMs: Math.round(savedTokens * 1_000 / tokensPerSecond),
    tokensPerSecond,
  }
}

function applyChanges(
  current: readonly PrefillFileEntry[],
  changes: readonly PrefillChange[],
): PrefillFileEntry[] {
  const byPath = new Map(current.map(entry => [entry.path, entry]))
  for (const change of changes) {
    if (change.action === 'set') byPath.set(change.entry.path, change.entry)
    else byPath.delete(change.path)
  }
  return [...byPath.values()]
}

function sortEntries(entries: Iterable<PrefillFileEntry>): PrefillFileEntry[] {
  return [...entries].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ))
}
