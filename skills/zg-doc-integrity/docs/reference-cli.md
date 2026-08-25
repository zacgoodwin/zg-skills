# CLI reference

Every verb is `bun lib/run.ts <verb>`, or `bin/zg-doc-integrity <verb>`, which
dispatches `setup` and `preference` to `lib/providers.ts` and everything else to
`lib/run.ts`. All output is JSON on stdout except the setup table.

`--run <dir>` defaults to the newest run under `.doc-integrity/runs/`, so the
common case needs no argument.

---

## `prepare <path-or-glob>... [--repo <dir>] [--providers '<json>']`

Loads the documents, tags regions, writes the throwaway bundle directory, builds
the four inventories, plans the shards, runs the structure lens, and writes
every discovery brief.

Argument order assigns document ids (`D1`, `D2`, …) and orders each finding's
options. Globs expand in sorted order. A glob that sweeps up an unsupported
extension skips it silently; a named file with one is an error.

`--providers` takes a JSON array of provider tokens (`["codex","agy"]`).
Omitted, it reads the saved preference. An unavailable provider fails preflight
before anything is written to disk.

Fails when the bundle exceeds 25,000 lines.

**Prints:** `runId`, `runRoot`, `bundleDir`, `documents`, `totalLines`,
`spawns[]`, `structureFindings`, `inventory`, `skipped[]`, `nextCommand`.

Each spawn is `{seat, kind, stub, briefPath, outPath, claimsPath?, command?}`. A
`command` means run that string through Bash; otherwise pass the `stub` to the
Agent tool. The stub is a short pointer — the seat reads its own brief off disk,
so the material under review never enters the orchestrator's context.

---

## `merge [--run <dir>]`

Gathers what the discovery seats wrote, resolves quotes to citations, drops
ungrounded findings, merges duplicates across seats, and dispatches what comes
next.

**Call it twice.** The first call returns a `reduceSpawn` — the cross-shard pass
over the claim ledgers. Run it, then call `merge` again to get `refuteSpawns`.

Refutation is capped at the top 15 findings by `severity × (100 − base)`, so
adversaries go where the stakes are highest and the discovery evidence thinnest.
Everything below the cap is marked `unrefuted` in the plan.

**Prints:** `findings`, `unverifiable`, `seatsHeardFrom[]`, `seatsSilent[]`,
`reduceSpawn`, `refuteSpawns[]`, `skipped[]`, `nextCommand`.

`seatsSilent` is a seat that wrote no file at all — different from one that
reported nothing, and reported as such.

---

## `collect [--run <dir>]`

Counts the refutation quorum off the verdict files on disk, scores confidence,
and writes the plan.

**Prints:** `planMd`, `planJson`, `counts`, `skipped[]`, `nextCommand`.

`plan.md` is the file a human edits. `plan.json` is the machine truth; the
parser takes finding bodies from the JSON and only the tick and the comment from
the markdown.

---

## `continue [--run <dir>]`

Reads the edited plan and does what it says. Exit 1 on `BLOCKED`.

| `action` | Meaning | What to do |
|---|---|---|
| `NOT-REVIEWED` | untouched | point the user at `plan.md` |
| `BLOCKED` | ambiguous, incomplete, or two findings editing one line | relay `reasons` verbatim |
| `REGENERATE` | a comment was left | run `regenSpawns`, then `merge` |
| `APPLY` | complete | run `applySpawns`, then `verify` |
| `NOTHING-TO-DO` | no findings, or all declined | say so |

On `APPLY` it snapshots every target file before returning. On `REGENERATE` it
advances the round, carries settled answers forward keyed by fingerprint, and
lists any answer dropped because its options changed (`reopened`). Round 5 is
the cap; past it, `continue` blocks rather than looping.

Decisions are recorded either way, so a "change nothing" survives into later
rounds.

---

## `verify [--run <dir>]`

Diffs each edited file against its snapshot. Exit 1 when anything failed.

**Prints:** `ok`, `files[]` with `applied`, `notApplied`, and `blast`, plus
`restoreHints[]`.

`blast` is any change outside an approved edit site, with one line of slack for
a rewrap. An apply agent that also improved something fails here.

---

## `setup [--repo <dir>] [--trust] [--probe] [--providers <csv>]`

Validates the cross-provider fleet: binary on PATH and `--version`, auth, folder
trust. One row per provider; exit 0 all-green else 1.

- `--trust` writes the codex `config.toml` trust entry for the repo root.
  Idempotent, prints exactly what it changed. agy needs none — it bypasses per
  run.
- `--probe` makes one live micro-call per CLI. The only paid check.
- `--providers codex,agy` scopes the table.

---

## `preference [--set '<json>']`

Without `--set`, prints `{exists, providers, source}`. A `source` of `"sibling"`
means the choice was read from an existing `z-adversarial-review` preference
rather than chosen here — treat it as answered.

With `--set`, validates and persists to
`~/.claude/zg-doc-integrity/provider-preference.json`. Global to the user, since
a CLI login is a per-machine fact.

---

## Run directory layout

```
.doc-integrity/runs/<runId>/
  state.json                    patterns, round, documents
  decisions.json                the ledger: declined and resolved, by fingerprint
  bundle/                       flat copies of the documents + manifest.json
  snapshots/                    originals, taken before the first edit
  r1/
    structure.json              findings the structure lens produced with no model
    merged.json                 resolved and deduped findings
    plan.md                     the file you edit
    plan.json                   the machine truth
    work-units.json             edits grouped by file, plus snapshot paths
    discover/<seat>/            brief.txt, findings.json, claims.json
    refute/<finding>-<seat>/    brief.txt, verdict.json
    apply/<docId>/              brief.txt
  r2/ ...                       one directory per comment round
```
