---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-prefill-model-selection

[English](2026-11-01-prefill-model-selection.md) | 中文

## 概述

新增模型选择预填充记录：仅写入日志的 prefill/selection 与 prefill/selection-request 事件、prefill-context 记录转换上的可选 reason，以及辅助选择消息使用的 prefill-selection 来源类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有会话日志保持原意：没有任何既有事件、来源类型或属性发生变化，不含新事件的日志仍折叠为相同的预填充记录与记账，并保持确定性顺序。旧读取器在执行或恢复截断之前，会把包含 prefill/selection 或 prefill/selection-request 的日志视为未知必需事件并拒绝，因此不会部分解释其载荷。prefill-selection 来源类型只能经由 prefill/selection-request 的消息到达；辅助选择调用从不进入对话界面，因此 user、developer 与标题请求联合类型只在声明中包含它。旧读取器的来源 schema 会剥离 prefill-context 转换条目上的可选 reason，而消息文本不包含它，因此渲染出的快照不变；缺少 reason 的条目保持“未记录模型理由”的原有含义。新读取器保留全部历史事件与来源类型，不含选择记录的日志保持确定性顺序。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/context/prefill-context packages/test-support/llm-replay packages/client/ui-prefill：967 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
