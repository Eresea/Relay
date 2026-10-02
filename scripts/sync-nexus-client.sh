#!/usr/bin/env bash
# Vendor the Nexus Rust SDK into packages/nexus-client-rs. Usage: NEXUS_DIR=../Nexus scripts/sync-nexus-client.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
nexus="${NEXUS_DIR:-$root/../Nexus}"
sdk="$nexus/sdk/rust"
dest="$root/packages/nexus-client-rs"
[ -f "$sdk/Cargo.toml" ] || { echo "Nexus Rust SDK not found at $sdk (set NEXUS_DIR)" >&2; exit 1; }
rm -rf "$dest"
mkdir -p "$dest"
cp -r "$sdk"/. "$dest"/
rm -rf "$dest/target" "$dest/Cargo.lock"
{
  echo "repo: Nexus"
  echo "commit: $(git -C "$nexus" rev-parse HEAD)"
  echo "path: sdk/rust"
  echo "note: $(git -C "$nexus" status --porcelain -- sdk/rust | grep -q . && echo 'synced from a dirty tree' || echo 'clean')"
} > "$dest/SOURCE"
echo "Synced nexus-client from $(git -C "$nexus" rev-parse --short HEAD)"
