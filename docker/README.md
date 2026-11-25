# Docker sandbox

The Dockerfile and `run.sh` in this directory run one `evalh` task in a
disposable Linux container. This is optional infrastructure; the rest of the
project works without Docker.

## Files

- `Dockerfile` - builds `evalh:latest` from the repository root. It installs
  `ca-certificates` and `git`, installs registry dependencies, compiles the
  TypeScript sources with `npm run build`, and leaves the CLI at
  `/app/dist/cli.js`.
- `run.sh` - builds the image and runs one task with the host `runs/` directory
  mounted at `/app/runs`. Provider credentials are not baked into the image.

## Build from the repository root

```bash
docker pull node:22-slim
docker build -f docker/Dockerfile -t evalh:latest .
```

The first build pulls `node:22-slim`. On Windows this requires Docker Desktop
with WSL 2; on Linux Docker Engine is enough. `npm install` in the image needs
network access to the npm registry. The checked-in `package-lock.json` contains
local `file:` links, so the build intentionally installs from `package.json`
instead of copying the lockfile.

## Run a task

From the repository root, using Git Bash, bash, or sh:

```bash
docker/run.sh tasks/demo/fix-greeting --model anthropic/claude-sonnet-4-5
docker/run.sh tasks/demo/fix-greeting --model lmstudio/qwen3.8-4b-distill --format qwen3
docker/run.sh tasks/demo/fix-greeting --runs-dir ./my-runs --max-turns 10
```

`run.sh` builds the image on every invocation, then runs:

```
docker run --rm -v <runs-dir>:/app/runs evalh:latest \
  node dist/cli.js run <taskDir> --runs-dir /app/runs [extra args]
```

The task directory is resolved inside the image. The harness copies the task's
`repo/` into a fresh run workspace, so no separate source mount is needed. Run
artifacts (`run.json`, `events.jsonl`, `workspace/`, `traces/`, `diff.patch`,
and so on) are written under the host runs directory. All arguments other than
`--runs-dir` are forwarded to `evalh run` unchanged, including `--model`,
`--format`, `--max-turns`, `--timeout`, and `--quiet`.

`EVALH_*` environment variables are forwarded into the container. If you keep
pi configuration on the host, set `EVALH_AGENT_DIR` to that directory; it is
mounted read-only at `/app/.pi-agent` and selected via
`PI_CODING_AGENT_DIR`. Without it, the container uses its default empty agent
directory, so providers that need credentials will fail until configured.

## Provider access

Cloud providers use the usual credentials from the mounted agent directory (or
provider environment variables). The container needs outbound HTTPS.

For a local OpenAI-compatible server such as LM Studio, configure the provider
in `models.json` with a `baseUrl` of:

```
http://host.docker.internal:1234/v1
```

`host.docker.internal` resolves to the host from inside the container via
`--add-host=host.docker.internal:host-gateway`, which `run.sh` adds on every
run. Start LM Studio on the host and bind it to `0.0.0.0` (or all interfaces)
so the container can reach it; on Linux, `host-gateway` requires a Docker Engine
version that supports it.

## Isolation caveats

- Tools run in a real Linux container: `bash`, `git`, `read`, `write`, `edit`,
  `grep`, and `find` operate on the container filesystem and its copied
  workspace. Paths and the `env` persona inside the container are Linux paths,
  so a family configured with `env.os: linux` and `env.shell: bash` matches
  reality.
- This is process/filesystem isolation, not a hardened security boundary. v1
  runs as root, keeps the container network enabled, and does not drop Linux
  capabilities. An agent with a shell tool can still reach the network and any
  mounted data. Future work: a non-root user, a default-deny network, and
  tighter capabilities.
- Only the runs directory (and optionally the read-only agent directory) is
  mounted. Writes to other container paths disappear when `--rm` removes the
  container.
- The container image is built locally and tagged `evalh:latest`; a rebuilt
  image replaces the old tag.
