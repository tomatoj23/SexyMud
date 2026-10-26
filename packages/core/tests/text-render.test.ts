import { describe, expect, it } from "vitest";
import {
  appearanceEvent,
  arrivedEvent,
  commandRefusedEvent,
  customCode,
  customEvent,
  departedEvent,
  sayEvent,
  stampEvent,
} from "../src/events.js";
import type { EventSkeleton, GameEvent } from "../src/types.js";
import type { OutputLine, OutputSpan } from "../src/text/line.js";
import { renderEvent } from "../src/text/render.js";
import type { ObserverState, RenderContent, RenderCopy } from "../src/text/render.js";
import { markupKey } from "../src/text/markup.js";

/**
 * The rendering half of the text surface (issue #50, spec/05 §2–§4): the
 * five engine event types as pure functions of (event, observer, injected
 * content). Every Chinese word below — pronouns, templates, refusal copy,
 * names, enter text — is INJECTED, exactly as Q6/Q7 ruled: the engine holds
 * the mechanism (stance resolution, template substitution, span structure)
 * and zero words, so the engine-purity scan stays honest and another pack
 * renders through the same functions with its own voice.
 *
 * Actor stance (spec/05 §3): the same say/departed/arrived event reads in
 * the second person for its actor ("你…") and by name for everyone else
 * ("黑衣人…" — the acceptance criteria's own example pair). Chinese needs no
 * verb conjugation for this, only the pronoun swap.
 */

const SKELETON: EventSkeleton = { seq: 7, tick: 120, actorId: "player-1" };

/** The test pack's voice — everything the engine does not own. */
const COPY: RenderCopy = {
  you: "你",
  sayLine: `${markupKey("speaker")}说：${markupKey("text")}`,
  departedLine: `${markupKey("mover")}经${markupKey("exit")}离开了${markupKey("from")}`,
  arrivedLine: `${markupKey("mover")}经${markupKey("exit")}来到了${markupKey("to")}`,
  appearanceTitle: `〔${markupKey("name")}〕`,
  appearanceExits: `出路：${markupKey("exits")}`,
  presenceRow: `${markupKey("name")}×${markupKey("count")}`,
  appearanceItems: `这里有：${markupKey("items")}`,
  appearancePeople: `在场：${markupKey("people")}`,
  listJoin: "、",
};

const CONTENT: RenderContent = {
  copy: COPY,
  names: {
    "player-1": "张三",
    "player-2": "李四",
    "npc-guard": "黑衣人",
    "room-lq-001": "镇口",
    "room-lq-002": "街市",
    "exit-north": "北",
  },
  descriptions: { "room-lq-001": "青石官道尽头，一座斑驳的石牌坊。" },
  enterTexts: { "room-lq-002": "人声渐密，你随着人流走进了街市。" },
  errCopy: {
    "cmd-rest": { err_use: "你伤势未愈，此刻无法安歇。" },
    "exit-inn-north": { err_traverse: "店小二拦住你：客官，上楼歇息请出示住客木牌。" },
  },
  reasonCopy: { unknownVerb: "这是什么招式？", gateClosed: "此路今夜封闭。", accessDenied: "你走不到那里。" },
};

const observer = (id: string): ObserverState => ({ observerId: id });

const stamped = (draft: Parameters<typeof stampEvent>[0]): GameEvent =>
  stampEvent(draft, SKELETON);

/** Line texts of a render, for assertions that read like output. */
const texts = (lines: readonly OutputLine[]): string[] => lines.map((line) => line.text);

/** Spans as "text@style" — readable structure assertions. */
const shapes = (line: OutputLine): string[] =>
  line.spans.map((span: OutputSpan) => `${span.text}@${span.style}`);

describe("renderEvent — say", () => {
  const said = stamped(
    sayEvent({ speakerId: "player-1", text: "天色不错", locationId: "room-lq-001" }),
  );

  it("renders the speaker's own event in the second person (你)", () => {
    const lines = renderEvent(said, observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["你说：天色不错"]);
    expect(shapes(lines[0] as OutputLine)).toEqual(["你@npcName", "说：天色不错@plain"]);
  });

  it("renders another speaker by name for a different observer (黑衣人)", () => {
    const guardSaid = stamped(
      sayEvent({ speakerId: "npc-guard", text: "此路不通！", locationId: "room-lq-001" }),
    );
    const lines = renderEvent(guardSaid, observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["黑衣人说：此路不通！"]);
    expect(shapes(lines[0] as OutputLine)).toEqual(["黑衣人@npcName", "说：此路不通！@plain"]);
  });

  it("passes the spoken text through verbatim", () => {
    const noisy = stamped(
      sayEvent({ speakerId: "player-1", text: "半角!与「括号」混排", locationId: "room-lq-001" }),
    );
    expect(texts(renderEvent(noisy, observer("player-2"), CONTENT))).toEqual([
      "张三说：半角!与「括号」混排",
    ]);
  });
});

