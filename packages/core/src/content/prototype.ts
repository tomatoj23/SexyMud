import type { EntryCommon } from "./entry.js";
import { compareIds } from "./order.js";

/**
 * Load-time prototype flattening (issue #16; spec/03 §6.1, ADR-0030).
 *
 * An entry may declare `prototypeParent: [<parent id>…]` and inherit from it;
 * flattening rewrites every entry into the entry it WOULD have been written
 * as, once, at load time. Nothing downstream ever sees an inheritance — a
 * flattened entry carries no `prototypeParent`, so re-flattening is not
 * something a runtime could do by accident (ADR-0030 §4).
 *
 * The four rules that make it deterministic:
 *
 * 1. **Only `tags` and `attrs` merge complementarily** (spec/03 §6). Every
 *    other key is replaced wholesale by the winning side — a room inheriting
 *    `exits` from a prototype takes the prototype's whole exit list, not the
 *    union of two lists.
 * 2. **Precedence is left → right, self last**: the entry itself beats all of
 *    its parents, and the rightmost parent beats the ones before it, so
 *    `[a, b, c]` reads "a, refined by b, refined by c, refined by me".
 * 3. **Merged arrays come out deduplicated and ascending** (ADR-0030 §6):
 *    a tag list is a SET, so its order carries no meaning and the canonical
 *    order is the only one that survives a change of load order.
 * 4. **Cycles throw** (ADR-0030 §5, the runtime half of the double lock —
 *    `content:check` is the offline half). A diamond is NOT a cycle: an
 *    ancestor reached by two different routes is fine, only being your own
 *    ancestor is not.
 *
 * Scope: ONE collection at a time. Inheritance never crosses collections
 * (ADR-0030 §3), so a parent id resolves against the same collection the child
 * lives in. Exits are therefore not flattened — a room's `exits` is a key like
 * any other and is replaced wholesale; an exit's own `prototype*` pair has no
 * consumer (spec/03 §6.1).
 *
 * `attrs` is merged but is NOT in the schema (ADR-0030 §7): it has no reader
 * yet, so opening `additionalProperties: false` for it would promise a shape
 * nobody designed. It is exercised by synthetic tests whose data is a bare
 * object that never passes through a schema.
 *
 * This module is internal — the registry is the seam (spec/00: the engine's
 * single channel for content), so hosts never call it and nothing here is
 * exported from the package root.
 */

/**
 * What the flattener needs of an entry: an id to resolve parents against, and
 * the prototype pair. Every entry type already satisfies this (they all extend
 * EntryCommon and carry an id), so each collection keeps its own type through
 * the call — `flattenCollection` returns T, not a widened shape.
 */
export type FlattenableEntry = EntryCommon & { readonly id: string };

/** An entry handled as data: the merge is structural and knows no collection. */
type EntryData = Record<string, unknown>;

/** A tag map being built: dimension → normalized key list. */
type TagBuckets = Record<string, readonly string[]>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Dedup + canonical order: a tag key list is a set (ADR-0030 §6).
 *
 * Canonicalizing only — it drops nothing and invents nothing. Whether a
 * dimension's value is a list of strings at all is a SHAPE question, and shape
 * is content:check's job (see the registry's header); this pass just puts
 * whatever is there into the one order every exposure uses.
 */
function normalizeKeys(keys: unknown): readonly string[] {
  const list = Array.isArray(keys) ? (keys as readonly string[]) : [];
  return [...new Set(list)].sort(compareIds);
}

/** The tag side of a merge, normalized: every key list deduped and ascending. */
function normalizeTags(value: unknown): TagBuckets {
  const result: TagBuckets = {};
  if (!isRecord(value)) {
    return result;
  }
  for (const [dimension, keys] of Object.entries(value)) {
    result[dimension] = normalizeKeys(keys);
  }
  return result;
}

/**
 * The tags union: per dimension, the union of both key sets. A dimension only
 * one side declares survives as it is — that is what "complementary" buys.
 */
function mergeTags(base: unknown, overlay: unknown): TagBuckets {
  const merged = normalizeTags(base);
  for (const [dimension, keys] of Object.entries(normalizeTags(overlay))) {
    merged[dimension] = [...new Set([...(merged[dimension] ?? []), ...keys])].sort(compareIds);
  }
  return merged;
}

