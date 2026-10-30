/**
 * Budgeted file selection and change reconciliation for prefill snapshots.
 *
 * @module @deepseek-ai/dsh-prefill-context/prepare
 */

import { createHash } from 'node:crypto'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ResolvedPrefillConfig } from './config.ts'
import type { ScanCandidate, ScanResult } from './scan.ts'
import type { PrefillChange, PrefillFileEntry } from './state.ts'
import {
  estimateTokens,
  renderBaselineText,
  renderDeltaText,
  renderFileBlock,
} from './render.ts'

/** Message text and ledger transitions prepared from one scan. */
export interface PreparedPrefill {
  /** Complete model-facing message text. */
  text: string
  /** Ledger transitions this message commits. */
  changes: PrefillChange[]
  /** Number of files whose contents appear in this message. */
  included: number
}

/** Scan-independent message identity. */
export interface PrepareContext {
  /** Turn whose pre-step requested the snapshot. */
  turn: number
  /** Root path shown to the model. */
  rootDisplay: string
}

interface LoadedFile {
  text: string
  bytes: number
  digest: string
}

type ReadOutcome =
  | { kind: 'ok'; file: LoadedFile }
  | { kind: 'oversize' }
  | { kind: 'unreadable'; detail: string }

const UNREADABLE_DETAIL_SEPARATOR = ': '

/**
 * Select shallow files first until the baseline budget is full.
 * @param fileSystem - mounted filesystem service.
 * @param scan - completed workspace scan.
 * @param config - normalized budgets and limits.
 * @param context - turn and displayed root.
 * @param signal - aborts file reads.
 * @returns the prepared baseline message.
 */
export async function prepareBaseline(
  fileSystem: FileSystem,
  scan: ScanResult,
  config: ResolvedPrefillConfig,
  context: PrepareContext,
  signal: AbortSignal | undefined,
): Promise<PreparedPrefill> {
  const budget = Math.max(0, config.budgetTokens - config.reserveTokens)
  const blocks: string[] = []
  const changes: PrefillChange[] = []
  let used = 0
  let oversize = 0
  let unreadable = 0
  let overBudget = 0
  const unreadableDetails: string[] = []

  for (const candidate of [...scan.candidates].sort(compareCandidates)) {
    signal?.throwIfAborted()
    if (candidate.size !== undefined && candidate.size > config.maxFileBytes) {
      oversize += 1
      continue
    }
    if (candidate.size !== undefined
      && Math.ceil(candidate.size / config.charsPerToken) + used > budget) {
      overBudget += 1
      continue
    }
    const outcome = await readCandidate(fileSystem, candidate, config.maxFileBytes, signal)
    if (outcome.kind === 'oversize') {
      oversize += 1
      continue
    }
    if (outcome.kind === 'unreadable') {
      unreadable += 1
      unreadableDetails.push(`${candidate.path}${UNREADABLE_DETAIL_SEPARATOR}${outcome.detail}`)
      continue
    }
    const block = renderFileBlock(candidate.path, undefined, outcome.file.text)
    const tokens = estimateTokens(block, config.charsPerToken)
    if (used + tokens > budget) {
      overBudget += 1
      continue
    }
    blocks.push(block)
    changes.push({
      action: 'set',
      entry: {
        path: candidate.path,
        version: candidate.version,
        digest: outcome.file.digest,
        bytes: outcome.file.bytes,
      },
    })
    used += tokens
  }

  return {
    text: renderBaselineText({
      turn: context.turn,
      rootDisplay: context.rootDisplay,
      included: blocks.length,
      contentTokens: used,
      blocks,
      oversize,
      unreadable,
      overBudget,
      incomplete: !scan.complete,
      errors: [...scan.errors, ...unreadableDetails],
    }),
    changes,
    included: blocks.length,
  }
}

/**
 * Reconcile the current workspace with the visible ledger.
 *
 * Content that does not fit the per-turn budget stays pending: its ledger entry
 * is not advanced, so a later turn offers it again. A complete scan reports
 * deleted paths; an incomplete scan never infers deletion.
 * @param fileSystem - mounted filesystem service.
 * @param scan - completed workspace scan.
 * @param config - normalized budgets and limits.
 * @param ledger - files represented by the visible snapshot.
 * @param context - turn and displayed root.
 * @param signal - aborts file reads.
 * @returns the prepared update, or undefined when nothing changed.
 */
