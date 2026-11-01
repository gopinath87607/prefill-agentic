import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyPrefillEvent,
  initPrefillState,
  parsePrefillSource,
  prefillSavingsSchema,
  prefillSavingsView,
  prefillStateSchema,
  sameAccounting,
  type PrefillChange,
  type PrefillContextSource,
  type PrefillContextState,
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

describe('prefill accounting fold', () => {
  it('records the baseline estimate and its ledger', () => {
    const subject = session()
    const baseline = appendBaseline(subject, 'x'.repeat(9), [
      entry('b.ts', null, 'b', 2),
      entry('a.ts', 'v1', 'a', 1),
    ])

    const state = applyPrefillEvent(initPrefillState(), baseline, 4)

    // ceil(9 / 4) tokens of text.
    expect(state.accounting).toEqual({ visibleTokens: 3, injectedTokens: 3, reusedTokens: 0 })
    expect(state.root).toBe(ROOT)
    expect(state.baselineSeq).toBe(baseline.seq)
    expect(state.baselineAt).toBe(baseline.time)
    expect(state.lastScanTurn).toBe(1)
    expect(state.messageSeqs).toEqual([baseline.seq])
    expect(state.files.map(file => file.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('credits each settlement cache read to the visible prefill content, bounded by it', () => {
    const subject = session()
    const baseline = appendBaseline(subject, 'x'.repeat(8))
    const withBaseline = applyPrefillEvent(initPrefillState(), baseline, 4)

    // Two visible prefill tokens, so a five-token cache read credits only two.
    const cold = applyPrefillEvent(withBaseline, settle(subject, {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 5,
    }), 4)
    expect(cold.accounting).toEqual({ visibleTokens: 2, injectedTokens: 2, reusedTokens: 2 })

    const update = appendPrefill(subject, 'y'.repeat(8), { scannedTurn: 2, root: ROOT, changes: [] })
    const withUpdate = applyPrefillEvent(cold, update, 4)
    expect(withUpdate.accounting).toEqual({ visibleTokens: 4, injectedTokens: 4, reusedTokens: 2 })

    const warm = applyPrefillEvent(withUpdate, settle(subject, {
      inputTokens: 3,
      outputTokens: 1,
      cacheReadTokens: 10,
    }), 4)
    expect(warm.accounting).toEqual({ visibleTokens: 4, injectedTokens: 4, reusedTokens: 6 })
  })

  it('leaves the state reference unchanged for unrelated events and unusable cache reports', () => {
    const subject = session()
    const state = applyPrefillEvent(initPrefillState(), appendBaseline(subject, 'x'.repeat(8)), 4)

    expect(applyPrefillEvent(state, subject.append('turn/start', { turn: 1 }), 4)).toBe(state)
    expect(applyPrefillEvent(state, settle(subject), 4)).toBe(state)
    expect(applyPrefillEvent(state, settle(subject, {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
    }), 4)).toBe(state)

    const withoutBaseline = applyPrefillEvent(initPrefillState(), settle(subject, {
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 5,
    }), 4)
    expect(withoutBaseline).toEqual(initPrefillState())
  })

  it('applies a delta update to the ledger and the accounting', () => {
    const subject = session()
    const baseline = appendBaseline(subject, 'x'.repeat(8), [entry('a.ts', 'v1', 'a', 1)])
    const state = applyPrefillEvent(initPrefillState(), baseline, 4)

    const update = appendPrefill(subject, 'y'.repeat(4), {
      scannedTurn: 2,
      root: ROOT,
      changes: [entry('a.ts', 'v2', 'a2', 3), { action: 'remove', path: 'missing.ts' }],
    })
    const next = applyPrefillEvent(state, update, 4)

    expect(next.accounting).toEqual({ visibleTokens: 3, injectedTokens: 3, reusedTokens: 0 })
    expect(next.messageSeqs).toEqual([baseline.seq, update.seq])
    expect(next.lastScanTurn).toBe(2)
    expect(next.files).toEqual([{ path: 'a.ts', version: 'v2', digest: 'a2', bytes: 3 }])
  })

  it('replaces the visible prefill tokens on a second baseline while keeping cumulative totals', () => {
    const subject = session()
    const state = applyPrefillEvent(initPrefillState(), appendBaseline(subject, 'x'.repeat(8)), 4)

    const rebaseline = appendBaseline(subject, 'q'.repeat(16), [entry('fresh.ts', null, 'f', 1)])
    const next = applyPrefillEvent(state, rebaseline, 4)

    expect(next.accounting).toEqual({ visibleTokens: 4, injectedTokens: 6, reusedTokens: 0 })
    expect(next.messageSeqs).toEqual([rebaseline.seq])
    expect(next.files).toEqual([{ path: 'fresh.ts', version: null, digest: 'f', bytes: 1 }])
  })

  it('clears the ledger when an update belongs to another root and keeps the totals', () => {
    const subject = session()
    const baseline = appendBaseline(subject, 'x'.repeat(8))
    const reused = applyPrefillEvent(
      applyPrefillEvent(initPrefillState(), baseline, 4),
      settle(subject, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 8 }),
      4,
    )

    const foreign = appendPrefill(subject, 'z'.repeat(40), { scannedTurn: 2, root: '/elsewhere', changes: [] })
    const next = applyPrefillEvent(reused, foreign, 4)

    expect(next).toMatchObject({
      root: null,
      baselineSeq: null,
      baselineAt: null,
      lastScanTurn: null,
      messageSeqs: [],
      files: [],
    })
    expect(next.accounting).toEqual({ visibleTokens: 0, injectedTokens: 2, reusedTokens: 2 })
  })

  it('clears the ledger when a surface replacement shadows a prefill message', () => {
    const subject = session()
    const baseline = appendBaseline(subject, 'x'.repeat(8))
    const reused = applyPrefillEvent(
      applyPrefillEvent(initPrefillState(), baseline, 4),
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
    const next = applyPrefillEvent(reused, replacement, 4)

    expect(next.baselineSeq).toBeNull()
    expect(next.messageSeqs).toEqual([])
    expect(next.accounting).toEqual({ visibleTokens: 0, injectedTokens: 2, reusedTokens: 2 })
  })

  it('keeps the ledger when a replacement does not cover a prefill message', () => {
    const subject = session()
    const baseline = appendBaseline(subject, 'x'.repeat(8))
    const state = applyPrefillEvent(initPrefillState(), baseline, 4)
    const unrelated = subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'ordinary request' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(applyPrefillEvent(state, unrelated, 4)).toBe(state)
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

describe('savings view', () => {
  it('subtracts the injected tokens from the reused tokens', () => {
    expect(prefillSavingsView(
      { visibleTokens: 3, injectedTokens: 100, reusedTokens: 250 },
      1_500,
    )).toEqual({
      injectedTokens: 100,
      reusedTokens: 250,
      savedTokens: 150,
      savedMs: 100,
      tokensPerSecond: 1_500,
    })
  })

  it('never reports negative savings and rounds the saved time', () => {
    expect(prefillSavingsView(
      { visibleTokens: 3, injectedTokens: 250, reusedTokens: 100 },
      1_000,
    )).toEqual({
      injectedTokens: 250,
      reusedTokens: 100,
      savedTokens: 0,
      savedMs: 0,
      tokensPerSecond: 1_000,
    })
    expect(prefillSavingsView(
      { visibleTokens: 1, injectedTokens: 100, reusedTokens: 101 },
      3,
    ).savedMs).toBe(333)
  })

  it('compares accounting by its counts', () => {
    const accounting = { visibleTokens: 1, injectedTokens: 2, reusedTokens: 3 }
    expect(sameAccounting(accounting, { ...accounting })).toBe(true)
    expect(sameAccounting(accounting, { ...accounting, visibleTokens: 2 })).toBe(false)
    expect(sameAccounting(accounting, { ...accounting, injectedTokens: 3 })).toBe(false)
    expect(sameAccounting(accounting, { ...accounting, reusedTokens: 4 })).toBe(false)
  })
})

describe('projection schemas', () => {
  it('accepts the empty state and rejects negative accounting', () => {
    const state = initPrefillState()
    expect(prefillStateSchema.parse(state)).toEqual(state)
    const invalid: PrefillContextState = {
      ...state,
      accounting: { visibleTokens: -1, injectedTokens: 0, reusedTokens: 0 },
    }
    expect(prefillStateSchema.safeParse(invalid).success).toBe(false)
  })

  it('accepts the served savings view and rejects out-of-contract values', () => {
    const view = prefillSavingsView({ visibleTokens: 1, injectedTokens: 100, reusedTokens: 250 }, 1_000)
    expect(prefillSavingsSchema.parse(view)).toEqual(view)
    expect(prefillSavingsSchema.safeParse({ ...view, extra: true }).success).toBe(false)
    expect(prefillSavingsSchema.safeParse({ ...view, savedMs: -1 }).success).toBe(false)
    expect(prefillSavingsSchema.safeParse({ ...view, tokensPerSecond: 0 }).success).toBe(false)
  })
})
