---
description: "面向长上下文模型的预填充工作区快照与仅追加更新，供用户和维护者调整模型在任务前读取的上下文。"
kind: "package-reference"
---

# @deepseek-ai/dsh-prefill-context

[English](README.md) | 中文

## 概述

`dsh-prefill-context` 在模型第一步之前把工作区内容交给长上下文模型：第一个符合条件的轮次让模型从扫描出的候选清单中选择相关文件，并注入这些内容的基线，后续轮次只追加变化路径。基线从不重写，因此请求前缀保持可复用。扫描遵循 `.gitignore` 与可配置排除模式，固定的系统提示段落要求模型复用快照。`prefillContext` 投影报告可见、注入、复用、选择与节省的 token 数；`prefillLedger` 为右侧边栏的预填充面板列出可见快照中的文件及其模型给出的理由。基础组合包保持该行禁用，由每个部署自行启用。

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

第一个符合条件的步骤扫描一次工作目录并注入基线。默认 `refresh: 'turn'` 时，之后每个轮次再次扫描，仅在内容变化时追加更新。`refresh: 'step'` 会在每一步扫描，因此模型编辑的文件会出现在同一轮次下一步的请求中。`refresh: 'never'` 会在会话余下时间内保持基线不变。

`position: 'before'` 把每份快照插入到该步骤声明的用户消息之前，使新会话的基线位于首个提示之前，并让最新的用户消息保持在最后。默认的 `'after'` 会把它插入到这些消息之后。

`agents: 'main'` 让快照与提示仅作用于顶层会话。默认的 `'all'` 也会给子代理各自的快照与提示；被委派的代理因此读取同一份已准备工作区，而不是重新发现文件。

### 选择预算

`budgetTokens` 是首份快照的内容预算；框架头部与扫描说明由 `reserveTokens` 覆盖。基线按模型的优先顺序填充剩余预算；确定性选择时则先最浅层、再按路径顺序，并跳过超过 `maxFileBytes`、`maxFileTokens` 或剩余预算的文件。仅因基线已满而被跳过的文件保持未跟踪，因此后续更新可在每轮 `deltaBudgetTokens` 的范围内添加它们。

路径索引是独立的有限段落。默认 `includePathIndex: true` 时，消息会在内容预算之外列出至多 `indexBudgetTokens` 个内容被跳过文件的路径。模型可以用现有的读取或搜索工具打开其中某个路径，而不必猜测工作区布局。设置 `includePathIndex: false` 可完全省略索引。

较大的预算减少发现调用，但与任何其他消息一样占用模型上下文。它同样计入压缩阈值：接近模型窗口的基线在压缩替换被遮蔽历史之前只留下很少的对话空间。应从任务形态出发，而不是从模型上限出发，并在提高预算前测量缓存复用。

### 选择要预填充的文件

默认 `selection: 'model'` 时，一次辅助调用决定基线内容。插件扫描工作区，把请求文本与有界候选清单（路径与字节大小，按最浅优先排序）发送给该步骤记录的模型路由；同时配置 `selectorProvider` 与 `selectorModel` 时则发送给该配置路由。只有被选中的路径会被读取，答案中的顺序即优先顺序，模型为每个文件给出的简短理由会记录到文件记录中并显示在[预填充面板](../../client/ui-prefill/README.zh.md)。模型未选择的文件不会被读取，也不会进入快照；被选中但不适应预算的文件会列入路径索引。

候选清单受 `selectorInputTokens` 限制：请求文本最多占该预算的一半，其余由候选行填充，因此超出预算的工作区只显示较浅的路径，模型无法选择未展示的路径。`selectorMaxFiles` 限制答案最多贡献多少个路径，`selectorMaxOutputTokens` 限制回复长度，调用必须在 `selectorTimeoutMs` 内完成。

选择调用从不进入对话；其确切请求与结果都是仅写入日志的会话事件（`prefill/selection-request` 与 `prefill/selection`），因此重放可以复现。无法运行或没有产生可用答案的调用会在同一步回退到确定性基线，面板会显示记录的原因：没有候选、没有请求文本、没有 `llm` 服务、没有路由、超时、流错误，或答案未命名任何可用路径。设置 `selection: 'deterministic'` 可跳过该调用，始终使用最浅优先顺序。

