// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  PrefillLedgerView, PrefillSavingsView, PrefillSelectionView,
} from '@deepseek-ai/dsh-prefill-context/client'
import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { en } from '../src/client/locales.ts'
import { PrefillDashboard, type PrefillProjectionReader } from '../src/client/PrefillDashboard.tsx'
import { PrefillTitle } from '../src/client/PrefillTitle.tsx'

afterEach(cleanup)

const t = makeTranslate(en)

interface Views {
  readonly prefillContext?: PrefillSavingsView
  readonly prefillLedger?: PrefillLedgerView
  readonly tokenUsage?: TokenUsageProjection
  readonly contextPressure?: ContextPressureProjection
}

/** A projection read seat over one fixed set of served values. */
function projectionReader(views: Views): PrefillProjectionReader {
  function read(key: 'prefillContext'): PrefillSavingsView | undefined
  function read(key: 'prefillLedger'): PrefillLedgerView | undefined
  function read(key: 'tokenUsage'): TokenUsageProjection | undefined
  function read(key: 'contextPressure'): ContextPressureProjection | undefined
  function read(key: keyof Views): Views[keyof Views] {
    return views[key]
  }
  return read
}

function renderDashboard(views: Views): void {
  render(<PrefillDashboard useProjection={projectionReader(views)} t={t} />)
}

const SAVINGS: PrefillSavingsView = {
  visibleTokens: 1_200,
  injectedTokens: 1_000,
  reusedTokens: 3_000,
  selectorTokens: 250,
  selectorCalls: 2,
  savedTokens: 1_750,
  savedMs: 1_750,
  tokensPerSecond: 1_000,
}

const SELECTION: PrefillSelectionView = {
  turn: 2,
  selection: 'model',
  fallback: null,
  detail: null,
  provider: 'mock',
  model: 'mock-model',
  files: [
    { path: 'src/a.ts', reason: 'entry point' },
    { path: 'README.md', reason: 'project overview' },
  ],
  dropped: 1,
  durationMs: 1_200,
  tokens: 300,
}

const LEDGER: PrefillLedgerView = {
  root: '/work',
  lastScanTurn: 2,
  files: [
    { path: 'README.md', bytes: 12, reason: 'project overview' },
    { path: 'src/a.ts', bytes: 1_536, reason: 'entry point' },
    { path: 'assets/big.bin', bytes: 2_621_440, reason: null },
  ],
  selection: SELECTION,
}

const USAGE: TokenUsageProjection = {
  uncachedInputTokens: 1_000,
  cacheReadTokens: 4_000,
  cacheWriteTokens: 0,
  outputTokens: 200,
  last: { uncachedInputTokens: 100, cacheReadTokens: 4_000, cacheWriteTokens: 0, outputTokens: 20 },
}

