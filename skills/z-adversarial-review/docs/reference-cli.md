# CLI reference

The deterministic core behind the `/z-adversarial-review` skill, callable
directly. One entry script, `bin/z-adversarial-review`, dispatches to two
bun modules: `setup` goes to `lib/models.ts`, everything else to
`lib/review.ts`. Two more modules (`lib/prompts.ts`, `lib/verdict.ts`) carry
their own debug CLIs, used by the eval harness and hand debugging.

All commands print an actionable one-line message and exit 1 on expected
failures (a `ZError`); anything else is a bug and rethrows with its stack.

- Want the guided end-to-end flow instead? Start with the
  [first-review tutorial](tutorial-first-review.md).
- Want the design rationale for these contracts? See the
  [design explanation](explanation-design.md).

## `prepare`

```bash
bin/z-adversarial-review prepare --pr-json <pr.json> --repo <dir> --out-dir <dir> \
  [--issue-json <issue.json>] \
  [--adversarial-mode <off|non-trivial|always>] \
  [--reviewer-model <inherit|haiku|sonnet|opus|fable>] \
  [--skeptic-models '<json array of 0-3 seat tokens>']
```

Assembles the blinded reviewer input for one PR and prints a JSON manifest.
In order: parses and preflights the seat lineup (fail-fast, before any
filesystem effect), verifies `--repo` is a git checkout, fetches the PR head
and base if either commit is missing locally (`git fetch origin <base>
pull/<N>/head`), writes the merge-base diff, creates the throwaway worktree,
chooses the spec, extracts the acceptance criteria, writes the four-key
input file, mints the run identity, writes CLI-seat briefs (adversarial runs
only), and writes the reviewer prompt.

| Flag | Required | Type / values | Effect |
|---|---|---|---|
| `--pr-json` | yes | path | Output of `gh pr view <N> --json number,title,url,body,headRefOid,baseRefOid,baseRefName,labels,closingIssuesReferences`. A missing field errors with that exact fetch command in the message. |
| `--repo` | yes | path | The git checkout under review. Must contain `.git`. |
| `--out-dir` | yes | path | Where every artifact lands: `input-pr-<N>.json`, `diff-pr-<N>.patch`, `prompt-pr-<N>.txt`, and the `runs/<runId>/` tree. Created if absent. |
| `--issue-json` | no | path | Output of `gh issue view <N> --json body,labels` for the PR's linked closing issue. When present and non-empty, the issue body becomes the spec. |
| `--adversarial-mode` | no | `off` \| `non-trivial` \| `always` (default `non-trivial`) | Whether the skeptic fan-out activates. `non-trivial` fans out on ≥ 10 changed lines or any trigger label (below). |
| `--reviewer-model` | no | `inherit` \| `haiku` \| `sonnet` \| `opus` \| `fable` (default `inherit`) | The reviewer spawn's Agent-tool model. CLI provider tokens are rejected here by name: the reviewer's orchestration prompt is Claude-harness-specific. |
| `--skeptic-models` | no | JSON array of 0–3 seat tokens | Per-seat skeptic lineup. Fewer than 3 tokens gap-fill with `inherit`; absent or `[]` means all-Claude, byte-identical to the pre-feature prompt. More than 3 tokens is an error. |

### Seat tokens

```
inherit | haiku | sonnet | opus | fable          # Agent tool, any seat
codex[:<model>] | gemini[:<model>] | agy[:<model>]   # CLI providers, skeptic seats only
```

`antigravity` is an accepted alias for `agy` (normalized in the manifest).
A `:<model>` suffix must be non-empty and match `^[A-Za-z0-9._/-]+$` — the
charset is an injection boundary (the suffix is spliced into a shell
command), not a vendor catalog; an unknown-but-well-formed model is the
provider's own error to raise. Every distinct requested CLI provider is
preflighted (binary on PATH + `--version`) before `prepare` touches the
filesystem; a miss errors with the install fix, including the
stale-session case (installed this session but PATH predates it).

### Diff generation

Three-dot merge-base diff (`base...head`) with lockfiles excluded:
`*.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`
(`DIFF_LOCKFILE_EXCLUDES` in `lib/review.ts`). A lockfile-only PR falls
back to the unfiltered diff so the reviewer is never handed an empty one; a
diff that is empty either way is an error — nothing to review.

### Spec selection and acceptance criteria

Preference order (`chooseSpec`):

1. Linked closing issue body — `specSource: "linked issue #N"`.
2. PR description — `specSource: "PR description (author-authored)"`, with a
   provenance note prepended to the spec the reviewer reads.
3. Neither — `specSource: "none"`, spec is a named fallback telling the
   reviewer to judge the diff on its own coherence and report the missing
   spec as a finding.

