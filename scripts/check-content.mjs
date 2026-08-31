// Content pipeline hard gate (ADR-0003): validates every JSON file under
// content/ against its JSON Schema and exits non-zero on any failure so it can
// be wired into CI / pre-commit. The file-to-schema mapping follows the
// directory conventions in docs/agents/content.md:
//   content/config/<name>.json        -> schemas/config.<name>.schema.json
//   content/<collection>/<entry>.json -> schemas/<collection>.schema.json
// Collections without content yet (dungeon/, martial/, ...) are simply absent
// and therefore not validated; adding a file adds it to the gate.
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

let failed = false;
for (const file of files.sort()) {
  const relative = file.slice(root.length + 1).replace(/\\/g, "/");
  const schemaRel = schemaPathFor(file);

  if (!schemaRel) {
    failed = true;
    console.error(`INVALID ${relative} (content files must live inside a collection directory)`);
    continue;
  }

  let schema;
  try {
    schema = JSON.parse(readFileSync(resolve(root, schemaRel), "utf8"));
  } catch {
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
}

process.exit(failed ? 1 : 0);
