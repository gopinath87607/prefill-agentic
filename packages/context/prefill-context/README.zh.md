---
description: "面向长上下文模型的预填充工作区快照与仅追加更新，供用户和维护者调整模型在任务前读取的上下文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-prefill-context

[English](README.md) | 中文

## 概述

`dsh-prefill-context` 让长上下文模型在任务开始前一次性获得工作区内容，而不是让它通过搜索与读取调用自行发现文件。第一个符合条件的轮次注入一份确定性的基线快照，涵盖纳入的文本文件；后续轮次只追加包含新增、修改和删除路径的小型更新。基线从不重写，因此任务推进时请求前缀保持可复用。基础组合包把该配置行声明为禁用；部署方按所用引擎的 token 预算启用它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当模型受益于预先准备好的工作区快照、而不是反复发起搜索调用时挂载本插件，尤其是推理引擎在长提示上的表现优于短提示迭代时。每份快照和更新都是持久历史中额外的一条 user 角色消息；它会在恢复时重建，并像其他消息一样被压缩替换。

第一个符合条件的步骤扫描一次工作目录并注入基线。默认 `refresh: 'turn'` 时，之后每个轮次再次扫描，仅在内容变化时追加更新。`refresh: 'never'` 会在会话余下时间内保持基线不变。

### 选择预算

`budgetTokens` 是整个快照的预算；框架头部与扫描说明由 `reserveTokens` 覆盖。基线先用最浅层的文件填充剩余预算，再按路径顺序填充，并跳过超过 `maxFileBytes` 或剩余预算的文件。仅因基线已满而被跳过的文件保持未跟踪，因此后续更新可在每轮 `deltaBudgetTokens` 的范围内添加它们。

较大的预算减少发现调用，但与任何其他消息一样占用模型上下文。它同样计入压缩阈值：接近模型窗口的基线在压缩替换被遮蔽历史之前只留下很少的对话空间。应从任务形态出发，而不是从模型上限出发，并在提高预算前测量缓存复用。

### 配置

最小挂载无需配置，使用 150,000 token 的基线预算。

```yaml
- name: '@deepseek-ai/dsh-prefill-context'
  config:
    budgetTokens: 700000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `budgetTokens` | `150000` | 扣除 `reserveTokens` 前的首份快照 token 预算 |
| `deltaBudgetTokens` | `32000` | 后续某一轮次追加内容的 token 预算 |
| `charsPerToken` | `4` | 每次预算决策使用的固定字符/token 估算值 |
| `reserveTokens` | `1024` | 为框架头部与扫描说明保留的 token 数 |
| `maxFileBytes` | `1048576` | 读入快照的最大文件字节数 |
| `maxFiles` | `20000` | 一次扫描收集的最大文件数 |
| `maxVisitedEntries` | `100000` | 一次扫描访问的最大目录项数 |
| `maxDepth` | `32` | 从工作目录向下遍历的最深目录层级 |
| `refresh` | `'turn'` | `'turn'` 在每个新轮次重新扫描；`'never'` 保持基线 |
| `includeExtensions` | 文本与代码列表 | 视为文本的小写扩展名；省略前导点时会自动添加 |
| `includeFileNames` | 构建与项目文件 | 无论扩展名如何都纳入的确切文件名 |
| `excludedDirectories` | 版本控制、依赖与构建目录 | 永不遍历的确切目录名 |
| `excludedFileNames` | 环境、凭据与密钥文件 | 永不纳入的确切文件名，先于纳入规则检查 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-prefill-context)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 启用该行

基础组合包把 `prefill-context` 声明为禁用。profile 补丁或 `--patch` overlay 启用它并提供预算：

```yaml
- id: prefill-context
  name: '@deepseek-ai/dsh-prefill-context'
  disabled: false
  config:
    budgetTokens: 700000
