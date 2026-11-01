---
description: "Web GUI 的预填充仪表盘：右侧边栏页面，展示已预填充的文件、缓存复用、节省的时间与最近的 token 用量；供用户与维护者验证预填充是否奏效。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-prefill

[English](README.md) | 中文

## 概述

预填充仪表盘是右侧边栏上的一个页面，读取四个由宿主计算的会话投影。它回答「预填充优先的上下文是否奏效」：当前可见快照携带哪些文件以及选择为何选中它们、其中多少 token 由服务商从缓存提供、这避免了多少提示词处理，以及最近一次请求的实际开销。所有数字都是服务商或宿主的精确计量，页面只负责格式化与排布。

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

与 `dsh-prefill-context` 及 `dsh-token-meter` 一起挂载本插件；页面注册为 `prefill` 标签页类型，并出现在右侧边栏引导页的「预填充仪表盘」入口。它是页面而非文件查看器：不认领任何资源地址，只能从引导页打开。

### 仪表盘显示什么

**预填充** 区块报告可见快照的文件数、当前可见的预填充 token 估计值、会话引入的全部预填充 token、缓存中包含预填充内容的提示词 token（服务商报告值）、选择调用次数及其服务商报告 token 数、净节省 token，以及这些 token 在配置的未缓存提示词速率下本应花费的时间。读数下方列出每个已预填充文件及其大小、选择记录的理由、工作区根目录与最近一次扫描所在的回合。

**最近一次选择** 报告最新基线的排序方式：`Model` 或 `Deterministic`、调用使用的提供方与模型、选中的文件数与丢弃的条目数、耗时与 token 数，以及回退到确定性顺序时的原因与诊断信息。会话记录选择之前不显示该区块。

**缓存与 token** 将四个互不重叠的计费桶——未缓存输入、缓存输入、缓存写入与输出——并列展示会话总计与最新一次请求样本。提示词行是三个输入桶之和，缓存命中行用缓存输入除以该提示词总数。

**上下文** 将下一次请求的预估提示词与最新公布的上下文窗口并列，并附百分比进度条。注释说明该读数是提示词侧的值，并已计入服务商采样之后屏幕上的改动。

### 如何理解这些数字

- 会话总计累加每一次请求，因此长会话中会超过任何单次提示词，甚至超过上下文窗口。与提示词预算对比时应看「最近一次请求」列。
- 会话缓存命中包含尚无内容可复用的首次冷请求；从零开始逐步上升是正常表现。
- 结算时，缓存复用最多记为上一次结算时可见的预填充 token：提示词前缀按顺序缓存，一次请求复用的预填充不可能超过其缓存前缀所包含的量。因此首次结算不记任何节省，下一次才开始报告。
- 节省 token 会扣除预填充与选择新增的开销：注入的预填充 token 与选择调用的用量，下限为零。选择开销超过复用量的会话报告无节省，而不是负数。
- 节省时间是估算：用节省 token 除以配置的 `promptTokensPerSecond`，并非实测延迟。

### 空状态

没有预填充快照时页面会说明这一点，并照常列出 token 与上下文读数。快照没有记录选择时不显示「最近一次选择」区块。若宿主不提供四个投影键中的任何一个，标签页显示一条不可用提示。空扫描与未记录回合的扫描各自说明其缺失。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

node 半部是空 apply，使该包能出现在宿主名单上；浏览器半部经 `exports["./client"]` 发布。浏览器半部注册 `prefill` 词典、带引导入口与注入上下文图标的 `prefill` 标签页类型、以包名为键注册在 `sidebar.right.pane.tab` 下的正文，以及以同一键注册在 `sidebar.right.pane.tab.title` 下的标签标题。每个注册都经由 `ctx.effect`，卸载时四项一并移除。

`PrefillDashboard` 通过标准 `useProjection` 座位读取 `prefillContext`、`prefillLedger`、`tokenUsage` 与 `contextPressure`，不在客户端折叠数据。宿主将 `prefillLedger` 排除在摘要之外，会话列表行因此从不携带文件清单；标签页正文是唯一读取方。最近一次选择随文件记录视图一起传递，正文把每种回退原因映射到 locale 键。`tokenUsage.last` 是累加总计旁的最新计费样本，`contextPressure.projectedTokens` 是计入界面改动后下一次请求的提示词量。

格式化是包内本地行为，文案由 locale 拥有：计数保持精确，不足一分钟的时长保留一位小数，字节数选用二进制单位，部分命中的缓存比例绝不四舍五入为 100。标题与正文共用一份样式表；标签页只使用语义化 `--dsw-*` 别名。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-prefill-context](../../context/prefill-context/README.zh.md)——拥有快照、只追加增量与两个预填充投影。
- [dsh-token-meter](../../llm/token-meter/README.zh.md)——拥有服务商用量累计与上下文压力。
- [ui-sidebar-right](../ui-sidebar-right/README.zh.md)——本页面注册所用的标签页注册表与键控座位。

-----

<a id="model-experience"></a>
## 模型体验

无，因为仪表盘只读取宿主计算的投影，不注册任何面向模型的界面。

#### KV Cache 影响

仪表盘不添加任何提示内容，因此不改变请求前缀；预填充快照自身的缓存效果由 `dsh-prefill-context` 拥有。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限可见快照**——文件清单只列出当前界面携带的内容。压缩遮蔽基线后清单会清空，直到下一次扫描注入新快照。
- **缓存复用是预填充归因，而非全部缓存使用**——读数只统计结算能归因到可见预填充的缓存提示词 token，其余缓存内容未被区分。
- **节省时间是推导值**——它取决于配置的吞吐量与 token 估计，是可比较的估算，而非实测响应时间差。
- **页面没有刷新控件**——它跟随会话投影变化，不提供手动重载。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

正文以包名为键注册，标签标题也以同一键注册；只改其中一个键会让标签标题留空。两个预填充投影类型均由 `@deepseek-ai/dsh-prefill-context/client` 重新导出，因此浏览器半部无需从 `dsh-prefill-context` 进行宿主侧导入。仪表盘通过键控座位的标准会话属性接收 `useProjection` 与 `t`。

</details>