/**
 * Lays `overlay` over `base`, the one place the merge law lives.
 *
 * Precedence is the caller's business (it calls this left → right, self last);
 * what lives here is which keys merge and which are replaced.
 *
 * Two keys are dropped on the way in rather than after: `prototypeParent` is a
 * consumed instruction (an entry carrying it downstream would look like it
 * still needs flattening), and `prototypeKey` is deliberately NOT inherited —
 * it is taken from `overlay` only, so an entry that never declared one has
 * none afterwards and cannot be inherited from. That is a constructive
 * guarantee, not a convention (ADR-0030 §4).
 */
function mergeInto(base: EntryData, overlay: EntryData): EntryData {
  const merged: EntryData = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === "prototypeParent" || key === "prototypeKey") {
      continue;
    }
    merged[key] = value;
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (key === "prototypeParent") {
      continue;
    }
    if (key === "tags" && isRecord(value)) {
      merged.tags = mergeTags(merged.tags, value);
      continue;
    }
    // attrs: the union is over its KEYS, and a key both sides declare takes
    // the higher-precedence value — the same law as tags, one level down.
    if (key === "attrs" && isRecord(merged.attrs) && isRecord(value)) {
      merged.attrs = { ...merged.attrs, ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Flattens one collection: every entry comes back as the entry it would have
 * been written as, with nothing left to inherit.
 *
 * `what` names the collection in error messages ("command", "room", …), the
 * same word the registry uses elsewhere.
 *
 * Ids are the caller's job — the registry de-duplicates before calling — and
 * flattening never changes an id, so the one id space the caller validated
 * stays valid (ids also stay unique because nothing is added or renamed).
 */
export function flattenCollection<T extends FlattenableEntry>(
  entries: readonly T[],
  what: string,
): readonly T[] {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  // Checked for EVERY entry up front, so the outcome does not depend on which
  // entry the walk happens to start from: `prototypeKey` IS the entry's own id
  // (ADR-0030 §4), which a schema cannot express and which must therefore fail
  // loudly here.
  for (const entry of byId.values()) {
    if (entry.prototypeKey !== undefined && entry.prototypeKey !== entry.id) {
      throw new Error(
        `content registry: ${what} "${entry.id}" declares prototypeKey "${entry.prototypeKey}" instead of its own id`,
      );
    }
  }

  /** Already-flattened entries, shared: an ancestor reached twice is computed once. */
  const flattened = new Map<string, EntryData>();
  /** The chain currently being walked — the cycle detector's whole state. */
  const path: string[] = [];

  const flatten = (entry: T): EntryData => {
    const done = flattened.get(entry.id);
    if (done !== undefined) {
      return done;
    }

    path.push(entry.id);
    let merged: EntryData = {};
    for (const parentId of entry.prototypeParent ?? []) {
      const parent = byId.get(parentId);
      if (parent === undefined) {
        throw new Error(
          `content registry: ${what} "${entry.id}" inherits from unknown ${what} id "${parentId}"`,
        );
      }
      // The cycle test lives HERE, at the call site, rather than inside
      // flatten: an ancestor that is already flattened answers from the memo
      // before it could ever ask whether it is on the current path — which is
      // exactly why a diamond is not mistaken for a cycle.
      if (path.includes(parentId)) {
        throw new Error(
          `content registry: ${what} prototype cycle: ${[...path, parentId].join(" → ")}`,
        );
      }
      // Before recursing too, and for the same reason: an entry flattened as a
      // plain entry first — where having no prototypeKey is perfectly legal —
      // would otherwise answer from the memo and never be checked as a parent.
      if (parent.prototypeKey === undefined) {
        throw new Error(
          `content registry: ${what} "${entry.id}" inherits from "${parentId}", which declares no prototypeKey`,
        );
      }
      merged = mergeInto(merged, flatten(parent));
    }
    merged = mergeInto(merged, entry as EntryData);
    path.pop();

    flattened.set(entry.id, merged);
    return merged;
  };

  // An entry that never declared `prototypeParent` is handed back UNTOUCHED —
  // the same object, not a rebuilt copy. A pack that uses no prototypes (every
  // pack today) therefore pays nothing at load and sees none of its data
  // rewritten; only what a merge actually produces is canonicalized.
  //
  // An EMPTY `prototypeParent: []` is not the same thing: the key is declared,
  // so it has to be consumed — an entry that still carries it would look like
  // it has inheriting left to do.
  return entries.map((entry) =>
    entry.prototypeParent === undefined ? entry : (flatten(entry) as unknown as T),
  );
}
