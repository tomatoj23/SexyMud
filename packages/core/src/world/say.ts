import { commandSpecFromEntry } from "../command/entry.js";
import type { CommandEntry } from "../command/entry.js";
import type { CommandRejection, CommandSpec } from "../command/pipeline.js";
import type { SayHookContext } from "./entity.js";
import { broadcastMessage } from "./message.js";
import type { MessagePorts } from "./message.js";
import type { WorldRuntime } from "./runtime.js";

/**
 * The say behaviour (spec/03 §7.4 + §7.7's say half, ADR-0028 §2): the
 * engine's factory say adapter and the hook orchestration beneath it.
 * Saying is a KERNEL behaviour, shipped by the engine and driven by the
 * world runtime plus the content registry — a host binds saySpec() to the
 * cmd-say content entry and a minimal world needs zero host-side game
 * code. The injection seam stays open: a host with special behaviour still
 * passes its own func.
 *
 * Two layers, each with a fixed contract:
 *
 *   say      — the hook orchestration (moveTo's counterpart for speech):
 *              at_pre_say (the speaker's veto point) → broadcastMessage
 *              (per-receiver delivery through every receiver's
 *              at_msg_receive, see message.ts) → at_post_say (the
 *              after-the-fact notification). Zero permission checks —
 *              gates are the command pipeline's business, exactly like
 *              moveTo.
 *   saySpec  — the factory adapter: a content command entry bound to the
 *              kernel behaviour through the same commandSpecFromEntry
 *              assembly as every command.
 *
 * Person stance (second person for the speaker, third for everyone else)
 * is the renderer's business per receiver (spec/01 §5.2): the engine
 * guarantees the per-receiver walk and events that carry the full context —
 * speaker, text, location — and that is all it guarantees. The spoken TEXT
 * is the player's own input passed through verbatim: it is conversation
 * data (a save/replay concern), not rendered narrative — wrapping it into
 * stance sentences happens per receiver, in the output pipeline, never here.
 */

/** One act of speech: who speaks, what they say. Where comes from the tree. */
export interface SayRequest {
  readonly speakerId: string;
  readonly text: string;
}

/** Where a say aborted: which vetoable hook refused. */
export type SayVetoStage = "at_pre_say";

export type SayResult = { ok: true } | { ok: false; stage: SayVetoStage };

/**
 * say — the speech orchestration (spec/03 §7.4 + §7.7's say half): the full
 * hook chain with ZERO permission checks (gates belong to the command
 * pipeline — the same reason moveTo carries none).
 *
 * The chain, in order (the veto precedes all delivery):
 *
 *   at_pre_say (speaker, veto — an explicit false aborts, nothing emitted)
 *   broadcastMessage — one say event per un-muted receiver among the
 *                      speaker's location's dynamic occupants, the speaker
 *                      included (per-receiver rendering turns the same
 *                      event into "you say" for the speaker and a name for
 *                      everyone else — the movement announces' rule)
 *   at_post_say (speaker, after the fact)
 *
 * The say event carries the full context (spec/01 §5.2): speakerId, text,
 * locationId — everything a renderer needs to stance it per receiver, and
 * nothing it does not (zero rendered text, spec/01 §5.1).
 */
export function say(runtime: WorldRuntime, request: SayRequest, ports: MessagePorts): SayResult {
  const speaker = runtime.entity(request.speakerId);
  const locationId = runtime.locationOf(request.speakerId);
  const hookContext: SayHookContext = {
    speakerId: request.speakerId,
    locationId,
    text: request.text,
    emit: ports.emit,
  };

  if (speaker.at_pre_say?.(hookContext) === false) {
    return { ok: false, stage: "at_pre_say" };
  }

  broadcastMessage(
    runtime,
    {
      locationId,
      draft: {
        type: "say",
        speakerId: request.speakerId,
        text: request.text,
        locationId,
      },
      fromEntityId: request.speakerId,
    },
    ports,
  );

  speaker.at_post_say?.(hookContext);
  return { ok: true };
}

/**
 * The engine's factory say adapter (ADR-0028 §2): bind this to the say
 * command's content entry and `call()` runs the whole chain — verb table,
 * parse, this func. The behaviour: the parsed text (argForm "text") goes
 * through say(); a vetoed at_pre_say becomes a CommandRejection whose
 * commandRefused event carries the veto semantics (commandKey, the
 * refusing stage) — the same shape a movement hook veto reports
 * (moveVetoed), and like every rejected result the seq is consumed.
 *
 * The spoken text stays verbatim in the event — conversation data, not
 * rendered narrative (see the module doc). "use" is the command
 * collection's fixed gate vocabulary (content.md), the same word lookSpec
 * and traversalSpec ask of their entries.
 */
export function saySpec(entry: CommandEntry): CommandSpec<WorldRuntime> {
  if (entry.argForm !== "text") {
    // Wiring bug, not play: the kernel say behaviour speaks the parsed text
    // — an entry with another argument form belongs to a different
    // behaviour (target-directed speech is not M2's).
    throw new Error(
      `saySpec: entry "${entry.id}" declares argForm "${entry.argForm}" — the kernel say behaviour speaks free text`,
    );
  }
  return commandSpecFromEntry<WorldRuntime>(entry, {
    accessType: "use",
    func: (ctx) => {
      const text = ctx.args;
      if (typeof text !== "string") {
        // Wiring bug, not play: argForm "text" parses to a string; anything
        // else means a custom parse hook disagreed with the declared form.
        throw new Error(
          `saySpec: parsed args for "${entry.id}" are not a text string`,
        );
      }
      const outcome = say(ctx.world, { speakerId: ctx.command.actorId, text }, { emit: ctx.emit });
      if (!outcome.ok) {
        ctx.emit(ctx.command.actorId, {
          type: "commandRefused",
          reason: "sayVetoed",
          commandKey: entry.id,
          stage: outcome.stage,
        });
        const rejection: CommandRejection = { kind: "rejected", reason: "sayVetoed" };
        return rejection;
      }
    },
  });
}
