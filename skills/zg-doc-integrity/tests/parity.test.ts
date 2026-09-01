// The duplication guard.
//
// This skill installs standalone, so lib/cli.ts is a COPY of
// z-adversarial-review's rather than an import. A copy silently diverging is
// the accepted cost's failure mode, so it is checked here instead of noticed
// later: inside this monorepo the two must be byte-identical, and in a
// standalone install (no sibling on disk) the check skips.
//
// Only cli.ts is guarded. lib/run-id.ts, lib/verdict.ts and lib/providers.ts
// are adapted on purpose -- documents have rounds where PRs have tickets, and
// the stages and seats differ -- so byte equality there would be wrong.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mine = join(here, "..", "lib", "cli.ts");
const sibling = join(here, "..", "..", "z-adversarial-review", "lib", "cli.ts");

describe("cli.ts parity with z-adversarial-review", () => {
  test.skipIf(!existsSync(sibling))("is byte-identical to the sibling copy", () => {
    expect(readFileSync(mine, "utf8")).toBe(readFileSync(sibling, "utf8"));
  });

  test("exists regardless, since this skill must run without the sibling", () => {
    expect(existsSync(mine)).toBe(true);
  });
});
