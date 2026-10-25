import { loadPack } from "./pack.js";
import type { LoadedPack } from "./pack.js";
import { WEB_HOST_COPY } from "./hostCopy.js";

/**
 * The browser's feed for the pack loader: vite's eager glob over the
 * repository's shipped content directory, parsed JSON files keyed by path.
 * The loader itself (pack.ts) stays feed-agnostic — tests hand it files
 * read off disk — so this module is the ONLY place the browser's bundler
 * enters the picture (ADR-0007's self-containment holds: the JSON ships
 * inside the bundle, no runtime fetch of content/).
 */

// Relative to THIS file: apps/web/src/game → repo root → content/.
const files = import.meta.glob("../../../../content/**/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

/** The shipped wuxia pack, loaded once per call (a fresh game reads it fresh). */
export function loadShippedPack(): LoadedPack {
  return loadPack(files, WEB_HOST_COPY);
}
