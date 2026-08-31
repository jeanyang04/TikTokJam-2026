#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
runtime_base_image="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
runtime_apt_mirror="${CONTAINER_APT_MIRROR:-}"
runtime_apt_security_mirror="${CONTAINER_APT_SECURITY_MIRROR:-}"
runtime_apt_packages="${CONTAINER_RUNTIME_APT_PACKAGES:-ca-certificates git ripgrep}"
codex_sandbox_mode="${CODEX_SANDBOX_MODE:-workspace-write}"

log() {
  printf '[local-poc] %s\n' "$*" >&2
}

engine_works() {
  "$1" info >/dev/null 2>&1
}

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
      log "CONTAINER_ENGINE=$CONTAINER_ENGINE was not found."
      return 1
    }
    engine_works "$CONTAINER_ENGINE" || {
      log "$CONTAINER_ENGINE is installed but its service is not running."
      return 1
    }
    printf '%s' "$CONTAINER_ENGINE"
    return
  fi

  if command -v docker >/dev/null 2>&1 && engine_works docker; then
    printf 'docker'
    return
  fi

  if command -v colima >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    log "Docker is not reachable; starting Colima."
    colima start >&2
    if engine_works docker; then
      printf 'docker'
      return
    fi
  fi

  if command -v podman >/dev/null 2>&1; then
    if ! engine_works podman && [[ "$(uname -s)" == "Darwin" ]]; then
      log "Podman is not reachable; starting its macOS machine."
      podman machine start >&2 || true
    fi
    if engine_works podman; then
      printf 'podman'
      return
    fi
  fi

  log "No running Docker, Colima, or Podman engine was found."
  log "Install one of them, start it, and rerun this command."
  return 1
}

if [[ -z "${ARK_API_KEY:-}" || -z "${ARK_MODEL:-}" ]]; then
  log "ARK_API_KEY and ARK_MODEL are required."
  log "Example: ARK_API_KEY=key ARK_MODEL=ep-id ./scripts/start-local-poc.sh"
  exit 2
fi

command -v node >/dev/null 2>&1 || {
  log "Node.js 22+ is required to run the local control plane."
  exit 2
}

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  log "Node.js 22+ is required; found $(node --version)."
  exit 2
fi

engine="$(detect_engine)"
log "Using $engine as the Agent Runtime engine."

# Postgres (LOCK 2, B3): brought up via `docker compose`, independently of
# which engine builds/runs the Agent Runtime containers above. Left running
# on exit (unlike the disposable runtime containers cleaned up below) so
# seeded demo data survives between `npm run poc` runs. If `docker compose`
# isn't available, CRM tools degrade gracefully rather than block the
# baseline — see gateway.ts's handling of a missing `withOwner`.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Starting Postgres (docker compose)."
  docker compose up -d postgres

  log "Waiting for Postgres to be ready."
  postgres_ready=false
  for _ in $(seq 1 30); do
    # Polls the container's own healthcheck (docker-compose.yml's pg_isready
    # check) via `docker inspect`, rather than running pg_isready through
    # `docker compose exec` on every tick — exec allocates a fresh session
    # each call and was unreliable in this non-interactive script context.
    postgres_container="$(docker compose ps -q postgres 2>/dev/null)"
    if [[ -n "$postgres_container" ]] \
      && [[ "$(docker inspect -f '{{.State.Health.Status}}' "$postgres_container" 2>/dev/null)" == "healthy" ]]; then
      postgres_ready=true
      break
    fi
    sleep 1
  done

  if [[ "$postgres_ready" == true ]]; then
    export DATABASE_URL_ADMIN="${DATABASE_URL_ADMIN:-postgres://app_admin:launchpad@127.0.0.1:5433/launchpad}"
    export DATABASE_URL_AGENT="${DATABASE_URL_AGENT:-postgres://app_agent:launchpad@127.0.0.1:5433/launchpad}"
    log "Postgres ready; DATABASE_URL_ADMIN and DATABASE_URL_AGENT exported."
  else
    log "Postgres did not become ready in time; CRM tools will report unavailable."
  fi
else
  log "docker compose not found; skipping Postgres. CRM tools will report unavailable."
