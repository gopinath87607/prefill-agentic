/**
 * Display formatting for the prefill dashboard.
 *
 * Every locale-varying unit and separator comes from the `prefill` namespace,
 * so the readings follow the interface language rather than the browser's.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { TokenUsageBuckets } from '@deepseek-ai/dsh-token-meter/client'

/** The dashboard's translate seat. */
export type PrefillTranslate = TranslateNS<'prefill'>

/**
 * Sum the three disjoint prompt-side billing buckets.
 * @param buckets - one request's or the session's usage buckets.
 * @returns billed prompt tokens, including cache reads and writes.
 */
export function billedInput(buckets: TokenUsageBuckets): number {
  return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

/**
 * Exact non-negative count with no grouping, because every reading is an exact
 * token or file count.
 * @param value - non-negative integer.
 * @returns the count as decimal text.
 */
export function formatCount(value: number): string {
  return String(value)
}

/**
 * Percentage text at one decimal place.
 * @param value - percentage in 0..100.
 * @param t - dashboard translate seat.
 * @returns locale-owned percent text.
 */
export function formatPercent(value: number, t: PrefillTranslate): string {
  return t('percent', { value: Math.round(value * 10) / 10 })
}

/**
 * Duration text: one decimal below a minute, whole minutes and seconds above.
 * @param ms - non-negative duration in milliseconds.
 * @param t - dashboard translate seat.
 * @returns locale-owned duration text.
 */
export function formatDuration(ms: number, t: PrefillTranslate): string {
  const seconds = ms / 1_000
  if (seconds < 60) return t('duration.seconds', { seconds: Math.round(seconds * 10) / 10 })
  const whole = Math.round(seconds)
  return t('duration.minutes', { minutes: Math.floor(whole / 60), seconds: whole % 60 })
}

/**
 * Byte size with a binary unit and one decimal.
 * @param bytes - non-negative byte count.
 * @param t - dashboard translate seat.
 * @returns locale-owned size text.
 */
export function formatBytes(bytes: number, t: PrefillTranslate): string {
  if (bytes < 1024) return t('bytes.b', { value: bytes })
  if (bytes < 1024 * 1024) return t('bytes.kb', { value: Math.round(bytes / 1024 * 10) / 10 })
  return t('bytes.mb', { value: Math.round(bytes / (1024 * 1024) * 10) / 10 })
}

/**
 * Cache-hit share of a prompt-side total, never rounding a partial hit to 100.
 * @param cacheReadTokens - prompt tokens the provider served from cache.
 * @param promptTokens - billed prompt tokens, including cache reads and writes.
 * @param t - dashboard translate seat.
 * @returns percentage text, or null when the prompt billed no input.
 */
export function formatCacheHit(cacheReadTokens: number, promptTokens: number, t: PrefillTranslate): string | null {
  if (promptTokens === 0) return null
  if (cacheReadTokens >= promptTokens) return formatPercent(100, t)
  return formatPercent(Math.min(99.9, cacheReadTokens / promptTokens * 100), t)
}
