#!/bin/sh
set -eu
pkg="$1"
base_ref="${VIBEHUB_BASE_REF:-origin/main}"
# merge-base, not the tip of the base: new commits on main are not the card's change.
base=$(git merge-base HEAD "$base_ref")
if git diff --quiet "$base" -- "$pkg" && [ -z "$(git ls-files --others --exclude-standard -- "$pkg")" ]; then
  echo "$pkg: nada mudou desde $base_ref — sem testes a rodar"
  exit 0
fi
cd "$pkg"
exec node_modules/.bin/vitest run --changed "$base"
