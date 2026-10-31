import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_HOST_COPY } from "../src/game/hostCopy.js";
import { loadPack } from "../src/game/pack.js";
import type { LoadedPack } from "../src/game/pack.js";

/**
 * The shipped wuxia pack as a test fixture (#51): files read off disk
 * exactly the way the core tests read them (traversal-chain's own
 * precedent), fed through the SAME loader the browser feed shares — so the
 * tests pin what the browser will run, not a parallel construction.
 */

const contentRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../content");

/** The shipped pack's parsed files, keyed `<dir>/<file>.json`. */
export function readPackFiles(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const dir of ["config", "commands", "rooms", "npcs", "monster", "effects"]) {
    const dirPath = join(contentRoot, dir);
    if (!existsSync(dirPath)) continue;
    for (const fileName of readdirSync(dirPath).filter((name) => name.endsWith(".json")).sort()) {
      files[`${dir}/${fileName}`] = JSON.parse(readFileSync(join(dirPath, fileName), "utf8"));
    }
  }
  return files;
}

/** The shipped pack, loaded once per call — a fresh validated registry. */
export function loadWuxiaPack(): LoadedPack {
  return loadPack(readPackFiles(), WEB_HOST_COPY);
}
