import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyPrefillAccountingEvent,
  applyPrefillLedgerEvent,
  initPrefillAccountingState,
  initPrefillLedgerState,
  parsePrefillSource,
  prefillAccountingStateSchema,
  prefillLedgerStateSchema,
  prefillLedgerView,
  prefillLedgerViewSchema,
  prefillSavingsSchema,
  prefillSavingsView,
  sameAccounting,
  type PrefillAccounting,
  type PrefillChange,
  type PrefillContextSource,
} from '../src/state.ts'

const ROOT = '/workspace'

function session(): Session {
  const id = SessionId('prefill-state')
  return Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd: ROOT,
  })
}

function appendPrefill(
  subject: Session,
  text: string,
  source: Omit<PrefillContextSource, 'kind'>,
): SessionEvent<'user/message'> {
  return subject.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'prefill-context', ...source },
  }), { surfaceOp: 'append' })
}

function appendBaseline(subject: Session, text: string, changes: PrefillChange[] = []): SessionEvent<'user/message'> {
  return appendPrefill(subject, text, { scannedTurn: 1, root: ROOT, baseline: true, changes })
}

function settle(subject: Session, usage?: TokenUsage): SessionEvent<'assistant/message'> {
  return subject.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'ok' }],
      source: { provider: 'mock', model: 'mock' },
    }),
    stream: [],
    ...(usage === undefined ? {} : { usage }),
  }, { surfaceOp: 'append' })
}

function entry(path: string, version: string | null, digest: string, bytes: number): PrefillChange {
  return { action: 'set', entry: { path, version, digest, bytes } }
}

/** Fold a baseline with no usage sample, the common starting point below. */
function baselined(subject: Session, text: string, changes: PrefillChange[] = []) {
  const baseline = appendBaseline(subject, text, changes)
  return {
    baseline,
    ledger: applyPrefillLedgerEvent(initPrefillLedgerState(), baseline),
    accounting: applyPrefillAccountingEvent(initPrefillAccountingState(), baseline, 4),
  }
}

