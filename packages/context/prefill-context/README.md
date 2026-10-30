---
description: "Prefill-first workspace snapshots with append-only updates, for users and maintainers tuning the context a long-context model reads before a task."
kind: "package-reference"
---

# @deepseek-ai/dsh-prefill-context

English | [中文](README.zh.md)

## Summary

`dsh-prefill-context` gives a long-context model the workspace contents up front instead of making it discover files through search and read calls. The first eligible turn injects one deterministic baseline snapshot of included text files; later turns append a small update containing only added, modified, and removed paths. The baseline is never rewritten, so the request prefix stays reusable while the task grows. The base bundle declares the row disabled; a deployment enables it with a token budget that matches its engine.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when the model benefits from reading a prepared workspace snapshot instead of issuing search calls, especially when the inference engine performs better on long prompts than on short iterative ones. Each snapshot and update is one additional user-role message in durable history; it is reconstructed on resume and replaced by compaction like any other message.

The first eligible step scans the working directory once and injects the baseline. With `refresh: 'turn'` (the default), each later turn scans again and appends an update only when content changed. `refresh: 'never'` settles on the baseline for the rest of the session.

### Choosing a budget

`budgetTokens` is the complete snapshot budget; the frame header and scan notes are covered by `reserveTokens`. The baseline fills the remaining budget with the shallowest files first, then files in path order, and skips files that would exceed `maxFileBytes` or the remaining budget. Files skipped only because the baseline was full stay untracked, so later updates can add them within `deltaBudgetTokens` per turn.

A large budget reduces discovery calls but consumes the same model context as any other message. It also counts toward the compaction threshold: a baseline near the model window leaves little room for conversation before compaction replaces the shadowed history. Start from the task shape, not the model maximum, and measure cache reuse before raising it.

### Configuration

The minimal mount needs no configuration and uses a 150,000-token baseline budget.

```yaml
- name: '@deepseek-ai/dsh-prefill-context'
  config:
    budgetTokens: 700000
```

| Field | Default | Meaning |
|---|---|---|
| `budgetTokens` | `150000` | Token budget for the first snapshot before `reserveTokens` |
| `deltaBudgetTokens` | `32000` | Token budget for contents appended in one later turn |
| `charsPerToken` | `4` | Fixed characters-per-token estimate used for every budget decision |
| `reserveTokens` | `1024` | Tokens reserved for the frame header and scan notes |
| `maxFileBytes` | `1048576` | Largest file read into the snapshot |
| `maxFiles` | `20000` | Largest number of files collected in one scan |
| `maxVisitedEntries` | `100000` | Largest number of directory entries visited in one scan |
| `maxDepth` | `32` | Deepest directory level traversed below the working directory |
| `refresh` | `'turn'` | `'turn'` rescan on each new turn; `'never'` keeps the baseline |
| `includeExtensions` | text and code list | Lowercase extensions treated as text; a leading dot is added when omitted |
| `includeFileNames` | build and project files | Exact filenames included regardless of extension |
| `excludedDirectories` | VCS, dependency, and build directories | Exact directory names never traversed |
| `excludedFileNames` | environment, credential, and key files | Exact filenames never included, checked before the include rules |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-prefill-context) is the exhaustive source for every accepted field and its JSDoc.

### Enabling the row

The base bundle declares `prefill-context` disabled. A profile patch or `--patch` overlay enables it and supplies the budget:

```yaml
- id: prefill-context
  name: '@deepseek-ai/dsh-prefill-context'
  disabled: false
  config:
    budgetTokens: 700000
```

