import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  mountAgentLoopTestDependencies,
  provideWorkingDirectoryFixture,
  unsupportedInbox,
  unsupportedModel,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as prefillContext from '@deepseek-ai/dsh-prefill-context'
import type { Config } from '@deepseek-ai/dsh-prefill-context'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const SIGNAL = new AbortController().signal

let workdir: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function workspace(files: Record<string, string>): Promise<string> {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-prefill-context-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(workdir, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content)
  }
  return workdir
}

async function mount(cwd: string, config: Config = {}): Promise<Fiber> {
  ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: '/' })
  provideWorkingDirectoryFixture(ctx, cwd)
  return ctx.plugin(prefillContext, config)
}

function session(cwd: string, id = 'session', meta: { origin?: 'subagent' } = {}): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
    createdAt: 0,
    isSeeded: false,
    cwd,
    ...meta,
  })
}

function sessionAgent(subject: Session, id = 'agent'): Agent {
  return {
    id: SessionId(id),
    options: {},
    session: subject,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('prefill-context must append directly to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function openTurn(subject: Session, turn: number): void {
  subject.append('turn/start', { turn })
  subject.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function proposal(text = 'request proposal'): ReturnType<typeof createUserMessage> {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

async function decide(
  ctx: Context,
  agent: Agent,
  turn: number,
  step = 1,
  signal: AbortSignal = SIGNAL,
  proposed: readonly ReturnType<typeof createUserMessage>[] = [proposal()],
): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { modelSelection: { provider: 'mock', model: 'mock' }, messages: [...proposed], turn, step, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [...proposed] }),
  )
}

async function fire(
  ctx: Context,
  agent: Agent,
  turn: number,
  step = 1,
  signal: AbortSignal = SIGNAL,
): Promise<void> {
  const proposed = [proposal()]
  const decision = await decide(ctx, agent, turn, step, signal, proposed)
  if (decision.kind !== 'enter') return
  for (const message of decision.messages) {
    if (proposed.includes(message)) continue
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  }
}

function prefillMessages(subject: Session): SessionEvent<'user/message'>[] {
  return subject.snapshotEvents().filter(
    (event): event is SessionEvent<'user/message'> => (
      event.type === 'user/message' && event.data.source.kind === 'prefill-context'
    ),
  )
}

function prefillText(event: SessionEvent<'user/message'>): string {
  return event.data.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
}

function requestText(request: { messages: readonly { content: readonly { type: string; text?: string }[] }[] }): string {
  return request.messages
    .flatMap(message => message.content)
    .flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : [])
    .join('\n')
}