describe("renderEvent — departed / arrived (Actor stance)", () => {
  const move = {
    entityId: "player-1",
    fromLocationId: "room-lq-001",
    toLocationId: "room-lq-002",
    moveType: "traverse" as const,
    viaExitId: "exit-north",
  };

  it("renders the mover's own departure as 你", () => {
    const lines = renderEvent(stamped(departedEvent(move)), observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["你经北离开了镇口"]);
  });

  it("renders another mover by name for an observer", () => {
    const lines = renderEvent(stamped(departedEvent(move)), observer("player-2"), CONTENT);
    expect(texts(lines)).toEqual(["张三经北离开了镇口"]);
  });

  it("renders the mover's own arrival as 你, styled on the mover", () => {
    const lines = renderEvent(stamped(arrivedEvent(move)), observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["你经北来到了街市", "人声渐密，你随着人流走进了街市。"]);
    expect(shapes(lines[0] as OutputLine)).toEqual([
      "你@npcName",
      "经@plain",
      "北@commandHint",
      "来到了街市@plain",
    ]);
  });

  it("renders an arrival WITHOUT the destination's enter text when the table has none (Q7: injected)", () => {
    const teleport = { ...move, toLocationId: "room-lq-001", viaExitId: null };
    const lines = renderEvent(stamped(arrivedEvent(teleport)), observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["你经来到了镇口"]);
  });

  it("substitutes an empty {exit} when the move names no exit", () => {
    const teleport = { ...move, viaExitId: null };
    const lines = renderEvent(stamped(departedEvent(teleport)), observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["你经离开了镇口"]);
  });

  it("falls back to the raw id for a name the table does not carry", () => {
    const stranger = { ...move, entityId: "npc-stranger" };
    const lines = renderEvent(stamped(departedEvent(stranger)), observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["npc-stranger经北离开了镇口"]);
  });
});

describe("renderEvent — arrived carries the destination's enterText (Q7)", () => {
  it("appends the enter text as its own plain line after the arrival sentence", () => {
    const move = {
      entityId: "player-1",
      fromLocationId: "room-lq-001",
      toLocationId: "room-lq-002",
      moveType: "traverse" as const,
      viaExitId: "exit-north",
    };
    const lines = renderEvent(stamped(arrivedEvent(move)), observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["你经北来到了街市", "人声渐密，你随着人流走进了街市。"]);
    expect(shapes(lines[1] as OutputLine)).toEqual(["人声渐密，你随着人流走进了街市。@plain"]);
  });
});

