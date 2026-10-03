import type { EventDraft } from "./command/pipeline.js";

/**
 * Event construction in ONE place (spec/01 §5): a factory per engine event
 * type — commandRefused / say / appearance / departed / arrived — plus the
 * extension arm `customEvent(type, fields)` for synthetic and host events.
 *
 * The factory unifies ONLY `type`, and it stamps it last: the skeleton
 * (seq/actorId/tick) belongs to the stampers — the pipeline stamps its
 * command's seq/actorId/tick and the now that command saw (spec/01 §2.2,
 * §5.0); on the settlement path the settler stamps seq/actorId and the due
 * bucket stamps the due tick (ADR-0034 §3) — and is never invented here.
 * What comes back is an `EventDraft`: exactly the fields handed in plus the
 * type, which is the emit port's whole contract.
 *
 * Names are the event type names with an `Event` suffix — `say` and
 * `appearance` are already taken by the say behaviour and look's room digest.
 */

/** A `commandRefused` event: the semantic refusal (reason + whatever locates its copy). */
export function commandRefusedEvent(fields: Record<string, unknown>): EventDraft {
  return { ...fields, type: "commandRefused" };
}

/** A `say` event: the spoken text verbatim, addressed to a location (conversation data, not narrative). */
export function sayEvent(fields: Record<string, unknown>): EventDraft {
  return { ...fields, type: "say" };
}

/** An `appearance` event: one room's digest for one viewer — the look outcome. */
export function appearanceEvent(fields: Record<string, unknown>): EventDraft {
  return { ...fields, type: "appearance" };
}

/** A `departed` event: one movement announcement, the leaving half. */
export function departedEvent(fields: Record<string, unknown>): EventDraft {
  return { ...fields, type: "departed" };
}

/** An `arrived` event: one movement announcement, the entering half. */
export function arrivedEvent(fields: Record<string, unknown>): EventDraft {
  return { ...fields, type: "arrived" };
}

/**
 * The extension arm's factory: a synthetic or host event under the caller's
 * own type. The type argument wins over any `type` in `fields`, same as every
 * factory above — `type` is the one field construction owns.
 */
export function customEvent(type: string, fields?: Record<string, unknown>): EventDraft {
  return { ...(fields ?? {}), type };
}
