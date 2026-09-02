/**
 * The condition contract (spec/01 §7, spec/02 §5; ADR-0022 §2 as corrected by
 * ADR-0024 §8): one recursive JSON expression grammar behind every "may X"
 * question — command availability, exit gates, learning prerequisites.
 *
 * - NOT a string DSL: lockstrings cannot be validated by JSON Schema, and
 *   content:check is a hard gate (ADR-0022 §2).
 * - Nodes are SINGLE-KEY and nest arbitrarily. A two-layer grammar
 *   (combinator over predicates only) cannot express `a AND b OR c` — weaker
 *   than the lockstring it replaces (ADR-0024 §8). The recursive form is
 *   { "any": [ { "all": [a, b] }, c ] }.
 * - Predicates are ENGINE CAPABILITY, not theme vocabulary (spec/02 §5.3):
 *   their names are whitelisted in schemas/condition.schema.json. Evaluation
 *   goes through a registry — hosts extend the registry, never the evaluator.
 * - Refusal copy (err_*) lives in the content ENTRY; the engine only reports
 *   WHICH field to read (errKey). Events stay semantic, never rendered text
 *   (spec/01 §5.1): "refusal is narrative too" means the DATA words it.
 */

/**
 * A condition node. Exactly one key: a combinator (`all` / `any` / `not`) or
 * a predicate name. A bare boolean is a degenerate leaf (hard true / false),
 * which also lets one accessType say "always" / "never" without a dummy
 * predicate.
 *
 * The union arms describe the grammar; TypeScript cannot enforce single-key
 * exclusivity on JSON, so the schema and the evaluator's runtime checks do.
 */
export type ConditionExpr =
  | boolean
  | { all: readonly ConditionExpr[] }
  | { any: readonly ConditionExpr[] }
  | { not: readonly ConditionExpr[] }
  | { [predicate: string]: unknown };

/**
 * What predicates may ask about the entity being checked ("the subject").
 * The engine defines the QUESTIONS (theme-neutral); content and hosts define
 * the ANSWERS by adapting their world to this facet — the engine has no
 * entity model of its own.
 */
export interface ConditionSubject {
  /** A numeric attribute, or undefined when the subject has none by that name. */
  attr(name: string): number | undefined;
  /**
   * A tag, named by BOTH its halves (ADR-0029 §1): a tag is a (dimension,
   * key) pair, so `hasTag("zone", "inner")` — never a bare string. Content
   * declares the same shape, the runtime tree stores the same shape, and
   * `has_tag` carries the pair as a two-element array (spec/06 §4's
   * three-way sync: facet, tuple predicate, schema).
   */
  hasTag(dimension: string, key: string): boolean;
  hasFlag(flag: string): boolean;
  hasState(state: string): boolean;
  /** Current location id; undefined when the subject is nowhere. */
  locationId(): string | undefined;
  /** Knows the technique/skill with this id (backs has_martial). */
  hasSkill(skillId: string): boolean;
}

/**
 * One predicate: pure and total. `arg` is the RAW JSON value under the
 * predicate key — each predicate owns its argument shape (a bare string, a
 * tuple, ...), mirrors it in the schema, and throws on anything else. Schema
 * and runtime enforce the same shapes: content:check catches bad content
 * offline, the throw catches host-assembled data that bypassed it.
 */
export type PredicateFn = (arg: unknown, subject: ConditionSubject) => boolean;

/** A registry entry: [name, predicate]. */
export type PredicateEntry = readonly [name: string, predicate: PredicateFn];

export type PredicateRegistry = ReadonlyMap<string, PredicateFn>;

/**
 * Builds a predicate registry. The same name twice is a build error (the
 * verb-table discipline): a shadowed predicate must fail loudly, not
 * silently resolve to one of its candidates.
 */
export function createPredicateRegistry(entries: Iterable<PredicateEntry>): PredicateRegistry {
  const registry = new Map<string, PredicateFn>();
  for (const [name, predicate] of entries) {
    if (name.trim() === "") {
      throw new Error("predicate registry: empty name");
    }
    if (typeof predicate !== "function") {
      throw new Error(`predicate registry: "${name}" is not a function`);
    }
    if (registry.has(name)) {
      throw new Error(`predicate registry: "${name}" is registered twice`);
    }
    registry.set(name, predicate);
  }
  return registry;
}

/** Requires the single-string argument shape shared by the membership predicates. */
function requireName(predicate: string, arg: unknown): string {
  if (typeof arg !== "string" || arg === "") {
    throw new Error(`predicate "${predicate}" expects one non-empty string`);
  }
  return arg;
}

const ATTR_GTE_ARGS = 'predicate "attr_gte" expects [attrName, minimum]';

const HAS_TAG_ARGS = 'predicate "has_tag" expects [dimension, key]';

/**
 * has_tag reads a DIMENSIONED tag (ADR-0029 §1), so its argument is the pair
 * — the same tuple shape attr_gte already established, and the same one
 * schemas/condition.schema.json whitelists. A bare string is not a tag: two
 * tags from different dimensions may share a key ("inner" the zone vs "inner"
 * the layer), and collapsing the pair into one string would either invent a
 * separator or lose the dimension.
 */
const hasTag: PredicateFn = (arg, subject) => {
  if (!Array.isArray(arg) || arg.length !== 2) {
    throw new Error(HAS_TAG_ARGS);
  }
  const [dimension, key] = arg;
  if (
    typeof dimension !== "string" ||
    dimension === "" ||
    typeof key !== "string" ||
    key === ""
  ) {
    throw new Error(HAS_TAG_ARGS);
  }
  return subject.hasTag(dimension, key);
};

