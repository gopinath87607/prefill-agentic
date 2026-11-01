# Agent Note: The model chooses which files a prefill baseline carries

Status: implemented

English | [中文](2026-11-01-model-driven-prefill-selection.zh.md)

## Problem

The deterministic baseline filled its token budget shallowest-first, so a large workspace spent most of the budget on top-level files and could omit the modules the request needed. Keyword matching, extension heuristics, or path proximity cannot establish which files answer a question in an unfamiliar tree. The user required a model decision: the harness must ask the model which candidate files matter before it injects anything, and repeat that decision when a compaction or root change forces a fresh baseline.

## Decision

- Every rebaseline — the first eligible step, a working-directory change, and the first step after a replacement shadows the snapshot — runs one auxiliary model call before the baseline is prepared. Deltas never call the model; they only append changed tracked files.
- The call receives the step's request text and a bounded candidate manifest: every scanned path with its byte size in deterministic shallow-first order, capped by `selectorInputTokens`. The request keeps at most half of that budget, so a workspace too large for it exposes only shallower paths. The model must answer `{"files":[{"path","reason"}]}` from the listed paths, subject to `selectorMaxFiles` and `selectorMaxOutputTokens`, within `selectorTimeoutMs`.
- The route is the configured `selectorProvider`/`selectorModel` pair when both are set, else the provider and model captured for the step. The harness validates every returned path against the candidate list, drops unknown, repeated, malformed, and over-cap entries with a count, and treats an answer that named entries but left none usable as invalid.
- Only the chosen paths are read, in the model's priority order, and each committed ledger entry keeps the model's short reason for that file. Chosen paths that do not fit the budget are named in the path index. Unchosen candidate files are not read and do not enter the snapshot.
- Every failure falls back to the deterministic shallow-first baseline in the same step and records a reason: `no-candidates`, `no-request`, `llm-unavailable`, `no-route`, `timeout`, `stream-error`, or `invalid-response`. `selection: 'deterministic'` skips the call entirely.
- The call is log-only. `prefill/selection-request` records the exact system instruction, messages, output cap, and manifest counters before dispatch; `prefill/selection` records the outcome with the route, duration, usage, raw blocks, and `llmStreamCall: true`. Replay reconstructs the auxiliary stream from that event, and no selection message ever enters the conversation surface.
- The savings view subtracts the selection calls' provider-reported usage from saved tokens, beside the injected estimate: `savedTokens = max(0, reusedTokens - injectedTokens - selectorTokens)`. `selectorCalls` counts dispatched calls, including one whose provider omitted usage.
- The dashboard's latest-selection section reports the method, route, chosen and dropped counts, duration, tokens, and any fallback reason with its diagnostic; file rows show the recorded reason.

## Alternatives considered

**Deterministic shallow-first only.** It is cheap, reproducible, and needs no route, but it selects by tree position, not relevance; a workspace deeper than the budget makes the most relevant file unreachable. It remains available as `selection: 'deterministic'` and as the fallback.

**Keyword and path matching.** The user rejected it: no fixed vocabulary captures which files answer an arbitrary request, and a wrong match injects misleading content silently.

**Ask the main model inline.** A selection step inside the conversation would make the decision model-visible and add a turn before every baseline, rewriting the prefix the prefill exists to keep cacheable. The auxiliary call keeps the conversation append-only, and its exact input and output are durable without a new conversation event.

**Run the selector on every turn.** The baseline is fixed until a rebaseline, so a per-turn call would pay latency and tokens for a decision that cannot move most of the snapshot; deltas already handle changed and untracked files.

**Let the answer name any path.** An unbounded prompt grows with the workspace and lets a hallucinated path enter the snapshot. The bounded manifest also makes validation against a closed set possible.

**Reuse the conversation's reasoning stream for selection.** Mixing the auxiliary output into the visible response would confuse the answer and break the one-event-per-model-request contract, so the call records its own durable events with a dedicated request purpose.

**Count selection tokens as saved.** Excluding them overstates savings; the user asked for truthful accounting, so the cost is netted and shown separately.

## Consequences

- A rebaseline now waits for one model call, up to `selectorTimeoutMs`, and consumes up to `selectorInputTokens` input and `selectorMaxOutputTokens` output tokens that are billed and subtracted from `savedTokens`.
- The manifest bounds the choice: deep paths in a large workspace are invisible to the selector. An empty answer commits an empty baseline, and later delta turns then append untracked files shallowest-first within `deltaBudgetTokens`.
- Relevance is trust in the model: paths are validated against the candidate list, but order and reasons are not scored.
- Two new required, non-ignorable Session events mean an older reader refuses a log that contains them; the [persistence record](../../../../docs/persistence-changes/2026-11-01-prefill-model-selection.md) explains that refusal and the optional `reason` property.
- The prefill ledger and savings projections gained selection state, so their `stateVersion` values advanced (ledger 2, accounting 4); old projection state is discarded and rebuilt from the log.

## Testing

Focused suites cover the selector (route resolution, manifest bounds, parsing and dropping, each fallback and its record), the folds and views, replay derivation of the auxiliary stream, and the dashboard's selection and fallback rendering. `pnpm exec vitest run packages/context/prefill-context packages/test-support/llm-replay packages/client/ui-prefill` passes. The persistence change is acknowledged in the record linked above.
