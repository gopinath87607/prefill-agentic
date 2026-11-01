/**
 * Model-driven baseline selection: build a bounded candidate manifest, ask the
 * routed model which paths matter, validate its answer, and record both the
 * exact request and the result.
 *
 * The selection call is auxiliary: it never enters the conversation surface,
 * and its inputs and output are durable log-only events. A failed call or an
 * unusable answer falls back to the deterministic shallow-first ordering.
 *
 * @module @deepseek-ai/dsh-prefill-context/selector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, Message, TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPrefillConfig } from './config.ts'
import { compareCandidates } from './prepare.ts'
import { sanitizePath } from './render.ts'
import type { ScanCandidate } from './scan.ts'
import {
  PREFILL_SELECTION_TIMEOUT_CODE,
  type PrefillSelectionEventData,
  type PrefillSelectionFile,
  type PrefillSelectionOutcome,
  type PrefillSelectionRequestEventData,
} from './state.ts'
import type { PrefillSelectionFallback } from './types.ts'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'prefill-selection': true
  }
}

/** Fixed instruction for every selection call. */
export const PREFILL_SELECTION_SYSTEM = [
  'You select workspace files that another model should read before answering a request.',
  'Return only JSON: {"files":[{"path":"<listed path>","reason":"<short reason>"}]}.',
  'Choose only paths from the candidate list.',
  'Prefer files the request needs to read or edit, then files that define shared types, configuration, or conventions.',
  'Do not choose a file only because it is large.',
  'Return an empty list when the request does not depend on workspace files.',
].join(' ')

/** Maximum characters kept for one model-written reason. */
const MAX_REASON_CHARS = 200

/** Maximum characters kept for one fallback diagnostic. */
const MAX_DETAIL_CHARS = 300

/** Portion of the selection input budget reserved for the user request. */
const REQUEST_SHARE = 0.5

/**
 * Floor for the bounded selection prompt. The fixed instruction, labels, and
 * footer must fit whatever budget a deployment configures.
 */
const MINIMUM_PROMPT_CHARS = 512

/** Inputs for one baseline selection. */
export interface PrefillSelectionInput {
  /** Turn whose pre-step requested the baseline. */
  readonly turn: number
  /** Latest user request text, or an empty string when none is visible. */
  readonly request: string
  /** Every eligible file in the scan. */
  readonly candidates: readonly ScanCandidate[]
  /** Route the conversation step uses, when known. */
  readonly route: { readonly provider: string; readonly model: string } | undefined
}

/** One selection outcome plus the facts recorded with it. */
export interface PrefillSelectionResult {
  /** Baseline ordering that actually ran. */
  readonly selection: PrefillSelectionOutcome
  /** Reason the configured model selection was not used. */
  readonly fallback: PrefillSelectionFallback | null
  /** Short diagnostic detail for a fallback. */
  readonly detail: string | null
  /** Provider route the selection call used. */
  readonly provider: string | null
  /** Exact model id the selection call used. */
  readonly model: string | null
  /** Paths the model chose, in its priority order. */
  readonly files: readonly PrefillSelectionFile[]
  /** Valid-looking entries dropped as duplicates, unknown paths, or over the cap. */
  readonly dropped: number
  /** End-to-end duration of the selection call, or null without a call. */
  readonly durationMs: number | null
  /** Provider-reported usage of the selection call. */
  readonly usage: TokenUsage | undefined
  /** Complete model output retained for replay. */
  readonly rawOutput: ContentBlock[] | undefined
  /** Whether one auxiliary stream call was dispatched. */
  readonly dispatched: boolean
}

/** Candidate manifest rendered for one selection request. */
interface SelectionManifest {
  /** Complete user message. */
  text: string
  /** Candidates whose path and size appear in the message. */
  shown: number
}

/** Parsed selection answer. */
interface ParsedSelection {
  files: PrefillSelectionFile[]
  dropped: number
}

/**
 * Ask the routed model which candidate paths should enter the baseline.
 *
 * The function owns the selection prompt, input bounds, route preparation,
 * output validation, deadline, and both durable records. It records
 * `prefill/selection-request` before dispatch and `prefill/selection` after
 * settling, including a deterministic fallback and its reason.
 * @param ctx - plugin context owning the LLM service and fiber.
 * @param agent - agent entering the step.
 * @param config - normalized selection and budget settings.
 * @param input - request text, candidates, and the step's route.
 * @param signal - turn cancellation.
 * @returns the baseline ordering to apply.
 * @throws when the caller aborts the turn or the plugin fiber is disposed.
 */
