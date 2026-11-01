import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '../src/client/locales.ts'
import {
  billedInput,
  formatBytes,
  formatCacheHit,
  formatCount,
  formatDuration,
  formatPercent,
} from '../src/client/format.ts'

const t = makeTranslate(en)

describe('billed input', () => {
  it('sums the three disjoint prompt-side buckets', () => {
    expect(billedInput({
      uncachedInputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 25,
      outputTokens: 7,
    })).toBe(1_025)
  })
})

describe('counts and percentages', () => {
  it('prints exact counts without grouping', () => {
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1_234_567)).toBe('1234567')
  })

  it('prints percentages at one decimal place', () => {
    expect(formatPercent(3.125, t)).toBe('3.1%')
    expect(formatPercent(100, t)).toBe('100%')
  })
})

describe('durations', () => {
  it('uses seconds below a minute', () => {
    expect(formatDuration(0, t)).toBe('0s')
    expect(formatDuration(32_440, t)).toBe('32.4s')
  })

  it('uses whole minutes and seconds from a minute on', () => {
    expect(formatDuration(60_000, t)).toBe('1m 0s')
    expect(formatDuration(162_500, t)).toBe('2m 43s')
  })
})

describe('byte sizes', () => {
  it('picks the binary unit with one decimal', () => {
    expect(formatBytes(12, t)).toBe('12 B')
    expect(formatBytes(1_536, t)).toBe('1.5 KB')
    expect(formatBytes(2_621_440, t)).toBe('2.5 MB')
  })
})

describe('cache hit', () => {
  it('reports no reading without billed prompt tokens', () => {
    expect(formatCacheHit(0, 0, t)).toBeNull()
  })

  it('reports a full hit as 100', () => {
    expect(formatCacheHit(900, 900, t)).toBe('100%')
  })

  it('keeps a near-full hit below 100', () => {
    expect(formatCacheHit(4_000, 5_000, t)).toBe('80%')
    expect(formatCacheHit(9_996, 10_000, t)).toBe('99.9%')
  })
})