fi

if [[ ! -d node_modules ]]; then
  log "Installing application dependencies."
  npm ci
fi

# Shared with seed-local.sh so `npm run poc` and `npm run seed` always agree
# on where the store lives.
source "$repo_dir/scripts/local-state-env.sh"
export RUNTIME_INSTANCE_ID="${RUNTIME_INSTANCE_ID:-local-$(id -u)-$(printf '%s' "$repo_dir" | cksum | awk '{print $1}')}"

mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME"
log "Persistent state: $local_state_root"
export CONTAINER_USER="${CONTAINER_USER:-$(id -u):$(id -g)}"

# The build needs the registry, and that is the one step that fails on a
# network the rest of the POC does not care about — a proxy, IPv6-only DNS,
# an offline demo room. Skipping is opt-in rather than automatic: silently
# reusing whatever image happens to be tagged would hide a stale runtime.
if [[ -n "${SKIP_RUNTIME_BUILD:-}" ]]; then
  if ! "$engine" image inspect "$runtime_image" >/dev/null 2>&1; then
    log "SKIP_RUNTIME_BUILD is set but $runtime_image is not present locally."
    log "Unset it and build once with a working registry connection."
    exit 1
  fi
  log "Skipping the Runtime image build; reusing the local $runtime_image."
else
  log "Building $runtime_image from Dockerfile.runtime (base: $runtime_base_image)."
  if ! "$engine" build \
    --file Dockerfile.runtime \
    --build-arg "NODE_IMAGE=$runtime_base_image" \
    --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
    --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
    --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
    --tag "$runtime_image" \
    .
  then
    if "$engine" image inspect "$runtime_image" >/dev/null 2>&1; then
      log "Build failed, but $runtime_image already exists locally."
      log "Re-run with SKIP_RUNTIME_BUILD=1 to start against it."
    fi
    exit 1
  fi
fi

log "Checking that the Runtime can bind-mount the configured state directories."
preflight_user_args=(--user "$CONTAINER_USER")
if [[ "$(basename "$engine")" == "podman" ]]; then
  preflight_user_args+=(--userns keep-id)
fi
if ! "$engine" run --rm \
  "${preflight_user_args[@]}" \
  --mount "type=bind,src=$AGENT_WORKSPACE_ROOT,dst=/workspace" \
  --mount "type=bind,src=$CODEX_HOME,dst=/codex-home" \
  "$runtime_image" sh -lc \
    'touch /workspace/.launchpad-write-test /codex-home/.launchpad-write-test && rm /workspace/.launchpad-write-test /codex-home/.launchpad-write-test'; then
  log "The container engine cannot mount $local_state_root."
  log "Set LOCAL_POC_DATA_ROOT to a directory shared with Docker/Colima/Podman."
  exit 2
fi

if [[ "$codex_sandbox_mode" == "workspace-write" ]] \
  && ! "$engine" run --rm "$runtime_image" \
    codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  log "Codex Landlock is unavailable in this Linux Runtime."
  log "Falling back to danger-full-access inside the disposable container boundary."
  log "Do not mount unrelated secrets or host directories into the Agent Runtime."
  codex_sandbox_mode=danger-full-access
fi

export NODE_ENV=production
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
export CODEX_SANDBOX_MODE="$codex_sandbox_mode"
export RUNTIME_PROVIDER=container
export CONTAINER_ENGINE="$engine"
export CONTAINER_RUNTIME_IMAGE="$runtime_image"

cleanup() {
  local container_ids
  container_ids="$($engine ps --all --quiet \
    --filter label=io.codejam.launchpad=agent-runtime \
    --filter "label=io.codejam.instance-id=$RUNTIME_INSTANCE_ID" 2>/dev/null || true)"
  if [[ -n "$container_ids" ]]; then
    log "Removing remaining Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] && "$engine" rm --force "$container_id" >/dev/null 2>&1 || true
    done <<<"$container_ids"
  fi
}
trap cleanup EXIT INT TERM

# Recover cleanly after a terminal or server crash from a previous local run.
cleanup

log "Building the local Web and API."
npm run build

log "Open http://localhost:$PORT"
npm start