export async function selectPrefillFiles(
  ctx: Context,
  agent: Agent,
  config: ResolvedPrefillConfig,
  input: PrefillSelectionInput,
  signal: AbortSignal,
): Promise<PrefillSelectionResult> {
  const startedAt = Date.now()
  const deterministic = (
    fallback: PrefillSelectionFallback | null,
    detail: string | null,
    call: {
      provider: string
      model: string
      dispatched: boolean
      usage?: TokenUsage | undefined
      rawOutput?: ContentBlock[] | undefined
    } | undefined,
  ): PrefillSelectionResult => {
    const result: PrefillSelectionResult = {
      selection: 'deterministic',
      fallback,
      detail,
      provider: call?.provider ?? null,
      model: call?.model ?? null,
      files: [],
      dropped: 0,
      durationMs: call === undefined ? null : Date.now() - startedAt,
      usage: call?.usage,
      rawOutput: call?.rawOutput,
      dispatched: call?.dispatched ?? false,
    }
    recordSelection(agent, input.turn, result)
    return result
  }

  if (config.selection === 'deterministic') return deterministic(null, null, undefined)
  if (input.candidates.length === 0) return deterministic('no-candidates', null, undefined)
  if (input.request.trim().length === 0) return deterministic('no-request', null, undefined)
  const llm = ctx.get('llm')
  if (llm === undefined) return deterministic('llm-unavailable', null, undefined)
  const route = selectionRoute(config, input)
  if (route === undefined) {
    return deterministic('no-route', 'no provider and model are configured for the selection call', undefined)
  }

  const manifest = buildManifest(input.candidates, input.request, config)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: manifest.text }],
    source: { kind: 'prefill-selection' },
  })]

  let call: Awaited<ReturnType<typeof llm.prepareCall>>
  using callDeadline = deadline(signal, config.selectorTimeoutMs, PREFILL_SELECTION_TIMEOUT_CODE)
  try {
    call = await llm.prepareCall({
      provider: route.provider,
      model: route.model,
      maxTokens: config.selectorMaxOutputTokens,
    }, callDeadline.signal)
  } catch (error: unknown) {
    signal.throwIfAborted()
    const fallback: PrefillSelectionFallback = timeoutOf(callDeadline.signal, PREFILL_SELECTION_TIMEOUT_CODE) === undefined
      ? 'no-route'
      : 'timeout'
    return deterministic(fallback, detailOf(error), undefined)
  }

  const request: PrefillSelectionRequestEventData = {
    turn: input.turn,
    route,
    system: PREFILL_SELECTION_SYSTEM,
    messages,
    maxTokens: config.selectorMaxOutputTokens,
    ...call.config.reasoningEffort === undefined ? {} : { reasoningEffort: call.config.reasoningEffort },
    candidates: input.candidates.length,
    shown: manifest.shown,
  }
  agent.session.append('prefill/selection-request', request)

  const options: GenerateOptions = {
    ...call.config,
    messages,
    system: PREFILL_SELECTION_SYSTEM,
    sessionId: agent.session.id,
    purpose: 'prefill-selection',
    signal: callDeadline.signal,
  }
  const assembler = new BlockAssembler()
  try {
    for await (const chunk of call.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
  } catch (error: unknown) {
    signal.throwIfAborted()
    ctx.fiber.assertActive()
    const fallback: PrefillSelectionFallback = timeoutOf(callDeadline.signal, PREFILL_SELECTION_TIMEOUT_CODE) === undefined
      ? 'stream-error'
      : 'timeout'
    return deterministic(fallback, detailOf(error), {
      ...route,
      dispatched: true,
    })
  }
  signal.throwIfAborted()
  ctx.fiber.assertActive()
  const dispatched = {
    ...route,
    dispatched: true,
    usage: assembler.usage,
    rawOutput: assembler.blocks(),
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    return deterministic('stream-error', finish.failure.message, dispatched)
  }
  const parsed = parseSelectionOutput(
    messageText(dispatched.rawOutput),
    new Set(input.candidates.map(candidate => candidate.path)),
    config.selectorMaxFiles,
  )
  if (parsed === undefined) {
    return deterministic('invalid-response', 'the selection response was not usable JSON', dispatched)
  }
  const result: PrefillSelectionResult = {
    selection: 'model',
    fallback: null,
    detail: null,
    provider: route.provider,
    model: route.model,
    files: parsed.files,
    dropped: parsed.dropped,
    durationMs: Date.now() - startedAt,
    usage: dispatched.usage,
    rawOutput: dispatched.rawOutput,
    dispatched: true,
  }
  recordSelection(agent, input.turn, result)
  return result
}

