#!/bin/sh
# Gate do vibehub (.vibehub/gate.json): roda só os testes do pacote ($1 = back|front) afetados pelo
# que o card mudou desde que saiu da base. Pacote sem mudança nenhuma é pulado — nem precisa de
# node_modules. A suíte inteira continua rodando no CI do PR; aqui é a checagem rápida antes do merge.
set -eu
pkg="$1"
base_ref="${VIBEHUB_BASE_REF:-origin/main}"
# merge-base, não a ponta da base: commits novos da main não são mudança do card.
base=$(git merge-base HEAD "$base_ref")
if git diff --quiet "$base" -- "$pkg" && [ -z "$(git ls-files --others --exclude-standard -- "$pkg")" ]; then
  echo "$pkg: nada mudou desde $base_ref — sem testes a rodar"
  exit 0
fi
cd "$pkg"
exec node_modules/.bin/vitest run --changed "$base"
