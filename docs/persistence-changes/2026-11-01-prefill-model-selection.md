---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-prefill-model-selection

English | [中文](2026-11-01-prefill-model-selection.zh.md)

## Summary

Adds the model-selection prefill records: the log-only prefill/selection and prefill/selection-request events, an optional reason on prefill-context ledger changes, and the prefill-selection source kind used by the auxiliary selection message.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-prefill-model-selection
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-31-prefill-context-source"
    after: "954accd72d1c771ade3c57be5efd3b404b68bf80a178fb7adb7fc05db09544cc"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-31-prefill-context-source"
    after: "0c7e690022cca357162da95dd5111c008e7ec4299a4c80fca6bb5aa80e9a7806"
    decision: same-version
  - root: "event:prefill/selection"
    previous: null
    after: "a4718e0e1115d889f894f88bd5e3812db457767e4f6ed43c59a43586f0ecfe69"
    decision: same-version
  - root: "event:prefill/selection-request"
    previous: null
    after: "7034a7f18f00187029c1829444688b442a34a42659bc6c75eb9a9b189f006e6d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-31-prefill-context-source"
    after: "75a3ef8ec9011aa7a09c5de6b23a1198063250051b1805f5d592c574f7222300"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-31-prefill-context-source"
    after: "7b6c914e7e65dbf3b68f58ccc38fc0865ec64b3b7c8daf6658a68abc1f4acb1e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing Session logs keep their meaning: no pre-existing event, source kind, or property changed, and a log without the new events folds to the same prefill ledger and accounting with deterministic ordering. An older reader refuses a log containing prefill/selection or prefill/selection-request as an unknown required event before execution or recovery truncation, so it never interprets their payloads partially. The prefill-selection source kind is reachable only through the messages of prefill/selection-request; the auxiliary selection call is never appended to the conversation surface, so the user, developer, and title-request unions carry it only as a declaration. An older reader's source schema strips the optional reason from a prefill-context change entry and the message text does not contain it, so the rendered snapshot is unchanged; an entry without a reason keeps the previous meaning of no recorded model reason. New readers preserve every historical event and source kind, and a log without selection records keeps the deterministic order.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/context/prefill-context packages/test-support/llm-replay packages/client/ui-prefill: 967 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
