import { ContentRegistry, createGame, type Game, type SaveStore } from "@sexymud/core";
import activitiesData from "../../../../content/config/activities.json";
import resourcesData from "../../../../content/config/resources.json";
import { LocalSaveStore } from "./localSaveStore.js";

/**
 * Content is imported at build time for the web shell. Structural validity is
 * enforced by the content pipeline gate (`pnpm content:check`) plus the
 * referential-integrity checks inside ContentRegistry.
 */
export function buildContentRegistry(): ContentRegistry {
  return ContentRegistry.from({
    activities: activitiesData.activities,
    resources: resourcesData.resources,
  });
}

const SAVE_KEY = "sexymud-save";

export interface BootResult {
  game: Game;
  saveStore: SaveStore;
  /** Content-derived bits the UI renders verbatim (host copy stays generic). */
  content: {
    resources: { id: string; name: string }[];
    activities: { id: string; name: string }[];
  };
}

export async function loadGame(): Promise<BootResult> {
  const content = buildContentRegistry();
  const clock = { now: () => Date.now() };
  const rng = { next: () => Math.random() };
  const saveStore: SaveStore = new LocalSaveStore(SAVE_KEY);
  const game = await createGame({ content, save: saveStore, clock, rng });
  return {
    game,
    saveStore,
    content: {
      resources: content.resources.map((resource) => ({ id: resource.id, name: resource.name })),
      activities: content.activities.map((activity) => ({ id: activity.id, name: activity.name })),
    },
  };
}

export async function resetSave(): Promise<void> {
  localStorage.removeItem(SAVE_KEY);
}
