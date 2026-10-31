---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-prefill-context-source

[English](2026-10-31-prefill-context-source.md) | 中文

## 概述

新增可合并扩展的用户消息来源类型 prefill-context，携带工作区扫描记录及其转换。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有会话日志仍然有效：所有既有来源变体保持不变。新日志可能包含来源类型为 prefill-context 的用户消息。MessageSourceMap 是可合并扩展的，消费方会跳过未知类型，因此未挂载该插件的读取方会忽略这些消息，而不会误解释它们；插件本身在折叠前会校验来源。由于新判别值不会与既有变体混淆，无需更改会话格式版本。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/context/prefill-context：35 个测试通过；pnpm run build:check 通过。

<a id="dev-note"></a>
## 开发备注

无。
