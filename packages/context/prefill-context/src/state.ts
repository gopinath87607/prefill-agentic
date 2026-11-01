/**
 * Durable prefill ledger, its cache accounting, and the host-only session
 * projections over both.
 *
 * @module @deepseek-ai/dsh-prefill-context/state
 */

import { z as zod } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PrefillLedgerView, PrefillSavingsView } from './types.ts'

/** Cordis plugin name and durable source kind. */
export const name = 'prefill-context'

/** Projection key holding cumulative prefill savings. */
export const PREFILL_PROJECTION_KEY = 'prefillContext'

/** Projection key holding the visible file snapshot and its scan identity. */
export const PREFILL_LEDGER_PROJECTION_KEY = 'prefillLedger'

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
  /** Prompt tokens served from cache that held visible prefill content. */
  readonly reusedTokens: number
  /**
   * Visible prefill tokens already present in the previous request's prompt,
   * which bounds what the next reported cache read can attribute to prefill.
   */
  readonly prefixTokens: number
}

/** Projection state: the visible file snapshot the pre-step reconciles against. */
export interface PrefillLedgerState {
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
}

/** Projection state: cumulative cache accounting that survives ledger resets. */
export interface PrefillAccountingState {
  /** Root of the visible snapshot, or null when no prefill message is visible. */
  readonly root: string | null
  /** Commit time of the visible baseline, or null when none is visible. */
  readonly baselineAt: number | null
  /** Sequence of every committed prefill message still on the surface. */
  readonly messageSeqs: readonly number[]
  /** Cumulative cache savings; survives compaction, which resets only visibility. */
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
  prefixTokens: zod.number().int().nonnegative(),
})

/** Persisted-state validation for the visible file snapshot. */
export const prefillLedgerStateSchema: zod.ZodType<PrefillLedgerState> = zod.object({
  root: zod.string().nullable(),
  baselineSeq: zod.number().int().nonnegative().nullable(),
  baselineAt: zod.number().nullable(),
  lastScanTurn: zod.number().int().positive().nullable(),
  messageSeqs: zod.array(zod.number().int().nonnegative()),
  files: zod.array(entrySchema),
})

/** Persisted-state validation for the cumulative cache accounting. */
export const prefillAccountingStateSchema: zod.ZodType<PrefillAccountingState> = zod.object({
  root: zod.string().nullable(),
  baselineAt: zod.number().nullable(),
  messageSeqs: zod.array(zod.number().int().nonnegative()),
  accounting: accountingSchema,
})

/** Savings schema served to clients; the wire boundary validates every view. */
export const prefillSavingsSchema: zod.ZodType<PrefillSavingsView> = zod.object({
  visibleTokens: zod.number().int().nonnegative(),
  injectedTokens: zod.number().int().nonnegative(),
  reusedTokens: zod.number().int().nonnegative(),
  savedTokens: zod.number().int().nonnegative(),
  savedMs: zod.number().int().nonnegative(),
  tokensPerSecond: zod.number().positive(),
}).strict()

/** File-snapshot schema served to clients; only the renderable fields cross the wire. */
export const prefillLedgerViewSchema: zod.ZodType<PrefillLedgerView> = zod.object({
  root: zod.string().nullable(),
  lastScanTurn: zod.number().int().positive().nullable(),
  files: zod.array(zod.object({
    path: zod.string().min(1),
    bytes: zod.number().int().nonnegative(),
  }).strict()),
}).strict()

const EMPTY_ACCOUNTING: PrefillAccounting = {
  visibleTokens: 0,
  injectedTokens: 0,
  reusedTokens: 0,
  prefixTokens: 0,
}

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
 * Ledger state for a session with no visible prefill message.
 * @returns an empty snapshot.
 */
export function initPrefillLedgerState(): PrefillLedgerState {
  return {
    root: null,
    baselineSeq: null,
    baselineAt: null,
    lastScanTurn: null,
    messageSeqs: [],
    files: [],
  }
}

/**
 * Accounting state for a session with no visible prefill message.
 * @returns zero visibility and zero savings.
 */
export function initPrefillAccountingState(): PrefillAccountingState {
  return { root: null, baselineAt: null, messageSeqs: [], accounting: EMPTY_ACCOUNTING }
}

