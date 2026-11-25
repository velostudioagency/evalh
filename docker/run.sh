#!/bin/sh
# Build evalh:latest and run one task in a disposable Linux container.
# POSIX sh: works in Git Bash on Windows and in bash/dash/sh on Linux/macOS.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
REPO_DIR=$(dirname -- "$SCRIPT_DIR")
IMAGE=evalh:latest

usage() {
	cat <<EOF
Usage: $(basename "$0") <taskDir> [options]

Builds evalh:latest, then runs one evalh task inside a Linux container.
taskDir is a path inside the image, relative to the repo root, for example
tasks/demo/fix-greeting. Runs are written to <runs-dir>/<run-id> on the host.

Options:
  --runs-dir <dir>    Host directory for runs (default: <repo>/runs)
  -h, --help          Show this help

Everything else (including --model, --format, --max-turns, --quiet) is passed
through to `evalh run` unchanged.
EOF
}

# Convert a host path into the form the Docker CLI expects on Windows.
host_mount_path() {
	case $(uname -s) in
		MINGW* | MSYS* | CYGWIN*)
			if command -v cygpath >/dev/null 2>&1; then
				cygpath -m "$1"
			else
				printf '%s\n' "$1"
			fi
			;;
		*) printf '%s\n' "$1" ;;
	esac
}

# Leading --runs-dir options, if any.
RUNS_DIR=
while [ "$#" -gt 0 ]; do
	case $1 in
		-h | --help)
			usage
			exit 0
			;;
		--runs-dir)
			if [ "$#" -lt 2 ]; then
				echo "error: --runs-dir needs a value" >&2
				exit 2
			fi
			RUNS_DIR=$2
			shift 2
			;;
		--runs-dir=*)
			RUNS_DIR=${1#--runs-dir=}
			shift
			;;
		--) shift; break ;;
		*) break ;;
	esac
done

if [ "$#" -lt 1 ]; then
	echo "error: missing taskDir" >&2
	usage >&2
	exit 2
fi
TASK_DIR=$1
shift

# Also accept --runs-dir after taskDir. Rotate the remaining arguments so the
# pass-through arguments keep their order.
COUNT=$#
INDEX=0
while [ "$INDEX" -lt "$COUNT" ]; do
	arg=$1
	shift
	INDEX=$((INDEX + 1))
	case $arg in
		--runs-dir)
			if [ "$#" -lt 1 ]; then
				echo "error: --runs-dir needs a value" >&2
				exit 2
			fi
			RUNS_DIR=$1
			shift
			INDEX=$((INDEX + 1))
			;;
		--runs-dir=*) RUNS_DIR=${arg#--runs-dir=} ;;
		*) set -- "$@" "$arg" ;;
	esac
done

if [ -z "$RUNS_DIR" ]; then
	RUNS_DIR=$REPO_DIR/runs
fi
mkdir -p "$RUNS_DIR"
RUNS_HOST=$(CDPATH= cd -- "$RUNS_DIR" && pwd -P)
RUNS_HOST=$(host_mount_path "$RUNS_HOST")

# An absolute host task path is accepted only when it lives inside this repo;
# nothing else from the host is mounted into the container.
case $TASK_DIR in
	/* | [A-Za-z]:*)
		if TASK_HOST=$(CDPATH= cd -- "$TASK_DIR" 2>/dev/null && pwd -P); then
			REPO_HOST=$(CDPATH= cd -- "$REPO_DIR" && pwd -P)
			case $TASK_HOST in
				"$REPO_HOST"/*) TASK_DIR=${TASK_HOST#"$REPO_HOST"/} ;;
				*)
					echo "error: taskDir is outside the repo and is not mounted: $TASK_DIR" >&2
					exit 2
					;;
			esac
		fi
		;;
esac

docker build -f "$SCRIPT_DIR/Dockerfile" -t "$IMAGE" "$REPO_DIR"

# Forward EVALH_* variables (for example EVALH_DEBUG=1) into the container.
DOCKER_ENV=
for name in $(env | sed -n 's/^\(EVALH_[A-Za-z0-9_]*\)=.*/\1/p'); do
	# EVALH_AGENT_DIR is a host-only setting; it is handled as a mount below.
	if [ "$name" = EVALH_AGENT_DIR ]; then
		continue
	fi
	DOCKER_ENV="$DOCKER_ENV -e $name"
done

# Optional: mount a host pi agent directory containing models.json / auth.json.
# Set its baseUrl to http://host.docker.internal:1234/v1 for LM Studio.
if [ -n "${EVALH_AGENT_DIR:-}" ]; then
	AGENT_HOST=$(CDPATH= cd -- "$EVALH_AGENT_DIR" && pwd -P)
	AGENT_HOST=$(host_mount_path "$AGENT_HOST")
	DOCKER_ENV="$DOCKER_ENV -e PI_CODING_AGENT_DIR=/app/.pi-agent"
	MSYS_NO_PATHCONV=1 docker run --rm \
		--add-host=host.docker.internal:host-gateway \
		$DOCKER_ENV \
		-v "$RUNS_HOST:/app/runs" \
		-v "$AGENT_HOST:/app/.pi-agent:ro" \
		"$IMAGE" node dist/cli.js run "$TASK_DIR" --runs-dir /app/runs "$@"
else
	MSYS_NO_PATHCONV=1 docker run --rm \
		--add-host=host.docker.internal:host-gateway \
		$DOCKER_ENV \
		-v "$RUNS_HOST:/app/runs" \
		"$IMAGE" node dist/cli.js run "$TASK_DIR" --runs-dir /app/runs "$@"
fi
