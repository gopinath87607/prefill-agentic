import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveConfig } from '../src/config.ts'
import type { Config, ResolvedPrefillConfig } from '../src/config.ts'
import type { ScanCandidate } from '../src/scan.ts'
import {
  PREFILL_SELECTION_SYSTEM,
  messageText,
  parseSelectionOutput,
  selectPrefillFiles,
  type PrefillSelectionInput,
  type PrefillSelectionResult,
} from '../src/selector.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { sessionAgent } from './session-agent.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function configured(overrides: Config = {}): ResolvedPrefillConfig {
  return resolveConfig(overrides)
}

function session(): Session {
  const id = SessionId('prefill-selector')
  return Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    cwd: '/workspace',
  })
}

function candidate(path: string, size: number | undefined): ScanCandidate {
  return {
    path,
    target: { targetKey: FsTargetKey(path), displayPath: path },
    size,
    version: null,
  }
}

const STEP_ROUTE = { provider: 'mock', model: 'mock' }

function input(
  request: string,
  candidates: readonly ScanCandidate[],
  route: { provider: string; model: string } = STEP_ROUTE,
): PrefillSelectionInput {
  return { turn: 7, request, candidates, route }
}

function unrouted(request: string, candidates: readonly ScanCandidate[]): PrefillSelectionInput {
  return { turn: 7, request, candidates, route: undefined }
}

async function mount(adapter: LlmAdapter): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function selectionEvents(subject: Session): SessionEvent<'prefill/selection'>[] {
  return subject.snapshotEvents().filter(
    (event): event is SessionEvent<'prefill/selection'> => event.type === 'prefill/selection',
  )
}

function requestEvents(subject: Session): SessionEvent<'prefill/selection-request'>[] {
  return subject.snapshotEvents().filter(
    (event): event is SessionEvent<'prefill/selection-request'> => event.type === 'prefill/selection-request',
  )
}

async function run(
  subject: Session,
  adapter: LlmAdapter,
  config: ResolvedPrefillConfig,
  selectionInput: PrefillSelectionInput,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ result: PrefillSelectionResult; agent: Agent }> {
  const context = await mount(adapter)
  const agent = sessionAgent(subject)
  const result = await selectPrefillFiles(context, agent, config, selectionInput, signal)
  return { result, agent }
}

