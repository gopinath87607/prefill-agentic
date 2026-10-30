# Prefill Agentic

[English](README.md) | 中文

Prefill Agentic 是面向长上下文引擎的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 分支。Harness 在模型第一步之前发送工作区的确定性快照，之后只追加后续轮次中发生变化的文件，因此引擎可以直接基于整个仓库工作，而不必把最初的调用花在搜索和读取上。

## 本分支新增

- `packages/context/prefill-context`：一个 Cordis 插件，通过文件服务扫描工作目录，把快照渲染为一条用户消息，并把每次文件变化记录到会话日志中。
- `prefill.patch.yml`：启用该插件的覆盖配置，包含 400,000 token 的基线和每轮 16,000 token 的增量，以及针对本地 Maya 分词器的每 token 3.4 字符估计。
- `engines.patch.yml`：把 `maya` 和 `satarata` 提供方接入 pi-ai 适配器，并从启动环境读取端点、模型 id 和凭据的覆盖配置。

## 预填充的工作方式

第一个符合条件的步骤扫描一次工作区，跳过被排除的文件和类似凭据的文件，先按目录深度、再按路径顺序用文件填满基线预算。后续轮次比较文件版本和摘要，追加一条包含新增、修改和删除路径的小更新。基线永远不会被重写，因此任务增长时较早的请求前缀仍可复用。每条消息都是持久的会话历史：恢复会话时会重建，压缩时会像其他消息一样被替换。

<a id="run"></a>

<a id="run-from-source"></a>

## 运行

先构建检出目录：

```sh
pnpm install
pnpm run build
```

### Linux

```sh
export MAYA_BASE_URL=http://127.0.0.1:8080/v1
export MAYA_MODEL=deepseek-v4.1-flash
export MAYA_API_KEY=<key>
export DSH_PROVIDER=maya
export DSH_MODEL="$MAYA_MODEL"
node apps/cli/lib/bin.js --profile web \
  --patch engines.patch.yml \
  --patch prefill.patch.yml \
  --port 3080
```

Web UI 监听 `http://127.0.0.1:3080` 并打印一个带 token 的 URL。VirtualBox 客户机可通过 `http://10.0.2.2:3080` 访问；添加 `--trusted-host 10.0.2.2:3080`，服务器才会接受该 Host 头。

### Windows 虚拟机

Windows 检出目录使用两个 PowerShell 脚本。第一个脚本从管理员窗口运行一次，然后从普通窗口启动 harness：

```powershell
powershell -ExecutionPolicy Bypass -File "\\vboxsvr\NVMe-Share\dsh-windows\setup-dsh.ps1"
```

```powershell
powershell -ExecutionPolicy Bypass -File C:\dsh-tools\start-dsh.ps1
```

安装脚本会在缺失时安装 Node 24、Git 和 pnpm，为 pnpm 的符号链接启用 Developer Mode 和长路径，把本分支克隆到 `C:\dsh` 并构建产物。启动脚本设置指向 `http://10.0.2.2:8080` 的引擎环境，在 3080 端口启动 Web UI 并打开浏览器。用 `-Port <port>` 或 `-Workspace <path>` 更改默认值；默认工作区是 `Documents\deepseek-harness`。

## 配置快照

编辑 `prefill.patch.yml`；启动器在启动时读取该文件：

```yaml
- id: prefill-context
  name: '@deepseek-ai/dsh-prefill-context'
  disabled: false
  config:
    budgetTokens: 400000
    deltaBudgetTokens: 16000
    charsPerToken: 3.4
```

`budgetTokens` 决定第一个快照的大小，`deltaBudgetTokens` 限制后续单轮追加的新增和删除内容，`charsPerToken` 在所有预算判断中把字符换算为 token。包的 README 记录了文件上限、深度、刷新模式、包含规则和排除项；基础 bundle 默认禁用该行，部署方用自己的预算显式启用。

让基线保持在压缩触发点以下。在 1M token 的引擎上，400,000 token 为逐字尾部和对话留出空间；接近模型窗口的快照会被压缩替换，缓存复用也随之结束。

## 配置引擎

`engines.patch.yml` 添加两个提供方，并从环境选择默认路由：

```sh
export MAYA_BASE_URL=https://engine.example/v1
export MAYA_MODEL=<served model id>
export MAYA_API_KEY=<key>
export SATARATA_BASE_URL=https://engine.example/v1
export SATARATA_MODEL=<served model id>
export SATARATA_API_KEY=<key>
export DSH_PROVIDER=maya
export DSH_MODEL="$MAYA_MODEL"
```

两个提供方默认使用 OpenAI Chat Completions 协议。其他协议可把 `MAYA_API` 或 `SATARATA_API` 设为 `openai-responses` 或 `anthropic-messages`。大量冷预填充可能让引擎在首个流式块之前忙碌数分钟，因此两条路由默认 20 分钟空闲超时；用 `MAYA_STREAM_IDLE_MS` 或 `SATARATA_STREAM_IDLE_MS` 覆盖。凭据只存在于启动环境中：不会提交任何密钥或部署 URL。

## 工作区限制

Windows 文件写入器会保留 NTFS 安全描述符并通过硬链接发布。VirtualBox 共享文件夹既不实现安全描述符写入，也不支持硬链接，因此 Windows harness 应编辑本地 NTFS 文件夹。共享文件夹仍可用于读取和预填充扫描，Linux harness 可以直接编辑它。

## 上游

DeepSeek Harness 处于开发者预览阶段，变化很快。运行前请阅读[上游文档](https://deepseek-harness.github.io/deepseek-harness/)和[安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)，并遵循[上游贡献指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md)。本分支跟踪 `master`，并保留上游许可证。

## 许可证

[MIT](LICENSE)
