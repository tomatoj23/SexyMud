import type { EventDraft } from "./command/pipeline.js";
import type {
  AppearanceEvent,
  ArrivedEvent,
  CommandRefusedEvent,
  CustomCode,
  CustomEventDraft,
  DepartedEvent,
  EngineEvent,
  EventSkeleton,
  GameEvent,
  SayEvent,
} from "./types.js";

/**
 * Event construction in ONE place (spec/01 §5): a factory per engine event
 * type — commandRefused / say / appearance / departed / arrived — plus the
 * extension arm `customEvent(type, fields)` for synthetic and host events,
 * plus `stampEvent`, the one place a draft becomes a DELIVERED event.
 *
 * The factory unifies ONLY `type`, and it stamps it last: the skeleton
 * (seq/actorId/tick) belongs to the stampers — the pipeline stamps its
 * command's seq/actorId/tick and the now that command saw (spec/01 §2.2,
 * §5.0); on the settlement path the settler stamps seq/actorId and the due
 * bucket stamps the due tick (ADR-0034 §3) — and is never invented here.
 * What comes back is an `EventDraft`: exactly the fields handed in plus the
 * type, which is the emit port's whole contract.
 *
 * The per-type factories take their arm's own field type (types.ts): a
 * misspelled engine field or a smuggled skeleton key is a compile error
 * there — the pin `@ts-expect-error` tests hold. `customEvent`'s fields stay
 * wide on purpose (content freedom), so a typo'd free field passes silently.
 *
 * Names are the event type names with an `Event` suffix — `say` and
 * `appearance` are already taken by the say behaviour and look's room digest.
 */

/** What a factory takes: its arm's own semantic fields — no type, no skeleton. */
type FieldsOf<T> = Omit<T, keyof EventSkeleton | "type">;

/** A `commandRefused` event: the semantic refusal (reason + whatever locates its copy). */
export function commandRefusedEvent(fields: FieldsOf<CommandRefusedEvent>): EventDraft {
  return { ...fields, type: "commandRefused" };
}

/** A `say` event: the spoken text verbatim, addressed to a location (conversation data, not narrative). */
export function sayEvent(fields: FieldsOf<SayEvent>): EventDraft {
  return { ...fields, type: "say" };
}

/** An `appearance` event: one room's digest for one viewer — the look outcome. */
export function appearanceEvent(fields: FieldsOf<AppearanceEvent>): EventDraft {
  return { ...fields, type: "appearance" };
}

/** A `departed` event: one movement announcement, the leaving half. */
export function departedEvent(fields: FieldsOf<DepartedEvent>): EventDraft {
  return { ...fields, type: "departed" };
}

/** An `arrived` event: one movement announcement, the entering half. */
export function arrivedEvent(fields: FieldsOf<ArrivedEvent>): EventDraft {
  return { ...fields, type: "arrived" };
}

/**
 * The extension arm's factory: a synthetic or host event under the caller's
 * own type. The type argument wins over any `type` in `fields`, same as every
 * factory above — `type` is the one field construction owns.
 *
 * What comes back is the ONLY branded `CustomEventDraft` in the system: a
 * hand-written literal matches no arm of `GameEvent` (and no event
 * expectation), so the extension arm cannot be reached by accident. The
 * fields carry through generically — `customEvent("x", { tick })` knows it
 * carries a `tick` (a settlement draft's one must-get-right field).
 *
 * `fields` is OPEN on purpose (content freedom): a typo'd free field is not
 * reported — the documented price — and the arm type itself carries no index
 * signature, so that openness cannot leak into `GameEvent` and waive the
 * engine arms' field checking (types.ts spells out the measured reason).
 */
export function customEvent<F extends Record<string, unknown> = Record<string, unknown>>(
  type: string,
  fields?: F,
): CustomEventDraft & Omit<F, "type"> {
  return { ...(fields ?? {}), type } as CustomEventDraft & Omit<F, "type">;
}

/**
 * A host's own semantic CODE (types.ts): the branded half of every code
 * face. The brand is type-only — what comes back IS the string handed in, so
 * assertions compare the same values they always did.
 */
export function customCode(text: string): CustomCode {
  return text as CustomCode;
}

/**
 * The ONE construction a draft becomes a delivered event on: the stampers'
 * checked boundary (spec/01 §5). Both stamping spreads — the pipeline's
 * `{...draft, seq, actorId, tick}` and the settler's `{...draft, seq,
 * actorId}` — route through here, because an open draft cannot be spread
 * into the closed `GameEvent` union directly. The skeleton always wins over
 * any same-named key on the draft (the EventDraft contract), and no value is
 * ever altered. The cast is the one place claiming a factory-built draft is
 * its `GameEvent` arm — construction in one place is what makes it true.
 */
export function stampEvent(draft: EventDraft, skeleton: EventSkeleton): GameEvent {
  return { ...draft, ...skeleton } as GameEvent;
}

/**
 * Whether an event is one of the engine's five arms — the consumer-side
 * discriminator the union's design promises (types.ts: narrowing happens
 * between the five engine types; the extension arm's `type` is an open
 * string, so a `switch` on it alone cannot eliminate it). The honest limit
 * is the emit port's documented cost: a host-smuggled custom event claiming
 * an engine type rides that arm here, and its missing fields fail loudly
 * downstream.
 */
export function isEngineEvent(event: GameEvent): event is EngineEvent {
  return (
    event.type === "commandRefused" ||
    event.type === "say" ||
    event.type === "appearance" ||
    event.type === "departed" ||
    event.type === "arrived"
  );
}
