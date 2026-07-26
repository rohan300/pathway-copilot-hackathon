#!/bin/bash
# GLD-16 measurement harness, step 1: run the nine demo letters through
# /api/extract once and cache each extraction under /tmp.
#
# The PDFs are patient documents and never enter git — this reads them from the
# read-only uploads directory and writes only to /tmp. Re-running is cheap
# because a cached extraction is never re-extracted.
#
# Usage: npm run dev, then bash scripts/gld16/extract-letters.sh
# Set GLD16_PORT when the dev server being measured is not on the default port.
set -u
U="${GLD16_UPLOADS:-/Users/rohan/.guildly/uploads}"
OUT="${GLD16_CACHE:-/tmp/gld16-extractions}"
PORT="${GLD16_PORT:-3000}"
mkdir -p "$OUT"
for pair in rE7WjRfmXMA5:0105 URJwSIwyQqGm:imp_0203 ctUmVFywSqrz:imp_2002 qNG-QtkVvZal:referral_2001 -nN6ZA8OaWNm:resp_1205 gPGxphxZWT76:resp_2005 ObFkK02jUzfE:resp_2306 xxdmStvXWCWo:simon_0602 voviODICwrDF:simon_1201; do
  id="${pair%%:*}"; name="${pair##*:}"
  [ -s "$OUT/$name.json" ] && { echo "cached $name"; continue; }
  echo "extracting $name ($id)..."
  curl -s -X POST "http://localhost:$PORT/api/extract" \
    -F "file=@$U/$id.pdf;type=application/pdf" > "$OUT/$name.json"
  head -c 120 "$OUT/$name.json"; echo
done
