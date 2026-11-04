#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required to build this project." >&2
  exit 1
fi

node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
fi

if (( node_major >= 22 )); then
  npm run release
else
  echo "Node.js 22+ is required; using a temporary Node.js 22 via npm exec."
  npm exec --yes --package=node@22 -- npm run release
fi

echo
echo "Release packages ready: $repo_root/release"