describe('selection outcomes', () => {
  it('records deterministic ordering without a model call when configured', async () => {
    const subject = session()
    const adapter = new MockAdapter([])
    const { result } = await run(subject, adapter, configured({ selection: 'deterministic' }), input(
      'request',
      [candidate('a.ts', 1)],
    ))

    expect(result).toMatchObject({
      selection: 'deterministic',
      fallback: null,
      detail: null,
      provider: null,
      model: null,
      files: [],
      dropped: 0,
      durationMs: null,
      usage: undefined,
      rawOutput: undefined,
      dispatched: false,
    })
    expect(adapter.requests).toHaveLength(0)
    expect(requestEvents(subject)).toHaveLength(0)
    expect(selectionEvents(subject)).toHaveLength(1)
    expect(selectionEvents(subject)[0]!.data).toEqual({ turn: 7, selection: 'deterministic', files: [] })
  })

  it('falls back before a call when there are no candidates', async () => {
    const subject = session()
    const adapter = new MockAdapter([])
    const { result } = await run(subject, adapter, configured(), input('request', []))

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'no-candidates', dispatched: false })
    expect(adapter.requests).toHaveLength(0)
    expect(selectionEvents(subject)[0]!.data.fallback).toBe('no-candidates')
  })

  it('falls back before a call when no request text is visible', async () => {
    const subject = session()
    const adapter = new MockAdapter([])
    const { result } = await run(subject, adapter, configured(), input('   ', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'no-request', dispatched: false })
    expect(adapter.requests).toHaveLength(0)
  })

  it('falls back when the llm service is absent', async () => {
    const subject = session()
    ctx = new Context()
    const result = await selectPrefillFiles(
      ctx,
      sessionAgent(subject),
      configured(),
      input('request', [candidate('a.ts', 1)]),
      new AbortController().signal,
    )

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'llm-unavailable', dispatched: false })
    expect(selectionEvents(subject)[0]!.data.fallback).toBe('llm-unavailable')
  })

  it('falls back when no route is available', async () => {
    const subject = session()
    const adapter = new MockAdapter([])
    const { result } = await run(subject, adapter, configured(), unrouted('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'no-route', dispatched: false })
    expect(result.detail).toContain('provider and model')
    expect(adapter.requests).toHaveLength(0)
    expect(requestEvents(subject)).toHaveLength(0)
  })

  it('reports a route preparation failure without dispatching', async () => {
    const subject = session()
    const adapter = new MockAdapter([])
    const { result } = await run(
      subject,
      adapter,
      configured(),
      input('request', [candidate('a.ts', 1)], { provider: 'missing', model: 'model' }),
    )

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'no-route', dispatched: false })
    expect(result.detail).not.toBeNull()
    expect(adapter.requests).toHaveLength(0)
    expect(requestEvents(subject)).toHaveLength(0)
  })

  it('reports a timeout during route preparation', async () => {
    const subject = session()
    const { result } = await run(
      subject,
      new SlowPrepareAdapter(),
      configured({ selectorTimeoutMs: 5 }),
      input('request', [candidate('a.ts', 1)]),
    )

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'timeout', dispatched: false })
    expect(result.durationMs).toBeNull()
  })

  it('describes a non-Error route failure without an Error message', async () => {
    const subject = session()
    const { result } = await run(
      subject,
      new RejectingPrepareAdapter('route down'),
      configured(),
      input('request', [candidate('a.ts', 1)]),
    )

    expect(result).toMatchObject({ fallback: 'no-route', detail: 'route down' })
  })

  it('bounds a long route failure detail', async () => {
    const subject = session()
    const { result } = await run(
      subject,
      new RejectingPrepareAdapter(new Error('x'.repeat(400))),
      configured(),
      input('request', [candidate('a.ts', 1)]),
    )

    expect(result.fallback).toBe('no-route')
    expect(result.detail).toHaveLength(300)
    expect(result.detail?.endsWith('…')).toBe(true)
  })
})

