#!/usr/bin/env bash
# Resolves and exports APP_DATA_DIR, AGENT_WORKSPACE_ROOT, and CODEX_HOME to
# the persistent local state root, so every script that sources this
# (start-local-poc.sh, seed-local.sh) reads and writes the same store instead
# of each defaulting independently to `.data` / `workspaces` under whatever
# directory it happened to be invoked from (e.g. `npm run seed -w
# @launchpad/server` on its own resolves those relative to apps/server).
#
# Usage: `repo_dir` must already be set by the caller, then:
#   source "$repo_dir/scripts/local-state-env.sh"

if [[ -n "${LOCAL_POC_DATA_ROOT:-}" ]]; then
  local_state_root="$LOCAL_POC_DATA_ROOT"
  export APP_DATA_DIR="$local_state_root/data"
  export AGENT_WORKSPACE_ROOT="$local_state_root/workspaces"
  export CODEX_HOME="$local_state_root/codex-home"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  local_state_root="${HOME}/.volc-agent-launchpad"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
else
  local_state_root="$repo_dir/.local"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
fi