describe('workspace snapshots', () => {
  it('injects one baseline with the included files and excludes secrets and ignored directories', async () => {
    const cwd = await workspace({
      'a.ts': 'export const a = 1\n',
      'nested/b.ts': 'export const b = 2\n',
      '.env': 'TOKEN=secret\n',
      'node_modules/dependency/index.js': 'module.exports = 1\n',
      'notes.txt': 'plain notes\n',
    })
    await mount(cwd)
    const subject = session(cwd)
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    const messages = prefillMessages(subject)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.data.source).toMatchObject({ kind: 'prefill-context', baseline: true, scannedTurn: 1, root: cwd })
    const text = prefillText(messages[0]!)
    expect(text).toContain('<prefill-context kind="baseline"')
    expect(text).toContain('--- FILE: a.ts ---')
    expect(text).toContain('export const a = 1')
    expect(text).toContain('--- FILE: nested/b.ts ---')
    expect(text).toContain('--- FILE: notes.txt ---')
    expect(text).not.toContain('.env')
    expect(text).not.toContain('node_modules')
  })

  it('applies .gitignore files, configured patterns, and case-insensitive exclusions', async () => {
    const cwd = await workspace({
      'keep.ts': 'keep\n',
      'skip.ts': 'skip\n',
      'a.skip': 'skip\n',
      'NODE_MODULES/pkg/index.ts': 'dependency\n',
      '.ENV': 'SECRET=1\n',
      '.env.local': 'SECRET=1\n',
      'Cargo.lock': 'lock\n',
      'generated/service.generated.ts': 'generated\n',
      'cache/entry.ts': 'cache\n',
      'nested/keep.ts': 'nested keep\n',
      'nested/skip.ts': 'nested skip\n',
      '.gitignore': 'skip.ts\n*.skip\ncache/\n',
      'nested/.gitignore': '*.ts\n!keep.ts\n',
    })
    await mount(cwd)
    const subject = session(cwd)
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    const text = prefillText(prefillMessages(subject)[0]!)
    expect(text).toContain('--- FILE: keep.ts ---')
    expect(text).toContain('--- FILE: nested/keep.ts ---')
    expect(text).toContain('--- FILE: .gitignore ---')
    expect(text).toContain('--- FILE: nested/.gitignore ---')
    expect(text).not.toContain('--- FILE: skip.ts ---')
    expect(text).not.toContain('--- FILE: a.skip ---')
    expect(text).not.toContain('--- FILE: NODE_MODULES/pkg/index.ts ---')
    expect(text).not.toContain('--- FILE: .ENV ---')
    expect(text).not.toContain('--- FILE: .env.local ---')
    expect(text).not.toContain('--- FILE: Cargo.lock ---')
    expect(text).not.toContain('--- FILE: generated/service.generated.ts ---')
    expect(text).not.toContain('--- FILE: cache/entry.ts ---')
    expect(text).not.toContain('--- FILE: nested/skip.ts ---')
    expect(text).not.toContain('SECRET=1')
  })

  it('includes gitignored paths when respectGitignore is disabled', async () => {
    const cwd = await workspace({
      'keep.ts': 'keep\n',
      'skip.ts': 'skip\n',
      '.gitignore': 'skip.ts\n',
    })
    await mount(cwd, { respectGitignore: false })
    const subject = session(cwd)
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    const text = prefillText(prefillMessages(subject)[0]!)
    expect(text).toContain('--- FILE: skip.ts ---')
    expect(text).toContain('--- FILE: keep.ts ---')
  })

  it('replaces the default exclusion patterns with a custom list', async () => {
    const cwd = await workspace({
      'keep.txt': 'keep\n',
      'drop.txt': 'drop\n',
      'a.ts': 'export const a = 1\n',
      '.env.local': 'SECRET=1\n',
      'custom/entry.ts': 'custom\n',
    })
    await mount(cwd, { excludedFilePatterns: ['*.txt', '!keep.txt', 'custom/'] })
    const subject = session(cwd)
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    const text = prefillText(prefillMessages(subject)[0]!)
    expect(text).toContain('--- FILE: keep.txt ---')
    expect(text).toContain('--- FILE: a.ts ---')
    expect(text).not.toContain('--- FILE: drop.txt ---')
    expect(text).not.toContain('--- FILE: custom/entry.ts ---')
    expect(text).not.toContain('SECRET=1')
  })

  it('caps per-file tokens in the baseline and lists skipped paths', async () => {
    const cwd = await workspace({
      'big.ts': 'x'.repeat(50),
      'small.ts': 'x',
    })
    await mount(cwd, { maxFileTokens: 5, charsPerToken: 1, budgetTokens: 10_000 })
    const subject = session(cwd)
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    const text = prefillText(prefillMessages(subject)[0]!)
    expect(text).toContain('Scan notes: 2 over the per-file token limit.')
    expect(text).not.toContain('--- FILE:')
    expect(text).toContain('Paths of files without contents follow the blocks')
    expect(text).toContain('--- PATHS NOT INCLUDED ---')
    expect(text).toContain('- big.ts')
    expect(text).toContain('- small.ts')
    expect(text).toContain('paths="2"')
  })

  it('omits the path index when disabled', async () => {
    const cwd = await workspace({ 'a.ts': 'x'.repeat(50) })
    await mount(cwd, { maxFileTokens: 0, includePathIndex: false })
    const subject = session(cwd)
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    const text = prefillText(prefillMessages(subject)[0]!)
    expect(text).not.toContain('--- PATHS NOT INCLUDED ---')
    expect(text).not.toContain('paths=')
  })

  it('omits the path index when its budget is zero', async () => {
    const cwd = await workspace({ 'a.ts': 'x'.repeat(50) })
    await mount(cwd, { maxFileTokens: 0, indexBudgetTokens: 0 })
    const subject = session(cwd)
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    const text = prefillText(prefillMessages(subject)[0]!)
    expect(text).not.toContain('--- PATHS NOT INCLUDED ---')
  })

  it('drops tracked files past the per-file token cap and lists new oversized paths as pending', async () => {
    const cwd = await workspace({
      'a.ts': 'x\n',
      'b.ts': 'y\n',
    })
    await mount(cwd, { maxFileTokens: 15, budgetTokens: 10_000, reserveTokens: 0 })
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    await writeFile(join(cwd, 'a.ts'), 'x'.repeat(20))
    await writeFile(join(cwd, 'b.ts'), 'y'.repeat(100))
    await writeFile(join(cwd, 'c.ts'), 'z'.repeat(100))
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)

    await fire(ctx!, agent, 2)

    const messages = prefillMessages(subject)
    expect(messages).toHaveLength(2)
    const update = messages[1]!
    expect(update.data.source).toMatchObject({ kind: 'prefill-context', scannedTurn: 2 })
    const text = prefillText(update)
    expect(text).toContain('--- DROPPED: a.ts (over the per-file token limit) ---')
    expect(text).toContain('--- DROPPED: b.ts (over the per-file token limit) ---')
    expect(text).toContain('Scan notes: 3 over the per-file token limit.')
    expect(text).toContain('--- PATHS PENDING ---')
    expect(text).toContain('- c.ts')
    expect(update.data.source.kind === 'prefill-context'
      ? update.data.source.changes
      : []).toEqual([
      { action: 'remove', path: 'a.ts' },
      { action: 'remove', path: 'b.ts' },
    ])
  })

  it('defers changed content that does not fit the delta budget and lists it as pending', async () => {
    const cwd = await workspace({
      'a.ts': 'short\n',
      'b.ts': 'remove me\n',
    })
    await mount(cwd, { budgetTokens: 10_000, reserveTokens: 0, deltaBudgetTokens: 1 })
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    await writeFile(join(cwd, 'a.ts'), 'a much longer replacement\n')
    await rm(join(cwd, 'b.ts'))
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)

    await fire(ctx!, agent, 2)

    const text = prefillText(prefillMessages(subject)[1]!)
    expect(text).toContain('1 changed files did not fit this update; they remain pending for a later turn.')
    expect(text).toContain('--- PATHS PENDING ---')
    expect(text).toContain('- a.ts')
    expect(text).toContain('--- REMOVED: b.ts ---')
  })

  it('places the snapshot before the claimed user messages', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd, { position: 'before' })
    const subject = session(cwd)
    openTurn(subject, 1)

    const decision = await decide(ctx!, sessionAgent(subject), 1)

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]!.source.kind).toBe('prefill-context')
    expect(decision.messages[1]!.source.kind).toBe('user')
  })

  it('places the snapshot after the claimed user messages by default', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd)
    const subject = session(cwd)
    openTurn(subject, 1)

    const decision = await decide(ctx!, sessionAgent(subject), 1)

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]!.source.kind).toBe('user')
    expect(decision.messages[1]!.source.kind).toBe('prefill-context')
  })

  it('rescans within the same turn with refresh step', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd, { refresh: 'step' })
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    await writeFile(join(cwd, 'a.ts'), 'export const a = 2\n')

    await fire(ctx!, agent, 1, 2)

    const messages = prefillMessages(subject)
    expect(messages).toHaveLength(2)
    expect(prefillText(messages[1]!)).toContain('export const a = 2')
    expect(prefillText(messages[1]!)).toContain('kind="delta"')
  })

  it('does not rescan a second step in the same turn with refresh turn', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd)
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    await writeFile(join(cwd, 'a.ts'), 'export const a = 2\n')

    await fire(ctx!, agent, 1, 2)

    expect(prefillMessages(subject)).toHaveLength(1)
  })

  it('skips subagent sessions under the main agent scope', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd, { agents: 'main' })
    const subject = session(cwd, 'subagent', { origin: 'subagent' })
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    expect(prefillMessages(subject)).toHaveLength(0)
  })

  it('injects into subagent sessions under the all agent scope', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd, { agents: 'all' })
    const subject = session(cwd, 'subagent', { origin: 'subagent' })
    openTurn(subject, 1)

    await fire(ctx!, sessionAgent(subject), 1)

    expect(prefillMessages(subject)).toHaveLength(1)
  })

  it('appends changes as a delta without rewriting the committed baseline', async () => {
    const cwd = await workspace({
      'a.ts': 'export const a = 1\n',
      'nested/b.ts': 'export const b = 2\n',
    })
    await mount(cwd)
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    const baseline = prefillMessages(subject)[0]!

    await writeFile(join(cwd, 'a.ts'), 'export const a = 10\n')
    await writeFile(join(cwd, 'c.ts'), 'export const c = 3\n')
    await rm(join(cwd, 'nested/b.ts'))
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)

    await fire(ctx!, agent, 2)

    const messages = prefillMessages(subject)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toBe(baseline)
    const update = messages[1]!
    expect(update.data.source).toMatchObject({ kind: 'prefill-context', scannedTurn: 2 })
    expect(update.data.source.kind === 'prefill-context' && update.data.source.baseline).toBeUndefined()
    const text = prefillText(update)
    expect(text).toContain('<prefill-context kind="delta"')
    expect(text).toContain('Added 1, modified 1, removed 1.')
    expect(text).toContain('A block in this update replaces any earlier block for the same path.')
    expect(text).toContain('--- FILE: a.ts (modified) ---')
    expect(text).toContain('--- FILE: c.ts (added) ---')
    expect(text).toContain('--- REMOVED: nested/b.ts ---')
  })

  it('injects nothing when the workspace is unchanged', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd)
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)

    await fire(ctx!, agent, 2)

    expect(prefillMessages(subject)).toHaveLength(1)
  })

  it('never scans after a baseline with refresh never', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd, { refresh: 'never' })
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    await writeFile(join(cwd, 'a.ts'), 'export const a = 2\n')
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)

    await fire(ctx!, agent, 2)

    expect(prefillMessages(subject)).toHaveLength(1)
  })

  it('prepares a new baseline after compaction shadows the committed one', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd)
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    const baseline = prefillMessages(subject)[0]!
    subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: baseline.seq, endSeq: baseline.seq },
      sourceEventSeqs: [baseline.seq],
    })
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)

    await fire(ctx!, agent, 2)

    const messages = prefillMessages(subject).filter(message => message.seq > baseline.seq)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.data.source).toMatchObject({ kind: 'prefill-context', baseline: true, scannedTurn: 2 })
  })

  it('prepares a new baseline when compaction shadows an update but not the baseline', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await mount(cwd)
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)
    const baseline = prefillMessages(subject)[0]!
    await writeFile(join(cwd, 'a.ts'), 'export const a = 2\n')
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)
    await fire(ctx!, agent, 2)
    const update = prefillMessages(subject).find(message => message.seq > baseline.seq)!
    subject.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted history' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: update.seq, endSeq: update.seq },
      sourceEventSeqs: [update.seq],
    })
    subject.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    openTurn(subject, 3)

    await fire(ctx!, agent, 3)

    const messages = prefillMessages(subject).filter(message => message.seq > update.seq)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.data.source).toMatchObject({ kind: 'prefill-context', baseline: true, scannedTurn: 3 })
  })

  it('stops injecting after the plugin fiber disposes', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    const fiber = await mount(cwd)
    const subject = session(cwd)
    const agent = sessionAgent(subject)
    openTurn(subject, 1)
    await fire(ctx!, agent, 1)

    await fiber.dispose()
    subject.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    openTurn(subject, 2)
    await fire(ctx!, agent, 2)

    expect(prefillMessages(subject)).toHaveLength(1)
  })

  it('rejects invalid configuration at plugin load', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    await expect(mount(cwd, { budgetTokens: -1 })).rejects.toThrow(/invalid config:[\s\S]*budgetTokens/u)
    await expect(mount(cwd, { refresh: 'sometimes' as never })).rejects.toThrow(/invalid config:[\s\S]*refresh/u)
    await expect(mount(cwd, { position: 'middle' as never })).rejects.toThrow(/invalid config:[\s\S]*position/u)
    await expect(mount(cwd, { agents: 'none' as never })).rejects.toThrow(/invalid config:[\s\S]*agents/u)
    await expect(mount(cwd, { maxFileTokens: -1 })).rejects.toThrow(/invalid config:[\s\S]*maxFileTokens/u)
    await expect(mount(cwd, { indexBudgetTokens: -1 })).rejects.toThrow(/invalid config:[\s\S]*indexBudgetTokens/u)
    await expect(mount(cwd, { excludedFilePatterns: [''] })).rejects.toThrow(/excludedFilePatterns entries must not be empty/u)
  })
})

