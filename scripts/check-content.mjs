// Content pipeline hard gate (ADR-0003): validates every JSON file under
// content/ against its JSON Schema and exits non-zero on any failure so it can
// be wired into CI / pre-commit. The file-to-schema mapping follows the
// directory conventions in docs/agents/content.md:
//   content/config/<name>.json        -> schemas/config.<name>.schema.json
//   content/<collection>/<entry>.json -> schemas/<collection>.schema.json
// Collections without content yet (dungeon/, martial/, ...) are simply absent
// and therefore not validated; adding a file adds it to the gate.
//
// Cross-file $ref (M1-T5): collection schemas may reference each other by $id
// (commands.schema.json -> condition.schema.json#/definitions/accessRules).
// Every schema under schemas/ is therefore REGISTERED up front so those refs
// resolve. Since the gap sweep of 2026-09-01, EVERY schema is also COMPILED
// for draft-07 legality: a schema mapped by content still fails the gate on
// compile errors, while a schema with no content yet only surfaces violations
// as WARN lines — design drafts get re-evaluated when their content lands,
// and a warn-level signal beats invisibility (spec/06 §3.1).
//
// Four checks run, and all four are hard failures except where noted:
//   1. every content file against its collection schema,
//   2. the dead-concept gate (banned-terms.json),
//   3. prototype cycles in the `prototypeParent` graph (added M3-T6, #19),
//   4. draft-07 legality of the unmapped schemas (WARN only).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function listJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listJsonFiles(full));
    } else if (entry.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

/** Schema path for a content file, or null when the file is not inside a collection directory. */
function schemaPathFor(contentFile) {
  const relative = contentFile.slice(root.length + 1).split(/[\\/]/);
  if (relative.length < 3) return null; // directly under content/ — not a collection
  const collection = relative[1];
  const baseName = relative[relative.length - 1].replace(/\.json$/, "");
  return collection === "config"
    ? join("schemas", `config.${baseName}.schema.json`)
    : join("schemas", `${collection}.schema.json`);
}

const contentDir = join(root, "content");
const files = listJsonFiles(contentDir);
if (files.length === 0) {
  console.error("content:check found no JSON files under content/ — empty content set");
  process.exit(1);
}

const ajv = new Ajv({
  allErrors: true,
  // Route Ajv's own strict-mode LOG-level findings (e.g. strictTypes union
  // types, which log rather than throw) through the same WARN channel the
  // sweep below uses, so nothing surfaces as an anonymous stderr line.
  logger: {
    log: (message) => console.log(message),
    warn: (message) => console.warn(`WARN    ${message}`),
    error: (message) => console.warn(`WARN    ${message}`),
  },
});

// Register every schema by $id (see the cross-file $ref note above). A schema
// file that is not valid JSON is a broken gate, so it fails the run loudly.
// The parsed objects are kept: Ajv caches compiled schemas by object identity,
// so per-file compiles must pass the SAME object or the $id re-registers and
// throws "already exists". Keys are forward-slash schema paths ("schemas/<name>"),
// matching how schemaPathFor results are normalized at lookup.
const schemasByPath = new Map();
for (const name of readdirSync(join(root, "schemas")).sort()) {
  if (!name.endsWith(".schema.json")) continue;
  let schema;
  try {
    schema = JSON.parse(readFileSync(join(root, "schemas", name), "utf8"));
  } catch (error) {
    console.error(`INVALID schemas/${name} (not valid JSON: ${error.message})`);
    process.exit(1);
  }
  ajv.addSchema(schema);
  schemasByPath.set(`schemas/${name}`, schema);
}

// Dead-concept gate. Concepts retired by an ADR must not creep back into content.
// This replaces the "⚠️ 已废，勿用" notes that used to sit in schema descriptions
// and docs: a note only works if someone happens to read it, this runs on every
// check. Terms with a legitimate non-mechanical use in prose (「突破重围」) live in
// `warn` so they surface without blocking the build.
const bannedRules = JSON.parse(
  readFileSync(join(root, "scripts", "banned-terms.json"), "utf8"),
);

function scanBannedTerms(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const hits = [];
  for (const [group, severity] of [
    ["banned", "error"],
    ["warn", "warn"],
  ]) {
    for (const [term, reason] of Object.entries(bannedRules[group] ?? {})) {
      lines.forEach((line, index) => {
        if (line.includes(term)) hits.push({ severity, term, reason, line: index + 1 });
      });
    }
  }
  return hits;
}

/** The collection a content file belongs to: the directory right under content/. */
function collectionOf(contentFile) {
  return contentFile.slice(root.length + 1).split(/[\\/]/)[1];
}

/**
 * Prototype cycle detection — the OFFLINE half of ADR-0030 §5's double lock
 * (M3-T6, #19). The runtime half lives in the registry's flattener, which
 * throws on a cycle at load; this one runs when the content is SAVED, so an
 * author meets the cycle here instead of a player meeting it at startup.
 *
 * Graphs are built PER COLLECTION because inheritance never crosses
 * collections (ADR-0030 §3): a parent id resolves against the child's own
 * collection and nowhere else. Ids are walked ascending and parents left →
 * right, so the cycle a run reports is the cycle the next run reports.
 *
 * Only the ROOT object of a file is walked. An exit carries the same four
 * fields (it is a command) but is never flattened: a room's `exits` is
 * replaced wholesale and an exit id is globally unique, so inheriting one is
 * impossible by construction (spec/03 §6.1).
 *
 * Cycles are the ONLY thing checked here. That a parent exists and declared a
 * `prototypeKey` are load-time checks the flattener already makes loudly
 * (M3-T3); repeating them offline would mean re-implementing the flattener,
 * and a copy would drift from the original.
 */
function checkPrototypeCycles(entries) {
  /** collection → id → parents (only files that DECLARE inheritance). */
  const graphs = new Map();
  let parented = 0;
  for (const { file, data } of entries) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    if (data.prototypeParent === undefined) continue;
    parented += 1;
    const collection = collectionOf(file);
    if (!graphs.has(collection)) graphs.set(collection, new Map());
    graphs.get(collection).set(data.id ?? file, {
      parents: Array.isArray(data.prototypeParent)
        ? data.prototypeParent.filter((id) => typeof id === "string")
        : [],
    });
  }

  const cycles = [];
  for (const collection of [...graphs.keys()].sort()) {
    const graph = graphs.get(collection);
    /** "open" = on the current path; "done" = fully walked. */
    const state = new Map();
    const path = [];
    const walk = (id) => {
      if (state.get(id) === "done") return; // an ancestor reached TWICE is a diamond, not a cycle
      if (state.get(id) === "open") {
        cycles.push({ collection, cycle: [...path.slice(path.indexOf(id)), id] });
        return;
      }
      state.set(id, "open");
      path.push(id);
      for (const parent of graph.get(id)?.parents ?? []) {
        // A parent this collection does not know is the registry's error to
        // raise at load, not this walk's.
        if (graph.has(parent)) walk(parent);
      }
      path.pop();
      state.set(id, "done");
    };
    for (const id of [...graph.keys()].sort()) walk(id);
  }
  return { cycles, parented };
}

