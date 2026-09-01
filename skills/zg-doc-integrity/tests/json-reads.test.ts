// One guard for a bug that was never about one call site.
//
// A verdict written with a UTF-8 BOM did not parse, so the seat counted as
// having not voted and the finding's confidence was scored off a short quorum.
// Nothing failed loudly. The fix routes every JSON read through parseJson /
// readJsonFile in lib/cli.ts, and the only way that stays true is to check the
// source: a new `JSON.parse(readFileSync(...))` anywhere in lib/ reopens it.
//
// This catches the inlined shape only. Parsing through a variable -- which is
// what readVerdict does -- is covered behaviourally in verdict.test.ts instead.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJson } from "../lib/cli.ts";

const libDir = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");

// The mark itself, as an escape: a literal BOM in this file is invisible and
// one encoding cleanup away from making the test below prove nothing.
const BOM = "\uFEFF";

describe("every JSON read goes through the shared reader", () => {
  test("no lib file parses a file read of its own", () => {
    const offenders = readdirSync(libDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /JSON\.parse\(\s*readFileSync/.test(readFileSync(join(libDir, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  test("parseJson tolerates a BOM and still rejects real garbage", () => {
    expect(parseJson(BOM + `{"a":1}`)).toEqual({ a: 1 });
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJson(BOM + "{ not json")).toThrow();
  });
});
