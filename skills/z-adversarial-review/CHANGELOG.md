# Changelog

All notable changes to the `z-adversarial-review` skill are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- A review seat could write into the main checkout, undetected. On SCP PR #4
  an empty, untracked `VERSION` appeared at the repo root mid-review; agy and
  the Claude seats can write anywhere, and the worktree sits two directories
  below the main checkout. `prepare` now snapshots the main checkout (HEAD,
  plus every dirty or untracked path with its status and a content hash,
  excluding `.worktrees/` and an in-repo `--out-dir`) into the run root, and
  `collect` fails the review, naming each path, when anything there changed
  or the snapshot is missing. Because the worktree shares the main repo's
  `.git`, the snapshot also covers every local ref (branches, tags, stash; not remote-tracking refs, which a background fetch moves), the
  config, every file in `info/`, the hooks dir, and which branch HEAD points at: the PR's own adversarial review
  showed a seat could plant a pre-commit hook from inside its worktree.
  Gitignored files (`../../debug.log`, `node_modules/`) are covered by size
  and mtime, and a submodule or nested repo (untracked or ignored) by a digest over its files.
  Seat briefs
  no longer say the review cannot land anywhere: they name the repo two
  directories up and say any write there fails the review.

- codex skeptic verdicts now count on Windows. codex runs its tools as a
  separate sandbox account (`CodexSandboxOffline`) with no ACL on the run
  directory under the user's Temp, so the old
  `sandbox_workspace_write.writable_roots` grant was accepted at startup but
  every verdict write failed with "Access ... is denied". codex then wrote the
  file wherever it could, and the quorum never counted it. A codex seat's brief
  now names a drop dir inside the review worktree (`.z-review-<uuid>`, a fresh
  path verified absent), which the sandbox can always write. The composed
  command creates it with plain `mkdir` (a vanished worktree aborts before
  codex starts instead of being re-created empty), moves the verdict to the
  canonical `skeptic-<k>/verdict.json`, removes the drop dir with `rm -rf`,
  and keeps codex's exit status; a successful run with no verdict, or a move
  that fails, exits nonzero. The path-trust rule is unchanged.
- A CLI skeptic that runs long now still leaves a verdict. agy routinely took
  6-10 minutes on a large diff against its `--print-timeout` and was cut off
  with nothing written, because the verdict file is a skeptic's last act. CLI
  seat briefs now carry a cut-off rule: write a complete verdict within the
  first 4 minutes with result `CONFUSED` and notes starting `PROVISIONAL: `,
  overwrite it as the review goes, and finalize it at the end. Every write goes
  to `verdict.json.tmp` and is renamed over `verdict.json`, so a cut-off
  mid-write keeps the last complete file. Agent-seat briefs are unchanged.
- codex, which has no timeout flag, is cut off inside its own command at the
  same `570s` (GNU `timeout` rejects `9m30s` with exit 125): GNU `timeout`,
  else `gtimeout` (Homebrew), else a bash watchdog. Both send TERM, then KILL
  10s later; the job runs in its own process group (`set -m`) and the whole
  group is killed once it returns, so no child codex spawned outlives the
  command holding the Bash tool's output pipe. Any cut-off reports exit 124.
- `readVerdict` rejects a non-string `notes` as INVALID (it used to crash
  `quorumFromDisk` with a TypeError); `null` notes read as absent.

### Changed

- `collect` computes adversarial confidence instead of trusting the
  reviewer's: with at least one valid skeptic verdict on disk it is
  `round(unrefuted / received × 100)` for every result, which reproduces the
  reviewer's lookup table, and the reviewer's own number is ignored. With no
  skeptic verdicts, the reviewer's own number stands but is capped at 99.
- A provisional `UPHELD` (notes starting `PROVISIONAL: `) no longer counts as
  unrefuted in the quorum, and the reviewer is told to count only
  non-provisional `UPHELD` verdicts.

## [1.4.1] - 2026-08-12

### Fixed

- `collect` no longer trusts the reviewer's self-reported
  `evidence.skepticVerdictPaths` to decide which skeptic verdicts to count.
  It now derives the three canonical `skeptic-<1,2,3>/verdict.json` paths
  itself from `--run-root`/`--ticket` (the same layout `prepare` wrote), so
  a reviewer that omits or under-lists that field can no longer make a
  disagreeing or unread skeptic verdict disappear from the quorum. `collect`
  now requires `--adversarial <true|false>` (the manifest's own field) to
  gate whether a quorum is counted at all.
- Two concurrent reviews of the same PR (or a crashed run's leftover) no
  longer share a worktree path. `prepare` now mints the run identity before
  creating the worktree and names it `review-pr-<N>-<runId>`, so one run's
  `cleanup` can never remove another run's still-active checkout.
- SKILL.md and docs now resolve the skill's own directory repo-local first
  (`.claude/skills/z-adversarial-review`), falling back to
  `$HOME/.claude/skills/z-adversarial-review` only when no repo-local copy
  exists — a vendored, version-pinned copy in a project repo no longer gets
  silently shadowed by whatever happens to be installed globally.

## [1.4.0] - 2026-08-12

### Added

- A first-run skeptic-fleet chooser. The first time a user runs
  `/z-adversarial-review`, Step 0 asks (AskUserQuestion) which outside CLIs —
  `codex`, `agy`, both, or Claude-only — should staff the three skeptic
  seats, validates the pick with `setup --providers`, and saves it so every
  later review reuses it silently.
- `lib/models.ts preference` — get/set the saved per-user skeptic-seat lineup
  backing that chooser (`~/.claude/z-adversarial-review/skeptic-preference.json`).
  `prepare` now falls back to it whenever `--skeptic-models` is omitted
  entirely (an explicit `'[]'` still means all-Claude for that one run).
- `setup --providers <csv>` — scope the validation table to a chosen subset
  instead of the whole fleet.

## [1.3.0] - 2026-08-12

### Removed

- The `gemini` skeptic provider. The cross-provider fleet is now `codex` and
  `agy` (Antigravity, which fronts Gemini models — `agy:gemini-3-pro` still
  seats one). `gemini` / `gemini:<model>` seat tokens are now an unknown-token
  error, and the `setup` table drops its row.

## [1.2.0] - 2026-08-12

Moved into the `zg-skills` monorepo at `skills/z-adversarial-review`. Carries
forward the full commit history of the standalone
[z-adversarial-review](https://github.com/zacgoodwin/z-adversarial-review)
repo (now archived). Version number carried over unchanged from
`package.json` at the time of the move; see the archived repo's history for
everything before this point.
