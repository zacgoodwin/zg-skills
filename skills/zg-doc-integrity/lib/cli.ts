// Shared CLI plumbing for every lib/*.ts entrypoint, extracted from zstack
// (github.com/zacgoodwin/zstack, lib/cli.ts + the ZError class from
// lib/config.ts). One copy of each shape: --flag parsing, required-flag
// extraction, JSON file reads, and the ZError -> exit-1 epilogue.

import { readFileSync } from "node:fs";

// An actionable, expected failure: printed as one message, exit 1. Anything
// else escaping main() is a bug and rethrows with its stack.
export class ZError extends Error {}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

// `--key value` pairs plus positionals, in one pass. A key listed in `booleans`
// consumes no value and stores true. `--key=value` is also accepted (split on
// the first `=`); for a boolean key the `=` form coerces "true"/"false" to real
// booleans and rejects anything else loudly. A non-boolean flag with no
// following token is a usage error, not a silent `undefined`.
export function parseFlags(args: string[], booleans: string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        const key = body.slice(0, eq);
        const raw = body.slice(eq + 1);
        if (booleans.includes(key)) {
          if (raw === "true") flags[key] = true;
          else if (raw === "false") flags[key] = false;
          else throw new ZError(`Flag --${key} is boolean; got --${key}=${raw} (expected true or false).`);
        } else {
          flags[key] = raw;
        }
        continue;
      }
      const key = body;
      if (booleans.includes(key)) {
        flags[key] = true;
      } else {
        const value = args[++i];
        if (value === undefined) throw new ZError(`Flag --${key} needs a value (got none).`);
        flags[key] = value;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

// A flag's string value, or undefined when absent or boolean.
export function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

export function requireFlag(flags: ParsedArgs["flags"], name: string): string {
  const v = str(flags, name);
  if (!v) throw new ZError(`Missing required --${name}.`);
  return v;
}

export function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ZError(`Cannot read JSON at ${path}: ${(e as Error).message}`);
  }
}

// The shared main() epilogue: an actionable failure (ZError) prints its message
// and exits 1; anything else is a bug and rethrows with its stack.
export function handleCliError(e: unknown): number {
  if (e instanceof ZError) {
    console.error(e.message);
    return 1;
  }
  throw e;
}
