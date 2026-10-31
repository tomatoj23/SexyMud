/**
 * Platform-facing ports and the engine's external contract.
 *
 * Everything here is pure: no platform API, no theme vocabulary, no hardcoded
 * quantities. Hosts (web, mini-program, desktop, server) provide the
 * implementations.
 *
 * This file is the contract layer described in docs/spec/01-engine-contract.md
 * and the six cross-cutting contracts it lists (§7). It also holds the event
 * union (§5) and the semantic-code value faces — the two closed vocabularies
 * every port below speaks.
 */

import type { MoveType } from "./world/entity.js";
import type { ExitDigest, StaticPresence } from "./world/look.js";
import type { MoveVetoStage } from "./world/move.js";
import type { SayVetoStage } from "./world/say.js";

/**
 * A host-authored semantic CODE, made by `customCode()` (events.ts). The
 * brand is TYPE-ONLY (a phantom): no runtime property is added — a branded
 * value IS the plain string it was made from.
 *
 * A bare string reaches no code slot on purpose. A typo like `"accessDenyed"`
 * is a compile error there instead of a rendering gap that surfaces three
 * weeks later as a player-facing mystery, while a host's own vocabulary
 * ("gateClosed", "learn") stays first-class — it just has to say so once.
 */
declare const customCodeBrand: unique symbol;

export type CustomCode = string & { readonly [customCodeBrand]: "customCode" };

/** Engine-produced reason codes — the `rejected` half (a refusal is content). */
export type RefusalReason =
  | "accessDenied"
  | "vetoed"
  | "notVisible"
  | "sayVetoed"
  | "moveVetoed";

/** The verb matcher's failure vocabulary — the narrowest parse slot. */
export type VerbReason = "emptyInput" | "unknownVerb";

/** Engine-produced reason codes — the `invalid` half (malformed input). */
export type ParseReason =
  | VerbReason
  | "verbMismatch"
  | "unexpectedArg"
  | "missingTarget"
  | "badOrdinal"
  | "missingNoun";

/**
 * The reason value face — ONE home (spec/02 §5.4: refusal wording is data,
 * and the code is what the renderer maps to copy). Covers both failure
 * halves: an event's `reason`, a `rejected` result and an `invalid` result
 * speak the same language.
 */
export type ReasonCode = RefusalReason | ParseReason | CustomCode;

/**
 * The accessType value face: the vocabulary a gate map is ASKED with. The
 * four literals are the engine's own asks (commands gate "use", exits
 * "traverse", rooms "enter"/"look" — the collections' fixed vocabulary,
 * spec/02 §4.1, spec/03 §2); anything else is content-side ("learn") and
 * says so through `customCode()`. The engine only carries the word through
 * to the gate map and back out on the refusal event.
 */
export type AccessTypeCode = "use" | "traverse" | "enter" | "look" | CustomCode;

/**
 * Three failure classes with different retry semantics (ADR-0025 §1.2):
 * - `rejected`: the engine legitimately refused (not enough resource, gate
 *   closed). The seq IS consumed; the refusal is returned to the player as an
 *   event, because it is game content rather than an error.
 * - `invalid`: malformed or unparseable. seq NOT consumed.
 * - `transport`: not delivered. seq NOT consumed; safe to retry.
 */
export type DispatchFailure =
  | { kind: "rejected"; reason: ReasonCode }
  | { kind: "invalid"; reason: ReasonCode }
  | { kind: "transport"; reason: ReasonCode };

/**
 * The engine's reading of "now": the high-water mark of command ticks.
 *
 * NOT milliseconds, and never derived from a wall clock. Anything time-based
 * is computed from this counter so the same command sequence always produces
 * the same result (ADR-0017).
 *
 * ⚠️ The direction matters (ADR-0031): a host does NOT implement this to model
 * time. Translating wall time into a tick is the host's job and it happens
 * once — when the {@link Command} is built, which carries its own `tick`. This
 * port is the engine's *reading*: the maximum tick it has admitted, exposed
 * back to commands. There is no second "now" to disagree with.
 */
