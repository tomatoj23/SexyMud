/**
 * Shape of the structural game configuration (content/config/, ADR-0004).
 * All of this is data: the engine never hardcodes progression tiers, cycle
 * lengths, caps or any other quantity — it only reads what content declares.
 *
 * A discrete progression-tier ladder used to live here; it was removed with
 * ADR-0019 because tiers gate on waiting rather than on player action. The
 * per-entry level curve lands with the M1 state model.
 */

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

export interface GameContentConfig {
  activities: ActivityConfig[];
  resources: ResourceConfig[];
}
