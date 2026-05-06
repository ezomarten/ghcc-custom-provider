#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

run_step() {
  printf '\n%s\n' "==> $*"
  "$@"
}

cd "$script_dir"

run_step npm ci --ignore-scripts
run_step npm audit --audit-level=moderate
run_step npm run check
run_step npm run build
run_step npm run package
run_step npx vsce ls --tree

mkdir -p build

shopt -s nullglob
vsix_files=( *.vsix )
if ((${#vsix_files[@]} == 0)); then
  printf '%s\n' 'No .vsix files were created.' >&2
  exit 1
fi

printf '\n%s\n' '==> Move .vsix files to build/'
mv -f -- "${vsix_files[@]}" build/

printf '\n%s\n' 'all done!'