/** Persist one selection outcome, including a call that fell back. */
function recordSelection(agent: Agent, turn: number, result: PrefillSelectionResult): void {
  const data: PrefillSelectionEventData = {
    turn,
    selection: result.selection,
    ...result.fallback === null ? {} : { fallback: result.fallback },
    ...result.detail === null ? {} : { detail: result.detail },
    ...result.provider === null ? {} : { provider: result.provider },
    ...result.model === null ? {} : { model: result.model },
    files: [...result.files],
    ...result.dropped === 0 ? {} : { dropped: result.dropped },
    ...result.durationMs === null ? {} : { durationMs: result.durationMs },
    ...result.usage === undefined ? {} : { usage: result.usage },
    ...result.rawOutput === undefined
      ? result.dispatched ? { llmStreamCall: true as const } : {}
      : { rawOutput: result.rawOutput, llmStreamCall: true as const },
  }
  agent.session.append('prefill/selection', data)
}

/** Resolve the configured selector route, then the conversation route. */
function selectionRoute(
  config: ResolvedPrefillConfig,
  input: PrefillSelectionInput,
): { provider: string; model: string } | undefined {
  if (config.selectorProvider !== undefined && config.selectorModel !== undefined) {
    return { provider: config.selectorProvider, model: config.selectorModel }
  }
  return input.route
}

/**
 * Render the bounded request text plus candidate manifest.
 *
 * The request keeps at most half of the input budget; the remaining budget
 * lists candidates in deterministic shallow-first order. Paths beyond the
 * budget cannot be selected by the model.
 */
function buildManifest(
  candidates: readonly ScanCandidate[],
  request: string,
  config: ResolvedPrefillConfig,
): SelectionManifest {
  const budgetChars = Math.max(
    Math.floor(config.selectorInputTokens * config.charsPerToken),
    MINIMUM_PROMPT_CHARS,
  )
  const requestText = truncate(request.trim(), Math.floor(budgetChars * REQUEST_SHARE))
  const header = `User request:\n${requestText}\n\nCandidate files (path and bytes):\n`
  const footer = `\nSelect at most ${String(config.selectorMaxFiles)} files from the listed paths. Return JSON only.`
  const omittedNote = (omitted: number): string => `\n(${String(omitted)} more candidate paths did not fit in this request.)`
  const noteReserve = omittedNote(candidates.length).length
  const available = Math.max(0, budgetChars - header.length - footer.length - noteReserve)
  const ordered = [...candidates].sort(compareCandidates)
  const lines: string[] = []
  let used = 0
  for (const candidate of ordered) {
    const line = `- ${sanitizePath(candidate.path)} ${candidate.size === undefined ? '?' : String(candidate.size)}\n`
    if (used + line.length > available) break
    lines.push(line)
    used += line.length
  }
  const shown = lines.length
  const omitted = ordered.length - shown
  return {
    text: `${header}${lines.join('')}${omitted > 0 ? omittedNote(omitted) : ''}${footer}`,
    shown,
  }
}

/** Keep at most `maxChars` characters, marking a real truncation. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n[... request truncated ...]'
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
}

/**
 * Join the text blocks of one message.
 * @param blocks - content blocks in order.
 * @returns concatenated text, ignoring non-text blocks.
 */
export function messageText(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/**
 * Parse and validate one selection answer against the manifest and output cap.
 *
 * A fenced or prose-wrapped JSON object is accepted by taking its first
 * brace-delimited span. Entries naming unknown paths, repeating a path, or
 * lacking a usable path are dropped and counted. An answer that named entries
 * but left none usable is invalid.
 * @param text - joined text blocks from the model response.
 * @param allowed - candidate paths the model was shown.
 * @param maxFiles - largest number of paths the answer may contribute.
 * @returns usable paths and the number of dropped entries, or undefined when unusable.
 */
export function parseSelectionOutput(
  text: string,
  allowed: ReadonlySet<string>,
  maxFiles: number,
): ParsedSelection | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  /* v8 ignore next -- a brace-delimited slice that parses is always a plain object */
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const files = (value as { files?: unknown }).files
  if (!Array.isArray(files)) return undefined
  const seen = new Set<string>()
  const selected: PrefillSelectionFile[] = []
  let dropped = 0
  for (const entry of files) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      dropped += 1
      continue
    }
    const path = (entry as { path?: unknown }).path
    if (typeof path !== 'string' || !allowed.has(path) || seen.has(path)) {
      dropped += 1
      continue
    }
    if (selected.length >= maxFiles) {
      dropped += 1
      continue
    }
    seen.add(path)
    const rawReason = (entry as { reason?: unknown }).reason
    const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
    selected.push({ path, reason: reason.length === 0 ? 'selected' : reason.slice(0, MAX_REASON_CHARS) })
  }
  return files.length > 0 && selected.length === 0 ? undefined : { files: selected, dropped }
}

/** Bounded one-line diagnostic. */
function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= MAX_DETAIL_CHARS ? message : `${message.slice(0, MAX_DETAIL_CHARS - 1)}…`
}
