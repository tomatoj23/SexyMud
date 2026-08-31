import type { ActivityConfig, GameContentConfig, RealmConfig, ResourceConfig } from "./types.js";

function indexById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new Error(`duplicate ${label} id: ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}

/**
 * Read-only view over validated content. Hosts load raw JSON, run it through
 * the JSON Schema gate (scripts/check-content.mjs at build/CI time), then hand
 * the parsed config here. The registry additionally enforces referential
 * integrity so a broken content set fails loudly and immediately (ADR-0003).
 */
export class ContentRegistry {
  private readonly realmsById: Map<string, RealmConfig>;
  private readonly activitiesById: Map<string, ActivityConfig>;
  private readonly resourcesById: Map<string, ResourceConfig>;
  private readonly realmsByIndex: RealmConfig[];

  private constructor(private readonly content: GameContentConfig) {
    this.realmsById = indexById(content.realms, "realm");
    this.activitiesById = indexById(content.activities, "activity");
    this.resourcesById = indexById(content.resources, "resource");

    // The engine relies on realm order (index 1..N) for the starting realm
    // and later for advancement, so gaps or duplicates fail here, loudly.
    this.realmsByIndex = [...content.realms].sort((a, b) => a.index - b.index);
    this.realmsByIndex.forEach((realm, position) => {
      if (realm.index !== position + 1) {
        throw new Error(
          `realm indexes must be consecutive starting at 1 (realm ${realm.id} has index ${realm.index})`,
        );
      }
    });

    if (!this.resourcesById.has(content.progression.realmResourceId)) {
      throw new Error(
        `progression.realmResourceId references unknown resource: ${content.progression.realmResourceId}`,
      );
    }

    for (const realm of content.realms) {
      if (realm.next != null && !this.realmsById.has(realm.next)) {
        throw new Error(`realm ${realm.id} references unknown next realm: ${realm.next}`);
      }
    }

    for (const activity of content.activities) {
      for (const rate of activity.rates ?? []) {
        if (!this.resourcesById.has(rate.resourceId)) {
          throw new Error(`activity ${activity.id} references unknown resource: ${rate.resourceId}`);
        }
      }
      if ((activity.rates?.length ?? 0) > 0 && (activity.cycleSeconds ?? 0) < 1) {
        throw new Error(`activity ${activity.id} declares rates but no cycleSeconds >= 1`);
      }
    }
  }

  static from(content: GameContentConfig): ContentRegistry {
    return new ContentRegistry(content);
  }

  get realms(): readonly RealmConfig[] {
    return this.content.realms;
  }

  get activities(): readonly ActivityConfig[] {
    return this.content.activities;
  }

  get resources(): readonly ResourceConfig[] {
    return this.content.resources;
  }

  /** Realm occupying position 1 in the progression sequence. */
  get startingRealmId(): string {
    const first = this.realmsByIndex[0];
    if (!first) throw new Error("content declares no realms");
    return first.id;
  }

  /** Resource whose amount measures realm progression. */
  get realmProgressResourceId(): string {
    return this.content.progression.realmResourceId;
  }

  realm(id: string): RealmConfig {
    const realm = this.realmsById.get(id);
    if (!realm) throw new Error(`unknown realm: ${id}`);
    return realm;
  }

  activity(id: string): ActivityConfig {
    const activity = this.activitiesById.get(id);
    if (!activity) throw new Error(`unknown activity: ${id}`);
    return activity;
  }

  resource(id: string): ResourceConfig {
    const resource = this.resourcesById.get(id);
    if (!resource) throw new Error(`unknown resource: ${id}`);
    return resource;
  }
}
