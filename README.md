# pi eval harness

`evalh` runs a coding agent on one task in a fresh workspace, records the full
interaction, and exports it as a training trace. It is built on the pi SDK, so the
agent loop, tools, and provider layer are the same ones pi uses.

v0.2.0 is a headless runner, CLI, and interactive TUI. Scoring is planned.

The source lives in the pi monorepo (`pi/packages/eval-harness`). This repository
is the standalone home for `evalh`.

## Quick start

From the evalh repository root:

```bash
npm install
npm run build
node dist/cli.js --help
```

The bare `evalh` commands below require a global install (`npm install -g evalh`).
From the repo root without one, invoke the CLI as `node dist/cli.js ...` instead.

Run a task:

```bash
evalh list tasks
evalh run tasks/demo/fix-greeting --model anthropic/claude-sonnet-4-5
```

For a local model, point `--model` at an OpenAI-compatible endpoint configured in
`~/.pi/agent/models.json`:

```bash
evalh run tasks/demo/fix-greeting --model lmstudio/qwen3.8-4b-distill
```

## Interactive mode

Running bare `evalh` in a terminal (no arguments, with a TTY) opens the
interactive wizard. It shows a menu — New task family, New run, Show a run,
List tasks, and Exit — and guides you through the chosen action. Without a
TTY, bare `evalh` prints the help text instead.

For scripts and other non-interactive use, call the commands directly.
`evalh init <dir>` is the scriptable alternative to the wizard's
"New task family" step.

## Task families

Start one with `evalh init tasks/my-family`. It writes a complete example
family with a runnable task. For a step-by-step walkthrough, see
[docs/task-authoring.md](docs/task-authoring.md).

```
tasks/<family>/
  family.yaml
  <task>/
    task.yaml
    prompt.md
    repo/
```

`family.yaml` holds shared defaults:

```yaml
name: demo
description: Starter tasks.

defaults:
  harness: pi
  model: anthropic/claude-sonnet-4-5
  thinkingLevel: off
  toolFamily: pi
  env:
    os: linux
    shell: bash
    user: dev
    hostname: devbox
    home: /home/dev
    timezone: UTC
    git: true
  limits:
    maxTurns: 40
    timeoutSec: 900
  trace:
    formats: [qwen3, jsonl]
    includeThinking: true
    includeToolSchemas: true
```

`task.yaml` points at the prompt and repository:

```yaml
id: fix-greeting
prompt: prompt.md
repo: repo
```

Any config key can be overridden per task. `evalh init <dir>` writes a complete
working example.

### Configuration reference