export async function prepareDelta(
  fileSystem: FileSystem,
  scan: ScanResult,
  config: ResolvedPrefillConfig,
  ledger: ReadonlyMap<string, PrefillFileEntry>,
  context: PrepareContext,
  signal: AbortSignal | undefined,
): Promise<PreparedPrefill | undefined> {
  const budget = config.deltaBudgetTokens
  const candidates = [...scan.candidates].sort(compareCandidates)
  const candidateByPath = new Map(candidates.map(candidate => [candidate.path, candidate]))
  const blocks: string[] = []
  const changes: PrefillChange[] = []
  const removedPaths: string[] = []
  const droppedPaths: string[] = []
  let added = 0
  let modified = 0
  let deferred = 0
  let oversize = 0
  let unreadable = 0
  let used = 0
  const unreadableDetails: string[] = []

  if (scan.complete) {
    for (const path of [...ledger.keys()].sort(compareStrings)) {
      if (!candidateByPath.has(path)) {
        removedPaths.push(path)
        changes.push({ action: 'remove', path })
      }
    }
  }

  for (const candidate of candidates) {
    signal?.throwIfAborted()
    const previous = ledger.get(candidate.path)
    if (previous !== undefined
      && previous.version !== null
      && candidate.version === previous.version
      && (candidate.size === undefined || candidate.size === previous.bytes)) {
      continue
    }
    const outcome = await readCandidate(fileSystem, candidate, config.maxFileBytes, signal)
    if (outcome.kind === 'oversize') {
      oversize += 1
      if (previous !== undefined) {
        droppedPaths.push(candidate.path)
        changes.push({ action: 'remove', path: candidate.path })
      }
      continue
    }
    if (outcome.kind === 'unreadable') {
      unreadable += 1
      unreadableDetails.push(`${candidate.path}${UNREADABLE_DETAIL_SEPARATOR}${outcome.detail}`)
      continue
    }
    if (previous !== undefined
      && previous.digest === outcome.file.digest
      && previous.bytes === outcome.file.bytes) {
      continue
    }
    const label = previous === undefined ? 'added' : 'modified'
    const block = renderFileBlock(candidate.path, label, outcome.file.text)
    const tokens = estimateTokens(block, config.charsPerToken)
    if (used + tokens > budget) {
      deferred += 1
      continue
    }
    blocks.push(block)
    changes.push({
      action: 'set',
      entry: {
        path: candidate.path,
        version: candidate.version,
        digest: outcome.file.digest,
        bytes: outcome.file.bytes,
      },
    })
    if (previous === undefined) added += 1
    else modified += 1
    used += tokens
  }

  if (changes.length === 0) return undefined
  return {
    text: renderDeltaText({
      turn: context.turn,
      rootDisplay: context.rootDisplay,
      added,
      modified,
      deferred,
      blocks,
      removedPaths,
      droppedPaths,
      oversize,
      unreadable,
      overBudget: 0,
      incomplete: !scan.complete,
      errors: [...scan.errors, ...unreadableDetails],
    }),
    changes,
    included: blocks.length,
  }
}

async function readCandidate(
  fileSystem: FileSystem,
  candidate: ScanCandidate,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
): Promise<ReadOutcome> {
  let size = candidate.size
  if (size === undefined) {
    try {
      const info = await fileSystem.stat(candidate.target, signal)
      if (info === undefined) return { kind: 'unreadable', detail: 'file disappeared' }
      if (info.type !== 'file') return { kind: 'unreadable', detail: 'not a regular file' }
      size = info.size
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      return { kind: 'unreadable', detail: messageOf(error) }
    }
  }
  if (size !== undefined && size > maxFileBytes) return { kind: 'oversize' }
  let text: string
  try {
    text = await fileSystem.readText(candidate.target, signal)
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    return { kind: 'unreadable', detail: messageOf(error) }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxFileBytes) return { kind: 'oversize' }
  return {
    kind: 'ok',
    file: {
      text,
      bytes,
      digest: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    },
  }
}

function compareCandidates(left: ScanCandidate, right: ScanCandidate): number {
  const depth = depthOf(left.path) - depthOf(right.path)
  return depth === 0 ? compareStrings(left.path, right.path) : depth
}

function depthOf(path: string): number {
  let depth = 0
  for (const character of path) {
    if (character === '/') depth += 1
  }
  return depth
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
