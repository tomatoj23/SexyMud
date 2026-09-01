/**
 * Public surface of the engine.
 *
 * This package is a library: it holds no theme vocabulary and imports no
 * content. Hosts supply Clock / Rng / SaveStore / Authority implementations and
 * render GameEvents themselves. See docs/spec/00-overview.md.
 */
export { SAVE_VERSION, migrateSnapshot } from "./save/migrations.js";
export { createSeededRng } from "./rng.js";
export {
  checkAccess,
  createPredicateRegistry,
  defaultPredicateEntries,
  defaultPredicateRegistry,
  evaluateCondition,
} from "./conditions.js";
export type {
  AccessCheck,
  AccessGate,
  AccessRules,
  ConditionExpr,
  ConditionSubject,
  PredicateEntry,
  PredicateFn,
  PredicateRegistry,
} from "./conditions.js";
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
export { createVerbTable, parseArgForm, parseNumeral } from "./command/parser.js";
export type {
  ArgForm,
  TargetRef,
  VerbEntry,
  VerbMatch,
  VerbTable,
} from "./command/parser.js";
export { mergeCmdSets } from "./command/cmdset.js";
export type {
  CmdSetCommand,
  CmdSetSource,
  MergeType,
  MergedCmdSet,
} from "./command/cmdset.js";
export { commandSetSources, commandSpecFromEntry } from "./command/entry.js";
export type {
  CommandEntry,
  CommandSpecOptions,
} from "./command/entry.js";
export { createContentRegistry } from "./content/registry.js";
export type { ContentRegistry } from "./content/registry.js";
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
