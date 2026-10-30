/**
 * Deterministic workspace traversal through the filesystem service.
 *
 * @module @deepseek-ai/dsh-prefill-context/scan
 */

import type { FileSystem, FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import type { ResolvedPrefillConfig } from './config.ts'

/** One regular file eligible for a snapshot. */
export interface ScanCandidate {
  /** Workspace-relative path with `/` separators. */
  path: string
  /** Resolved target used for reading. */
  target: FsTarget
  /** Byte size when the backend reports it. */
  size: number | undefined
  /** Opaque freshness token, or null when the backend omits it. */
  version: string | null
}

/** Result of one workspace traversal. */
export interface ScanResult {
  candidates: ScanCandidate[]
  /** Whether every eligible entry below the root was visited. */
  complete: boolean
  /** Directory listings that failed, formatted for the model-facing header. */
  errors: string[]
}

/**
 * Walk the workspace in codepoint order and collect eligible text files.
 *
 * Traversal stops early at a configured cap or depth limit; the result then
 * reports an state.incomplete scan so callers never infer that an unseen path was
 * removed. Unreadable directories are reported and skipped.
 * @param fileSystem - mounted filesystem service.
 * @param root - resolved workspace root.
 * @param config - normalized limits and include rules.
 * @param signal - aborts the traversal.
 * @returns eligible candidates plus scan completeness.
 */
export async function scanWorkspace(
  fileSystem: FileSystem,
  root: FsTarget,
  config: ResolvedPrefillConfig,
  signal: AbortSignal | undefined,
): Promise<ScanResult> {
  const candidates: ScanCandidate[] = []
  const errors: string[] = []
  const visitedDirectories = new Set<string>()
  const state = { visitedEntries: 0, stopped: false, incomplete: false }

  const walk = async (directory: FsTarget, relativePath: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    const key = directory.targetKey
    if (visitedDirectories.has(key)) return
    visitedDirectories.add(key)
    let entries: FsDirEntry[]
    try {
      entries = [...await fileSystem.listDir(directory, signal)]
    } catch (error: unknown) {
      if (signal?.aborted) throw error
      errors.push(`${relativePath.length === 0 ? '.' : relativePath}: ${errorMessage(error)}`)
      state.incomplete = true
      return
    }
    entries.sort(compareNames)
    for (const entry of entries) {
      if (state.stopped) return
      signal?.throwIfAborted()
      state.visitedEntries += 1
      if (state.visitedEntries > config.maxVisitedEntries) {
        state.stopped = true
        return
      }
      const childPath = relativePath.length === 0 ? entry.name : `${relativePath}/${entry.name}`
      if (entry.type === 'directory') {
        if (config.excludedDirectories.has(entry.name)) continue
        if (!fileSystem.contains(root, entry.target)) continue
        if (depth >= config.maxDepth) {
          state.incomplete = true
          continue
        }
        await walk(entry.target, childPath, depth + 1)
        continue
      }
      if (entry.type !== 'file') continue
      if (!isIncluded(entry.name, config)) continue
      if (!fileSystem.contains(root, entry.target)) continue
      if (candidates.length >= config.maxFiles) {
        state.stopped = true
        return
      }
      candidates.push({
        path: childPath,
        target: entry.target,
        size: entry.size,
        version: entry.version === undefined ? null : String(entry.version),
      })
    }
  }

  await walk(root, '', 0)
  return { candidates, complete: !state.stopped && !state.incomplete, errors }
}

function compareNames(left: FsDirEntry, right: FsDirEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function isIncluded(name: string, config: ResolvedPrefillConfig): boolean {
  if (config.excludedFileNames.has(name)) return false
  if (config.includeFileNames.has(name)) return true
  const lower = name.toLowerCase()
  return config.includeExtensions.some(extension => lower.endsWith(extension))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
