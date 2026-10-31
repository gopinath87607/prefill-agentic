/**
 * Deterministic workspace traversal through the filesystem service.
 *
 * @module @deepseek-ai/dsh-prefill-context/scan
 */

import ignore from 'ignore'
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
  /** Directory listings and `.gitignore` reads that failed, formatted for the model-facing header. */
  errors: string[]
}

/** One `.gitignore` file whose rules apply below its directory. */
interface GitignoreLayer {
  /** Workspace-relative directory containing the rules; empty for the root. */
  directory: string
  matcher: ReturnType<typeof ignore>
}

/**
 * Walk the workspace in codepoint order and collect eligible text files.
 *
 * Traversal stops early at a configured cap or depth limit; the result then
 * reports an incomplete scan so callers never infer that an unseen path was
 * removed. Unreadable directories are reported and skipped. Configured
 * patterns and, when enabled, `.gitignore` files exclude paths without reading
 * their contents.
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
  const excludedPatterns = ignore({ ignorecase: true }).add([...config.excludedFilePatterns])
  const gitignoreLayers: GitignoreLayer[] = []

  const isExcluded = (path: string, name: string, isDirectory: boolean): boolean => {
    if (!isDirectory && config.excludedFileNames.has(name.toLowerCase())) return true
    const candidate = isDirectory ? `${path}/` : path
    if (excludedPatterns.ignores(candidate)) return true
    return gitignoreIgnores(candidate, gitignoreLayers)
  }

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
      errors.push(`${displayDirectory(relativePath)}: ${errorMessage(error)}`)
      state.incomplete = true
      return
    }
    entries.sort(compareNames)
    const layerStart = gitignoreLayers.length
    if (config.respectGitignore) {
      await readGitignoreLayer(fileSystem, entries, relativePath, config.maxFileBytes, signal, errors, gitignoreLayers)
    }
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
        if (config.excludedDirectories.has(entry.name.toLowerCase())) continue
        if (isExcluded(childPath, entry.name, true)) continue
        if (!fileSystem.contains(root, entry.target)) continue
        if (depth >= config.maxDepth) {
          state.incomplete = true
          continue
        }
        await walk(entry.target, childPath, depth + 1)
        continue
      }
      if (entry.type !== 'file') continue
      if (isExcluded(childPath, entry.name, false)) continue
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
    gitignoreLayers.length = layerStart
  }

  await walk(root, '', 0)
  return { candidates, complete: !state.stopped && !state.incomplete, errors }
}

/**
 * Read the directory's own `.gitignore` and push its rules for this subtree.
 * @param fileSystem - mounted filesystem service.
 * @param entries - sorted entries of the directory.
 * @param relativePath - workspace-relative directory path, empty for the root.
 * @param maxFileBytes - largest `.gitignore` read.
 * @param signal - aborts the read.
 * @param errors - collected failure reports.
 * @param layers - active layer stack, mutated in place.
 * @returns when the rules have been pushed or the failure recorded.
 */
async function readGitignoreLayer(
  fileSystem: FileSystem,
  entries: readonly FsDirEntry[],
  relativePath: string,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
  errors: string[],
  layers: GitignoreLayer[],
): Promise<void> {
  const entry = entries.find(candidate => candidate.type === 'file' && candidate.name === '.gitignore')
  if (entry === undefined) return
  const display = relativePath.length === 0 ? '.gitignore' : `${relativePath}/.gitignore`
  if (entry.size !== undefined && entry.size > maxFileBytes) {
    errors.push(`${display}: over the size limit`)
    return
  }
  try {
    const text = await fileSystem.readText(entry.target, signal)
    if (text.trim().length === 0) return
    layers.push({ directory: relativePath, matcher: ignore().add(text) })
  } catch (error: unknown) {
    if (signal?.aborted) throw error
    errors.push(`${display}: ${errorMessage(error)}`)
  }
}

/**
 * Resolve the nearest `.gitignore` decision for a path.
 *
 * Layers are checked deepest first. A layer only sees the path relative to its
 * own directory, and the first layer that names the path (ignored or
 * re-included) decides it; a parent's decision stands when no child names it.
 * @param path - workspace-relative path with a trailing slash for directories.
 * @param layers - active layers from shallowest to deepest.
 * @returns whether the path is ignored.
 */
function gitignoreIgnores(path: string, layers: readonly GitignoreLayer[]): boolean {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]
    if (layer === undefined) continue
    const relative = layer.directory.length === 0
      ? path
      : path.startsWith(`${layer.directory}/`)
        ? path.slice(layer.directory.length + 1)
        : undefined
    if (relative === undefined) continue
    const result = layer.matcher.test(relative)
    if (result.ignored || result.unignored) return result.ignored
  }
  return false
}

function displayDirectory(relativePath: string): string {
  return relativePath.length === 0 ? '.' : relativePath
}

function compareNames(left: FsDirEntry, right: FsDirEntry): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

function isIncluded(name: string, config: ResolvedPrefillConfig): boolean {
  if (config.includeFileNames.has(name)) return true
  const lower = name.toLowerCase()
  return config.includeExtensions.some(extension => lower.endsWith(extension))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
