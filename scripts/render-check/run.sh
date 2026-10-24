#!/usr/bin/env bash
# Renders the real Program tab and coach view components at HEAD (or another ref)
# and in the working tree, and compares them. See README.md.
#
#   scripts/render-check/run.sh            # HEAD vs working tree
#   scripts/render-check/run.sh <ref>      # <ref> vs working tree
#
# Exits non-zero if the structure fixtures differ, an exercise name is missing,
# a screen throws, or the rest text disagrees with the web's src/lib/rest.ts.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
REF="${1:-HEAD}"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/render-check.XXXXXX")"
fail=0

mkdir -p "$OUT/base" "$OUT/new"
git -C "$REPO" archive "$REF" app lib components | tar -x -C "$OUT/base" || { echo "cannot snapshot $REF"; exit 1; }
(cd "$REPO" && cp -R app lib components "$OUT/new/")

node "$HERE/gen.cjs" "$OUT" || exit 1

for tree in base new; do
  for fx in structure structure-rest rest; do
    node "$HERE/harness.cjs" "$OUT/$tree" "$OUT/$fx.json" > "$OUT/out-$tree-$fx.txt" 2> "$OUT/err-$tree-$fx.txt"
    code=$?
    if [ $code -ne 0 ]; then echo "FAIL harness $tree/$fx exited $code"; cat "$OUT/err-$tree-$fx.txt"; fail=1; fi
  done
done
echo "$(head -1 "$OUT/err-new-structure.txt")"

echo
echo "== 1. Structure, no rest fields: $REF vs working tree"
if cmp -s "$OUT/out-base-structure.txt" "$OUT/out-new-structure.txt"; then
  echo "IDENTICAL ($(wc -l < "$OUT/out-new-structure.txt" | tr -d ' ') lines, $(shasum "$OUT/out-new-structure.txt" | cut -c1-12))"
else
  echo "DIFFERS:"; diff "$OUT/out-base-structure.txt" "$OUT/out-new-structure.txt"; fail=1
fi

echo
echo "== 2. Structure with a rest on every exercise: $REF vs working tree"
if cmp -s "$OUT/out-base-structure-rest.txt" "$OUT/out-new-structure-rest.txt"; then
  echo "IDENTICAL"
else
  echo "DIFFERS (expected only when the build changes how rest prints):"
  diff "$OUT/out-base-structure-rest.txt" "$OUT/out-new-structure-rest.txt" | grep '^[<>]' | sort | uniq -c
  fail=1
fi

echo
echo "== 3. Screens that threw"
if grep -l THREW "$OUT"/out-new-*.txt >/dev/null 2>&1; then
  grep -H THREW "$OUT"/out-new-*.txt; fail=1
else
  echo "none in the working tree ($(grep -h THREW "$OUT"/out-base-*.txt | wc -l | tr -d ' ') at $REF)"
fi

echo
echo "== 4. Rest text vs the web's src/lib/rest.ts (working tree)"
node "$HERE/check-rest.cjs" "$OUT" > "$OUT/check-rest.txt"
code=$?
grep -E '^(BAD|THREW)' "$OUT/check-rest.txt"
tail -1 "$OUT/check-rest.txt"
[ $code -ne 0 ] && fail=1

echo
echo "Full output: $OUT"
[ $fail -eq 0 ] && echo "RENDER CHECK: CLEAN" || echo "RENDER CHECK: FAILED"
exit $fail