describe('model selection', () => {
  it('records the request and applies the model order and reasons', async () => {
    const subject = session()
    const text = '```json\n{"files":[{"path":"b.ts","reason":"entry point"},{"path":"src/a.ts","reason":"types"}]}\n```'
    const adapter = new MockAdapter([textResponse(text)], {
      efforts: [{ id: ReasoningEffortId('high'), name: 'High' }],
      defaultEffort: ReasoningEffortId('high'),
    })
    const { result } = await run(subject, adapter, configured({ selectorMaxFiles: 2 }), input(
      'explain the entry point',
      [candidate('src/a.ts', 10), candidate('b.ts', undefined)],
    ))

    expect(result).toMatchObject({
      selection: 'model',
      fallback: null,
      provider: 'mock',
      model: 'mock',
      files: [{ path: 'b.ts', reason: 'entry point' }, { path: 'src/a.ts', reason: 'types' }],
      dropped: 0,
      dispatched: true,
      usage: { inputTokens: 10, outputTokens: text.length },
    })
    expect(result.rawOutput).toEqual([{ type: 'text', text }])

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'mock',
      model: 'mock',
      purpose: 'prefill-selection',
      system: PREFILL_SELECTION_SYSTEM,
      maxTokens: 2_048,
    })
    const prompt = messageText(adapter.requests[0]!.messages[0]!.content)
    expect(prompt).toContain('explain the entry point')
    expect(prompt).toContain('- src/a.ts 10')
    expect(prompt).toContain('- b.ts ?')
    expect(prompt).toContain('Select at most 2 files')

    const request = requestEvents(subject)
    expect(request).toHaveLength(1)
    expect(request[0]!.data).toMatchObject({
      turn: 7,
      route: { provider: 'mock', model: 'mock' },
      maxTokens: 2_048,
      reasoningEffort: 'high',
      candidates: 2,
      shown: 2,
    })
    const selection = selectionEvents(subject)
    expect(selection).toHaveLength(1)
    expect(selection[0]!.data).toMatchObject({
      turn: 7,
      selection: 'model',
      provider: 'mock',
      model: 'mock',
      files: [{ path: 'b.ts', reason: 'entry point' }, { path: 'src/a.ts', reason: 'types' }],
      usage: { inputTokens: 10, outputTokens: text.length },
      llmStreamCall: true,
    })
    expect(selection[0]!.data.rawOutput).toEqual([{ type: 'text', text }])
    expect(selection[0]!.data.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('uses a configured selector route when the step route is absent', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse('{"files":[]}')])
    const { result } = await run(
      subject,
      adapter,
      configured({ selectorProvider: 'mock', selectorModel: 'mock' }),
      unrouted('request', [candidate('a.ts', 1)]),
    )

    expect(result).toMatchObject({ selection: 'model', provider: 'mock', model: 'mock', files: [] })
    expect(requestEvents(subject)[0]!.data.route).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('treats an explicit empty list as a successful selection', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse('{"files":[]}')])
    const { result } = await run(subject, adapter, configured(), input('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ selection: 'model', fallback: null, files: [], dropped: 0 })
    expect(selectionEvents(subject)[0]!.data.files).toEqual([])
  })

  it('drops unknown, duplicate, and over-cap entries and defaults a blank reason', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse(JSON.stringify({
      files: [
        { path: 'a.ts', reason: '  ' },
        { path: 'a.ts', reason: 'repeat' },
        { path: 'ghost.ts', reason: 'unknown' },
        { path: 'b.ts', reason: 'second' },
      ],
    }))])
    const { result } = await run(
      subject,
      adapter,
      configured({ selectorMaxFiles: 1 }),
      input('request', [candidate('a.ts', 1), candidate('b.ts', 1)]),
    )

    expect(result).toMatchObject({
      selection: 'model',
      files: [{ path: 'a.ts', reason: 'selected' }],
      dropped: 3,
    })
  })

  it('falls back on unusable JSON', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse('not json at all')])
    const { result } = await run(subject, adapter, configured(), input('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'invalid-response', dispatched: true })
    expect(result.rawOutput).toEqual([{ type: 'text', text: 'not json at all' }])
    expect(selectionEvents(subject)[0]!.data).toMatchObject({
      fallback: 'invalid-response',
      llmStreamCall: true,
    })
  })

  it('falls back when every named path is unusable', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse('{"files":[{"path":"ghost.ts","reason":"x"}]}')])
    const { result } = await run(subject, adapter, configured(), input('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'invalid-response', dispatched: true })
  })
})