### 测量缓存节省

每条预填充消息都曾以未缓存方式处理一次，之后在请求中由提供方缓存提供。`prefillContext` 投影记录这笔交易：`visibleTokens` 估算当前界面上预填充消息的 token 数，`injectedTokens` 估算每条预填充消息引入的 token 数，`reusedTokens` 汇总归因到可见预填充内容的提供方缓存读取，`selectorTokens` 汇总每次已派发选择调用的提供方报告用量，`selectorCalls` 统计这些调用，`savedTokens` 是 `reusedTokens` 减去 `injectedTokens` 与 `selectorTokens` 后的值（下限为零）。`savedMs` 按 `promptTokensPerSecond`（部署引擎未缓存的提示吞吐量）把净节省 token 换算为时间。编辑器的用量对话框显示“预填充节省”一行，[预填充面板](../../client/ui-prefill/README.zh.md)则把每一项读数与文件列表、token 分桶及上下文压力并列展示。

复用归因是下界。token 数按 `charsPerToken` 从消息文本估算；提示前缀按顺序缓存，因此一次结算最多归因上一次结算时可见的预填充 token——即其缓存前缀所能容纳的量——未报告缓存读取的结算不计入。选择 token 则依据提供方报告的用量；派发前失败的调用不报告 token，也不计入调用次数。基线之后的首次结算因此总是不计入节省，下一次请求才开始报告复用。请根据目标引擎的实测值设置 `promptTokensPerSecond`。默认的每秒 1,000 token 假设使用快速加速器，较慢的引擎会因此低估节省的时间。

### 配置

最小挂载无需配置，使用 150,000 token 的基线预算。

