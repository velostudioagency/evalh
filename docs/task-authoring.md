# Task authoring

This guide walks through creating a task family, writing a task by hand, and
running it. A **family** is a folder that groups tasks and holds settings they
share. A **task** is one folder with a prompt and a small repository for the
agent to work in.

## Before you start

`evalh` is the CLI for this package. From the repository root you can either
build it once:

```bash
npm run build -w @earendil-works/pi-eval-harness
node packages/eval-harness/dist/cli.js --help
```

or link the `evalh` command:

```bash
npm link -w @earendil-works/pi-eval-harness
evalh help
```

The commands below use `evalh`. If you did not link it, use
`node packages/eval-harness/dist/cli.js` instead.

## 1. Create a family with `evalh init`

```bash
evalh init tasks/my-family
```

This writes a complete starter family:

```
tasks/my-family/
  family.yaml
  README.md
  example-task/
    task.yaml
    prompt.md
    repo/
      README.md
      package.json
      src/greet.js
      test/greet.test.js
```

The example task has one failing test. You can run it as-is, then edit the files
to make your own task.

`init` refuses to write into a non-empty directory. To write anyway, add
`--force`:

```bash
evalh init tasks/my-family --force
```

## 2. Author a task by hand

### Layout

```
tasks/
  my-family/
    family.yaml          shared settings for every task
    README.md            notes for humans
    fix-greeting/        one task folder
      task.yaml          what the task is and where its files are
      prompt.md          the instructions given to the agent
      repo/              the files the agent sees and edits
```

The folder name (`fix-greeting`) becomes the task id when `task.yaml` does not
set one. The `tasks/demo/fix-greeting` folder in this repository is a complete
example you can copy.

### family.yaml

Put shared settings under `defaults`. These apply to every task in the family
unless a task overrides them.

```yaml
name: my-family
description: Small starter tasks for trying the harness.

defaults:
  harness: pi
  model: anthropic/claude-sonnet-4-5
  thinkingLevel: off
  toolFamily: pi
  limits:
    maxTurns: 30
    timeoutSec: 600
  trace:
    formats: [qwen3]
    includeThinking: true
    includeToolSchemas: true
```

Meaning of the keys used here:

| Key | Meaning |
| --- | --- |
| `name` | Family name shown by `evalh list` and `evalh show` |
| `description` | Short human-readable note |
| `harness` | Agent loop to use; use `pi` in this version |
| `model` | Model as `provider/model` |
| `thinkingLevel` | Reasoning budget; `off` is a good start |
| `toolFamily` | Tools the agent gets; `pi` includes `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `limits.maxTurns` | Stop after this many turns |
| `limits.timeoutSec` | Stop after this many seconds |
| `trace.formats` | Exporters to run: `qwen3`, `jsonl`, or both |

### task.yaml

Keep this file small. It names the prompt, the repo, and any settings that
differ from the family.

```yaml
id: fix-greeting
prompt: prompt.md
repo: repo
```

`prompt` and `repo` are paths relative to the task folder, so the values above
are the usual choice. To override a family setting for one task, add it here:

```yaml
id: fix-greeting
prompt: prompt.md
repo: repo
model: anthropic/claude-sonnet-4-5
limits:
  maxTurns: 10
```

### prompt.md

Write plain instructions. The text of this file becomes the agent's task. Say
what to run, what to change, and what not to change.

```markdown
The test suite in this repository is failing.

Run `npm test` to see the failure, find the bug, and fix it. Do not change the
test file.
```

Keep the prompt short and checkable. "Make the tests pass" is clearer than
"improve the code".

### repo/

`repo/` is an ordinary folder of files. There is no special fixture format.
Everything in it is copied into a fresh workspace for each run. The demo task
uses three files:

`repo/package.json` gives the agent a command to run:

```json
{
	"name": "fix-greeting",
	"private": true,
	"type": "module",
	"scripts": {
		"test": "node --test"
	}
}
```

`repo/src/greet.js` holds the bug the agent should find:

```js
export function greet(name) {
	return `Hello, ${nmae}!`;
}
```

`repo/test/greet.test.js` defines what "fixed" means:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "../src/greet.js";

test("greets by name", () => {
	assert.equal(greet("Ada"), "Hello, Ada!");
});
```

Keep one concern per file: source in `src/`, tests in `test/`, and a short
`README.md`. The agent can then read, edit, and write these files just as it
would in a real project.

## 3. Give the agent something to act on

The `pi` tool family gives the agent `read`, `bash`, `edit`, `write`, `grep`,
`find`, and `ls`. So a fixture is simply a file placed in `repo/`:

- `bash` lets the agent run `npm test`, `git status`, or any command available
  in the workspace.
- `edit` and `write` let it change source files or add new ones.
- `read`, `grep`, `find`, and `ls` let it explore the repository.

Put a small, repeatable check in the repo. In the demo, `npm test` fails before
the fix and passes after it. Without a check like this, there is no way to tell
whether the agent did the task.

### "Do not change the test file"

Write constraints in `prompt.md`, next to the goal:

```markdown
Run `npm test` to see the failure, find the bug, and fix it. Do not change the
test file.
```

This is an instruction to the agent, not a rule the harness enforces. In this
version there is no scorer. To check the constraint yourself, open `diff.patch`
in the run folder and confirm that only `src/greet.js` changed. Put files the
agent must not touch in their own folder, such as `repo/test/`, so a broken
constraint is easy to spot in the diff.

## 4. Run and inspect

First check that your task is discovered:

```bash
evalh list tasks
```

### `evalh run`

```bash
evalh run tasks/my-family/fix-greeting --model anthropic/claude-sonnet-4-5
```

The CLI prints the run folder, status, turns, duration, workspace path, diff
path, and trace paths. Each run gets a new folder under `runs/` (or under
`--runs-dir <dir>`). The agent edits `workspace/`; `input/` stays a pristine
copy of `repo/`.

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--model provider/model` | Override the model from the config |
| `--tool-family <name>` | Override the tool family |
| `--format qwen3,jsonl` | Choose trace exporters |
| `--max-turns <n>` | Stop after n turns |
| `--timeout <seconds>` | Stop after n seconds |
| `--runs-dir <dir>` | Write runs somewhere other than `./runs` |
| `--quiet` | Print only the final status and run path |

### `evalh show`

```bash
evalh show runs/<run-id>
```

This prints the run summary: status, task, model, turns, duration, and the
paths to the workspace, diff, and event log. Add `--json` to get the full run
metadata instead:

```bash
evalh show runs/<run-id> --json
```

Read `runs/<run-id>/diff.patch` to see exactly what the agent changed, and
`runs/<run-id>/events.jsonl` for the step-by-step event log.

### `evalh export`

The run exports traces when it finishes. To export again, for example in a
different format:

```bash
evalh export runs/<run-id> --format qwen3
```

Leave out `--format` to use the formats from the task config. Exported files
are written to `runs/<run-id>/traces/`, and the command prints each path it
wrote. `qwen3` produces `qwen3.txt`; `jsonl` produces `events.jsonl`.

## Quick checklist

- `evalh init tasks/my-family` gives you a working starting point.
- One `family.yaml` per family, one `task.yaml` per task.
- `prompt.md` states the goal and any constraints in plain language.
- `repo/` contains ordinary files, including a command that checks the result.
- Run with `evalh run`, inspect with `evalh show`, re-export with `evalh export`.
