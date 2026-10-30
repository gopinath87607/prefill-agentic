# Prefill Agentic

English | [中文](README.zh.md)

Prefill Agentic is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) for long-context engines. The harness sends a deterministic snapshot of the workspace before the model's first step, then appends only the files that changed on later turns, so the engine can work from the whole repository without spending its first calls on search and read.

## What this fork adds

- `packages/context/prefill-context`: a Cordis plugin that scans the working directory through the file service, renders the snapshot as one user message, and records every file transition in the session log.
- `prefill.patch.yml`: the overlay that enables the plugin with a 400,000-token baseline, a 16,000-token per-turn delta, and a 3.4 characters-per-token estimate for the local Maya tokenizer.
- `engines.patch.yml`: the overlay that routes the `maya` and `satarata` providers through the pi-ai adapter and reads endpoints, model ids, and credentials from the launch environment.

## How prefill works

The first eligible step scans the workspace once, skips excluded and credential-like files, and fills the baseline budget with the shallowest files first, then in path order. Later turns compare file versions and digests and append a small update containing added, modified, and removed paths. The baseline is never rewritten, so the earlier request prefix stays reusable while the task grows. Each message is durable session history: resume reconstructs it, and compaction replaces it like any other message.

<a id="run"></a>

<a id="run-from-source"></a>

## Run

Build the checkout once:

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

The Web UI listens on `http://127.0.0.1:3080` and prints a token URL. A VirtualBox guest reaches it at `http://10.0.2.2:3080`; add `--trusted-host 10.0.2.2:3080` so the server accepts that host header.

### Windows VM

The Windows checkout uses two PowerShell scripts. Run the first once from an elevated window, then start the harness from a normal window:

```powershell
powershell -ExecutionPolicy Bypass -File "\\vboxsvr\NVMe-Share\dsh-windows\setup-dsh.ps1"
```

```powershell
powershell -ExecutionPolicy Bypass -File C:\dsh-tools\start-dsh.ps1
```

Setup installs Node 24, Git, and pnpm when they are missing, enables Developer Mode and long paths for pnpm's symlinks, clones this fork to `C:\dsh`, and builds the artifacts. The launcher sets the engine environment for `http://10.0.2.2:8080`, starts the Web UI on port 3080, and opens the browser. Pass `-Port <port>` or `-Workspace <path>` to change the defaults; the default workspace is `Documents\deepseek-harness`.

## Configure the snapshot

Edit `prefill.patch.yml`; the launcher reads it at startup:

```yaml
- id: prefill-context
  name: '@deepseek-ai/dsh-prefill-context'
  disabled: false
  config:
    budgetTokens: 400000
    deltaBudgetTokens: 16000
    charsPerToken: 3.4
```

`budgetTokens` sizes the first snapshot, `deltaBudgetTokens` caps new and removed content appended in one later turn, and `charsPerToken` converts characters to tokens for every budget decision. The package README documents the file caps, depth, refresh mode, include rules, and exclusions, and the base bundle keeps the row disabled so a deployment opts in with its own budget.

Keep the baseline below the compaction trigger. On a 1M-token engine, 400,000 tokens leaves room for the verbatim tail and the conversation; a snapshot close to the model window is replaced by compaction, which ends the cache reuse.

## Configure engines

`engines.patch.yml` adds two providers and selects the default route from the environment:

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

Both providers speak OpenAI Chat Completions by default. Set `MAYA_API` or `SATARATA_API` to `openai-responses` or `anthropic-messages` for another protocol. A large cold prefill can keep the engine busy for minutes before the first stream chunk, so both routes default to a 20-minute idle timeout; override it with `MAYA_STREAM_IDLE_MS` or `SATARATA_STREAM_IDLE_MS`. Credentials stay in the launch environment: no key or deployment URL is committed.

## Workspace limits

The Windows file writer preserves NTFS security descriptors and publishes through hard links. VirtualBox shared folders implement neither operation, so a Windows harness should edit a local NTFS folder. The shared folder still works for reading and for the prefill scan, and the Linux harness can edit it directly.

## Upstream

DeepSeek Harness is in developer preview and changes rapidly. Read the [upstream documentation](https://deepseek-harness.github.io/deepseek-harness/) and the [safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) before running the harness, and follow the [upstream contributing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/CONTRIBUTING.md). This fork tracks `master` and keeps the upstream license.

## License

[MIT](LICENSE)
