import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CommandResult } from "../src/types.js";
import { commandSetSources } from "../src/command/entry.js";
import type { CommandEntry } from "../src/command/entry.js";
import type { CommandSpec, Message } from "../src/command/pipeline.js";
import { createCommandHarness, expectMessageSequence } from "../src/command/testing.js";
import { createContentRegistry } from "../src/content/registry.js";
import type { ContentRegistry } from "../src/content/registry.js";
import { broadcastMessage } from "../src/world/message.js";
import type { MessagePorts } from "../src/world/message.js";
import { createEntity } from "../src/world/entity.js";
import type { Entity, EntityHooks } from "../src/world/entity.js";
import { say, saySpec } from "../src/world/say.js";
import type { NpcEntry, RoomEntry } from "../src/world/entry.js";
import { createWorldRuntime } from "../src/world/runtime.js";
import type { WorldRuntime } from "../src/world/runtime.js";

/**
 * The M2-T3 say behaviour (issue #9, spec/03 §7.4 + §7.7's say half,
 * ADR-0028 §2): the receiver-side message hook (at_msg_receive, vetoable,
 * fromObj nullable), the speaker-side pre/post pair (at_pre_say vetoable,
 * at_post_say after the fact), the per-receiver broadcast primitive they ride
 * on, and the engine's factory say adapter bound to the real cmd-say content
 * entry. As with look and traversal, this test plays the HOST: real content,
 * live runtime, per-dispatch cmdset re-merge; the second and third fake
 * players drive the same-room / far-room receiver scenes.
 *
 * Person stance (you / he / she) is deliberately NOT tested as output — it is
 * the renderer's business per receiver (spec/01 §5.2). What IS tested: the
 * engine walks the same-room dynamic-occupancy set one receiver at a time,
 * each emitted event carries the full context (speaker, text, location), and
 * no event ever carries rendered text.
 */

const contentDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../content");

function loadCollection<T>(name: string): T[] {
  const dir = join(contentDir, name);
  return readdirSync(dir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => JSON.parse(readFileSync(join(dir, fileName), "utf8")) as T);
}

const RECEIVERS = ["actor-1", "actor-2", "actor-3"];

// ---------------------------------------------------------------------------
// Synthetic world (engine-only, no content files): the hook orchestration
// itself, in the style of entity-move.test.ts.
// ---------------------------------------------------------------------------

function makeRooms(): RoomEntry[] {
  const room = (id: string): RoomEntry => ({
    id,
    name: `name-${id}`,
    description: `description-${id}`,
    enterText: `enter-${id}`,
    exits: [],
  });
  return [room("room-a"), room("room-b")];
}

function makeRuntime(): WorldRuntime {
  return createWorldRuntime({ registry: createContentRegistry({ rooms: makeRooms() }) });
}

/** One collected emission: the recipient plus the un-stamped semantic draft. */
interface Emission {
  to: string;
  draft: { type: string } & Record<string, unknown>;
}

function makePorts(): { ports: MessagePorts; emissions: Emission[] } {
  const emissions: Emission[] = [];
  return {
    emissions,
    ports: {
      emit: (to, draft) => {
        emissions.push({ to, draft: draft as Emission["draft"] });
      },
    },
  };
}

/** An entity that logs every message-family hook it receives. */
function recorder(id: string, log: string[], hooks: Partial<EntityHooks> = {}): Entity {
  return createEntity(id, {
    at_msg_receive: (ctx) => {
      log.push(`${id}:at_msg_receive(from=${ctx.fromEntityId ?? "none"},to=${ctx.receiverId})`);
    },
    at_pre_say: () => {
      log.push(`${id}:at_pre_say`);
    },
    at_post_say: () => {
      log.push(`${id}:at_post_say`);
    },
    ...hooks,
  });
}