describe('real agent-loop request history', () => {
  it('puts the baseline, guidance, and later deltas in front of the model', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(prefillContext, { budgetTokens: 4096 })
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(
      SessionId('prefill-loop'),
      { provider: 'mock', model: 'mock' },
      { cwd },
    )

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await writeFile(join(cwd, 'a.ts'), 'export const a = 2\n')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const first = requestText(adapter.requests[0]!)
    const second = requestText(adapter.requests[1]!)
    expect(first).toContain('Workspace prefill:')
    expect(first).toContain('<prefill-context kind="baseline"')
    expect(first).toContain('export const a = 1')
    expect(first).not.toContain('<prefill-context kind="delta"')
    expect(second).toContain('Workspace prefill:')
    expect(second).toContain('<prefill-context kind="baseline"')
    expect(second).toContain('<prefill-context kind="delta"')
    expect(second).toContain('export const a = 2')

    const messages = prefillMessages(agent.session)
    expect(messages).toHaveLength(2)
    expect(messages.every(message => message.surfaceOp === 'append')).toBe(true)
    await ctx.fiber.dispose()
    ctx = undefined
  })

  it('omits the guidance section when guidance is disabled', async () => {
    const cwd = await workspace({ 'a.ts': 'export const a = 1\n' })
    ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    const adapter = new MockAdapter([textResponse('answer')])
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.plugin(prefillContext, { budgetTokens: 4096, guidance: false })
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(
      SessionId('prefill-loop-no-guidance'),
      { provider: 'mock', model: 'mock' },
      { cwd },
    )

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const first = requestText(adapter.requests[0]!)
    expect(first).not.toContain('Workspace prefill:')
    expect(first).toContain('<prefill-context kind="baseline"')
    await ctx.fiber.dispose()
    ctx = undefined
  })
})

describe('Loader exports', () => {
  it('keeps function-plugin metadata and no default export', () => {
    expect('default' in prefillContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(prefillContext) as Record<string, unknown>
    expect(unwrapped).toBe(prefillContext)
    expect(unwrapped.name).toBe('prefill-context')
    expect(unwrapped.inject).toEqual(['agents', 'workingDirectory', 'sessionProjections'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