The acceptance-criteria slice (`extractAcceptanceCriteria`) takes lines
after an `Acceptance Criteria` heading at any level (`#` through `######`)
up to the next heading of any level; a second AC heading re-opens the
section. No AC section found → the input carries `AC_FALLBACK`, which tells
the reviewer to derive the implied contract and report the missing section
as a finding (`acFound: false` in the manifest).

### Adversarial activation

`non-trivial` mode fans out when either holds:

- changed-line count ≥ 10 (`ADVERSARIAL_DIFF_THRESHOLD`; added + removed
  lines, `+++`/`---` file headers excluded), or
- any label in `security`, `migration`, `payments`, `auth`
  (`ADVERSARIAL_TRIGGER_LABELS`) on the PR or its linked issue.

`off` never fans out; `always` always does.

### The worktree

A detached checkout of the PR head at `<repo>/.worktrees/review-pr-<N>` —
under the repo, never a system temp dir (reviewers run real test suites in
it). Self-healing: a leftover worktree from an earlier run of the same PR is
force-removed and re-added, so a crashed review never wedges the next one.

### Manifest fields

| Field | Meaning |
|---|---|
| `pr`, `title`, `url` | PR identity, echoed from `pr.json`. |
| `specSource` | `linked issue #N` \| `PR description (author-authored)` \| `none`. Anything but a linked issue is a caveat the report must repeat. |
| `acFound` | Whether the spec had an `Acceptance Criteria` section. |
| `diffLines` | Changed-line count of the (filtered) diff. |
| `labels` | Deduplicated, sorted union of PR + linked-issue label names. |
| `adversarialMode` | The mode `prepare` ran with. |
| `adversarial` | The computed activation — whether this review fans out skeptics. |
| `reviewerModel` | Resolved reviewer seat token (Agent models only). |
| `skepticModels` | The resolved 3-seat lineup, gap-fills included, alias-normalized (e.g. `["codex","inherit","inherit"]`). |
| `runId` | One-shot run identity: `run-<UTCyyyymmdd-hhmmss>-<4hex>`. Minted fresh per `prepare`, so a re-run can never mis-address the previous attempt's verdict. |
| `runRoot` | `<out-dir>/runs/<runId>` — the root `collect` counts the quorum under. |
| `verdictPath` | Where the reviewer must write `verdict.json`: `<runRoot>/t<pr>/reviewer-1/verdict.json`. |
| `inputPath`, `promptPath`, `diffPath` | The blinded input file, the reviewer prompt, the raw diff. |
| `worktreePath` | Absolute path of the throwaway worktree (pass to `cleanup`). |
| `stub` | The ~400-byte pointer prompt to pass verbatim as the reviewer spawn's prompt. |

The four-key input file (`inputPath`) holds exactly
`{ticketBody, acceptanceCriteria, diff, worktreePath}` — enforced by a
compile-time type identity and a runtime key check
(`assertReviewerInput` in `lib/prompts.ts`). A fifth key throws.

## `collect`

```bash
bin/z-adversarial-review collect --verdict <verdict.json> --run-root <dir> \
  --run <runId> --ticket <n>
```

Validates the reviewer's verdict file against the exact spawn `prepare`
minted (all four values come from the manifest: `verdictPath`, `runRoot`,
`runId`, `pr`) and counts the skeptic quorum off disk. Prints JSON and
exits 0 **both ways** — INVALID is an answer, not an error:

```json
{ "ok": true, "result": "REVIEW-FINDINGS", "notes": "…", "confidence": 67,
  "quorum": { "received": 3, "of": 3, "unrefuted": 2, "invalid": [] } }
```

or `{ "ok": false, "reason": "…" }`.

| Field | Meaning |
|---|---|
| `result` | One of `REVIEW-APPROVE`, `REVIEW-FINDINGS`, `NEEDS-HUMAN`, `BLOCKED`, `CONFUSED`. |
| `notes` | The reviewer's human-facing line: findings list, question, or reason. `""` when absent. |
| `confidence` | 0–100 from the verdict's evidence, or `null` when absent or out of range. On adversarial runs the reviewer reads it off a fixed lookup table over the skeptic verdicts it held (3 UPHELD of 3 → 100, 2 → 67, 1 → 33, 0 → 0; short lineups have their own rows) — never model arithmetic. |
| `quorum` | Counted off the skeptic verdict files on disk; `null` on a single pass (the reviewer listed no skeptic paths). `received` = valid files found, `of` = 3, `unrefuted` = valid verdicts whose result is `UPHELD`, `invalid` = one reason per listed-but-unusable path. |

