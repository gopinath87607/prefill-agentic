/**
 * Durable prefill ledger and its host-only session projection.
 *
 * @module @deepseek-ai/dsh-prefill-context/state
 */

import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

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

/** Persisted-state validation for the host-only projection. */
export const prefillStateSchema: zod.ZodType<PrefillContextState> = zod.object({
  root: zod.string().nullable(),
  baselineSeq: zod.number().int().nonnegative().nullable(),
  baselineAt: zod.number().nullable(),
  lastScanTurn: zod.number().int().positive().nullable(),
  messageSeqs: zod.array(zod.number().int().nonnegative()),
  files: zod.array(entrySchema),
})

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
 * @returns an empty ledger.
 */
export function initPrefillState(): PrefillContextState {
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
 * Fold one committed session event into the prefill ledger.
 *
 * A baseline replaces the ledger and records its own sequence. An update
 * applies its transitions. A surface replacement that shadows the baseline
 * message clears the ledger, so the next pre-step prepares a new baseline after
 * compaction.
 * @param state - state covering every earlier event.
 * @param event - next committed event.
 * @returns the next state, or the same reference when the event is unrelated.
 */
export function applyPrefillEvent(state: PrefillContextState, event: SessionEvent): PrefillContextState {
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
    if (state.root !== source.root || state.baselineAt === null) return initPrefillState()
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
    return initPrefillState()
  }
  return state
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