```

补丁会替换它命名的每个属性，不会合并嵌套对象。补丁修改任何字段时都要完整重述 `config` 对象。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

本节说明插件的设计；可观察的行为见[使用本包](#use-this-package)。

### 设计理念

插件前置一个 `agent/pre-step` 监听器，先委托下游，然后在扫描产生基线或非空更新时追加一条带来源的 `UserMessage`。每条消息使用来源 `{ kind: 'prefill-context', scannedTurn, root, baseline?, changes }`，其中 `changes` 记录该消息提交的每一次记录转换。

`prefillContext` 宿主专用会话投影把这些消息折叠为可见文件记录：路径、后端新鲜度版本、内容摘要与字节大小。更新会应用其转换；遮蔽任一已提交预填充消息的 surface 替换会清空投影，因此压缩后的下一步会准备新的基线。重放与检查点恢复会得到同一份记录，因为来源记录了每一次转换。

### 遍历与变更检测

扫描通过 `ctx.fs` 遍历工作目录，每一层按码点排序，并跳过排除的目录名。`ctx.fs.contains` 拒绝解析根之外的 target，`targetKey` 打破符号链接环。扫描在 `maxFiles` 或 `maxVisitedEntries` 处停止，或在 `maxDepth` 处记录 `incomplete`；不完整的扫描从不报告删除。

基线按最浅优先顺序读取文件，并把每个文件渲染为带分隔符的块。后续扫描先比较后端新鲜度版本与大小，再读取并对变化的候选计算哈希。摘要与字节大小都与记录项一致的已变化文件视为未变化。不适应 `deltaBudgetTokens` 的内容保留旧记录项，以便后续轮次重试。超出大小限制的已跟踪文件产生删除通知。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 监听器、扫描编排、消息插入 |
| [`src/config.ts`](src/config.ts) | 配置 schema、默认值与规范化 |
| [`src/scan.ts`](src/scan.ts) | 通过 `ctx.fs` 进行的确定性有界工作区遍历 |
| [`src/prepare.ts`](src/prepare.ts) | 有预算的文件选择、读取、哈希与记录转换 |
| [`src/render.ts`](src/render.ts) | 框架、块与变更通知的渲染 |
| [`src/state.ts`](src/state.ts) | 持久来源类型、校验与记录投影 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够时，阅读以下页面。

- [上下文分组地图](../README.zh.md) — 同组请求上下文包。
- [Agent loop](../../core/agent-loop/README.zh.md#understand-the-implementation) — `agent/pre-step` 决定哪些消息进入请求的位置。
- [压缩](../../compaction/compaction-basic/README.zh.md) — 替换何时遮蔽基线，以及为什么随后会出现新的快照。

-----

<a id="model-experience"></a>
## 模型体验

### 工作区快照与更新

#### 模型看到的内容

首个符合条件的 pre-step 插入一条基线消息。它以 `<prefill-context kind="baseline" turn="<turn>" root="<root>" files="<count>" content-tokens="<estimate>">` 开头，随后是两行说明、可选的扫描备注、每个文件一个带分隔符的块，以及结束标签。之后每个发生变化的轮次插入一条 `kind="delta"` 的更新，包含新增、修改与删除文件计数、标记为 `(added)` 或 `(modified)` 的块，以及 `--- REMOVED: <path> ---` 通知。框架声明文件内容是数据，不是覆盖任务的指令。

#### Token 影响

基线在压缩遮蔽它之前最多占用 `budgetTokens` 减去 `reserveTokens`。每个符合条件的轮次最多追加 `deltaBudgetTokens` 的文件内容，外加计数、路径与通知行。因此保留历史按基线加每一次已提交更新增长；`refresh: 'never'` 只增加基线。

#### KV Cache 影响

首次快照之后仅追加。基线与先前的更新在后续请求中保持相同位置，因此复用匹配前缀的提供方无需重新计算它们。无变化的轮次不追加任何内容。已跟踪文件的变化会在末尾追加新内容，而不是重写早先的副本；删除是通知，而不是前缀编辑。工作目录变化或遮蔽任一快照消息的压缩会追加新的基线；压缩替换本身已经使其切点之后不再可复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **按轮次刷新** — 默认 `refresh: 'turn'` 下，工具在当前轮次修改的文件要到后续轮次才出现在更新中。做出编辑的模型会从工具结果中看到变化；由外部修改的文件需要等待。
- **固定 token 估算** — 每次预算决策使用 `charsPerToken`，而不是引擎 tokenizer。内容密集的文件可能超出预期预算，稀疏文件则可能留下未用预算。
- **仅按名称排除机密** — 默认排除文件名覆盖常见环境、凭据与密钥文件，但不检查内容。自定义 `includeFileNames` 或 `includeExtensions` 列表可能纳入机密，名称不同的机密文件也会被纳入。
- **删除通知保留内容** — 从记录中移除路径只会追加通知；早先的块会留在历史中，直到压缩遮蔽它。
- **不完整扫描保留旧记录项** — 当 `maxDepth`、`maxVisitedEntries` 或 `maxFiles` 使扫描停止时，不会推断删除，因此已删除文件可能留在记录中，直到完整扫描运行。
- **基线与对话争用上下文** — 接近上下文窗口的基线会更早触发压缩；之后准备的新基线会再次消耗预算。
- **新鲜度依赖后端** — 当后端不报告新鲜度令牌时，摘要快速路径仍会读取内容，因此扫描可能在每个符合条件的轮次重新读取所有已跟踪文件。
- **较长的预填充会超过提供方空闲超时** — 对于较大的基线，引擎可能在发出首个流式块前忙碌数分钟。pi-ai 适配器默认的 300,000 毫秒流空闲超时会使该次尝试失败并重试整个提示；提高提供方路由的 `streamIdleTimeoutMs` 以覆盖测得的预填充时间。
- **不可读与二进制文件** — 无法按文本读取内容的文件会在扫描备注中报告并省略。快照成员资格取决于配置的名称与扩展名规则，而不是内容检测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

随发行版交付的基础行保持禁用，以便每个部署选择预算。插件补丁必须完整重述 `config` 对象，因为补丁会替换它命名的属性。该投影仅限宿主；没有客户端 UI 读取它。

</details>
