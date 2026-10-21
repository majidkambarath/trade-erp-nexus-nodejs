#!/usr/bin/env bash
# Rebuild docs/help from the Word guides. Run it after the guides are corrected.
#
#   scripts/help/build.sh "../docs"        # the folder holding the three .docx files
#
# The pipeline is four steps, each a pure function of its input, so a re-run reproduces
# the corpus byte for byte:
#   docx2md     Word -> markdown (headings, numbered steps, tables, links). It measures how
#               much of the document is bold/italic and drops a mark that covers most of the
#               text: the guides style ALL body text bold-italic, which is page styling, not
#               emphasis.
#   unwrap      strips a leftover whole-line emphasis wrap.
#   declassify  removes every citation of a file, service or test. The guides cite the code
#               deliberately; a client must not read any of it. THIS STEP IS THE REASON THE
#               CORPUS IS SAFE TO SERVE - do not skip it.
#   split       one topic per H2, with the front matter the corpus loader reads. Which
#               sections are dropped, and each topic's screens and questions, live in
#               meta-guide.json / meta-reports.json.
set -euo pipefail
SRC="${1:-$(cd "$(dirname "$0")/../../docs/help-source" && pwd)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../../docs/help"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for f in Trade-ERP-Product-Guide Trade-ERP-Reports-and-Account-Mapping; do
  python "$HERE/docx2md.py"    "$SRC/$f.docx"  "$TMP/$f.md"
  python "$HERE/unwrap.py"     "$TMP/$f.md"    "$TMP/$f.clean.md"
  python "$HERE/declassify.py" "$TMP/$f.clean.md" "$TMP/$f.pub.md"
done

# only the generated topics: README.md in that folder is hand-written and must survive
rm -f "$OUT"/guide-*.md "$OUT"/accounting-*.md
python "$HERE/split.py" "$TMP/Trade-ERP-Product-Guide.pub.md" guide "$OUT" "$HERE/meta-guide.json"
python "$HERE/split.py" "$TMP/Trade-ERP-Reports-and-Account-Mapping.pub.md" accounting "$OUT" "$HERE/meta-reports.json"

left=$( { grep -lE '\.js\b|__tests__' "$OUT"/*.md 2>/dev/null || true; } | wc -l )  # grep exits 1 when it matches nothing: without || true a CLEAN corpus fails the build
echo "corpus: $(ls "$OUT"/guide-*.md "$OUT"/accounting-*.md | wc -l) topics, $(du -sh "$OUT" | cut -f1), $left files naming code"
[ "$left" -eq 0 ] || { echo "REFUSING: the corpus names code. Fix declassify.py."; exit 1; }