describe('prefill ledger fold', () => {
  it('records the baseline snapshot and its commit', () => {
    const subject = session()
    const { baseline, ledger } = baselined(subject, 'x'.repeat(9), [
      entry('b.ts', null, 'b', 2),
      entry('a.ts', 'v1', 'a', 1),
    ])

    expect(ledger.root).toBe(ROOT)
    expect(ledger.baselineSeq).toBe(baseline.seq)
    expect(ledger.baselineAt).toBe(baseline.time)
    expect(ledger.lastScanTurn).toBe(1)
    expect(ledger.messageSeqs).toEqual([baseline.seq])
    expect(ledger.files).toEqual([
      { path: 'a.ts', version: 'v1', digest: 'a', bytes: 1 },
      { path: 'b.ts', version: null, digest: 'b', bytes: 2 },
    ])
  })

  it('applies each delta update to the snapshot', () => {
    const subject = session()
    const { baseline, ledger } = baselined(subject, 'x'.repeat(8), [entry('a.ts', 'v1', 'a', 1)])

    const update = appendPrefill(subject, 'y'.repeat(4), {
      scannedTurn: 2,
      root: ROOT,
      changes: [entry('a.ts', 'v2', 'a2', 3), { action: 'remove', path: 'missing.ts' }],
    })
    const next = applyPrefillLedgerEvent(ledger, update)

    expect(next.messageSeqs).toEqual([baseline.seq, update.seq])
    expect(next.lastScanTurn).toBe(2)
    expect(next.files).toEqual([{ path: 'a.ts', version: 'v2', digest: 'a2', bytes: 3 }])
  })

  it('replaces the snapshot on a second baseline', () => {
    const subject = session()
    const { ledger } = baselined(subject, 'x'.repeat(8))

    const rebaseline = appendBaseline(subject, 'q'.repeat(16), [entry('fresh.ts', null, 'f', 1)])
    const next = applyPrefillLedgerEvent(ledger, rebaseline)

    expect(next.baselineSeq).toBe(rebaseline.seq)
    expect(next.messageSeqs).toEqual([rebaseline.seq])
    expect(next.files).toEqual([{ path: 'fresh.ts', version: null, digest: 'f', bytes: 1 }])
  })

  it('clears the snapshot when an update belongs to another root', () => {
    const subject = session()
    const { ledger } = baselined(subject, 'x'.repeat(8))

    const foreign = appendPrefill(subject, 'z'.repeat(40), { scannedTurn: 2, root: '/elsewhere', changes: [] })

    expect(applyPrefillLedgerEvent(ledger, foreign)).toEqual(initPrefillLedgerState())
  })

  it('clears the snapshot when a surface replacement shadows a prefill message', () => {
    const subject = session()
    const { baseline, ledger } = baselined(subject, 'x'.repeat(8))

    const replacement = subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: baseline.seq, endSeq: baseline.seq },
      sourceEventSeqs: [baseline.seq],
    })

    expect(applyPrefillLedgerEvent(ledger, replacement)).toEqual(initPrefillLedgerState())
  })

  it('records the latest selection and preserves file reasons through a same-turn baseline', () => {
    const subject = session()
    const selection = subject.append('prefill/selection', {
      turn: 1,
      selection: 'model',
      provider: 'mock',
      model: 'mock',
      files: [{ path: 'a.ts', reason: 'defines a' }],
      durationMs: 12,
      usage: { inputTokens: 30, outputTokens: 5 },
    })
    const baseline = appendBaseline(subject, 'x'.repeat(8), [
      { action: 'set', entry: { path: 'a.ts', version: null, digest: 'a', bytes: 1, reason: 'defines a' } },
    ])
    const ledger = applyPrefillLedgerEvent(applyPrefillLedgerEvent(initPrefillLedgerState(), selection), baseline)

    expect(ledger.selection).toEqual({
      turn: 1,
      selection: 'model',
      fallback: null,
      detail: null,
      provider: 'mock',
      model: 'mock',
      files: [{ path: 'a.ts', reason: 'defines a' }],
      dropped: 0,
      durationMs: 12,
      tokens: 35,
    })
    expect(ledger.files).toEqual([
      { path: 'a.ts', version: null, digest: 'a', bytes: 1, reason: 'defines a' },
    ])
    expect(prefillLedgerView(ledger).selection).toMatchObject({ turn: 1, tokens: 35 })
    expect(prefillLedgerView(ledger).files[0]!.reason).toBe('defines a')

    const later = appendPrefill(subject, 'y'.repeat(8), {
      scannedTurn: 2,
      root: ROOT,
      baseline: true,
      changes: [],
    })
    expect(applyPrefillLedgerEvent(ledger, later).selection).toBeNull()
  })

  it('summarizes a selection without a route or duration as null readings', () => {
    const subject = session()
    const selection = subject.append('prefill/selection', {
      turn: 1,
      selection: 'deterministic',
      fallback: 'llm-unavailable',
      files: [],
    })

    expect(prefillLedgerView(applyPrefillLedgerEvent(initPrefillLedgerState(), selection)).selection).toEqual({
      turn: 1,
      selection: 'deterministic',
      fallback: 'llm-unavailable',
      detail: null,
      provider: null,
      model: null,
      files: [],
      dropped: 0,
      durationMs: null,
      tokens: 0,
    })
  })

  it('keeps path order when a baseline arrives already sorted', () => {
    const subject = session()
    const { ledger } = baselined(subject, 'x'.repeat(8), [
      entry('a.ts', null, 'a', 1),
      entry('b.ts', null, 'b', 2),
    ])

    expect(ledger.files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('drops removals from a baseline and keeps duplicate entries in input order', () => {
    const subject = session()
    const first = entry('a.ts', null, 'first', 1)
    const second = entry('a.ts', null, 'second', 2)
    const { ledger } = baselined(subject, 'x'.repeat(8), [
      second,
      { action: 'remove', path: 'gone.ts' },
      first,
    ])

    expect(ledger.files).toEqual([
      { path: 'a.ts', version: null, digest: 'second', bytes: 2 },
      { path: 'a.ts', version: null, digest: 'first', bytes: 1 },
    ])
  })

  it('ignores a durable prefill source that fails validation', () => {
    const subject = session()
    const { baseline, ledger } = baselined(subject, 'x'.repeat(8))
    const accounting = applyPrefillAccountingEvent(initPrefillAccountingState(), baseline, 4)
    const invalid = subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'not a ledger' }],
      source: { kind: 'prefill-context', scannedTurn: 0, root: ROOT, changes: [] },
    }), { surfaceOp: 'append' })

    expect(applyPrefillLedgerEvent(ledger, invalid)).toBe(ledger)
    expect(applyPrefillAccountingEvent(accounting, invalid, 4)).toBe(accounting)
  })

  it('keeps the snapshot for unrelated events and uncovered replacements', () => {
    const subject = session()
    const { ledger } = baselined(subject, 'x'.repeat(8))
    const unrelated = subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary request' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(applyPrefillLedgerEvent(ledger, subject.append('turn/start', { turn: 1 }))).toBe(ledger)
    expect(applyPrefillLedgerEvent(ledger, unrelated)).toBe(ledger)
  })
})