describe('selection failures after dispatch', () => {
  it('classifies a stream failure as stream-error', async () => {
    const subject = session()
    const adapter = new MockAdapter([() => { throw new Error('adapter exploded') }])
    const { result } = await run(subject, adapter, configured(), input('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({
      selection: 'deterministic',
      fallback: 'stream-error',
      detail: 'adapter exploded',
      provider: 'mock',
      model: 'mock',
      dispatched: true,
      rawOutput: [],
    })
    expect(selectionEvents(subject)[0]!.data).toMatchObject({
      fallback: 'stream-error',
      rawOutput: [],
      llmStreamCall: true,
    })
  })

  it('classifies a middleware failure as stream-error', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse('{"files":[]}')])
    const context = await mount(adapter)
    context.on('llm/stream', async function* (_options, next) {
      yield* next()
      throw new Error('middleware exploded')
    })

    const result = await selectPrefillFiles(
      context,
      sessionAgent(subject),
      configured(),
      input('request', [candidate('a.ts', 1)]),
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      selection: 'deterministic',
      fallback: 'stream-error',
      detail: 'middleware exploded',
      dispatched: true,
    })
    expect(selectionEvents(subject)[0]!.data).toMatchObject({
      fallback: 'stream-error',
      llmStreamCall: true,
    })
  })

  it('classifies the deadline as timeout', async () => {
    const subject = session()
    const adapter = new MockAdapter(['hang'])
    const { result } = await run(
      subject,
      adapter,
      configured({ selectorTimeoutMs: 5 }),
      input('request', [candidate('a.ts', 1)]),
    )

    expect(result).toMatchObject({ selection: 'deterministic', fallback: 'timeout', dispatched: true })
    expect(result.durationMs).not.toBeNull()
  })

  it('classifies an error finish as stream-error', async () => {
    const subject = session()
    const adapter = new MockAdapter([[
      { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER', message: 'provider failed' } } },
    ]])
    const { result } = await run(subject, adapter, configured(), input('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ fallback: 'stream-error', detail: 'provider failed', dispatched: true })
  })

  it('classifies an aborted finish as stream-error', async () => {
    const subject = session()
    const adapter = new MockAdapter([[
      { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stream aborted' } } },
    ]])
    const { result } = await run(subject, adapter, configured(), input('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ fallback: 'stream-error', detail: 'stream aborted', dispatched: true })
  })

  it('treats a non-terminal finish as an unusable answer', async () => {
    const subject = session()
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'nope' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]])
    const { result } = await run(subject, adapter, configured(), input('request', [candidate('a.ts', 1)]))

    expect(result).toMatchObject({ fallback: 'invalid-response', dispatched: true })
  })

  it('rethrows caller cancellation during the stream', async () => {
    const subject = session()
    const adapter = new MockAdapter(['hang'])
    const controller = new AbortController()
    const context = await mount(adapter)
    const pending = selectPrefillFiles(
      context,
      sessionAgent(subject),
      configured(),
      input('request', [candidate('a.ts', 1)]),
      controller.signal,
    )
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    controller.abort(new Error('caller cancelled'))

    await expect(pending).rejects.toThrow('caller cancelled')
    expect(selectionEvents(subject)).toHaveLength(0)
  })

  it('rethrows an already-cancelled turn before dispatch', async () => {
    const subject = session()
    const adapter = new MockAdapter([])
    const controller = new AbortController()
    controller.abort(new Error('pre-cancelled'))
    const context = await mount(adapter)

    await expect(selectPrefillFiles(
      context,
      sessionAgent(subject),
      configured(),
      input('request', [candidate('a.ts', 1)]),
      controller.signal,
    )).rejects.toThrow('pre-cancelled')
    expect(adapter.requests).toHaveLength(0)
  })
})

describe('selection prompt', () => {
  it('truncates the request and notes candidates that did not fit', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse('{"files":[]}')])
    const candidates = Array.from({ length: 40 }, (_unused, index) => candidate(
      `deep/nested/directory/file-with-a-long-name-${String(index)}.ts`,
      1,
    ))
    const request = 'r'.repeat(1_000)
    await run(
      subject,
      adapter,
      configured({ selectorInputTokens: 1, charsPerToken: 4 }),
      input(request, candidates),
    )

    const prompt = messageText(adapter.requests[0]!.messages[0]!.content)
    expect(prompt).toContain('[... request truncated ...]')
    expect(prompt).toMatch(/\d+ more candidate paths did not fit in this request\./)
    expect(requestEvents(subject)[0]!.data.shown).toBeLessThan(40)
    expect(requestEvents(subject)[0]!.data.candidates).toBe(40)
  })

  it('lists candidates shallow-first, then by path', async () => {
    const subject = session()
    const adapter = new MockAdapter([textResponse('{"files":[]}')])
    await run(
      subject,
      adapter,
      configured(),
      input('request', [candidate('z.ts', 1), candidate('a/b.ts', 2), candidate('m.ts', 3)]),
    )

    const prompt = messageText(adapter.requests[0]!.messages[0]!.content)
    expect(prompt.indexOf('- m.ts 3')).toBeLessThan(prompt.indexOf('- z.ts 1'))
    expect(prompt.indexOf('- z.ts 1')).toBeLessThan(prompt.indexOf('- a/b.ts 2'))
  })
})