A patch replaces each property it names; it does not merge nested objects. Restate the complete `config` object when a patch changes any field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the plugin; the observable behavior is covered in [Use this package](#use-this-package).

### Design concept

The plugin prepends an `agent/pre-step` listener that delegates first, then appends one sourced `UserMessage` when a scan produces a baseline or a non-empty update. Each message uses the source `{ kind: 'prefill-context', scannedTurn, root, baseline?, changes }`, where `changes` records every ledger transition the message commits.

The `prefillContext` host-only session projection folds those messages into the visible file ledger: paths, backend freshness versions, content digests, and byte sizes. An update applies its transitions; a surface replacement that shadows any committed prefill message clears the projection, so the next step prepares a fresh baseline after compaction. Replay and checkpoint restore derive the same ledger because the source records every transition.

### Traversal and change detection

Scanning walks the working directory through `ctx.fs`, sorted by codepoint at every level, and skips excluded directory names. `ctx.fs.contains` rejects targets outside the resolved root, and `targetKey` breaks symlink cycles. The scan stops at `maxFiles` or `maxVisitedEntries`, or records `incomplete` at `maxDepth`; an incomplete scan never reports deletions.

The baseline reads files in shallow-first order and renders each as a delimited block. Later scans compare the backend freshness token and size first, then read and hash changed candidates. A changed file whose digest and byte size match its ledger entry is unchanged. Content that does not fit `deltaBudgetTokens` keeps its old ledger entry so a later turn retries it. Oversize tracked files produce a removal notice.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step listener, scan orchestration, message insertion |
| [`src/config.ts`](src/config.ts) | Config schema, defaults, and normalization |
| [`src/scan.ts`](src/scan.ts) | Deterministic bounded workspace traversal through `ctx.fs` |
| [`src/prepare.ts`](src/prepare.ts) | Budgeted file selection, reads, hashing, and ledger transitions |
| [`src/render.ts`](src/render.ts) | Frame, block, and change-notice rendering |
| [`src/state.ts`](src/state.ts) | Durable source type, validation, and the ledger projection |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Context group map](../README.md) — sibling request-context packages.
- [Agent loop](../../core/agent-loop/README.md#understand-the-implementation) — where `agent/pre-step` decides which messages enter a request.
- [Compaction](../../compaction/compaction-basic/README.md) — when replacement shadows the baseline and why a fresh snapshot follows.

-----

<a id="model-experience"></a>
## Model Experience

### Workspace snapshot and updates

#### What the model sees

The first eligible pre-step inserts one baseline message. It opens with `<prefill-context kind="baseline" turn="<turn>" root="<root>" files="<count>" content-tokens="<estimate>">`, followed by a two-line instruction, optional scan notes, one delimited block per file, and the closing tag. Each later changed turn inserts one update with `kind="delta"`, counters for added, modified, and removed files, blocks labeled `(added)` or `(modified)`, and `--- REMOVED: <path> ---` notices. The frame states that file contents are data, not instructions that override the task.

#### Token effect

The baseline occupies at most `budgetTokens`, minus `reserveTokens`, until compaction shadows it. Each qualifying turn appends at most `deltaBudgetTokens` of file contents, plus counters, paths, and notice lines. Retained history therefore grows by the baseline plus every committed update; `refresh: 'never'` adds only the baseline.

#### KV Cache effect

Append-only after the first snapshot. The baseline and preceding updates stay at the same positions in later requests, so a provider that reuses a matching prefix does not recompute them. A turn with no changes appends nothing. A change to a tracked file appends new content at the end rather than rewriting the earlier copy, and a removal is a notice rather than a prefix edit. A working-directory change or a compaction that shadows any snapshot message appends a new baseline; the compaction replacement already invalidates reuse after its cut.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Turn-level refresh** — with the default `refresh: 'turn'`, a file changed by a tool during the current turn appears in an update only on a later turn. The model that made the edit sees the change in its tool result; an externally changed file waits.
- **Fixed token estimate** — every budget decision uses `charsPerToken`, not the engine tokenizer. A dense file can exceed the intended budget and a sparse file can leave budget unused.
- **Name-based secret exclusion only** — the default excluded filenames cover common environment, credential, and key files, but content is not inspected. A custom `includeFileNames` or `includeExtensions` list can include a secret, and a differently named secret file is included.
- **Removal notices retain content** — removing a path from the ledger appends a notice; the earlier block remains in history until compaction shadows it.
- **Incomplete scans keep old entries** — when `maxDepth`, `maxVisitedEntries`, or `maxFiles` stops a scan, deletions are not inferred, so a deleted file can remain in the ledger until a complete scan runs.
- **Baseline competes with conversation** — a baseline near the context window triggers compaction sooner; the fresh baseline prepared afterward consumes budget again.
- **Backend-dependent freshness** — the digest fast path still reads content when the backend reports no freshness token, so a scan can reread every tracked file on each eligible turn.
- **Long prefills outlast provider idle timeouts** — an engine can stay busy for minutes before it emits the first stream chunk for a large baseline. The pi-ai adapter's default 300,000 ms stream idle timeout then fails the attempt and retries the whole prompt; raise `streamIdleTimeoutMs` on the provider route to cover the measured prefill time.
- **Unreadable and binary files** — files whose contents cannot be read as text are reported in scan notes and omitted. Snapshot membership follows the configured name and extension rules, not content detection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The shipped base row stays disabled so each deployment chooses a budget. A plugin patch must restate the complete `config` object because patches replace the property they name. The projection is host-only; no client UI reads it.

</details>