export interface Clock {
  nowTick(): number;
}

/**
 * Seeded deterministic random source. The seed lives in the save.
 *
 * `getState()` is MANDATORY (ADR-0033 §1): a host may not supply a random
 * source whose state it cannot export, because an unserializable stream makes
 * "save, reload, replay" produce a different world — determinism is one of
 * the three pillars (ADR-0017), and a save that does not round-trip is not a
 * save. The state is one number, so the cost is nil and restoring is O(1).
 */
export interface Rng {
  next(): number;
  /** The stream's whole state, as a single number (mulberry32: one uint32). */
  getState(): number;
}

export interface Snapshot<T = unknown> {
  version: number;
  data: T;
}

export interface SaveStore {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
}

export interface Command {
  /** Monotonic, assigned by the caller. Used for ordering, dedup and replay. */
  seq: number;
  /**
   * Explicit actor — never inferred from ambient "current character" state.
   * Retrofitting this later means changing every call site and reducer
   * signature (ADR-0025 §1.1).
   */
  actorId: string;
  /**
   * The engine tick this command happened at. Same law as `actorId`: context
   * is carried by the command, not inferred from the environment. The engine
   * keeps the high-water mark of these ticks and calls it "now" (ADR-0031).
   */
  tick: number;
  /** Raw player input, before parsing. */
  raw: string;
}

/**
 * Dispatch outcome for one command. `seq` identifies which command this
 * result answers (spec/01 §2.2): on `rejected` the seq IS consumed — an
 * event carrying it was emitted — while on `invalid`/`transport` no event
 * with that seq ever reaches the stream, so the caller knows it may reissue.
 */
export type CommandResult =
  | { ok: true; seq: number; events: GameEvent[] }
  | ({ ok: false; seq: number } & DispatchFailure);

/**
 * The skeleton every DELIVERED event carries — the part no factory invents
 * (spec/01 §5): the stampers own it. A command's events are stamped by the
 * pipeline (its seq/actorId and the now that command saw, §2.2 + §5.0); a
 * settlement event by the settler (seq/actorId) with its `tick` coming from
 * the due bucket's `dueTick` (ADR-0034 §3).
 */
export type EventSkeleton = {
  seq: number;
  /**
   * The tick this event is FOR (O1, spec/01 §5): the world time at which it
   * happened, never milliseconds and never a wall clock.
   *
   * Two stamping rules, one reason — a reader has to be able to render "three
   * days ago":
   * - a command's own events carry the now that command saw (the high-water
   *   mark raised by its tick);
   * - a SETTLEMENT event carries the tick it was DUE (a due bucket's
   *   `dueTick`), never the tick it was caught up on (ADR-0034 §3). Stamping
   *   the catch-up tick would make event order depend on which player logged
   *   in first, and replay would stop being deterministic.
   */
  tick: number;
  actorId: string;
};

/**
 * A `commandRefused` event: the semantic refusal. `reason` says WHICH
 * refusal; the remaining fields LOCATE the content copy the renderer reads
 * (`commandKey`'s `err_*` field named by `errKey`, spec/02 §5.4) and are
 * each optional — a pre-stage veto has only the reason to give.
 */
export type CommandRefusedEvent = EventSkeleton & {
  type: "commandRefused";
  reason: ReasonCode;
  /** The command entry whose copy words this refusal. */
  commandKey?: string;
  /** The gate vocabulary this refusal came from, when it came from a gate. */
  accessType?: AccessTypeCode;
  /** The ENTRY field the renderer reads the copy from (`err_*`, spec/02 §5.4). */
  errKey?: string;
  /** The room whose gate denied, when a room gate was the refuser. */
  roomId?: string;
  /**
   * The refusing hook, when a movement/speech hook vetoed. Closed over the
   * hook families that actually emit refusals today; a new family (the
   * get/give/drop transfer stages already exist in `world/transfer.ts`) joins
   * by widening this union when its refusal events land.
   */
  stage?: MoveVetoStage | SayVetoStage;
};

