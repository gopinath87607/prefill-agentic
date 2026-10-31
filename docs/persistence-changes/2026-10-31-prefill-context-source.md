---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-prefill-context-source

English | [中文](2026-10-31-prefill-context-source.zh.md)

## Summary

Adds a merge-extensible user-message source kind, prefill-context, carrying the workspace scan ledger and its transitions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-prefill-context-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "981a6ca8b9b6a52f6dcff7ccb6e7f6fa899bff3b3086f6f9b25dababbba6a0b9"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "f1c98dff2c8cd992002bf27df68839d11d81a99d7f6b3f43d0671d193fcc9c48"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "0df2a0f94752e79c752545fd9352d64ab2ded063b2947adf5692cc1898ee0611"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "a11435e5cbddac5519451b4543387872a26cb540aa19a98b64cdf8dd91ea4108"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing session logs remain valid: every pre-existing source variant is unchanged. New logs may contain user messages whose source kind is prefill-context. MessageSourceMap is merge-extensible and consumers fall through unknown kinds, so a reader without the plugin ignores these messages instead of misinterpreting them; the plugin itself validates the source before folding it. No Session format version change is needed because the new discriminator cannot be confused with an existing variant.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/context/prefill-context: 35 tests passed; pnpm run build:check passed.

<a id="dev-note"></a>
## Dev Note

None.