describe('selection output parsing', () => {
  const allowed = new Set(['a.ts', 'b.ts'])

  it('rejects text without a complete object', () => {
    expect(parseSelectionOutput('plain text', allowed, 2)).toBeUndefined()
    expect(parseSelectionOutput('{', allowed, 2)).toBeUndefined()
    expect(parseSelectionOutput('} {', allowed, 2)).toBeUndefined()
    expect(parseSelectionOutput('{not json}', allowed, 2)).toBeUndefined()
    expect(parseSelectionOutput('null', allowed, 2)).toBeUndefined()
  })

  it('rejects a document without a files array', () => {
    expect(parseSelectionOutput('[]', allowed, 2)).toBeUndefined()
    expect(parseSelectionOutput('{"files":null}', allowed, 2)).toBeUndefined()
    expect(parseSelectionOutput('{"filse":[]}', allowed, 2)).toBeUndefined()
  })

  it('accepts a fenced object and drops malformed entries', () => {
    expect(parseSelectionOutput(
      'prose {"files":[null,[],{"path":5},{"path":"a.ts","reason":"why"}]} trailing',
      allowed,
      2,
    )).toEqual({ files: [{ path: 'a.ts', reason: 'why' }], dropped: 3 })
  })

  it('defaults a non-string reason and bounds a long one', () => {
    expect(parseSelectionOutput('{"files":[{"path":"a.ts","reason":5}]}', allowed, 2)!.files[0]!.reason)
      .toBe('selected')
    expect(parseSelectionOutput(
      `{"files":[{"path":"a.ts","reason":"${'r'.repeat(300)}"}]}`,
      allowed,
      2,
    )!.files[0]!.reason).toHaveLength(200)
  })

  it('keeps at most maxFiles usable paths', () => {
    expect(parseSelectionOutput(
      '{"files":[{"path":"a.ts"},{"path":"b.ts"}]}',
      allowed,
      1,
    )).toEqual({ files: [{ path: 'a.ts', reason: 'selected' }], dropped: 1 })
  })
})

describe('message text', () => {
  it('joins text blocks and ignores other block types', () => {
    expect(messageText([
      { type: 'text', text: 'visible ' },
      { type: 'reasoning', text: 'hidden' },
      { type: 'text', text: 'answer' },
    ])).toBe('visible answer')
  })
})

describe('selection configuration', () => {
  it('requires the selector provider and model together', () => {
    expect(() => resolveConfig({ selectorProvider: 'mock' })).toThrow(/configured together/)
    expect(() => resolveConfig({ selectorModel: 'mock' })).toThrow(/configured together/)
  })

  it('rejects empty selector names', () => {
    expect(() => resolveConfig({ selectorProvider: ' ', selectorModel: 'mock' }))
      .toThrow(/selectorProvider must not be empty/)
    expect(() => resolveConfig({ selectorProvider: 'mock', selectorModel: ' ' }))
      .toThrow(/selectorModel must not be empty/)
  })

  it('rejects selector limits outside the timer range', () => {
    expect(() => resolveConfig({ selectorTimeoutMs: 0 })).toThrow(/greater than zero/)
    expect(() => resolveConfig({ selectorTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow(/must not exceed/)
  })

  it('rejects an unknown selection mode', () => {
    expect(() => resolveConfig({ selection: 'keyword' as never })).toThrow(/must be one of/)
  })
})

class SlowPrepareAdapter extends LlmAdapter {
  override resolveModel(
    _provider: string,
    _model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return new Promise((_resolve, reject) => {
      const fail = (): void => {
        reject(signal?.reason instanceof Error ? signal.reason : new Error('resolveModel aborted'))
      }
      if (signal?.aborted) { fail(); return }
      signal?.addEventListener('abort', fail, { once: true })
    })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('unused')
  }
}

class RejectingPrepareAdapter extends LlmAdapter {
  constructor(private readonly rejection: unknown) {
    super()
  }

  override async resolveModel(): Promise<LlmResolvedModelInfo> {
    throw this.rejection
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('unused')
  }
}