/** A `say` event: the spoken text verbatim, addressed to a location. */
export type SayEvent = EventSkeleton & {
  type: "say";
  speakerId: string;
  text: string;
  locationId: string;
};

/**
 * An `appearance` event: one room's digest for one viewer — the look
 * outcome. Ids and lists only: the names and copy stay in content data
 * (spec/01 §5.1), reached by id exactly like `err_*` text.
 */
export type AppearanceEvent = EventSkeleton & {
  type: "appearance";
  roomId: string;
  exits: readonly ExitDigest[];
  staticPresence: readonly StaticPresence[];
  occupants: readonly string[];
};

/** The move semantics both movement announcements carry. */
type MoveAnnouncement = EventSkeleton & {
  entityId: string;
  fromLocationId: string;
  toLocationId: string;
  moveType: MoveType;
  /** The exit traversed, when the move is a traversal; null/absent otherwise. */
  viaExitId?: string | null;
};

/** A `departed` event: one movement announcement, the leaving half. */
export type DepartedEvent = MoveAnnouncement & {
  type: "departed";
};

/** An `arrived` event: one movement announcement, the entering half. */
export type ArrivedEvent = MoveAnnouncement & {
  type: "arrived";
};

/**
 * A `strike` event: one attack landing (or being dodged) — the combat
 * kernel's one-row ledger (#56, spec/01 §5.2). Every field the PRESENTATION
 * needs rides on day one (damage band, remaining-life band, dodge/crit
 * flags, element, source, rank placeholder): a field added later would break
 * save and simulator compatibility — the union's stated red line.
 *
 * `damageRatio` / `defenderHpRatio` are BAND NAMES (string), not ratios: the
 * numbers live nowhere on the event, and which bands exist is pack
 * vocabulary (dimensions.json's damageBand/lifeBand, engine-reservations
 * discipline — the engine knows no band literal). `rank` is the optional
 * martial-rank placeholder: optional NOW so a later value is not a shape
 * change.
 */
export type StrikeEvent = EventSkeleton & {
  type: "strike";
  attackerId: string;
  defenderId: string;
  /** Damage dealt after mitigation; 0 when dodged. */
  damage: number;
  /** The damage band's name (pack vocabulary — dimensions damageBand). */
  damageRatio: string;
  /** The defender's remaining-life band's name (dimensions lifeBand). */
  defenderHpRatio: string;
  isDodge: boolean;
  /** C1 has no crits: always false, present for the day the roll exists. */
  isCrit: boolean;
  /** The attack's element name (pack vocabulary; "no element" is a pack value). */
  element: string;
  /** The attack's delivery method name (external/internal — pack vocabulary). */
  source: string;
  /** Martial-rank placeholder — never set in C1 (no martial arts yet). */
  rank?: string;
};

/**
 * A `dotTick` event: one damage-over-time pulse landing — the observable
 * half of observation-time compensation settlement (#56, spec/04 §4.2). The
 * `tick` stamp is the pulse's DUE tick (`startTick + k × interval`), never
 * the catch-up moment — the settlement-stamping rule (spec/01 §5.0).
 */
export type DotTickEvent = EventSkeleton & {
  type: "dotTick";
  /** The effect entry the poison instance rides (the look-up-back key). */
  effectId: string;
  /** Who the poison is on (the defender of every pulse). */
  targetId: string;
  /** Damage dealt by this pulse. */
  damage: number;
  /** The pulse damage's band name (dimensions damageBand). */
  damageRatio: string;
  /** The target's remaining-life band's name after this pulse (lifeBand). */
  defenderHpRatio: string;
  /** Pulses applied so far including this one. */
  pulsesApplied: number;
  /** The instance's pulse ceiling (the entry's maxPulses). */
  pulsesTotal: number;
};

/**
 * A `death` event: someone reached their death threshold. `kind` says which
 * side of the strike pair died (an npc is static presence — no tree row; a
 * player is a tree entity); `cause` names the killer arm.
 */
