#!/usr/bin/env bash
# Parameterized stand-in for a cross-provider skeptic CLI (codex | gemini |
# agy), the provider-side sibling of mock-claude.sh. The real adapters feed
# the brief to codex/gemini on STDIN and to agy as the -p ARGUMENT; this mock
# mirrors that per-provider input mode, extracts the verdict path + envelope
# from the brief's own exit contract, and writes the skeptic verdict file --
# proving the contract's provider-neutrality end to end: any process that
# writes a well-addressed verdict.json counts, zero changes to verdict code.
set -euo pipefail
PROVIDER="${1:?usage: mock-provider.sh <codex|gemini|agy> [brief-when-agy]}"
case "$PROVIDER" in
  agy) BRIEF="${2:?the agy mock takes the brief as argument 2 (mirroring agy -p)}" ;;
  codex|gemini) BRIEF="$(cat)" ;;
  *) echo "unknown provider \"$PROVIDER\" (codex|gemini|agy)" >&2; exit 2 ;;
esac

# Same extraction technique as mock-claude.sh: the path is the line two below
# "write EXACTLY this file", the envelope values are greppable in the contract.
PF="$(mktemp)"
printf '%s' "$BRIEF" > "$PF"
LINE="$(grep -n 'write EXACTLY this file' "$PF" | tail -1 | cut -d: -f1)"
VPATH="$(sed -n "$((LINE + 2))p" "$PF" | tr -d '\r')"
RUN_ID="$(grep -o 'run-[0-9]\{8\}-[0-9]\{6\}-[0-9a-f]\{4\}' "$PF" | tail -1)"
TICKET="$(grep -o '"ticket": [0-9]*' "$PF" | tail -1 | grep -o '[0-9]*')"
ATTEMPT="$(grep -o '"attempt": [0-9]*' "$PF" | tail -1 | grep -o '[0-9]*')"
rm -f "$PF"

printf '{"schema":1,"runId":"%s","ticket":%s,"stage":"skeptic","attempt":%s,"result":"UPHELD","evidence":{"lens":"refutation","claimChecked":"mock-provider %s structural check"},"notes":"mock %s skeptic: structural smoke only, nothing actually attacked"}\n' \
  "$RUN_ID" "$TICKET" "$ATTEMPT" "$PROVIDER" "$PROVIDER" > "$VPATH"

echo "verdict written"
