/**
 * Shape of the structural game configuration (content/config/, ADR-0004).
 * All of this is data: the engine never hardcodes realm lists, cycle
 * lengths, caps or any other quantity — it only reads what content declares.
 */

export interface RealmConfig {
  id: string;
  /** 1-based position in the progression sequence. */
  index: number;
  name: string;
  /** Amount of the progression resource required to advance past this realm. */
  cultivationRequired: number;
  /** Id of the next realm; null (or absent) on the final realm. */
  next?: string | null;
}

export interface ActivityRate {
  resourceId: string;
  /** Amount granted per completed cycle. */
  amountPerCycle?: number;
  /** Relative weight for per-cycle random picks (production activities). */
  weight?: number;
}

export interface ActivityProgression {
  /**
   * Content-side level parameters only; the player's current level and xp
   * are runtime state and live in the save.
   */
  maxLevel: number;
  xpPerCycle?: number;
}

export interface ActivityConfig {
  id: string;
  name: string;
  progression: ActivityProgression;
  /** Direct resource outputs of the activity. */
  rates?: ActivityRate[];
  /** Length of one production cycle in seconds. */
  cycleSeconds?: number;
  /** Offline accrual cap in hours; absent means uncapped. */
  offlineCapHours?: number;
}

export interface ResourceConfig {
  id: string;
  name: string;
  /** Category key; display lives in `name`, and the engine never branches on it. */
  kind: string;
}

export interface RealmProgressSettings {
  /** Resource whose amount measures realm progression. */
  resourceId: string;
}

export interface GameContentConfig {
  realms: RealmConfig[];
  activities: ActivityConfig[];
  resources: ResourceConfig[];
  realmProgress: RealmProgressSettings;
}