describe("say — the hook orchestration (spec/03 §7.4, §7.7's say half)", () => {
  it("runs at_pre_say, the per-receiver broadcast, then at_post_say — in that order", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(recorder("listener-1", log), "room-a");
    runtime.addEntity(recorder("speaker-1", log), "room-a");
    const { ports, emissions } = makePorts();

    const result = say(runtime, { speakerId: "speaker-1", text: "the wind rises tonight" }, ports);

    expect(result).toEqual({ ok: true });
    // Receivers walk ascending (listener-1 < speaker-1), the speaker included:
    // per-receiver rendering turns the same event into "you" for the speaker
    // and a name for everyone else — exactly like the movement announces.
    expect(log).toEqual([
      "speaker-1:at_pre_say",
      "listener-1:at_msg_receive(from=speaker-1,to=listener-1)",
      "speaker-1:at_msg_receive(from=speaker-1,to=speaker-1)",
      "speaker-1:at_post_say",
    ]);
    expect(emissions).toEqual([
      {
        to: "listener-1",
        draft: {
          type: "say",
          speakerId: "speaker-1",
          text: "the wind rises tonight",
          locationId: "room-a",
        },
      },
      {
        to: "speaker-1",
        draft: {
          type: "say",
          speakerId: "speaker-1",
          text: "the wind rises tonight",
          locationId: "room-a",
        },
      },
    ]);
  });

  it("aborts at at_pre_say's explicit false: no broadcast, no post hook", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(recorder("listener-1", log), "room-a");
    runtime.addEntity(
      createEntity("speaker-1", {
        at_pre_say: () => {
          log.push("speaker-1:at_pre_say");
          return false;
        },
      }),
      "room-a",
    );
    const { ports, emissions } = makePorts();

    const result = say(runtime, { speakerId: "speaker-1", text: "silenced" }, ports);

    expect(result).toEqual({ ok: false, stage: "at_pre_say" });
    expect(log).toEqual(["speaker-1:at_pre_say"]);
    expect(emissions).toEqual([]);
  });

  it("treats a void-returning at_pre_say as proceed (only an explicit false vetoes)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(
      createEntity("speaker-1", {
        at_pre_say: () => {
          // side effects only, no return value
        },
      }),
      "room-a",
    );
    const { ports, emissions } = makePorts();

    const result = say(runtime, { speakerId: "speaker-1", text: "still audible" }, ports);

    expect(result).toEqual({ ok: true });
    expect(emissions).toHaveLength(1);
  });

  it("throws loudly on an unregistered speaker (wiring bug, not play)", () => {
    const runtime = makeRuntime();
    const { ports } = makePorts();
    expect(() => say(runtime, { speakerId: "ghost", text: "anyone?" }, ports)).toThrow(
      /unknown entity/,
    );
  });
});

describe("broadcastMessage — at_msg_receive is a first-class citizen (spec/03 §7.4)", () => {
  it("delivers one event per receiver, each through that receiver's at_msg_receive", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(recorder("alpha", log), "room-a");
    runtime.addEntity(recorder("beta", log), "room-a");
    runtime.addEntity(recorder("far-1", log), "room-b");
    const { ports, emissions } = makePorts();

    broadcastMessage(
      runtime,
      { locationId: "room-a", draft: { type: "ambient", tier: 2 } },
      ports,
    );

    // Same-room occupants only, ascending; the far-room entity never hears.
    expect(log).toEqual([
      "alpha:at_msg_receive(from=none,to=alpha)",
      "beta:at_msg_receive(from=none,to=beta)",
    ]);
    expect(emissions).toEqual([
      { to: "alpha", draft: { type: "ambient", tier: 2 } },
      { to: "beta", draft: { type: "ambient", tier: 2 } },
    ]);
  });

  it("drops the message for a receiver whose at_msg_receive returns an explicit false — others unaffected", () => {
    const runtime = makeRuntime();
    const log: string[] = [];
    runtime.addEntity(
      createEntity("deaf-1", {
        at_msg_receive: (ctx) => {
          log.push(`deaf-1:at_msg_receive(from=${ctx.fromEntityId ?? "none"},to=${ctx.receiverId})`);
          // Muting is a receiver-side decision with the full context in hand:
          // "not from that sender" is the classic mute.
          return ctx.fromEntityId !== "speaker-1";
        },
      }),
      "room-a",
    );
    runtime.addEntity(recorder("hearing-1", log), "room-a");
    const { ports, emissions } = makePorts();

    broadcastMessage(
      runtime,
      {
        locationId: "room-a",
        draft: { type: "say", speakerId: "speaker-1", text: "behind you" },
        fromEntityId: "speaker-1",
      },
      ports,
    );

    // Both receivers' hooks ran (each decided); the muted one got no event.
    expect(log).toEqual([
      "deaf-1:at_msg_receive(from=speaker-1,to=deaf-1)",
      "hearing-1:at_msg_receive(from=speaker-1,to=hearing-1)",
    ]);
    expect(emissions).toEqual([
      {
        to: "hearing-1",
        draft: { type: "say", speakerId: "speaker-1", text: "behind you" },
      },
    ]);
  });

  it("carries fromEntityId undefined for senderless system messages — the fromObj-nullable path", () => {
    const runtime = makeRuntime();
    const seen: Array<{ from: string | undefined; receiverId: string }> = [];
    runtime.addEntity(
      createEntity("alpha", {
        at_msg_receive: (ctx) => {
          seen.push({ from: ctx.fromEntityId, receiverId: ctx.receiverId });
        },
      }),
      "room-a",
    );
    runtime.addEntity(
      createEntity("beta", {
        at_msg_receive: (ctx) => {
          seen.push({ from: ctx.fromEntityId, receiverId: ctx.receiverId });
        },
      }),
      "room-a",
    );
    const { ports, emissions } = makePorts();

    // The host's system path: a semantic event with NO sender — the renderer
    // locates the copy by key, exactly like err_* fields. fromObj is null.
    broadcastMessage(
      runtime,
      { locationId: "room-a", draft: { type: "systemNotice", noticeKey: "night-falls" } },
      ports,
    );

    expect(seen).toEqual([
      { from: undefined, receiverId: "alpha" },
      { from: undefined, receiverId: "beta" },
    ]);
    expect(emissions).toEqual([
      { to: "alpha", draft: { type: "systemNotice", noticeKey: "night-falls" } },
      { to: "beta", draft: { type: "systemNotice", noticeKey: "night-falls" } },
    ]);
  });

  it("treats a void-returning at_msg_receive as receive (only an explicit false mutes)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(
      createEntity("alpha", {
        at_msg_receive: () => {
          // observing only, no return value
        },
      }),
      "room-a",
    );
    const { ports, emissions } = makePorts();

    broadcastMessage(runtime, { locationId: "room-a", draft: { type: "ping" } }, ports);

    expect(emissions).toEqual([{ to: "alpha", draft: { type: "ping" } }]);
  });

  it("broadcasts into an entity container's occupants just the same (any location)", () => {
    const runtime = makeRuntime();
    runtime.addEntity(createEntity("box-1"), "room-a");
    runtime.addEntity(createEntity("stowaway-1"), "box-1");
    const { ports, emissions } = makePorts();

    broadcastMessage(runtime, { locationId: "box-1", draft: { type: "whisper" } }, ports);

    expect(emissions).toEqual([{ to: "stowaway-1", draft: { type: "whisper" } }]);
  });

  it("throws loudly on an unresolvable location (wiring bug, not a silent empty broadcast)", () => {
    const runtime = makeRuntime();
    const { ports } = makePorts();
    expect(() =>
      broadcastMessage(runtime, { locationId: "nowhere", draft: { type: "ping" } }, ports),
    ).toThrow(/neither a loaded room nor a registered entity/);
  });
});

