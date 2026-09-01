/**
 * Public surface of the engine.
 *
 * This package is a library: it holds no theme vocabulary and imports no
 * content. Hosts supply Clock / Rng / SaveStore / Authority implementations and
 * render GameEvents themselves. See docs/spec/00-overview.md.
 */
export { SAVE_VERSION, migrateSnapshot } from "./save/migrations.js";
export { createSeededRng } from "./rng.js";
export { runCommand } from "./command/pipeline.js";
export type {
  CommandContext,
  CommandDeps,
  CommandSpec,
  EventDraft,
  Message,
  MessageSink,
  ParseOutcome,
} from "./command/pipeline.js";
export { createCommandHarness, createTestClock, expectMessageSequence } from "./command/testing.js";
export type {
  CallOptions,
  CallOutcome,
  CommandHarness,
  ExpectedMessage,
  HarnessOptions,
  TestClock,
} from "./command/testing.js";
export type {
  Authority,
  Clock,
  Command,
  CommandResult,
  DispatchFailure,
  EventMeta,
  GameEvent,
  GameListener,
  Rng,
  SaveStore,
  Snapshot,
} from "./types.js";
