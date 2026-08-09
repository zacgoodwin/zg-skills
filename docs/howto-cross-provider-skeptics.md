# How to run skeptic seats on other vendors' CLIs

Put one or more skeptic seats on OpenAI's `codex`, Google's `gemini`, or
Antigravity's `agy` instead of Claude, so the three refutation attempts do
not all share one model's blind spots. End result: a review whose quorum
mixes providers, with each CLI seat's verdict counted off disk exactly like
a Claude seat's.

## Prerequisites

- A working z-adversarial-review install (see the
  [tutorial](tutorial-first-review.md) if you have never run a review).
- The CLI for each provider you want, installed and authenticated:
  - `codex` — `npm install -g @openai/codex`, then `codex login`
  - `gemini` — `npm install -g @google/gemini-cli`, then run `gemini` once
    interactively to sign in (or set `GEMINI_API_KEY`)
  - `agy` — install Google Antigravity (https://antigravity.google), then
    run `agy` once interactively to sign in

You only need the providers you plan to seat. The reviewer seat itself is
Claude-only; CLI tokens there are rejected by design.

## Steps

1. Validate the fleet before a review depends on it:

   ```bash
   bin/z-adversarial-review setup --repo .
   ```

   One row per provider: binary (+ version), auth, folder trust. Exit 0
   means all green. A `MISSING` row names its own fix — the install command,
   the sign-in step, or "restart the terminal so the PATH change lands".

2. If the codex row shows `trust: missing`, write the trust entry:

   ```bash
   bin/z-adversarial-review setup --repo . --trust
   ```

   This appends `[projects."<repo-root>"] trust_level = "trusted"` to
   `~/.codex/config.toml`, idempotently, and prints exactly what it changed.
   gemini and agy need no persisted trust — their adapters bypass per run.

3. (Optional) Prove auth end-to-end with one paid micro-call per provider:

   ```bash
   bin/z-adversarial-review setup --repo . --probe
   ```

4. Run the review with the lineup you want. From the skill, say it in words
   — "review PR 123 with skeptics on codex, gemini, agy" — or pass the flag
   yourself:

   ```bash
   bin/z-adversarial-review prepare --pr-json pr.json --repo . --out-dir "$TMP" \
     --skeptic-models '["codex","gemini","agy"]'
   ```

   Token grammar: `codex[:<model>]`, `gemini[:<model>]`, `agy[:<model>]`
   (alias `antigravity`), or the Agent tokens
   `inherit|haiku|sonnet|opus|fable`. Fewer than three tokens gap-fill with
   `inherit` — `'["codex"]'` puts codex in seat 1 and leaves seats 2–3 on
   Claude. A `:<model>` suffix pins the provider's model
   (e.g. `codex:o4-mini`); its charset is restricted to `[A-Za-z0-9._/-]`
   because it is spliced into a shell command.

## Verification

The manifest `prepare` prints shows the resolved lineup:

```json
"skepticModels": ["codex", "gemini", "agy"]
```

and the final report's Mode line repeats it. After `collect`, a healthy
cross-provider run shows `quorum: {"received": 3, "of": 3, …}` — the verdict
contract is provider-neutral, so any process that wrote a well-addressed
`verdict.json` counted.

## How a CLI seat actually runs

`prepare` writes each CLI seat's brief to a file
(`…/skeptic-<k>/brief.txt`) and composes one exact command per provider —
in code, never improvised by the reviewer, which runs it foreground via its
Bash tool with a raised timeout. The command runs from inside the throwaway
worktree; the seat's verdict directory (and, for gemini/agy, the blinded
input's directory — their sandboxes restrict reads, codex's only writes) is
granted explicitly. A CLI seat that dies or times out has written no
verdict file: that reports honestly as a short quorum, never impersonated.

## Troubleshooting

- **`Skeptic provider "X" failed preflight`** from `prepare` — the binary is
  missing or broken. The message carries the fix; `prepare` fail-fasts
  before creating any worktree, so nothing needs cleanup.
- **Installed it this session but still "not found on PATH"** — the session's
  PATH predates the install. Restart the terminal/session; `setup` detects
  the agy variant of this and says so.
- **codex seat dies immediately** — check `setup`'s trust column; without
  the `config.toml` entry codex refuses the folder. Run `setup --trust`.
- **A seat ran but the quorum shows it in `invalid`** — the reason string
  says why (mis-addressed envelope, placeholder, outside the run subtree).
  That seat's verdict is discarded by design, never reinterpreted; see the
  [verdict schema](reference-cli.md#the-verdict-file-schema).
- **Security note**: CLI skeptics execute the PR author's code with their
  vendor's permission prompts skipped, sandboxed to the throwaway worktree —
  the same exposure the Claude reviewer accepts by running the PR's tests.
  Don't review code you would not execute.

## Related

- [CLI reference — `setup` and seat tokens](reference-cli.md#setup)
- [Explanation — why independent skeptics at all](explanation-design.md#skeptics-one-reader-agrees-with-itself)