describe('prefill dashboard', () => {
  it('shows the prefilled files, the savings readings, and the latest request beside the totals', () => {
    renderDashboard({
      prefillContext: SAVINGS,
      prefillLedger: LEDGER,
      tokenUsage: USAGE,
      contextPressure: { projectedTokens: 4_000, pressureTokens: 3_900, contextWindow: 128_000 },
    })

    expect(screen.getByRole('heading', { name: 'Prefill' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Cache and tokens' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Context' })).toBeTruthy()

    // Files: count tile, title, root, scan, and one row per file with its size.
    const prefill = within(screen.getByRole('region', { name: 'Prefill' }))
    expect(prefill.getByText('3')).toBeTruthy()
    expect(prefill.getByText('Prefilled files (3)')).toBeTruthy()
    expect(prefill.getByText('/work')).toBeTruthy()
    expect(prefill.getByText('Turn 2')).toBeTruthy()
    expect(prefill.getByText('src/a.ts')).toBeTruthy()
    expect(prefill.getByText('1.5 KB')).toBeTruthy()
    expect(prefill.getByText('12 B')).toBeTruthy()
    expect(prefill.getByText('2.5 MB')).toBeTruthy()
    expect(prefill.getByText('entry point')).toBeTruthy()
    expect(prefill.getByText('project overview')).toBeTruthy()

    // Selection: which method ordered the baseline, its route, and its cost.
    const selection = within(prefill.getByRole('heading', { name: 'Latest selection' }).parentElement as HTMLElement)
    expect(selection.getByText('Model')).toBeTruthy()
    expect(selection.getByText('mock / mock-model')).toBeTruthy()
    expect(selection.getByText('2')).toBeTruthy()
    expect(selection.getByText('1')).toBeTruthy()
    expect(selection.getByText('1.2s')).toBeTruthy()
    expect(selection.getByText('300')).toBeTruthy()
    expect(selection.getByText('The model chooses from a bounded candidate list; the deterministic fallback orders the same candidates shallow-first.')).toBeTruthy()

    // Savings: visible, injected, reused, selection, saved, and time.
    expect(prefill.getByText('1200')).toBeTruthy()
    expect(prefill.getByText('1000')).toBeTruthy()
    expect(prefill.getByText('3000')).toBeTruthy()
    expect(prefill.getByText('250')).toBeTruthy()
    expect(prefill.getByText('1750')).toBeTruthy()
    expect(prefill.getByText('1.8s')).toBeTruthy()
    expect(prefill.getByText('Saved time assumes 1000 uncached prompt tokens per second.')).toBeTruthy()
    expect(prefill.getByText('Saved tokens subtract the tokens the selection calls added.')).toBeTruthy()

    // Tokens: exact totals beside the newest sample, with cache hit shares.
    expect(screen.getByRole('columnheader', { name: 'Session total' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'Last request' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Prompt' }).closest('tr')?.textContent).toBe('Prompt50004100')
    expect(screen.getByRole('rowheader', { name: 'Cache hit' }).closest('tr')?.textContent).toBe('Cache hit80%97.6%')
    expect(screen.getByRole('rowheader', { name: 'Cache write' }).closest('tr')?.textContent).toBe('Cache write00')

    // Context: the projected prompt against the advertised window.
    expect(screen.getByText('4000 of 128000 tokens')).toBeTruthy()
    expect(screen.getByText('3.1%')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
  })

  it('explains why the first request reports no savings', () => {
    renderDashboard({
      prefillContext: {
        ...SAVINGS, visibleTokens: 0, injectedTokens: 0, reusedTokens: 0, selectorTokens: 0, selectorCalls: 0, savedTokens: 0, savedMs: 0,
      },
    })

    expect(screen.getByText('The first request only adds tokens; reuse is credited once the next request reads the cached prefix.')).toBeTruthy()
    expect(screen.queryByText('Saved tokens subtract the tokens the selection calls added.')).toBeNull()
    expect(screen.getByText('No prefill snapshot has been recorded yet.')).toBeTruthy()
    expect(screen.getByText('No token usage has been reported yet.')).toBeTruthy()
    expect(screen.getByText('No context usage has been reported yet.')).toBeTruthy()
    expect(screen.getByText('0s')).toBeTruthy()
    expect(screen.getAllByText('None')).toHaveLength(1)
  })

  it('explains a deterministic fallback without a route or diagnostic', () => {
    renderDashboard({
      prefillLedger: {
        ...LEDGER,
        selection: {
          ...SELECTION,
          selection: 'deterministic',
          fallback: 'no-candidates',
          detail: null,
          provider: null,
          model: null,
          files: [],
          dropped: 0,
          durationMs: null,
          tokens: 0,
        },
      },
    })

    const selection = within(screen.getByRole('heading', { name: 'Latest selection' }).parentElement as HTMLElement)
    expect(selection.getByText('Deterministic')).toBeTruthy()
    expect(selection.getByText('The scan found no eligible files.')).toBeTruthy()
    expect(selection.getAllByText('None')).toHaveLength(2)
    expect(selection.queryByText('Dropped entries')).toBeNull()
  })

  it('shows the diagnostic detail recorded with a fallback', () => {
    renderDashboard({
      prefillLedger: {
        ...LEDGER,
        selection: { ...SELECTION, selection: 'deterministic', fallback: 'timeout', detail: 'PREFILL_SELECTION_TIMEOUT' },
      },
    })

    const selection = within(screen.getByRole('heading', { name: 'Latest selection' }).parentElement as HTMLElement)
    expect(selection.getByText('The selection call timed out.')).toBeTruthy()
    expect(selection.getByText('PREFILL_SELECTION_TIMEOUT')).toBeTruthy()
  })

  it('keeps the file list when prefill accounting is unavailable', () => {
    renderDashboard({ prefillLedger: LEDGER })

    expect(screen.getByText('Prefill accounting is unavailable for this session.')).toBeTruthy()
    expect(screen.getByText('Prefilled files (3)')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
  })

  it('reports an empty scan and a scan without a recorded turn', () => {
    renderDashboard({ prefillLedger: { root: '/work', lastScanTurn: null, files: [], selection: null } })

    expect(screen.getByText('Prefilled files (0)')).toBeTruthy()
    expect(screen.getByText('The last scan included no files.')).toBeTruthy()
    expect(screen.getByText('None')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Latest selection' })).toBeNull()
  })

  it('reports token usage before the first sample and context pressure without a window', () => {
    renderDashboard({
      tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      contextPressure: { pressureTokens: 500 },
    })

    expect(screen.getByText('No token usage has been reported yet.')).toBeTruthy()
    expect(screen.getByText('500 tokens')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('prefers the projected prompt and reads a window smaller than the prompt', () => {
    renderDashboard({ contextPressure: { pressureTokens: 500, projectedTokens: 900, contextWindow: 1_000 } })

    expect(screen.getByText('900 of 1000 tokens')).toBeTruthy()
    expect(screen.getByText('90%')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('90')
  })

  it('reports no cache hit while no prompt input is billed', () => {
    renderDashboard({
      tokenUsage: {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        last: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      },
    })

    expect(screen.getByRole('rowheader', { name: 'Cache hit' }).closest('tr')?.textContent).toBe('Cache hitNoneNone')
  })

  it('states when none of its projections is served', () => {
    renderDashboard({})

    expect(screen.getByRole('status').textContent).toBe('Prefill data is not available for this session yet.')
    expect(screen.queryByRole('heading')).toBeNull()
  })
})

describe('prefill chip title', () => {
  it('draws the injected-context glyph before the tab title', () => {
    const { container } = render(<PrefillTitle useTabInfo={() => ({ tab: { title: 'Prefill' } })} />)

    expect(screen.getByText('Prefill')).toBeTruthy()
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeTruthy()
  })
})