export type DeathEvent = EventSkeleton & {
  type: "death";
  /** Who died. */
  deceasedId: string;
  kind: "npc" | "player";
  cause: "strike" | "dot";
};

/**
 * The engine's event vocabulary — CLOSED, discriminated by `type`
 * (spec/01 §5). Eight arms are the engine's real names, the whole set: the
 * five from the command/world layer (commandRefused, say, appearance,
 * departed, arrived) plus the combat kernel's three (#56: strike, dotTick,
 * death). A synthetic type (`worldSettled`, `pong`) is not an engine event
 * and does not pretend to be one. A new engine event means a new arm here,
 * in the union, and a new factory in events.ts.
 */
export type EngineEvent =
  | CommandRefusedEvent
  | SayEvent
  | AppearanceEvent
  | DepartedEvent
  | ArrivedEvent
  | StrikeEvent
  | DotTickEvent
  | DeathEvent;

declare const customEventBrand: unique symbol;

/**
 * The extension arm: a synthetic or host event under the caller's own type.
 * BRANDED (type-only, no runtime property): only `customEvent()` hands these
 * out, so a hand-written literal drops into NO arm and fails to compile — a
 * misspelled engine field cannot hide in here either.
 *
 * ⚠️ Deliberately NO index signature. The open carrying of free fields lives
 * at CONSTRUCTION (`customEvent`'s `fields` parameter — a typo'd free field
 * is not reported there, the documented price of content freedom). An index
 * signature here would waive the union's fresh-literal excess check for the
 * WHOLE of `GameEvent`: a complete engine-arm literal plus one typo'd field
 * would then slip into the engine arm silently — the exact misspelling hole
 * this union exists to close (measured, not conjectured).
 */
export type CustomEventDraft = {
  readonly [customEventBrand]: "customEvent";
  type: string;
};

/**
 * A delivered custom event: the extension arm plus the stamped skeleton.
 *
 * Everything here is a TYPE ALIAS on purpose, and the fact is measured: an
 * intersection of object-literal aliases carries an IMPLICIT index signature
 * (so `GameEvent` still flows into the open `EventDraft` emit port), while an
 * interface — or an intersection with one — does not; and an implicit index
 * never waives the union's field checking the way an EXPLICIT
 * `[key: string]: unknown` does. Both halves are pinned in events.test.ts.
 */
export type CustomEvent = CustomEventDraft & EventSkeleton;

/**
 * A single engine occurrence — the CLOSED union (spec/01 §5): either one of
 * the engine's eight, or the branded extension arm. There is no index
 * signature to fall back on, so no event shape escapes the two construction
 * paths (events.ts).
 *
 * Closed on every TYPED boundary — annotations, expectations and the
 * factories' parameters all reject a hand-written or misspelled literal. The
 * emit PORT (`EventDraft`) stays open by design (spec/01 §5: the emission
 * batch is normalized, not compile-enforced), so a hand-built draft can still
 * ride it; engine src is scan-pinned, and a host's free construction is the
 * documented cost — `stampEvent` in events.ts is the single place a draft is
 * claimed to be its arm.
 *
 * Pure semantics — NEVER rendered text. Rendering is deferred to the text
 * surface (src/text, shipped WITH the engine since #50), per receiver, so
 * that a Chinese reader sees the second-person pronoun where an observer
 * sees a name (ADR-0006, docs/spec/05-output-pipeline.md).
 */
export type GameEvent = EngineEvent | CustomEvent;

export interface EventMeta {
  /** Inclusive seq range covered by this delivery, for gap detection. */
  fromSeq: number;
  toSeq: number;
}

export type GameListener = (events: GameEvent[], meta: EventMeta) => void;

/**
 * The authority over world state.
 *
 * The UI knows only this interface, never the implementation — swapping a
 * local authority for a remote one must not change a line of engine code
 * (ADR-0017, ADR-0025 §1).
 */
export interface Authority {
  dispatch(command: Command): Promise<CommandResult>;
  subscribe(listener: GameListener): () => void;
  snapshot(): Promise<Snapshot>;
}
