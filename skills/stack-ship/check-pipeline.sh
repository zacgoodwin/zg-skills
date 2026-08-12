#!/usr/bin/env bash
# Gate test: quality-pipeline wiring for /stack-ship (stax + roborev +
# z-adversarial-review). Deterministic, <2s. Only network-ish call is roborev
# against the local daemon. Run from the repo you intend to ship, resolving
# the repo-local install first and $HOME as fallback:
#   PACK=".claude/skills/stack-ship"; [ -d "$PACK" ] || PACK="$HOME/.claude/skills/stack-ship"
#   bash "$PACK/check-pipeline.sh"
# Project-policy checks (e.g. pinning .roborev.toml agent/model) belong in the
# project's own gate, not here.
set -u
fail=0
ok()   { printf 'OK    %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; fail=1; }

# bun is z-adversarial-review's runtime.
for c in st roborev bun jq gh git; do
  command -v "$c" >/dev/null 2>&1 && ok "$c on PATH" || bad "$c missing from PATH"
done

gh extension list 2>/dev/null | grep -q gh-stack \
  && ok "gh-stack extension" || bad "gh-stack extension -> gh extension install github/gh-stack"

# --git-path resolves through linked worktrees (.git is a file there) to the
# shared hooks dir; a hardcoded .git/hooks breaks in every st worktree lane.
hook="$(git rev-parse --git-path hooks)/post-commit"
[ -f "$hook" ] && grep -q roborev "$hook" \
  && ok "roborev post-commit hook" || bad "roborev hook -> roborev init"

if command -v roborev >/dev/null 2>&1; then
  # No separate daemon-status check: any roborev CLI call auto-starts a
  # stopped daemon (v0.64 behavior), so "daemon down" self-heals right here;
  # if the daemon is genuinely unstartable, `roborev list` fails and the
  # jq -e below turns empty stdin into a red gate (exit 4). One round-trip
  # keeps the gate inside its <2s budget.
  # The /stack-ship gate keys on this schema; drift must fail here, not there.
  # -e is load-bearing: it exits 4 on empty input and 1 on null/false, so a
  # dead daemon or null payload fails closed. Do not drop it.
  # Only done jobs carry a P/F verdict; queued/running/canceled ones sit in
  # --open with verdict:null (normal for ~1min after every commit), so the
  # schema assertion applies to completed jobs only.
  # roborev emits null (not []) when the branch has no jobs; a dead daemon
  # yields empty stdin which jq -e exits 4 on, so null-as-empty stays closed.
  # Status values are whitelisted too: a renamed status (e.g. "completed")
  # would otherwise slip an F verdict past the done-only filter.
  roborev list --json --open 2>/dev/null \
    | jq -e '(. // []) | type=="array"
        and all(.[]; .status=="queued" or .status=="running" or .status=="done"
                     or .status=="failed" or .status=="canceled")
        and all(.[] | select(.status=="done"); .verdict=="P" or .verdict=="F")
        and all(.[] | select(.status!="done"); .verdict==null)' >/dev/null \
    && ok "roborev list schema (status + done-verdict P/F)" || bad "roborev list failed (daemon down? -> roborev daemon start) or schema changed"
fi

# Skills resolve from the project first, then the user dir; accept either.
skill_present() { # name
  [ -f ".claude/skills/$1/SKILL.md" ] || [ -f "$HOME/.claude/skills/$1/SKILL.md" ]
}
skill_present stack-ship \
  && ok "stack-ship skill" || bad "stack-ship skill -> npx skills add zacgoodwin/zg-skills --skill stack-ship"
skill_present z-adversarial-review \
  && ok "z-adversarial-review skill" || bad "z-adversarial-review skill -> npx skills add zacgoodwin/zg-skills --skill z-adversarial-review && (cd ~/.claude/skills/z-adversarial-review && bun install)"

# st validate is metadata-only (local, fast); full `st doctor` does network
# checks and belongs in troubleshooting, not the pre-commit gate.
if command -v st >/dev/null 2>&1; then
  st validate >/dev/null 2>&1 && ok "st stack metadata" || bad "st metadata -> st fix (or st doctor)"
fi

exit $fail