/** Drop visibility while keeping cumulative injected and reused counts. */
function clearAccounting(state: PrefillAccountingState): PrefillAccountingState {
  return {
    root: null,
    baselineAt: null,
    messageSeqs: [],
    accounting: { ...state.accounting, visibleTokens: 0, prefixTokens: 0 },
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
 * The cached prefix is the previous request's prompt, which held exactly the
 * prefill tokens visible at that settlement. The new prefill message committed
 * for this step is in the current request but not in the cached prefix, so it
 * cannot be credited here; it becomes credit for the NEXT settlement. Capping
 * the reported cache read by the previous settlement's visible tokens keeps
 * the figure at the prefill share of the cached prefix (an upper bound only
 * when the provider cached less than that whole prompt).
 */
function applyAssistantUsage(
  state: PrefillAccountingState,
  event: SessionEvent<'assistant/message'>,
): PrefillAccountingState {
  const cacheRead = event.data.usage?.cacheReadTokens ?? 0
  const { visibleTokens, prefixTokens, reusedTokens } = state.accounting
  const credited = reusedTokens + Math.min(cacheRead, prefixTokens)
  if (credited === reusedTokens && prefixTokens === visibleTokens) return state
  return {
    ...state,
    accounting: { ...state.accounting, reusedTokens: credited, prefixTokens: visibleTokens },
  }
}

/**
 * Fold one committed session event into the visible file snapshot.
 *
 * A baseline replaces the snapshot and records its own sequence. An update
 * applies its transitions. A surface replacement that shadows any prefill
 * message clears the snapshot, so the next pre-step prepares a fresh baseline.
 * @param state - state covering every earlier event.
 * @param event - next committed event.
 * @returns the next state, or the same reference when the event is unrelated.
 */
export function applyPrefillLedgerEvent(state: PrefillLedgerState, event: SessionEvent): PrefillLedgerState {
  if (event.type !== 'user/message') return state
  if (event.data.source.kind === name) {
    const source = parsePrefillSource(event.data.source)
    if (source === undefined) return state
    if (source.baseline === true) {
      return {
        root: source.root,
        baselineSeq: event.seq,
        baselineAt: event.time,
        lastScanTurn: source.scannedTurn,
        messageSeqs: [event.seq],
        files: sortEntries(source.changes.flatMap(change => change.action === 'set' ? [change.entry] : [])),
      }
    }
    if (state.root !== source.root || state.baselineAt === null) return initPrefillLedgerState()
    return {
      ...state,
      lastScanTurn: source.scannedTurn,
      messageSeqs: [...state.messageSeqs, event.seq],
      files: sortEntries(applyChanges(state.files, source.changes)),
    }
  }
  const operation = event.surfaceOp
  if (operation !== 'append'
    && state.messageSeqs.some(seq => operation.startSeq <= seq && seq <= operation.endSeq)) {
    return initPrefillLedgerState()
  }
  return state
}

/**
 * Fold one committed session event into cumulative prefill cache accounting.
 *
 * Visibility follows the same rules as the ledger: a baseline replaces it, an
 * update extends it, and a surface replacement or root change clears it.
 * Cumulative injected and reused counts survive every reset.
 * @param state - state covering every earlier event.
 * @param event - next committed event.
 * @param charsPerToken - fixed density used to estimate prefill message tokens.
 * @returns the next state, or the same reference when the event is unrelated.
 */
export function applyPrefillAccountingEvent(
  state: PrefillAccountingState,
  event: SessionEvent,
  charsPerToken: number,
): PrefillAccountingState {
  if (event.type === 'assistant/message') return applyAssistantUsage(state, event)
  if (event.type !== 'user/message') return state
  if (event.data.source.kind === name) {
    const source = parsePrefillSource(event.data.source)
    if (source === undefined) return state
    const tokens = textTokens(event.data.content, charsPerToken)
    if (source.baseline === true) {
      return {
        root: source.root,
        baselineAt: event.time,
        messageSeqs: [event.seq],
        accounting: {
          visibleTokens: tokens,
          injectedTokens: state.accounting.injectedTokens + tokens,
          reusedTokens: state.accounting.reusedTokens,
          prefixTokens: 0,
        },
      }
    }
    if (state.root !== source.root || state.baselineAt === null) return clearAccounting(state)
    return {
      ...state,
      messageSeqs: [...state.messageSeqs, event.seq],
      accounting: {
        ...state.accounting,
        visibleTokens: state.accounting.visibleTokens + tokens,
        injectedTokens: state.accounting.injectedTokens + tokens,
      },
    }
  }
  const operation = event.surfaceOp
  if (operation !== 'append'
    && state.messageSeqs.some(seq => operation.startSeq <= seq && seq <= operation.endSeq)) {
    return clearAccounting(state)
  }
  return state
}

/**
 * Whether two accounting snapshots hold the same client-visible counts.
 * @param left - one accounting snapshot.
 * @param right - another accounting snapshot.
 * @returns true when every count rendered by the savings view is equal.
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
 * @returns current prefill size, net saved tokens, and their estimated processing time.
 */
export function prefillSavingsView(accounting: PrefillAccounting, tokensPerSecond: number): PrefillSavingsView {
  const savedTokens = Math.max(0, accounting.reusedTokens - accounting.injectedTokens)
  return {
    visibleTokens: accounting.visibleTokens,
    injectedTokens: accounting.injectedTokens,
    reusedTokens: accounting.reusedTokens,
    savedTokens,
    savedMs: Math.round(savedTokens * 1_000 / tokensPerSecond),
    tokensPerSecond,
  }
}

/**
 * Client view of the visible file snapshot.
 * @param state - folded ledger state.
 * @returns the renderable root, scan turn, and file sizes.
 */
export function prefillLedgerView(state: PrefillLedgerState): PrefillLedgerView {
  return {
    root: state.root,
    lastScanTurn: state.lastScanTurn,
    files: state.files.map(entry => ({ path: entry.path, bytes: entry.bytes })),
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