describe('prefill accounting fold', () => {
  it('records the baseline estimate as both visible and injected', () => {
    const subject = session()
    const { baseline, accounting } = baselined(subject, 'x'.repeat(9))

    // ceil(9 / 4) tokens of text, present in the request but not yet in a prefix.
    expect(accounting).toMatchObject({
      root: ROOT,
      baselineAt: baseline.time,
      messageSeqs: [baseline.seq],
      accounting: {
        visibleTokens: 3, injectedTokens: 3, reusedTokens: 0, prefixTokens: 0,
        selectorTokens: 0, selectorCalls: 0,
      },
    })
  })

  it('credits a settlement with the prefill tokens its cached prefix held', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))

    // The baseline request itself has no cached prefill prefix, so its own
    // settlement credits nothing and arms the next one.
    const cold = applyPrefillAccountingEvent(accounting, settle(subject, {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 5,
    }), 4)
    expect(cold.accounting).toEqual({
      visibleTokens: 2, injectedTokens: 2, reusedTokens: 0, prefixTokens: 2,
      selectorTokens: 0, selectorCalls: 0,
    })

    const update = appendPrefill(subject, 'y'.repeat(8), { scannedTurn: 2, root: ROOT, changes: [] })
    const withUpdate = applyPrefillAccountingEvent(cold, update, 4)
    expect(withUpdate.accounting).toEqual({
      visibleTokens: 4, injectedTokens: 4, reusedTokens: 0, prefixTokens: 2,
      selectorTokens: 0, selectorCalls: 0,
    })

    // The cached prefix held two prefill tokens, so at most two are credited.
    const warm = applyPrefillAccountingEvent(withUpdate, settle(subject, {
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 10,
    }), 4)
    expect(warm.accounting).toEqual({
      visibleTokens: 4, injectedTokens: 4, reusedTokens: 2, prefixTokens: 4,
      selectorTokens: 0, selectorCalls: 0,
    })

    const hotter = applyPrefillAccountingEvent(warm, settle(subject, {
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 10,
    }), 4)
    expect(hotter.accounting).toEqual({
      visibleTokens: 4, injectedTokens: 4, reusedTokens: 6, prefixTokens: 4,
      selectorTokens: 0, selectorCalls: 0,
    })
  })

  it('leaves the state reference unchanged for unrelated events and unusable reports', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))

    expect(applyPrefillAccountingEvent(accounting, subject.append('turn/start', { turn: 1 }), 4)).toBe(accounting)
    // An unreported settlement advances the prefix without crediting anything.
    const settled = applyPrefillAccountingEvent(accounting, settle(subject), 4)
    expect(settled.accounting).toEqual({
      visibleTokens: 2, injectedTokens: 2, reusedTokens: 0, prefixTokens: 2,
      selectorTokens: 0, selectorCalls: 0,
    })
    expect(applyPrefillAccountingEvent(settled, settle(subject), 4)).toBe(settled)

    const withoutBaseline = applyPrefillAccountingEvent(initPrefillAccountingState(), settle(subject, {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 5,
    }), 4)
    expect(withoutBaseline).toEqual(initPrefillAccountingState())
  })

  it('accumulates dispatched selection usage without touching prefill tokens', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))
    const selection = subject.append('prefill/selection', {
      turn: 1,
      selection: 'model',
      provider: 'mock',
      model: 'mock',
      files: [],
      llmStreamCall: true,
      usage: { inputTokens: 30, outputTokens: 5 },
    })

    const next = applyPrefillAccountingEvent(accounting, selection, 4)
    expect(next.accounting).toEqual({
      visibleTokens: 2, injectedTokens: 2, reusedTokens: 0, prefixTokens: 0,
      selectorTokens: 35, selectorCalls: 1,
    })
    expect(applyPrefillAccountingEvent(accounting, subject.append('prefill/selection', {
      turn: 1,
      selection: 'deterministic',
      fallback: 'llm-unavailable',
      files: [],
    }), 4)).toBe(accounting)
  })

  it('counts a selection report with usage but no dispatched stream call', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))
    const selection = subject.append('prefill/selection', {
      turn: 1,
      selection: 'model',
      files: [],
      usage: { inputTokens: 7, outputTokens: 3 },
    })

    expect(applyPrefillAccountingEvent(accounting, selection, 4).accounting).toMatchObject({
      selectorTokens: 10,
      selectorCalls: 0,
    })
  })

  it('estimates zero tokens for a prefill message without text', () => {
    const subject = session()
    const baseline = subject.append('user/message', createUserMessage({
      content: [{ type: 'reasoning', text: 'not text' }],
      source: { kind: 'prefill-context', scannedTurn: 1, root: ROOT, baseline: true, changes: [] },
    }), { surfaceOp: 'append' })

    expect(applyPrefillAccountingEvent(initPrefillAccountingState(), baseline, 4).accounting).toMatchObject({
      visibleTokens: 0,
      injectedTokens: 0,
    })
  })

  it('adds each delta update to the visible and injected totals', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))

    const update = appendPrefill(subject, 'y'.repeat(4), { scannedTurn: 2, root: ROOT, changes: [] })
    const next = applyPrefillAccountingEvent(accounting, update, 4)

    expect(next.accounting).toEqual({
      visibleTokens: 3, injectedTokens: 3, reusedTokens: 0, prefixTokens: 0,
      selectorTokens: 0, selectorCalls: 0,
    })
    expect(next.messageSeqs).toEqual([accounting.messageSeqs[0]!, update.seq])
  })

  it('replaces the visible tokens on a second baseline while keeping cumulative totals', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))

    const rebaseline = appendBaseline(subject, 'q'.repeat(16))
    const next = applyPrefillAccountingEvent(accounting, rebaseline, 4)

    expect(next.accounting).toEqual({
      visibleTokens: 4, injectedTokens: 6, reusedTokens: 0, prefixTokens: 0,
      selectorTokens: 0, selectorCalls: 0,
    })
    expect(next.messageSeqs).toEqual([rebaseline.seq])
  })

  it('clears visibility when an update belongs to another root and keeps the totals', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))
    const armed = applyPrefillAccountingEvent(accounting, settle(subject, {
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 8,
    }), 4)
    const reused = applyPrefillAccountingEvent(armed, settle(subject, {
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 8,
    }), 4)
    expect(reused.accounting.reusedTokens).toBe(2)

    const foreign = appendPrefill(subject, 'z'.repeat(40), { scannedTurn: 2, root: '/elsewhere', changes: [] })
    const next = applyPrefillAccountingEvent(reused, foreign, 4)

    expect(next).toMatchObject({ root: null, baselineAt: null, messageSeqs: [] })
    expect(next.accounting).toEqual({
      visibleTokens: 0, injectedTokens: 2, reusedTokens: 2, prefixTokens: 0,
      selectorTokens: 0, selectorCalls: 0,
    })
  })

  it('clears visibility when a surface replacement shadows a prefill message', () => {
    const subject = session()
    const { baseline, accounting } = baselined(subject, 'x'.repeat(8))
    const reused = applyPrefillAccountingEvent(
      applyPrefillAccountingEvent(accounting, settle(subject, {
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 8,
      }), 4),
      settle(subject, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 8 }),
      4,
    )

    const replacement = subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: baseline.seq, endSeq: baseline.seq },
      sourceEventSeqs: [baseline.seq],
    })
    const next = applyPrefillAccountingEvent(reused, replacement, 4)

    expect(next.baselineAt).toBeNull()
    expect(next.messageSeqs).toEqual([])
    expect(next.accounting).toEqual({
      visibleTokens: 0, injectedTokens: 2, reusedTokens: 2, prefixTokens: 0,
      selectorTokens: 0, selectorCalls: 0,
    })
  })

  it('keeps the accounting for an unrelated replacement', () => {
    const subject = session()
    const { accounting } = baselined(subject, 'x'.repeat(8))
    const unrelated = subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary request' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(applyPrefillAccountingEvent(accounting, unrelated, 4)).toBe(accounting)
  })
})

