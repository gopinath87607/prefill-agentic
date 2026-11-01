---
description: "Prefill dashboard for the Web GUI: the right-sidebar page that shows prefilled files, cache reuse, saved time, and the latest token usage; for users and maintainers checking whether prefill is paying off."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-prefill

English | [中文](README.zh.md)

## Summary

The Prefill dashboard is a right-sidebar page over four host-computed session projections. It answers whether prefill-first context is working: which files the visible snapshot carries and why the selection chose them, how many of their tokens the provider served from cache, how much prompt processing that avoided, and what the latest request actually cost. Every figure is exact provider or host accounting; the page only formats and lays it out.

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

Mount this plugin beside `dsh-prefill-context` and `dsh-token-meter`; the page registers itself as a `prefill` tab type and appears as the "Prefill dashboard" entry on the right sidebar's guide page. It is a page, not a file viewer: it claims no resource address and opens from the guide.

### What the dashboard shows

The **Prefill** section reports the number of files in the visible snapshot, the estimated prefill tokens currently visible, every prefill token the session introduced, the provider-reported prompt tokens served from cache that held prefill content, the selection calls and their provider-reported tokens, the net tokens saved, and the time those tokens would have taken at the configured uncached prompt rate. Below the readings it lists each prefilled file with its size and the reason the selection recorded, the workspace root, and the turn of the last scan.

**Latest selection** reports how the newest baseline was ordered: `Model` or `Deterministic`, the provider and model the call used, how many files it chose and how many entries it dropped, its duration and tokens, and the fallback reason with its diagnostic when the deterministic order ran instead. The section is absent until the session records a selection.

**Cache and tokens** places four disjoint billing buckets — uncached input, cached input, cache write, and output — beside the session total and the newest request sample. The prompt row sums the three input buckets, and the cache-hit row divides cached input by that prompt total.

**Context** shows the next request's projected prompt against the newest advertised context window, with a percentage meter. The note states that the reading is prompt-side and adjusted for changes on screen since the provider's sample.

### Reading the numbers

- Session totals add every request, so on a long session they exceed any single prompt and can exceed the context window. The "Last request" column is the number to compare with the prompt budget.
- The session cache hit includes the cold first request, which has nothing to reuse. A session that starts at zero and climbs is behaving correctly.
- Reuse is credited at a settlement only up to the prefill tokens visible at the previous settlement: a prompt prefix is cached in order, so one request cannot reuse more prefill than its cached prefix held. The first settlement therefore credits nothing, and the next one starts reporting savings.
- Saved tokens subtract what prefill and selection added: the injected prefill tokens and the selection calls' usage, floored at zero. A session whose selection costs exceed its reuse reports no savings rather than a negative number.
- Saved time is an estimate: saved tokens divided by the configured `promptTokensPerSecond`, not a measured latency.

### Empty states

Without a prefill snapshot the page says so and still lists the token and context readings. A snapshot without a recorded selection shows no Latest selection section. A tab whose host serves none of the four projection keys shows one unavailable notice. An empty scan and a scan without a recorded turn each state their own absence.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half is an empty apply, so the package can appear on the host roster; the browser half ships through `exports["./client"]`. The browser half registers the `prefill` dictionaries, the `prefill` tab type with its guide entry and injected-context glyph, the body under `sidebar.right.pane.tab` keyed by the package name, and the chip title under `sidebar.right.pane.tab.title` with the same key. Each registration rides `ctx.effect`, so unloading removes all four.

`PrefillDashboard` reads `prefillContext`, `prefillLedger`, `tokenUsage`, and `contextPressure` through the standard `useProjection` seat and renders them without client-side folding. `prefillLedger` is summary-excluded on the host so Session list rows never carry a file list; the tab body is the only reader. The latest selection travels inside the ledger view, and the body maps each fallback reason to a locale key. `tokenUsage.last` is the newest billed sample beside the accumulated totals, and `contextPressure.projectedTokens` is the next request's prompt after surface changes.

Formatting is package-local and locale-owned: counts stay exact, durations use one decimal below a minute, byte sizes pick a binary unit, and cache-hit shares never round a partial hit to 100. The title and body share one stylesheet; the tab uses semantic `--dsw-*` aliases only.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-prefill-context](../../context/prefill-context/README.md) — owns the snapshot, the append-only deltas, and both prefill projections.
- [dsh-token-meter](../../llm/token-meter/README.md) — owns provider usage accumulation and context pressure.
- [ui-sidebar-right](../ui-sidebar-right/README.md) — the tab registry and keyed seats this page registers into.

-----

<a id="model-experience"></a>
## Model Experience

None, as the dashboard reads host-computed projections and registers no model-facing surface.

#### KV Cache effect

The dashboard adds no prompt content, so it changes no request prefix; the prefill snapshot's own cache effects are owned by `dsh-prefill-context`.

## Known Limitations and Deferred Work

- **Visible snapshot only** — the file list names what the current surface carries. A compaction that shadows the baseline clears it until the next scan injects a fresh snapshot.
- **Cache reuse is prefill attribution, not total cache use** — the reading counts only cached prompt tokens a settlement could attribute to visible prefill; other cached content is not separated.
- **Saved time is derived** — it follows the configured throughput and token estimate, so it is a comparable estimate rather than a measured response-time delta.
- **The page has no refresh control** — it follows the session projections as they move and offers no manual reload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The body registers under the package name as its key, and the chip title registers under the same key; changing one key without the other leaves the tab title blank. Both prefill projection types are re-exported by `@deepseek-ai/dsh-prefill-context/client`, so the browser half needs no host-side import from `dsh-prefill-context`. The dashboard receives `useProjection` and `t` through the keyed slot's standard session props.

</details>
