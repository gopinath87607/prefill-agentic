/**
 * Browser-safe contracts of the prefill projection.
 *
 * This module holds the ONE declaration of the `prefillContext` projection
 * key, free of host-side value imports so the `./client` namespace serves
 * clients the same view type.
 *
 * @module @deepseek-ai/dsh-prefill-context/types
 */

/**
 * Cache savings attributed to the prefill snapshot.
 *
 * The figures are estimates: token counts come from the message text at
 * `charsPerToken`, and saved time assumes the configured uncached prompt
 * throughput. A prompt prefix is served from cache in order, so the prefill
 * share of one request's cache reads is bounded by the prefill tokens visible
 * on the surface at that request.
 */
export interface PrefillSavingsView {
  /** Estimated tokens every prefill message has introduced, each processed uncached once. */
  injectedTokens: number
  /** Provider-reported prompt tokens served from cache and attributed to prefill content. */
  reusedTokens: number
  /** Net tokens whose prompt processing the prefill avoided; never negative. */
  savedTokens: number
  /** {@link savedTokens} at the configured uncached prompt throughput. */
  savedMs: number
  /** Uncached prompt throughput the saved time assumes, in tokens per second. */
  tokensPerSecond: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Cache savings attributed to the prefill snapshot; see {@link PrefillSavingsView}. */
    prefillContext: PrefillSavingsView
  }
}