describe('durable source validation', () => {
  const valid: PrefillContextSource = {
    kind: 'prefill-context',
    scannedTurn: 1,
    root: ROOT,
    baseline: true,
    changes: [],
  }

  it('accepts a complete baseline or update record', () => {
    expect(parsePrefillSource(valid)).toEqual(valid)
    expect(parsePrefillSource({ ...valid, baseline: undefined })).toEqual({ ...valid, baseline: undefined })
  })

  it('rejects incomplete or malformed records', () => {
    expect(parsePrefillSource(undefined)).toBeUndefined()
    expect(parsePrefillSource({ kind: 'prefill-context' })).toBeUndefined()
    expect(parsePrefillSource({ ...valid, scannedTurn: 0 })).toBeUndefined()
    expect(parsePrefillSource({ ...valid, root: '' })).toBeUndefined()
    expect(parsePrefillSource({ ...valid, changes: [{ action: 'bogus' }] })).toBeUndefined()
    expect(parsePrefillSource({ ...valid, changes: [entry('a.ts', null, '', 1)] })).toBeUndefined()
  })
})

describe('savings and ledger views', () => {
  it('subtracts the injected tokens from the reused tokens', () => {
    expect(prefillSavingsView(
      {
        visibleTokens: 3, injectedTokens: 100, reusedTokens: 250, prefixTokens: 0,
        selectorTokens: 0, selectorCalls: 0,
      },
      1_500,
    )).toEqual({
      visibleTokens: 3,
      injectedTokens: 100,
      reusedTokens: 250,
      selectorTokens: 0,
      selectorCalls: 0,
      savedTokens: 150,
      savedMs: 100,
      tokensPerSecond: 1_500,
    })
  })

  it('never reports negative savings and rounds the saved time', () => {
    expect(prefillSavingsView(
      {
        visibleTokens: 3, injectedTokens: 250, reusedTokens: 100, prefixTokens: 0,
        selectorTokens: 0, selectorCalls: 0,
      },
      1_000,
    )).toEqual({
      visibleTokens: 3,
      injectedTokens: 250,
      reusedTokens: 100,
      selectorTokens: 0,
      selectorCalls: 0,
      savedTokens: 0,
      savedMs: 0,
      tokensPerSecond: 1_000,
    })
    expect(prefillSavingsView(
      {
        visibleTokens: 1, injectedTokens: 100, reusedTokens: 101, prefixTokens: 0,
        selectorTokens: 0, selectorCalls: 0,
      },
      3,
    ).savedMs).toBe(333)
  })

  it('compares accounting by its client-visible counts', () => {
    const accounting: PrefillAccounting = {
      visibleTokens: 1, injectedTokens: 2, reusedTokens: 3, prefixTokens: 4,
      selectorTokens: 5, selectorCalls: 1,
    }
    expect(sameAccounting(accounting, { ...accounting })).toBe(true)
    // The prefix arms the next settlement; it never renders, so it is excluded.
    expect(sameAccounting(accounting, { ...accounting, prefixTokens: 9 })).toBe(true)
    expect(sameAccounting(accounting, { ...accounting, visibleTokens: 2 })).toBe(false)
    expect(sameAccounting(accounting, { ...accounting, injectedTokens: 3 })).toBe(false)
    expect(sameAccounting(accounting, { ...accounting, reusedTokens: 4 })).toBe(false)
    expect(sameAccounting(accounting, { ...accounting, selectorTokens: 6 })).toBe(false)
    expect(sameAccounting(accounting, { ...accounting, selectorCalls: 2 })).toBe(false)
  })

  it('subtracts the selection cost from the saved tokens', () => {
    expect(prefillSavingsView({
      visibleTokens: 3, injectedTokens: 100, reusedTokens: 250, prefixTokens: 0,
      selectorTokens: 40, selectorCalls: 1,
    }, 1_000)).toEqual({
      visibleTokens: 3,
      injectedTokens: 100,
      reusedTokens: 250,
      selectorTokens: 40,
      selectorCalls: 1,
      savedTokens: 110,
      savedMs: 110,
      tokensPerSecond: 1_000,
    })
  })

  it('serves the renderable fields of the visible snapshot', () => {
    const subject = session()
    const { ledger } = baselined(subject, 'x'.repeat(8), [entry('nested/a.ts', 'v1', 'a', 12)])

    expect(prefillLedgerView(ledger)).toEqual({
      root: ROOT,
      lastScanTurn: 1,
      files: [{ path: 'nested/a.ts', bytes: 12, reason: null }],
      selection: null,
    })
  })
})

