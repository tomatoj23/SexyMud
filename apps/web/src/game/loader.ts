import { ContentRegistry, createGame, type Game, type SaveStore } from "@idlerpg/core";
import activitiesData from "../../../../content/config/activities.json";
import realmsData from "../../../../content/config/realms.json";
import resourcesData from "../../../../content/config/resources.json";
import settingsData from "../../../../content/config/settings.json";
import { LocalSaveStore } from "./localSaveStore.js";

/**
 * Content is imported at build time for the web shell. Structural validity is
 * enforced by the content pipeline gate (`pnpm content:check`) plus the
 * referential-integrity checks inside ContentRegistry.
 */
export function buildContentRegistry(): ContentRegistry {
  return ContentRegistry.from({
    realms: realmsData.realms,
    activities: activitiesData.activities,
    resources: resourcesData.resources,
    realmProgress: { resourceId: settingsData.realmProgress.resourceId },
  });
}

const SAVE_KEY = "idlerpg-save";

export interface BootResult {
  game: Game;
  saveStore: SaveStore;
  /** Content-derived bits the UI renders verbatim (host copy stays generic). */
  content: {
    progressResourceName: string;
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
      progressResourceName: content.resource(content.realmProgressResourceId).name,
      activities: content.activities.map((activity) => ({ id: activity.id, name: activity.name })),
    },
  };
}

export async function resetSave(): Promise<void> {
  localStorage.removeItem(SAVE_KEY);
}
