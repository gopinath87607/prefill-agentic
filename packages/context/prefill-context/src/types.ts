/**
 * Browser-safe contracts of the prefill projections.
 *
 * This module holds the ONE declaration of the `prefillContext` and
 * `prefillLedger` projection keys, free of host-side value imports so the
 * `./client` namespace serves clients the same view types.
 *
 * @module @deepseek-ai/dsh-prefill-context/types
 */

import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/**
 * Cache savings attributed to the prefill snapshot.
 *
 * The figures are estimates: token counts come from the message text at
 * `charsPerToken`, and saved time assumes the configured uncached prompt
 * throughput. A prompt prefix is served from cache in order, so one request's
 * cache reads are credited at most with the prefill tokens visible at the
 * previous settlement — the tokens its cached prefix can hold.
 */
export interface PrefillSavingsView {
  /** Estimated tokens of the prefill messages currently visible on the surface. */
  visibleTokens: number
  /** Estimated tokens every prefill message has introduced, each processed uncached once. */
  injectedTokens: number
  /** Provider-reported prompt tokens served from cache that held prefill content. */
  reusedTokens: number
  /** Prompt and output tokens every dispatched selection call has introduced. */
  selectorTokens: number
  /** Number of dispatched selection calls whose usage is included in {@link selectorTokens}. */
  selectorCalls: number
  /** Net tokens whose prompt processing the prefill avoided after selection cost; never negative. */
  savedTokens: number
  /** {@link savedTokens} at the configured uncached prompt throughput. */
  savedMs: number
  /** Uncached prompt throughput the saved time assumes, in tokens per second. */
  tokensPerSecond: number
}

/** One file whose contents the visible prefill snapshot carries. */
export interface PrefillFileView {
  /** Workspace-relative path with `/` separators. */
  path: string
  /** UTF-8 byte length of the prefilled content. */
  bytes: number
  /** Model-written reason the path was selected, or null under deterministic ordering. */
  reason: string | null
}

/** One path the selection call chose, with its short reason. */
export interface PrefillSelectionFileView {
  /** Workspace-relative path that appeared in the candidate manifest. */
  path: string
  /** Short model-written reason the path matters to the request. */
  reason: string
}

/** Why the model selection did not produce the baseline ordering. */
export type PrefillSelectionFallback =
  | 'no-candidates'
  | 'no-request'
  | 'llm-unavailable'
  | 'no-route'
  | 'timeout'
  | 'stream-error'
  | 'invalid-response'

/** Latest baseline selection, as rendered by the dashboard. */
export interface PrefillSelectionView {
  /** Turn whose pre-step ran the selection. */
  turn: number
  /** Baseline ordering that actually ran. */
  selection: 'model' | 'deterministic'
  /** Reason the configured model selection was not used, or null. */
  fallback: PrefillSelectionFallback | null
  /** Short diagnostic detail for a fallback, or null. */
  detail: string | null
  /** Provider route the selection call used, or null without a call. */
  provider: string | null
  /** Exact model id the selection call used, or null without a call. */
  model: string | null
  /** Paths the model chose, in its priority order; empty for deterministic ordering. */
  files: readonly PrefillSelectionFileView[]
  /** Valid-looking entries dropped as duplicates, unknown paths, or over the cap. */
  dropped: number
  /** End-to-end duration of the selection call, or null without a call. */
  durationMs: number | null
  /** Reported prompt and output tokens of the selection call. */
  tokens: number
}

/**
 * Files represented by the visible prefill snapshot.
 *
 * The list is the ledger the pre-step reconciles against, so it names exactly
 * the files whose contents the model received. It is excluded from Session
 * summary payloads: a list row renders no file list.
 */
export interface PrefillLedgerView {
  /** Absolute workspace root the paths are relative to, or null before the first scan. */
  root: string | null
  /** Turn of the latest committed scan, or null before the first scan. */
  lastScanTurn: number | null
  /** Files whose contents are in the visible snapshot, sorted by path. */
  files: readonly PrefillFileView[]
  /** Latest baseline selection, or null before the first baseline. */
  selection: PrefillSelectionView | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Cache savings attributed to the prefill snapshot; see {@link PrefillSavingsView}. */
    prefillContext: PrefillSavingsView
    /** Files in the visible prefill snapshot; see {@link PrefillLedgerView}. */
    prefillLedger: SessionProjectionSummaryExcluded<PrefillLedgerView>
  }
}