const attrGte: PredicateFn = (arg, subject) => {
  if (!Array.isArray(arg) || arg.length !== 2) {
    throw new Error(ATTR_GTE_ARGS);
  }
  const [attrName, minimum] = arg;
  if (
    typeof attrName !== "string" ||
    attrName === "" ||
    typeof minimum !== "number" ||
    !Number.isFinite(minimum)
  ) {
    throw new Error(ATTR_GTE_ARGS);
  }
  const value = subject.attr(attrName);
  if (value === undefined) {
    // A threshold over a missing attribute is not met.
    return false;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`condition subject attr("${attrName}") must return a finite number or undefined`);
  }
  return value >= minimum;
};

function stringMembership(
  predicate: string,
  probe: (subject: ConditionSubject, value: string) => boolean,
): PredicateFn {
  return (arg, subject) => probe(subject, requireName(predicate, arg));
}

/**
 * The engine's built-in predicates (spec/02 §5.3) — engine capability, not
 * theme vocabulary, so these names are fixed here AND whitelisted in
 * schemas/condition.schema.json. Extending the registry with new names is an
 * engine-sanctioned extension point; content using a new name must extend the
 * schema whitelist in the same change (three-way sync, spec/06 §4).
 *
 * has_martial reads the generic hasSkill facet: what a "skill" IS belongs to
 * the content pack, not the engine. has_tag is the one predicate whose facet
 * takes TWO arguments — a tag is a (dimension, key) pair, not a string.
 */
export const defaultPredicateEntries: readonly PredicateEntry[] = [
  ["attr_gte", attrGte],
  ["has_tag", hasTag],
  ["has_flag", stringMembership("has_flag", (s, flag) => s.hasFlag(flag))],
  ["has_state", stringMembership("has_state", (s, state) => s.hasState(state))],
  [
    "in_location",
    stringMembership("in_location", (s, locationId) => s.locationId() === locationId),
  ],
  ["has_martial", stringMembership("has_martial", (s, skillId) => s.hasSkill(skillId))],
];

/** The built-ins as a ready registry — the default when none is injected. */
export const defaultPredicateRegistry: PredicateRegistry = createPredicateRegistry(defaultPredicateEntries);

const COMBINATORS: ReadonlySet<string> = new Set(["all", "any", "not"]);

/**
 * Evaluates a condition expression. Pure and deterministic: the same
 * expression, subject and registry always yield the same boolean.
 *
 * Malformed nodes throw. content:check rejects them offline, so a throw here
 * means host-assembled data bypassed the schema — and failing loudly beats
 * silently granting or denying a gate.
 */
export function evaluateCondition(
  expr: ConditionExpr,
  subject: ConditionSubject,
  registry: PredicateRegistry = defaultPredicateRegistry,
): boolean {
  if (typeof expr === "boolean") {
    return expr;
  }
  if (typeof expr !== "object" || expr === null || Array.isArray(expr)) {
    throw new Error("condition: a node is a boolean or a single-key object");
  }
  const keys = Object.keys(expr);
  if (keys.length !== 1) {
    throw new Error(
      `condition: a node carries exactly one key, got ${keys.length}: ${keys.join(", ")}`,
    );
  }
  const key = keys[0]!;
  const arg = (expr as Record<string, unknown>)[key];

  if (COMBINATORS.has(key)) {
    if (!Array.isArray(arg) || arg.length === 0) {
      throw new Error(`condition: "${key}" expects a non-empty array of nodes`);
    }
    const results = arg.map((child) => evaluateCondition(child as ConditionExpr, subject, registry));
    if (key === "all") {
      return results.every(Boolean);
    }
    if (key === "any") {
      return results.some(Boolean);
    }
    // "not": true when NO child is true. A lone child is plain negation;
    // several children are "none of these" (De Morgan over any).
    return results.every((result) => !result);
  }

  const predicate = registry.get(key);
  if (predicate === undefined) {
    throw new Error(`condition: unknown predicate "${key}"`);
  }
  return predicate(arg, subject);
}

/**
 * The outer gate map (spec/02 §5.2): accessType → expression, plus `default`
 * evaluated for accessTypes with no expression — the lockstring's
 * `edit:...; use:...` segmentation as data.
 *
 * `default` is a FULL condition, not just a policy bit: a bare boolean is the
 * common form (false = deny-by-default), but any expression may stand in
 * ("undeclared types require the member flag").
 */
export interface AccessRules {
  /** Evaluated when the asked accessType has no expression. */
  default: ConditionExpr;
  /** One gate per accessType; boolean leaves are hard open / closed. */
  [accessType: string]: ConditionExpr;
}

/** What one dispatch asks of a gate map. */
export interface AccessGate {
  rules: AccessRules;
  /**
   * The accessType this check asks — commands gate "use", exits "traverse",
   * learning gates "learn". The vocabulary is content-side; the engine only
   * carries it through.
   */
  accessType: string;
}

/**
 * Outcome of one access check. On denial, `errKey` names the ENTRY field the
 * renderer reads the refusal copy from: `err_<accessType>` when an expression
 * denied, `err_default` when the default gate did. The engine never words a
 * refusal (spec/02 §5.4) — Evennia's access() returns a bare bool and leaves
 * the digging to each call site; the errKey makes the data field first-class.
 */
export type AccessCheck = { ok: true } | { ok: false; accessType: string; errKey: string };

export function checkAccess(
  rules: AccessRules,
  accessType: string,
  subject: ConditionSubject,
  registry: PredicateRegistry = defaultPredicateRegistry,
): AccessCheck {
  const gate = rules[accessType];
  const effective = gate === undefined ? rules.default : gate;
  if (evaluateCondition(effective, subject, registry)) {
    return { ok: true };
  }
  return {
    ok: false,
    accessType,
    errKey: gate === undefined ? "err_default" : `err_${accessType}`,
  };
}
