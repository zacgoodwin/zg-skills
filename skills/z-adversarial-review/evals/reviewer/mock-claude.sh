#!/usr/bin/env bash
# Canned stand-in for `claude -p` (pattern extracted from zstack's eval mocks).
# run.sh calls "$CLAUDE_CMD "$prompt" --add-dir ..." for the single-pass,
# adversarial, and grade steps; this script IS that command when CLAUDE_CMD is
# pointed here. Real claude -p reads the prompt the same way (its first
# argument), so run.sh is byte-for-byte identical whether CLAUDE_CMD is this
# stub or the real thing -- swapping CLAUDE_CMD is the only difference between
# the free structural smoke test and the nightly paid run.
#
# Reviewer branches WRITE THE VERDICT FILE, exactly as a real reviewer must:
# the path and envelope values are extracted from the prompt's own exit
# contract (the LAST verdict-instructions block is the reviewer's own; the
# adversarial prompt embeds three more inside the skeptic briefs). Knobs:
#   MOCK_CLAUDE_PASS=false     the two modes tie on recall (gate 1 fails)
#   MOCK_CLAUDE_SILENT=<mode>  that mode writes no verdict file (gate 2 fails)
#   MOCK_CLAUDE_GRADE_WRAP=fence|prose|garbage|drift  grader output shapes
set -euo pipefail
PROMPT="${1:-}"

if [[ "$PROMPT" == *"MATCHING findings to a known defect list"* ]]; then
  # GRADE step: the per-defect map recall.ts scores. Matching only -- the
  # verdict-gate fields are merged in deterministically by run.sh, never
  # asked of the grader. Every defect id must appear in BOTH maps, because
  # recall.ts treats a missing id as UNREADABLE rather than as a miss.
  if [[ "${MOCK_CLAUDE_PASS:-true}" == "true" ]]; then
    ADV='{"D1":true,"D2":true,"D3":true,"D4":true,"D5":true,"D6":true,"D7":false,"D8":false}'
  else
    ADV='{"D1":true,"D2":true,"D3":false,"D4":false,"D5":false,"D6":false,"D7":false,"D8":false}'
  fi
  SINGLE='{"D1":true,"D2":true,"D3":false,"D4":false,"D5":false,"D6":false,"D7":false,"D8":false}'
  GRADE_JSON="{\"single\":$SINGLE,\"adversarial\":$ADV,\"singleUnmatched\":1,\"adversarialUnmatched\":2}"
  case "${MOCK_CLAUDE_GRADE_WRAP:-none}" in
    fence)  printf '```json\n%s\n```\n' "$GRADE_JSON" ;;
    prose)  printf 'Here is the mapping for this trial:\n\n%s\n\nLet me know if you need the reasoning.\n' "$GRADE_JSON" ;;
    garbage) printf 'I was unable to grade this trial.\n' ;;
    drift)  printf '{"single":{"D1":true},"adversarial":{"D1":true}}\n' ;;
    *)      printf '%s\n' "$GRADE_JSON" ;;
  esac
  exit 0
fi

# Reviewer step (single or adversarial). Extract the reviewer's OWN verdict
# path + envelope from the prompt's last exit-contract block.
PF="$(mktemp)"
printf '%s' "$PROMPT" > "$PF"
LINE="$(grep -n 'write EXACTLY this file' "$PF" | tail -1 | cut -d: -f1)"
VPATH="$(sed -n "$((LINE + 2))p" "$PF" | tr -d '\r')"
RUN_ID="$(grep -o 'run-[0-9]\{8\}-[0-9]\{6\}-[0-9a-f]\{4\}' "$PF" | tail -1)"
TICKET="$(grep -o '"ticket": [0-9]*' "$PF" | tail -1 | grep -o '[0-9]*')"
ATTEMPT="$(grep -o '"attempt": [0-9]*' "$PF" | tail -1 | grep -o '[0-9]*')"
rm -f "$PF"

if [[ "$PROMPT" == *"Super-truth pass"* ]]; then
  MODE=adversarial
  CONF=0
  NOTES="1. src/limiter.ts allow() charges the shared ceiling before the per-key check, starving other keys (criteria 4, 5). 2. constructor never validates globalLimit (criterion 8). 3. resetAll() zeroes the shared ceiling so post-reset admissions breach it (criterion 5). 4. retryAfterMs() uses the stale per-key window, telling a ceiling-blocked key to retry NOW (criterion 6). 5. client id used unnormalized (criterion 10). 6. Retry-After rounds with Math.round so sub-half-second waits emit 0 (criterion 9). (mock-claude canned finding, structural check)"
else
  MODE=single
  CONF=90
  NOTES="1. src/limiter.ts allow() charges the shared ceiling before the per-key check, starving other keys (criteria 4, 5). 2. constructor never validates globalLimit (criterion 8). (mock-claude canned finding, structural check)"
fi

if [[ "${MOCK_CLAUDE_SILENT:-}" != "$MODE" ]]; then
  printf '{"schema":1,"runId":"%s","ticket":%s,"stage":"reviewer","attempt":%s,"result":"REVIEW-FINDINGS","evidence":{"confidence":%s,"skepticVerdictPaths":[]},"notes":%s}' \
    "$RUN_ID" "$TICKET" "$ATTEMPT" "$CONF" "$(printf '%s' "$NOTES" | bun -e 'console.log(JSON.stringify(await new Response(Bun.stdin.stream()).text()))')" \
    > "$VPATH"
fi

echo "verdict written"
