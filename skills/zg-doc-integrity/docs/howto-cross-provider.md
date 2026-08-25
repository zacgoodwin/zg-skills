# How to use codex and Antigravity seats

Outside CLIs do two jobs here: an independent **discovery** pass over the same
candidate clusters Claude reads, and adversarial **refutation** of individual
findings.

The reason to bother is correlated error. Two Claude seats agreeing that a
passage contradicts another is weaker evidence than Claude and codex agreeing,
because two runs of the same model make the same mistakes. The confidence
formula prices this directly: a multi-vendor agreement is worth +10 over a
same-vendor one.

## One-time setup

```bash
bun lib/providers.ts setup --repo . --trust
```

```
provider  binary            auth  trust
codex     ok codex 0.31.0   ok    trusted
agy       ok agy 1.4.2      ok    bypassed-per-run

wrote [projects."/home/you/project"] trust_level = "trusted" to /home/you/.codex/config.toml

all green
```

- `--trust` writes the codex trust entry for this repo root. Idempotent, and it
  prints exactly what it changed. agy needs nothing persisted — it bypasses per
  run.
- `--probe` adds one live micro-call per CLI. The only paid check; use it when
  you want end-to-end proof rather than "the binary answers `--version`".
- A MISSING row names its own fix. The one worth knowing: if you installed a CLI
  during this shell session, the row says to restart the terminal rather than
  "not found", because that is almost always what happened.

Then save the choice so you are never asked again:

```bash
bun lib/providers.ts preference --set '["codex","agy"]'
```

If you already chose a skeptic lineup for `z-adversarial-review`, this skill
reads it rather than asking a second time. `preference` reports
`"source": "sibling"` when that happened. Setting your own overrides it
permanently.

## What the seats actually run

Commands are composed in code and rendered into the manifest verbatim. Nothing
is improvised at runtime:

```bash
# discovery
codex exec -s workspace-write --cd "/run/bundle" \
  -c 'sandbox_workspace_write.writable_roots=["/run/r1/discover/cli-codex"]' \
  --skip-git-repo-check - < "/run/r1/discover/cli-codex/brief.txt"

cd "/run/bundle" && agy -p "$(cat /run/r1/discover/cli-agy/brief.txt)" \
  --add-dir "/run/r1/discover/cli-agy" --dangerously-skip-permissions \
  --print-timeout 9m30s
```

Two things to notice. The working directory is the **bundle**, not your repo:
the CLI sees flat copies of the documents under review and nothing else. And
each seat can write only to its own output directory.

`--dangerously-skip-permissions` on agy and `-s workspace-write` on codex mean
these run without their vendor's interactive prompts. That is a real exposure,
stated rather than buried: the seats read copies of your documents and write
JSON into a scratch directory. They never see the repo, and they never write to
your documents — only the apply step does that, and only after you approve.

## Choosing a lineup

| Lineup | When |
|---|---|
| `[]` — Claude only | The default. Fine for a first pass on documents you know well. |
| `["codex"]` or `["agy"]` | One outside vendor. Enough to earn the multi-vendor confidence bonus and catch the obvious blind spots. |
| `["codex","agy"]` | Documents where a wrong instruction is expensive. Two vendors discovering and refuting, at roughly double the outside cost. |

A model suffix pins a specific model: `codex:o3`, `agy:gemini-3`. The suffix is
spliced into a shell command, so it is validated against a strict character
class — an unknown-but-well-formed model is the provider's error to raise, not
this skill's.

## Refutation seats

Refuters divide across the vendors you configured. With `["codex","agy"]`, each
refuted finding gets one Claude refuter, one codex, one agy. With `[]` it gets
three Claude refuters.

Refuters are capped at the top 15 findings by `severity × (100 − base)` —
adversaries go where the stakes are highest and the discovery evidence is
thinnest. A finding three vendors already agree on is a poor use of one.
Everything below the cap is marked `unrefuted` in the plan rather than presented
as verified.

## Troubleshooting

**A seat wrote nothing.** `merge` reports it in `seatsSilent` and in the plan's
"what this run did not do" section. That is different from finding nothing, and
the plan says so. Re-run that one spawn; its brief is still on disk.

**codex fails with a trust error.** Run `setup --trust` again — the entry is per
repo root, so a new checkout needs its own.

**agy times out.** `--print-timeout 9m30s` is set to fit inside a 10-minute Bash
tool cap. A brief large enough to exceed that means the cluster is too big;
that is a bug worth reporting rather than a setting to raise.

**You want to change vendors mid-review.** You cannot, within a run. The seats
are fixed at `prepare`. Start a new review, or set the preference and let the
next round pick it up.