Quorum path-trust rule: a listed skeptic verdict path must resolve inside
`<runRoot>/t<ticket>/` after normalization. Outside paths (another run's
directory, an invented `/tmp` file, a traversal) and duplicates land in
`invalid` with the reason. The directory is read at collect time, so a
skeptic verdict that landed after the reviewer returned still counts.

`--ticket` must be a positive integer (the PR number).

## `cleanup`

```bash
bin/z-adversarial-review cleanup --repo <dir> --worktree <path>
```

Removes the throwaway worktree and prunes stale registrations. Idempotent:
prints `removed` or `absent`, exit 0 either way. Run it after every review,
including failed ones.

## `setup`

```bash
bin/z-adversarial-review setup [--repo <dir>] [--trust] [--probe]
```

Validates the cross-provider skeptic fleet (`codex`, `gemini`, `agy`): one
row per provider with binary (+ version), auth, and folder-trust status.
Exit 0 all-green, else 1 (scriptable). `--repo` defaults to `.`.

| Check | codex | gemini | agy |
|---|---|---|---|
| Binary | `codex --version` | `gemini --version` | `agy --version` |
| Auth | `codex login status` | credentials file under `~/.gemini` (`oauth_creds.json` or `google_accounts.json`) or `GEMINI_API_KEY` | `agy models` |
| Trust | `[projects."<repo-root>"] trust_level = "trusted"` in `~/.codex/config.toml` | bypassed per run (`--skip-trust`) | bypassed per run (`--dangerously-skip-permissions`) |

- `--trust` — writes the codex trust entry for the repo root. Idempotent
  (existing entry untouched, both TOML string forms recognized), append-only,
  and refuses to touch a config it cannot read. Prints exactly what changed.
- `--probe` — opt-in live micro-call per green provider ("Reply with exactly
  OK"). The only paid check; end-to-end auth proof.

See [how to run skeptic seats on other vendors' CLIs](howto-cross-provider-skeptics.md)
for the workflow around this verb.

## Debug CLIs

### `lib/prompts.ts` — build prompts from files

```bash
bun lib/prompts.ts prompt <input.json> --verdict-path <p> --run <runId> \
  --ticket <n> --attempt <k> [--adversarial-mode <m>] [--labels <json-array>] \
  [--skeptic-dirs <json-array-of-3>]
bun lib/prompts.ts stub <prompt.txt>
```

`prompt` prints the reviewer prompt; activation is computed from the mode,
the input's own diff, and `--labels`. `stub` prints the ~400-byte spawn stub
for an already-written prompt file (errors if the file is unreadable). Used
by `evals/reviewer/run.sh`; production goes through `prepare`, which calls
the same constructors.

### `lib/verdict.ts` — validate one verdict file

```bash
bun lib/verdict.ts check <verdict.json> --run <runId> --ticket <n> \
  --stage <reviewer|skeptic> --attempt <k>
```

Prints `{"ok":true,"verdict":{…}}` or `{"ok":false,"reason":"…"}`; exit 0
both ways (exit 1 is a usage error). This is the same validator `collect`
and the eval's gate 2 use.

## The verdict file schema

Every stage (reviewer and each skeptic) reports by writing one
`verdict.json` into its own artifact directory
(`<out-dir>/runs/<runId>/t<ticket>/<stage>-<attempt>/`, composed only by
`stageDest` in `lib/run-id.ts`):

```json
{
  "schema": 1,
  "runId": "run-20260809-142301-9f3a",
  "ticket": 123,
  "stage": "reviewer",
  "attempt": 1,
  "result": "REVIEW-FINDINGS",
  "evidence": { "confidence": 67, "skepticVerdictPaths": ["…"] },
  "notes": "1. src/limiter.ts:41 …"
}
```

Result unions per stage (`STAGE_RESULTS`):

- `reviewer`: `REVIEW-APPROVE`, `REVIEW-FINDINGS`, `NEEDS-HUMAN`, `BLOCKED`, `CONFUSED`
- `skeptic`: `REFUTED`, `UPHELD`, `CONFUSED`

Evidence shape per stage (validated shallowly, consumed deterministically):
reviewer `{confidence, skepticVerdictPaths}`, skeptic `{lens, claimChecked}`.

A verdict is INVALID — named with a reason, never reinterpreted — when it
is: unreadable, not valid JSON, not an object, the wrong `schema` version,
mis-addressed (any of `runId`/`ticket`/`stage`/`attempt` not matching the
spawn), outside its stage's result union, carrying the contract's own
`<placeholder>` text in `notes`, or carrying a non-object `evidence`.

## Related

- [Tutorial: your first blinded review](tutorial-first-review.md)
- [How-to: cross-provider skeptic seats](howto-cross-provider-skeptics.md)
- [How-to: run the reviewer eval](howto-run-the-eval.md)
- [Explanation: why blinded, why skeptics, why files](explanation-design.md)