// ---------------------------------------------------------------------------
// Real content, host mode: the factory adapter through call().
// ---------------------------------------------------------------------------

interface DriveOutcome {
  result: CommandResult;
  messages: Message[];
}

/**
 * A host session over the live runtime: each dispatch re-merges the sources
 * of the actor's current room (sources change with location) and runs the
 * given spec for the input. The seq counter is session-wide and monotonic,
 * as a real host's would be.
 */
function makeDriver(registry: ContentRegistry, runtime: WorldRuntime) {
  let seq = 0;
  const call = (actorId: string, input: string, spec: CommandSpec<WorldRuntime>): DriveOutcome => {
    const roomId = runtime.locationOf(actorId);
    const room = registry.room(roomId);
    seq += 1;
    const harness = createCommandHarness<WorldRuntime>({
      world: runtime,
      liveWorld: true,
      receivers: RECEIVERS,
      cmdsets: [...commandSetSources(registry.commands), ...commandSetSources(room.exits)],
      subjectOf: (world, id) => world.subjectOf(id),
    });
    return harness.call(spec, input, { actorId, seq });
  };
  const sayInput = (actorId: string, input: string): DriveOutcome =>
    call(actorId, input, saySpec(registry.command("cmd-say")));
  return { sayInput };
}

function loadRegistry(): ContentRegistry {
  return createContentRegistry({
    commands: loadCollection<CommandEntry>("commands"),
    rooms: loadCollection<RoomEntry>("rooms"),
    npcs: loadCollection<NpcEntry>("npcs"),
    monsters: loadCollection<{ id: string }>("monster"),
  });
}

/**
 * The standard three-player stage: two fake players in the inn hall (which
 * also places the innkeeper — static presence, never a receiver), one in the
 * village mouth. Per-player hook overrides ride in through createEntity.
 */
function makeStage(hooks: Record<string, Partial<EntityHooks>> = {}) {
  const registry = loadRegistry();
  const runtime = createWorldRuntime({ registry });
  runtime.addEntity(createEntity("actor-1", hooks["actor-1"]), "room-lq-003");
  runtime.addEntity(createEntity("actor-2", hooks["actor-2"]), "room-lq-003");
  runtime.addEntity(createEntity("actor-3", hooks["actor-3"]), "room-lq-001");
  return { registry, runtime, drive: makeDriver(registry, runtime) };
}