describe("renderEvent — appearance", () => {
  const looked = stamped(
    appearanceEvent({
      roomId: "room-lq-001",
      exits: [
        { exitId: "exit-north", direction: "北", verbs: ["北", "north"] },
        { exitId: "exit-east", direction: "东", verbs: ["东", "east"] },
      ],
      staticPresence: [{ id: "npc-guard", count: 2 }],
      occupants: ["npc-guard"],
    }),
  );

  it("renders title, description, exits, presence and occupants in order", () => {
    const lines = renderEvent(looked, observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual([
      "〔镇口〕",
      "青石官道尽头，一座斑驳的石牌坊。",
      "出路：北、东",
      "这里有：黑衣人×2",
      "在场：黑衣人",
    ]);
  });

  it("styles the title as roomName, directions as commandHint, items and people by their kinds", () => {
    const lines = renderEvent(looked, observer("player-1"), CONTENT);
    expect(shapes(lines[0] as OutputLine)).toEqual(["〔@plain", "镇口@roomName", "〕@plain"]);
    expect(shapes(lines[2] as OutputLine)).toEqual(["出路：@plain", "北、东@commandHint"]);
    expect(shapes(lines[3] as OutputLine)).toEqual([
      "这里有：@plain",
      "黑衣人@itemName",
      "×2@plain",
    ]);
    expect(shapes(lines[4] as OutputLine)).toEqual(["在场：@plain", "黑衣人@npcName"]);
  });

  it("skips the description line when the table carries none, and list lines when empty", () => {
    const bare = stamped(
      appearanceEvent({ roomId: "room-lq-002", exits: [], staticPresence: [], occupants: [] }),
    );
    const lines = renderEvent(bare, observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["〔街市〕"]);
  });
});

describe("renderEvent — commandRefused reads its copy through the injected tables", () => {
  it("reads the entry's err_* copy by commandKey + errKey (spec/02 §5.4)", () => {
    const refused = stamped(
      commandRefusedEvent({
        reason: "accessDenied",
        commandKey: "exit-inn-north",
        accessType: "traverse",
        errKey: "err_traverse",
      }),
    );
    const lines = renderEvent(refused, observer("player-1"), CONTENT);
    expect(texts(lines)).toEqual(["店小二拦住你：客官，上楼歇息请出示住客木牌。"]);
    expect(shapes(lines[0] as OutputLine)).toEqual([
      "店小二拦住你：客官，上楼歇息请出示住客木牌。@danger",
    ]);
  });

  it("falls back to the reason code's copy when no entry copy locates it", () => {
    const refused = stamped(commandRefusedEvent({ reason: "unknownVerb" }));
    expect(texts(renderEvent(refused, observer("player-1"), CONTENT))).toEqual([
      "这是什么招式？",
    ]);
  });

  it("answers a custom code's copy through the same reason face", () => {
    const refused = stamped(commandRefusedEvent({ reason: customCode("gateClosed") }));
    expect(texts(renderEvent(refused, observer("player-1"), CONTENT))).toEqual([
      "此路今夜封闭。",
    ]);
  });

  it("prefers the entry's err_* copy over the reason copy when both exist", () => {
    const refused = stamped(
      commandRefusedEvent({
        reason: "accessDenied",
        commandKey: "cmd-rest",
        accessType: "use",
        errKey: "err_use",
      }),
    );
    // reasonCopy carries "accessDenied" too ("你走不到那里。") — the entry's
    // specific err_* copy must win, pinning the PRIORITY direction itself
    expect(texts(renderEvent(refused, observer("player-1"), CONTENT))).toEqual([
      "你伤势未愈，此刻无法安歇。",
    ]);
  });

  it("throws loudly when no injected copy covers the refusal (a wiring miss)", () => {
    const refused = stamped(
      commandRefusedEvent({ reason: "moveVetoed", commandKey: "exit-inn-north", stage: "at_pre_move" }),
    );
    expect(() => renderEvent(refused, observer("player-1"), CONTENT)).toThrow(/renderEvent/);
  });
});

describe("renderEvent — the extension arm renders nothing, by explicit decision", () => {
  it("returns no lines for a custom event (the seam lands with the mechanism tickets)", () => {
    const settled = stamped(customEvent("worldSettled", { span: 10 }));
    expect(renderEvent(settled, observer("player-1"), CONTENT)).toEqual([]);
  });
});

describe("renderEvent — purity", () => {
  it("is deterministic: same event, same observer, same content, same lines", () => {
    const said = stamped(
      sayEvent({ speakerId: "player-1", text: "天色不错", locationId: "room-lq-001" }),
    );
    expect(renderEvent(said, observer("player-2"), CONTENT)).toEqual(
      renderEvent(said, observer("player-2"), CONTENT),
    );
  });

  it("leaves a typo'd placeholder visible in the output instead of eating it", () => {
    const typoCopy: RenderContent = {
      ...CONTENT,
      copy: { ...COPY, sayLine: `${markupKey("spaker")}说：${markupKey("text")}` },
    };
    const said = stamped(
      sayEvent({ speakerId: "player-1", text: "喂", locationId: "room-lq-001" }),
    );
    expect(texts(renderEvent(said, observer("player-2"), typoCopy))).toEqual([
      `${markupKey("spaker")}说：喂`,
    ]);
  });

  it("tiles every rendered line completely (spans concatenate to the text)", () => {
    const looked = stamped(
      appearanceEvent({
        roomId: "room-lq-001",
        exits: [{ exitId: "exit-north", direction: "北", verbs: ["北"] }],
        staticPresence: [{ id: "npc-guard", count: 2 }],
        occupants: ["npc-guard"],
      }),
    );
    for (const line of renderEvent(looked, observer("player-1"), CONTENT)) {
      expect(line.spans.map((span) => span.text).join("")).toBe(line.text);
    }
  });
});