describe('projection schemas', () => {
  it('accepts the empty accounting state and rejects negative counts', () => {
    const state = initPrefillAccountingState()
    expect(prefillAccountingStateSchema.parse(state)).toEqual(state)
    expect(prefillAccountingStateSchema.safeParse({
      ...state,
      accounting: { visibleTokens: -1, injectedTokens: 0, reusedTokens: 0, prefixTokens: 0 },
    }).success).toBe(false)
    expect(prefillAccountingStateSchema.safeParse({
      ...state,
      accounting: { visibleTokens: 0, injectedTokens: 0, reusedTokens: 0, prefixTokens: -1 },
    }).success).toBe(false)
  })

  it('accepts the empty ledger state and rejects out-of-contract entries', () => {
    const state = initPrefillLedgerState()
    expect(prefillLedgerStateSchema.parse(state)).toEqual(state)
    expect(prefillLedgerStateSchema.safeParse({ ...state, lastScanTurn: 0 }).success).toBe(false)
    expect(prefillLedgerStateSchema.safeParse({
      ...state,
      files: [{ path: 'a.ts', version: null, digest: 'a', bytes: -1 }],
    }).success).toBe(false)
  })

  it('accepts the served savings view and rejects out-of-contract values', () => {
    const view = prefillSavingsView(
      {
        visibleTokens: 1, injectedTokens: 100, reusedTokens: 250, prefixTokens: 0,
        selectorTokens: 5, selectorCalls: 1,
      },
      1_000,
    )
    expect(prefillSavingsSchema.parse(view)).toEqual(view)
    expect(prefillSavingsSchema.safeParse({ ...view, extra: true }).success).toBe(false)
    expect(prefillSavingsSchema.safeParse({ ...view, visibleTokens: -1 }).success).toBe(false)
    expect(prefillSavingsSchema.safeParse({ ...view, savedMs: -1 }).success).toBe(false)
    expect(prefillSavingsSchema.safeParse({ ...view, tokensPerSecond: 0 }).success).toBe(false)
  })

  it('accepts the served ledger view and rejects out-of-contract values', () => {
    const view = {
      root: ROOT,
      lastScanTurn: 1,
      files: [{ path: 'a.ts', bytes: 3, reason: null }],
      selection: null,
    }
    expect(prefillLedgerViewSchema.parse(view)).toEqual(view)
    expect(prefillLedgerViewSchema.safeParse({ ...view, extra: true }).success).toBe(false)
    expect(prefillLedgerViewSchema.safeParse({
      ...view,
      files: [{ path: 'a.ts', bytes: 3, digest: 'a' }],
    }).success).toBe(false)
    expect(prefillLedgerViewSchema.safeParse({ ...view, files: [{ path: 'a.ts', bytes: -1 }] }).success).toBe(false)
  })
})
