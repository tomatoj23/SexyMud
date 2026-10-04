import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isAlreadyExists,
  isInvalidCredentials,
  isUnauthenticated,
  signalOf,
} from "../src/game/cloudbaseSignals.js";

/**
 * The CloudBase SDK's error signal table (#43, decision D2) — the ONE place
 * its documented vocabulary is judged. What these pins hold:
 *
 *   - the table's own reading: every documented enum word, precedence when
 *     one error carries two signals, and the `unknown` fall-through (the
 *     unknown⇒network rule's one home);
 *   - the two ownership scans: no SDK vocabulary is judged outside this
 *     table (`already_exists` once), and the rule is EXPLAINED once (the
 *     rationale wording four sites used to copy). Scans run over `apps/web/src`
 *     only — tests narrate behavior and are not the rule's home.
 */

describe("cloudbaseSignals — the one SDK error signal table (decision D2)", () => {
  it("classifies every documented enum word — duplicates outrank credentials outrank sessions", () => {
    expect(signalOf({ code: "already_exists" })).toBe("already-exists");
    expect(signalOf({ code: "ALREADY_EXISTS" })).toBe("already-exists");
    expect(signalOf({ category: "INVALID_CREDENTIALS" })).toBe("invalid-credentials");
    expect(signalOf({ category: "USER_NOT_FOUND" })).toBe("invalid-credentials");
    expect(signalOf({ category: "AUTH_METHOD_MISMATCH" })).toBe("invalid-credentials");
    expect(signalOf({ code: "invalid_password" })).toBe("invalid-credentials");
    expect(signalOf({ code: "invalid_credentials" })).toBe("invalid-credentials");
    expect(signalOf({ code: "invalid_grant" })).toBe("invalid-credentials");
    expect(signalOf({ errorCode: 16 })).toBe("unauthenticated");
    expect(signalOf({ code: "unauthenticated" })).toBe("unauthenticated");
    expect(signalOf({ code: "UNAUTHENTICATED" })).toBe("unauthenticated");
    expect(signalOf({ code: "login_required" })).toBe("unauthenticated");
    expect(signalOf({ statusCode: 401 })).toBe("unauthenticated");
    expect(signalOf({ status: 401 })).toBe("unauthenticated");
    expect(signalOf({ status: "401" })).toBe("unauthenticated");
    // One carrier, two signals: the table reads the duplicate first.
    expect(signalOf({ code: "already_exists", errorCode: 16 })).toBe("already-exists");
  });

  it("everything the table does not name is 'unknown' — the rule's default, no string guessing", () => {
    expect(signalOf(new TypeError("Failed to fetch"))).toBe("unknown");
    expect(signalOf({ code: "internal", message: "boom" })).toBe("unknown");
    expect(signalOf("unauthenticated")).toBe("unknown"); // the word without the channel carries no signal
    expect(signalOf(undefined)).toBe("unknown");
  });

  it("the predicates answer their own signal only — one table, read three ways", () => {
    expect(isAlreadyExists({ code: "already_exists" })).toBe(true);
    expect(isAlreadyExists({ code: "ALREADY_EXISTS" })).toBe(true);
    expect(isAlreadyExists({ code: "unauthenticated" })).toBe(false);
    expect(isInvalidCredentials({ category: "INVALID_CREDENTIALS" })).toBe(true);
    expect(isInvalidCredentials({ code: "invalid_grant" })).toBe(true);
    expect(isUnauthenticated({ errorCode: 16 })).toBe(true);
    expect(isUnauthenticated({ code: "login_required" })).toBe(true);
    expect(isUnauthenticated({ status: "401" })).toBe(true);
    expect(isUnauthenticated({ code: "internal" })).toBe(false);
  });
});

describe("the signal table has one owner (src scan)", () => {
  it("finds no SDK error vocabulary outside cloudbaseSignals.ts — judged once, `already_exists` included", () => {
    // Quoted enum words only (case-insensitive: both SDK spellings), because
    // prose may name a signal in backticks without judging it. Documented
    // blind spots: the numeric shapes (errorCode 16 / HTTP 401) and a
    // computed carrier (`code: someVar`) — both would land in the table file
    // anyway; a quoted literal anywhere else is the drift this pin bans.
    const vocabulary = /["'](?:already_exists|unauthenticated|login_required|invalid_password|invalid_credentials|invalid_grant|user_not_found|auth_method_mismatch)["']/gi;
    expect(srcOffenders(vocabulary)).toEqual([]);
  });

  it("finds no second copy of the unknown⇒network rationale — the rule is EXPLAINED once", () => {
    // The rationale phrase family ("retryable is the safe reading…") — the
    // drift-prone wording four sites copied and #43 folded into the table.
    expect(srcOffenders(/safe reading/gi)).toEqual([]);
  });
});

/** Every hit of `pattern` under apps/web/src outside the signals table. */
function srcOffenders(pattern: RegExp): string[] {
  const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      // Skip by FULL PATH (the events.test.ts precedent): a basename
      // exemption would silently cover a future nested file of the same name.
      if (path === join(srcRoot, "game", "cloudbaseSignals.ts")) continue;
      for (const match of readFileSync(path, "utf8").matchAll(pattern)) {
        offenders.push(`${path.slice(srcRoot.length + 1)}: ${match[0]}`);
      }
    }
  };
  walk(srcRoot);
  return offenders;
}