describe("the say factory adapter over real content (ADR-0028 §2)", () => {
  it("runs the full chain through call(): same-room players each get one say event, the far player none", () => {
    const { drive } = makeStage();

    const out = drive.sayInput("actor-1", "说 今夜风大");

    expect(out.result).toEqual({ ok: true, seq: 1, events: expect.any(Array) });
    // The speaker AND the same-room player each get their own event; the
    // far-room player gets nothing. Static presence (the innkeeper) never
    // consumes events — receivers are dynamic occupancy only (ADR-0028 §1).
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "say",
          speakerId: "actor-1",
          text: "今夜风大",
          locationId: "room-lq-003",
        },
      },
      {
        to: "actor-2",
        event: {
          type: "say",
          speakerId: "actor-1",
          text: "今夜风大",
          locationId: "room-lq-003",
        },
      },
    ]);
    expect(out.messages.filter((message) => message.to === "actor-3")).toEqual([]);
  });

  it("carries zero rendered text: the event's text is the player's input verbatim, no stance, no quoting", () => {
    const { registry, drive } = makeStage();

    const out = drive.sayInput("actor-1", "说 今夜风大，诸位早些歇息");

    const event = out.messages[0]?.event as Record<string, unknown>;
    // The spoken text passes through untouched — wrapping it into 「…」 or
    // prefixing a stance sentence is the renderer's job per receiver.
    expect(event.text).toBe("今夜风大，诸位早些歇息");
    expect(JSON.stringify(out.messages)).not.toContain("说道");
    expect(JSON.stringify(out.messages)).not.toContain("你说");
    // Static presence stays out of the event: the innkeeper's name is data,
    // and the spoken line above deliberately does not contain it either.
    expect(JSON.stringify(out.messages)).not.toContain(registry.npc("npc-lq-002").name);
  });

  it("follows the English verb to the same dispatch — verbs are data", () => {
    const { drive } = makeStage();

    const out = drive.sayInput("actor-1", "say hello there");

    expect(out.result.ok).toBe(true);
    expect(out.messages).toHaveLength(2);
    const event = out.messages[0]?.event as Record<string, unknown>;
    expect(event.text).toBe("hello there");
  });

  it("refuses when at_pre_say vetoes: rejected with the veto semantics, zero broadcast", () => {
    const { drive } = makeStage({
      "actor-1": { at_pre_say: () => false },
    });

    const out = drive.sayInput("actor-1", "说 今夜风大");

    // A hook veto is a legitimate mid-execution refusal (the
    // CommandRejection channel): rejected consumes the seq, exactly like a
    // movement hook veto (moveVetoed) and a visibility refusal (notVisible).
    expect(out.result).toEqual({ ok: false, seq: 1, kind: "rejected", reason: "sayVetoed" });
    expectMessageSequence(out.messages, [
      {
        to: "actor-1",
        event: {
          type: "commandRefused",
          reason: "sayVetoed",
          commandKey: "cmd-say",
          stage: "at_pre_say",
        },
      },
    ]);
  });

  it("blocks one receiver via a synthetic at_msg_receive hook: the others still hear (issue #9 demo)", () => {
    const { drive } = makeStage({
      "actor-2": { at_msg_receive: () => false },
    });

    const out = drive.sayInput("actor-1", "说 今夜风大");

    expect(out.result.ok).toBe(true);
    expect(out.messages.map((message) => message.to)).toEqual(["actor-1"]);
  });

  it("delivers a senderless system message through the same seam over the real world (fromObj nullable)", () => {
    const { runtime } = makeStage();
    const emissions: Emission[] = [];
    const ports: MessagePorts = {
      emit: (to, draft) => {
        emissions.push({ to, draft: draft as Emission["draft"] });
      },
    };

    // The host's system path: no speaker, no command — the engine seam is
    // broadcastMessage itself, the same primitive say rides on.
    broadcastMessage(
      runtime,
      { locationId: "room-lq-003", draft: { type: "systemNotice", noticeKey: "dusk-falls" } },
      ports,
    );

    expect(emissions).toEqual([
      { to: "actor-1", draft: { type: "systemNotice", noticeKey: "dusk-falls" } },
      { to: "actor-2", draft: { type: "systemNotice", noticeKey: "dusk-falls" } },
    ]);
  });

  it("is deterministic: two identical sessions emit identical streams (ADR-0017)", () => {
    const runSession = () => {
      const { drive } = makeStage();
      return [drive.sayInput("actor-1", "说 今夜风大"), drive.sayInput("actor-2", "say hi")].map(
        (out) => ({ result: out.result, messages: out.messages }),
      );
    };

    expect(runSession()).toEqual(runSession());
  });

  it("fails loudly when bound to an entry that is not argForm text (wiring bug, not play)", () => {
    const base = loadCollection<CommandEntry>("commands").find((c) => c.id === "cmd-say")!;
    const entry: CommandEntry = { ...base, argForm: "none" };
    expect(() => saySpec(entry)).toThrow(/argForm/);
  });
});