```yaml
- name: '@deepseek-ai/dsh-prefill-context'
  config:
    budgetTokens: 700000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `budgetTokens` | `150000` | 扣除 `reserveTokens` 前的快照内容 token 预算 |
| `deltaBudgetTokens` | `32000` | 后续某一轮次追加内容的 token 预算 |
| `charsPerToken` | `4` | 每次预算决策使用的固定字符/token 估算值 |
| `reserveTokens` | `1024` | 为框架头部与扫描说明保留的 token 数 |
| `maxFileBytes` | `1048576` | 读入快照的最大文件字节数 |
| `maxFileTokens` | `32000` | 按估算 token 纳入的单个文件上限 |
| `maxFiles` | `20000` | 一次扫描收集的最大文件数 |
| `maxVisitedEntries` | `100000` | 一次扫描访问的最大目录项数 |
| `maxDepth` | `32` | 从工作目录向下遍历的最深目录层级 |
| `refresh` | `'turn'` | `'turn'` 在每个新轮次重新扫描；`'step'` 在每一步重新扫描；`'never'` 保持基线 |
| `position` | `'after'` | 把消息放在该步骤声明的用户消息之前或之后 |
| `agents` | `'all'` | `'main'` 只服务顶层会话；`'all'` 包含子代理 |
| `selection` | `'model'` | `'model'` 让路由模型选择基线路径；`'deterministic'` 保持最浅优先顺序 |
| `selectorProvider` | 未设置 | 选择调用的提供方路由；与 `selectorModel` 成对设置 |
| `selectorModel` | 未设置 | 选择调用的模型 id；与 `selectorProvider` 成对设置 |
| `selectorInputTokens` | `16000` | 请求文本与候选清单的估算输入 token 预算 |
| `selectorMaxFiles` | `64` | 选择答案最多可贡献的路径数 |
| `selectorMaxOutputTokens` | `2048` | 选择调用的输出 token 上限 |
| `selectorTimeoutMs` | `30000` | 选择调用的端到端截止时间 |
| `includePathIndex` | `true` | 列出内容未被纳入的路径 |
| `indexBudgetTokens` | `4000` | 路径索引的 token 预算，在 `budgetTokens` 之外 |
| `respectGitignore` | `true` | 扫描时应用各目录的 `.gitignore` |
| `guidance` | `true` | 在代理的系统提示中注册固定的预填充提示 |
| `promptTokensPerSecond` | `1000` | 把节省 token 换算为估算时间所用的未缓存提示吞吐量 |
| `includeExtensions` | 文本与代码列表 | 视为文本的小写扩展名；省略前导点时会自动添加 |
| `includeFileNames` | 构建与项目文件 | 无论扩展名如何都纳入的确切文件名 |
| `excludedDirectories` | 版本控制、依赖与构建目录 | 永不遍历的目录名，大小写不敏感 |
| `excludedFileNames` | 环境、凭据与密钥文件 | 永不纳入的文件名，大小写不敏感 |
| `excludedFilePatterns` | 锁文件、生成文件与机密模式 | 永不纳入的 gitignore 风格工作区相对模式；前导 `!` 可重新纳入 |

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

插件前置一个 `agent/pre-step` 监听器，先委托下游，然后在扫描产生基线或非空更新时追加一条带来源的 `UserMessage`。每条消息使用来源 `{ kind: 'prefill-context', scannedTurn, root, baseline?, changes }`，其中 `changes` 记录该消息提交的每一次记录转换。重新建立基线前会先运行选择调用，其请求与结果是独立的仅日志事件。

`prefillContext` 会话投影累计预填充 token 记账并提供节省视图；`prefillLedger` 投影把同样的消息折叠为可见文件记录：路径、后端新鲜度版本、内容摘要、字节大小与选择理由。文件记录视图被排除在摘要之外，因此会话列表行从不携带文件清单。更新会应用其转换；遮蔽任一已提交预填充消息的 surface 替换会清空两个投影，因此压缩后的下一步会准备新的基线。累计节省与选择调用统计会在该重置后保留，因为替换本身已使前缀复用失效，而新基线会再次以未缓存方式付出。重放与检查点恢复会得到同一份记录，因为来源记录了每一次转换。

代理创建时，插件会在该代理的作用域内、以 `FILE_REFERENCE` 排序位置注入一个 `context:prefill` 系统提示段落。该段落是固定字符串，因此不会让不同请求的提示产生差异。`main` 代理范围会同时跳过子代理会话的该段落与快照。

### 选择调用

`selectPrefillFiles` 先取配置的 `selectorProvider`/`selectorModel` 对，否则使用该步骤捕获的提供方与模型，然后从请求文本与确定性候选顺序渲染清单。它通过 `llm.prepareCall` 在 `deadline(signal, selectorTimeoutMs, PREFILL_SELECTION_TIMEOUT_CODE)` 下打开调用，记录包含确切系统指令、消息与输出上限的 `prefill/selection-request`，并以用途 `'prefill-selection'` 通过 `BlockAssembler` 流式接收答案。拼接后的文本块通过取第一个花括号包围的 JSON 对象解析；路径未知、重复或缺少字符串路径的条目会被丢弃并计数，超过 `selectorMaxFiles` 的条目同样如此，而命名了条目却全部不可用的答案视为无效。`prefill/selection` 记录结果、路由、耗时、用量、原始块，以及派发流时的 `llmStreamCall: true`。`prepareCall` 失败记录 `no-route` 或 `timeout`；流失败记录 `stream-error` 或 `timeout`；错误或中止的结束记录 `stream-error`；不可用的答案记录 `invalid-response`。

### 遍历与变更检测

扫描通过 `ctx.fs` 遍历工作目录，每一层按码点排序，并在读取任何内容之前跳过排除的目录名与 gitignore 风格模式。启用 `respectGitignore` 时，每个目录的 `.gitignore` 会成为其子树的规则层；命名某路径的最近一层决定该路径，因此嵌套 `.gitignore` 可以重新纳入其父层忽略的路径。配置的 `excludedFilePatterns` 作为一个大小写不敏感的匹配器使用；文件名与目录名同样按大小写不敏感比较。`ctx.fs.contains` 拒绝解析根之外的 target，`targetKey` 打破符号链接环。扫描在 `maxFiles` 或 `maxVisitedEntries` 处停止，或在 `maxDepth` 处记录 `incomplete`；不完整的扫描从不报告删除。

基线按最浅优先顺序读取文件，并把每个文件渲染为带分隔符的块。超过 `maxFileBytes` 或 `maxFileTokens` 的文件会被跳过并计入扫描备注；其余路径进入有界路径索引。后续扫描先比较后端新鲜度版本与大小，再读取并对变化的候选计算哈希。摘要与字节大小都与记录项一致的已变化文件视为未变化。不适应 `deltaBudgetTokens` 的内容保留旧记录项，以便后续轮次重试，并会列在更新的待处理索引中。已跟踪文件增长到超过大小或单文件 token 限制时，会产生 `DROPPED` 通知并移除记录项。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：pre-step 监听器、重建基线的选择、代理范围、提示段落、扫描编排、消息插入 |
| [`src/config.ts`](src/config.ts) | 配置 schema、默认值与规范化 |
| [`src/selector.ts`](src/selector.ts) | 选择提示、候选清单、辅助调用、答案校验与持久选择记录 |
| [`src/scan.ts`](src/scan.ts) | 确定性遍历、gitignore 规则层与排除模式 |
| [`src/prepare.ts`](src/prepare.ts) | 有预算的文件选择、读取、哈希、记录转换与路径索引输入 |
| [`src/render.ts`](src/render.ts) | 框架、块、通知、路径索引与提示的渲染 |
| [`src/state.ts`](src/state.ts) | 持久来源类型、校验、记录与节省折叠，以及投影 schema |
| [`src/types.ts`](src/types.ts) | 浏览器安全的 `prefillContext` 与 `prefillLedger` 视图约定及投影键声明 |
| [`src/client.ts`](src/client.ts) | 重新导出投影约定的客户端命名空间 |

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

首个符合条件的 pre-step 插入一条基线消息。它以 `<prefill-context kind="baseline" turn="<turn>" root="<root>" files="<count>" content-tokens="<estimate>" paths="<listed>">` 开头，随后是两行说明、可选的扫描备注、每个文件一个带分隔符的块，以及可选的 `--- PATHS NOT INCLUDED ---` 路径索引，列出内容被跳过的路径。之后每个发生变化的轮次插入一条 `kind="delta"` 的更新，包含新增、修改与删除文件计数、标记为 `(added)` 或 `(modified)` 的块、`--- REMOVED: <path> ---` 与 `--- DROPPED: <path> (<reason>) ---` 通知，以及可选的 `--- PATHS PENDING ---` 索引，列出未适应本次更新的已变化路径。框架声明同一路径的新块会替换旧块，并声明文件内容是数据，不是指令。启用 `guidance: true` 时，系统提示还会带上一段固定文字：把快照中未变化的内容视为当前状态，不要重新读取这些文件；后续块会替换同一路径的早先块；对列出的路径使用读取或搜索工具；在后续快照块命名某路径之前，以写入或编辑结果为准。基线的内容与顺序来自辅助选择调用，这是对话模型看不到的独立请求：它读取 `PREFILL_SELECTION_SYSTEM` 中的固定指令、请求文本，以及带字节大小的候选路径。

#### Token 影响

基线在压缩遮蔽它之前最多占用 `budgetTokens` 减去 `reserveTokens`。路径索引额外增加至多 `indexBudgetTokens` 的路径行。每个符合条件的轮次最多追加 `deltaBudgetTokens` 的文件内容，外加计数、路径、通知行与小型待处理索引。因此保留历史按基线加每一次已提交更新增长；`refresh: 'never'` 只增加基线，而 `refresh: 'step'` 可能在单个轮次内增加多次更新。每次已派发的选择调用会在对话界面之外增加自身的提示与输出，受 `selectorInputTokens` 与 `selectorMaxOutputTokens` 限制；`prefillContext` 把该用量记录在 `selectorTokens` 中。

#### KV Cache 影响

首次快照之后仅追加。基线与先前的更新在后续请求中保持相同位置，因此复用匹配前缀的提供方无需重新计算它们。无变化的轮次不追加任何内容。已跟踪文件的变化会在末尾追加新内容，而不是重写早先的副本；删除或丢弃是通知，而不是前缀编辑。`position: 'before'` 时，新会话的基线位于其首条用户消息之前；默认的 `'after'` 则跟在声明的消息之后。工作目录变化或遮蔽任一快照消息的压缩会追加新的基线；压缩替换本身已经使其切点之后不再可复用。提示段落是固定位置的固定文本，因此不会带来逐请求变化。选择调用是与对话不共享前缀的独立辅助请求；只有提供方独立缓存其提示时才会复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **默认按轮次刷新** — `refresh: 'turn'` 下，工具在当前轮次修改的文件要到后续轮次才出现在更新中。`refresh: 'step'` 以每一步扫描的代价弥补这一点，而且该扫描仍发生在下一次请求之前。
- **固定 token 估算** — 每次预算决策使用 `charsPerToken`，而不是引擎 tokenizer。内容密集的文件可能超出预期预算，稀疏文件则可能留下未用预算。
- **仅按名称与模式排除机密** — 默认排除文件名与模式覆盖常见环境、凭据、密钥、锁文件与生成文件，但不检查内容。自定义 `includeFileNames`、`includeExtensions` 或重新纳入模式可能加入机密，名称不同的机密文件也会被纳入。
- **路径索引只有名称** — 被跳过的路径不带大小、语言或变更状态，列表本身也受 `indexBudgetTokens` 限制。超出扫描上限的路径完全不会被列出。
- **Gitignore 规则尽力而为** — 不可读或过大的 `.gitignore` 会在扫描备注中报告，其子树的规则会被跳过。否定规则不能重新纳入被忽略目录之下的路径，因为遍历会先剪枝该目录。
- **提示段落是无条件的** — 当 `guidance` 启用且代理在范围内时，即使工作区没有纳入任何文件或后续扫描不产生更新，该段落仍然存在。
- **删除与丢弃通知保留内容** — 从记录中移除路径只会追加通知；早先的块会留在历史中，直到压缩遮蔽它。
- **不完整扫描保留旧记录项** — 当 `maxDepth`、`maxVisitedEntries` 或 `maxFiles` 使扫描停止时，不会推断删除，因此已删除文件可能留在记录中，直到完整扫描运行。
- **基线与对话争用上下文** — 接近上下文窗口的基线会更早触发压缩；之后准备的新基线会再次消耗预算。
- **新鲜度依赖后端** — 当后端不报告新鲜度令牌时，摘要快速路径仍会读取内容，因此扫描可能在每个符合条件的轮次重新读取所有已跟踪文件。
- **较长的预填充会超过提供方空闲超时** — 对于较大的基线，引擎可能在发出首个流式块前忙碌数分钟。pi-ai 适配器默认的 300,000 毫秒流空闲超时会使该次尝试失败并重试整个提示；提高提供方路由的 `streamIdleTimeoutMs` 以覆盖测得的预填充时间。
- **每个基线都包含一次选择调用** — `selection: 'model'` 时，步骤在首次请求前最多等待 `selectorTimeoutMs`，调用的 token 会计费并从 `savedTokens` 中扣除。设置 `selection: 'deterministic'` 可移除该调用。
- **候选清单限制可选范围** — 只有一行能放入 `selectorInputTokens` 的路径才会出现，且按最浅优先排序，因此大型工作区中的深层路径无法被选择。`selectorMaxFiles` 与 `selectorMaxOutputTokens` 进一步限制答案。
- **选择质量取决于模型** — 路径会对照候选清单校验，但相关性、顺序与理由均被信任。空答案会提交空基线，后续轮次随后会在 `deltaBudgetTokens` 范围内按最浅优先追加未跟踪文件。
- **节省是估算值** — 注入 token 依据 `charsPerToken`，复用 token 在上一次结算时最多归因当时可见的预填充 token，选择 token 依据提供方报告的用量，节省时间假设 `promptTokensPerSecond` 与引擎未缓存的提示吞吐量一致。
- **不可读与二进制文件** — 无法按文本读取内容的文件会在扫描备注中报告并省略。快照成员资格取决于配置的名称与扩展名规则，而不是内容检测。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

随发行版交付的基础行保持禁用，以便每个部署选择预算。插件补丁必须完整重述 `config` 对象，因为补丁会替换它命名的属性。这些投影提供由 `src/types.ts` 声明、`src/client.ts` 重新导出的客户端视图；编辑器的用量对话框读取节省视图，右侧边栏的预填充面板读取二者。提示段落通过 `agent.ctx.inject(['systemPrompt'], ...)` 按代理安装，并随代理或插件一起释放。

</details>
