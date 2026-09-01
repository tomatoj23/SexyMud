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
  CommandRejection,
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
export type { ContentRegistry, MonsterRecord } from "./content/registry.js";
export type { ExitEntry, NpcEntry, PlacementEntry, RoomEntry } from "./world/entry.js";
export { MOVE_TYPES, createEntity } from "./world/entity.js";
export type {
  AnnounceMoveContext,
  Entity,
  EntityHooks,
  MoveHookContext,
  MoveInfo,
  MoveType,
  MsgReceiveContext,
  SayHookContext,
} from "./world/entity.js";
export { createWorldRuntime } from "./world/runtime.js";
export type { WorldRuntime, WorldRuntimeOptions } from "./world/runtime.js";
export { moveTo } from "./world/move.js";
export type { MovePorts, MoveRequest, MoveResult, MoveVetoStage } from "./world/move.js";
export { traversalSpec } from "./world/traverse.js";
export { atLook, lookSpec, returnAppearance } from "./world/look.js";
export type { ExitDigest, LookOutcome, RoomAppearance, StaticPresence } from "./world/look.js";
export { broadcastMessage } from "./world/message.js";
export type { BroadcastRequest, MessagePorts } from "./world/message.js";
export { say, saySpec } from "./world/say.js";
export type { SayRequest, SayResult, SayVetoStage } from "./world/say.js";
export type { EntityState, WorldState } from "./state/tree.js";
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