| Key | Values | Meaning |
| --- | --- | --- |
| `harness` | `pi`, `omp` | Runner profile; `pi` and `omp` are implemented, `custom` is not. `omp` defaults `toolFamily` to `omp` when it is not set (see [Tool families](#tool-families)) |
| `model` | `provider/model` | Model resolved by pi's model runtime |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | Reasoning budget |
| `toolFamily` | `pi`, `omp`, `custom` | Which tools the model sees |
| `tools` | list of names | Explicit allowlist; overrides `toolFamily`; required when `toolFamily: custom` |
| `systemPrompt.mode` | `pi`, `custom`, `template` | Use pi's prompt, a file, or an inline template |
| `systemPrompt.file` | path | Prompt file relative to the task |
| `systemPrompt.template` | string | Inline template with `{{cwd}}`, `{{os}}`, etc. |
| `systemPrompt.append` | string | Extra text appended to the system prompt |
| `systemPrompt.realism` | boolean | Keep the OS/persona framing |
| `env.*` | OS, shell, user, host, home, timezone | Persona shown to the model |
| `env.git` | boolean | Create a git baseline and capture `diff.patch` |
| `limits.maxTurns` | number | Hard turn cap |
| `limits.timeoutSec` | number | Wall-clock cap |
| `trace.formats` | `qwen3`, `jsonl` | Exporters to run; both are implemented |

With `systemPrompt.realism: true` (the default), pi mode drops pi's "running inside
pi" preamble and `<docs>` section from the system prompt, removes its `PI_*` rule, and
scrubs model/benchmark identity wording from assistant and tool text in traces.
`realism: false` leaves pi's default prompt and traces untouched.

Known limitation: realism does not change pi's environment injection. The
`<environment>` addendum still carries the resolved `env.user`, `env.hostname`, and
`env.home` values, so set the `env.*` persona fields to match the intended
environment (or use the Docker sandbox) to avoid host leakage.

## Run layout

```
runs/<run-id>/
  run.json            run metadata and resolved config
  events.jsonl        canonical event log
  session.jsonl       raw pi session events
  input/              pristine copy of repo/
  workspace/          the copy the agent edits
  requests/           exact provider request payloads
  responses/          resp-0001.json, ... raw assistant messages
  traces/             qwen3.txt, events.jsonl
  diff.patch          git diff against the baseline
  logs/
    runner.log
    system-prompt.txt
    tools.json
    prompt.md
```

Each run gets a new directory. The input copy is never modified.

## Tool families

- `pi` exposes the built-in pi tools: `read`, `bash`, `edit`, `write`, `grep`,
  `find`, `ls`. `powershell` is added on Windows only; calling it elsewhere
  throws, so it is not offered there.
- `omp` exposes the subset of oh-my-pi tools that can be backed by pi's local
  implementations: `read`, `write`, `edit`, `bash`, `grep`, `find`. OMP-only
  tools such as `task`, `eval`, `lsp`, `web_search`, and `todo` depend on OMP's
  `ToolSession` runtime and are not available in v0.2.0.
- `custom` uses the `tools` list as an allowlist.

## Models

The harness resolves `provider/model` through pi's model runtime, using
`~/.pi/agent/auth.json` and `~/.pi/agent/models.json`. Set `PI_CODING_AGENT_DIR`
to point at a different agent directory (preferred, and read by pi core);
`PI_AGENT_DIR` is accepted as a legacy alias by this harness. Run `evalh doctor`
to see which directory is active. To use an OpenAI-compatible endpoint, add it
to `models.json` the same way you would for pi.

## Trace formats

All exporters read the same canonical event log, so the conversation is identical
across formats and only the wire envelope changes. `qwen3` writes the vendored
Qwen3 chat template (`templates/qwen3/4b.jinja`) to `traces/qwen3.txt`. `jsonl`
writes the raw canonical event stream to `traces/events.jsonl`, one JSON object
per line. Exact provider request payloads are captured under `requests/`, and
raw assistant messages under `responses/`, for auditing.

## Docker sandbox (Linux)

`docker/run.sh` runs one task inside a disposable Linux container instead of on
your host. It builds `evalh:latest` from `docker/Dockerfile`, mounts the host
runs directory at `/app/runs`, and passes the remaining arguments to `evalh run`.
Requires Docker Desktop with WSL 2 on Windows, or Docker Engine on Linux. The
first build pulls `node:22-slim` and needs npm registry access.

From the repository root, in Git Bash or any POSIX shell:

```bash
docker/run.sh tasks/demo/fix-greeting --model anthropic/claude-sonnet-4-5
docker/run.sh tasks/demo/fix-greeting --model lmstudio/qwen3.8-4b-distill --format qwen3
docker/run.sh tasks/demo/fix-greeting --runs-dir ./my-runs --max-turns 10
```

The task directory is interpreted inside the image (a path relative to the repo
root). The harness copies the task's `repo/` into a run workspace, so no source
mount is needed; `events.jsonl`, `workspace/`, `traces/`, and `diff.patch` land in
the host runs directory. All arguments except `--runs-dir` are forwarded to
`evalh run`. `EVALH_*` variables are forwarded to the container; set
`EVALH_AGENT_DIR` to mount a host pi agent directory read-only at
`/app/.pi-agent` for `models.json` and credentials. For LM Studio, set the
provider's `baseUrl` to `http://host.docker.internal:1234/v1` and bind LM Studio
to all interfaces on the host. See [docker/README.md](docker/README.md) for full
details.

Isolation caveats: tools run in a real Linux container, so the workspace and OS
persona are Linux, but v0.2.0 runs as root with networking enabled and no capability
drop. This is not a hardened security boundary. Future work: a non-root user and
a tighter network policy.

## Isolation

Local runs execute on the host. The workspace is a copy and git gives you a clean
baseline and diff, but this is not a security boundary: an agent can reach the
network and the rest of the machine. Use the Docker sandbox above for a separate
Linux process and filesystem.

The `env` block is a persona. On a local run the real paths are host paths, so set
`env.os` and `env.shell` to match the host, or use the Docker sandbox where the
container filesystem is Linux.

## Roadmap

- Harden the Docker sandbox: non-root user, restricted network, capability drop
- Full OMP tool adapter
- Real macOS and Windows VM personas
- Scoring and LLM-judge hooks
- ~~Interactive TUI~~ (shipped in v0.2.0)