let failed = false;
/** Everything the cycle pass needs, collected as the files are parsed below. */
const prototypeEntries = [];
for (const file of files.sort()) {
  const relative = file.slice(root.length + 1).replace(/\\/g, "/");
  const schemaRel = schemaPathFor(file);

  if (!schemaRel) {
    failed = true;
    console.error(`INVALID ${relative} (content files must live inside a collection directory)`);
    continue;
  }

  const schema = schemasByPath.get(schemaRel.replace(/\\/g, "/"));
  if (!schema) {
    failed = true;
    console.error(`MISSING schema ${schemaRel.replace(/\\/g, "/")} for ${relative}`);
    continue;
  }

  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    failed = true;
    console.error(`INVALID ${relative} (not valid JSON: ${error.message})`);
    continue;
  }
  // Parsed but not yet checked: the prototype graph is a pass over whole
  // collections, so it runs after this loop (see checkPrototypeCycles).
  prototypeEntries.push({ file, data });

  let validate;
  try {
    // Compiles through the pre-registered $id space, so cross-file $refs
    // resolve; the SAME parsed object is passed so Ajv's per-object cache
    // sees one schema per $id.
    validate = ajv.compile(schema);
  } catch (error) {
    // A mapped schema that cannot even compile is a broken gate, not a
    // content bug — fail cleanly instead of crashing mid-run.
    failed = true;
    console.error(`INVALID ${relative} (schema ${schemaRel.replace(/\\/g, "/")} does not compile: ${error.message})`);
    continue;
  }
  if (!validate(data)) {
    failed = true;
    console.error(`INVALID ${relative} (schema: ${schemaRel.replace(/\\/g, "/")})`);
    for (const err of validate.errors ?? []) {
      console.error(`  - ${err.instancePath} ${err.message}`);
    }
  } else {
    console.log(`OK      ${relative}`);
  }

  for (const hit of scanBannedTerms(file)) {
    const isError = hit.severity === "error";
    (isError ? console.error : console.warn)(
      `${isError ? "BANNED " : "WARN   "} ${relative}:${hit.line} 「${hit.term}」— ${hit.reason}`,
    );
    if (isError) failed = true;
  }
}

