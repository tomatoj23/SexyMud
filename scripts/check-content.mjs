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
// resolve. Registration is not compilation: a schema is compiled — and thus
// its draft-07 legality checked — only when content maps to it or another
// compiled schema $refs it, so schemas without content still do not fail the
// gate (spec/06 §3.1).
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

const ajv = new Ajv({ allErrors: true });

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

let failed = false;
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

  const validate = ajv.compile(schema);
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

if (unusedSchemas.length > 0) {
  console.log(
    `NOTE     ${unusedSchemas.length} schema(s) have no content mapping, so they were not compiled directly (a schema referenced via $ref still compiles through its consumers): ${unusedSchemas.join(", ")}`,
  );
}

process.exit(failed ? 1 : 0);
