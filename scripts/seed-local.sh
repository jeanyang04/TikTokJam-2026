#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# `npm run seed -w @launchpad/server` on its own runs with apps/server as its
# cwd, so APP_DATA_DIR/AGENT_WORKSPACE_ROOT resolve to apps/server/.data and
# apps/server/workspaces unless already set — a *different* store than the
# one `npm run poc` serves at $repo_dir/.local (or LOCAL_POC_DATA_ROOT / the
# macOS state root). Source the same resolver `start-local-poc.sh` uses so
# seeding always lands in the store the running server actually reads.
source "$repo_dir/scripts/local-state-env.sh"

mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT"

npm run seed -w @launchpad/server -- "$@"