const { cycles, parented } = checkPrototypeCycles(prototypeEntries);
if (cycles.length > 0) {
  failed = true;
  for (const { collection, cycle } of cycles) {
    console.error(`CYCLE    ${collection}: prototype cycle ${cycle.join(" → ")}`);
  }
} else {
  console.log(
    `OK      prototype graph: no cycle across ${prototypeEntries.length} file(s), ${parented} of them declaring prototypeParent`,
  );
}

// Reverse scan: this loop only ever walks content/, so a schema that no content
// file can select would stay invisible forever. Surface the count so an
// orphaned schema (one whose name can never map to a content path) is noticed.
// Collections without content are expected — adding content opts it into the
// gate — so this reports, it does not fail.
const usedSchemas = new Set(
  files
    .map((file) => schemaPathFor(file))
    .filter(Boolean)
    .map((path) => path.replace(/\\/g, "/")),
);
const unusedSchemas = readdirSync(join(root, "schemas"))
  .filter((name) => name.endsWith(".schema.json"))
  .map((name) => join("schemas", name).replace(/\\/g, "/"))
  .filter((path) => !usedSchemas.has(path))
  .sort();

// A $ref library (condition, common) is referenced BY other schemas rather
// than selected by a directory, so it will never have a content mapping —
// calling it a "design draft" is wrong, and the distinction is one this
// check prints on every run.
const LIBRARY_KEYS = new Set(["$schema", "$id", "title", "description", "definitions", "$ref"]);
const isLibrary = (schema) => Object.keys(schema).every((key) => LIBRARY_KEYS.has(key));
const librarySchemas = unusedSchemas.filter((path) => isLibrary(schemasByPath.get(path)));

if (unusedSchemas.length > 0) {
  console.log(
    `NOTE     ${unusedSchemas.length} schema(s) have no content mapping — ${librarySchemas.length} of them are $ref libraries (${librarySchemas.join(", ")}) and never will be; the other ${unusedSchemas.length - librarySchemas.length} are design drafts until their collections land; compile problems surface as WARN below, not failures: ${unusedSchemas.join(", ")}`,
  );
}

// Draft-07 legality sweep over the unmapped schemas (spec/06 §3.1): a design
// draft that cannot compile is worth SEEING now — it becomes a hard failure
// the moment content for its collection lands — but not worth blocking the
// gate, since re-evaluation is scheduled with that landing. Mapped schemas
// already failed the gate above if they could not compile.
for (const schemaRel of unusedSchemas) {
  const schema = schemasByPath.get(schemaRel);
  try {
    ajv.compile(schema);
  } catch (error) {
    console.warn(
      `WARN    ${schemaRel} does not compile (no content maps to it yet; fix or re-evaluate before landing its collection): ${error.message}`,
    );
  }
}

process.exit(failed ? 1 : 0);
