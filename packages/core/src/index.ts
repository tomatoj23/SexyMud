/**
 * Public surface of the engine.
 *
 * This package is a library: it holds no theme vocabulary and imports no
 * content. Hosts supply Rng / SaveStore / Authority implementations and render
 * GameEvents themselves; ticks they *produce* and stamp onto each command —
 * `Clock` is the engine's high-water reading back to them (ADR-0031). See
 * docs/spec/00-overview.md.
 */
export { SAVE_VERSION, migrateSnapshot } from "./save/migrations.js";
export { summaryOf } from "./save/summary.js";
export type { SaveSummary } from "./save/summary.js";
export { createSeededRng } from "./rng.js";
export { createTickClock, observeDispatch } from "./clock.js";
export type { TickClock } from "./clock.js";
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
export {
  appearanceEvent,
  arrivedEvent,
  commandRefusedEvent,
  customCode,
  customEvent,
  deathEvent,
  departedEvent,
  dotTickEvent,
  isEngineEvent,
  sayEvent,
  stampEvent,
  strikeEvent,
} from "./events.js";
export { effectiveNowTick, parseCommand, runCommand } from "./command/pipeline.js";
export { createDispatchDriver, settlementFirst } from "./command/driver.js";
export type {
  DispatchDriver,
  DispatchDriverOptions,
  DispatchOutcome,
  HeartbeatRequest,
} from "./command/driver.js";
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
export { resolve, verbTableFrom } from "./command/resolve.js";
export type {
  Bindings,
  CommandBinding,
  ResolveOutcome,
} from "./command/resolve.js";
export { commandSetSources, commandSpecFromEntry } from "./command/entry.js";
export type {
  CommandEntry,
  CommandSpecOptions,
} from "./command/entry.js";
export { createContentRegistry } from "./content/registry.js";
export type {
  ContentRegistry,
  ContentRegistryOptions,
  DimensionTable,
  MonsterRecord,
  MonsterStats,
} from "./content/registry.js";
export type {
  Calendar,
  CalendarRing,
  CalendarSegment,
  CharacterTable,
  CombatTierBand,
  CombatTiersTable,
  SettingsGroup,
  SettingsTable,
} from "./content/config.js";
// The effect contract (#56): the entry shape, the modifier minimal core
// (ADR-0005's empty-degenerate form), and the primitive registry the
// mechanism modules register their implementations into.
export type { EffectEntry, EffectPrimitive } from "./effects/entry.js";
export { aggregateModifiers } from "./effects/modifiers.js";
export type { FlatModifier, Modifier, PercentModifier } from "./effects/modifiers.js";
export { createEffectPrimitiveRegistry } from "./effects/registry.js";
export type {
  EffectExecutionContext,
  EffectPrimitiveHandler,
} from "./effects/registry.js";
// The combat kernel (#56): the strike orchestration adapter, the shipped
// primitives, the arithmetic, the character-model seeds, and the poison's
// observation-time compensation settle handler.
export { strikeSpec } from "./combat/strike.js";
export type { StrikeSpecOptions } from "./combat/strike.js";
export { defaultEffectPrimitives } from "./combat/primitives.js";
export {
  bandOf,
  DEFAULT_STRIKE_ELEMENT,
  DEFAULT_STRIKE_SOURCE,
  monsterCombatFace,
  readDefenseK,
  retaliationDamage,
  strikeDamage,
} from "./combat/damage.js";
export { createDotSettleHandler, primaryResourceOf, seedCharacterAttrs } from "./combat/session.js";
export { grantFlagSpec } from "./world/flag.js";
export { resolveNpcTarget } from "./world/target.js";
export type { NpcTargetResolution, TargetFailure } from "./world/target.js";
export { createGameTime, ringPeriod, segmentAt, segmentIndexAt } from "./time/calendar.js";
export type { GameTime } from "./time/calendar.js";
export { cooldownReady, cooldownRemaining } from "./time/cooldown.js";
export type { CooldownTable } from "./time/cooldown.js";
export { createDueBucket } from "./time/due.js";
export type { DueBucket, DueEmitter, DueEvent, DueHandler, DueItem, DueScheduler } from "./time/due.js";
export { stageAt } from "./time/stage.js";
export type { Stage, StageReadout } from "./time/stage.js";
export { createSettler } from "./time/settle.js";
export type {
  EntitySettleHandler,
  SettleDraft,
  SettleEmitter,
  SettleRequest,
  SettleSpan,
  Settler,
  SettlerOptions,
  WorldSettleHandler,
} from "./time/settle.js";
export { createTimeTuning } from "./time/tuning.js";
export type { TimeTuning } from "./time/tuning.js";
export type { EntryCommon, TagMap } from "./content/entry.js";
export type { ExitEntry, NpcEntry, PlacementEntry, RoomEntry } from "./world/entry.js";
export { MOVE_TYPES, createEntity } from "./world/entity.js";
export type {
  AnnounceMoveContext,
  CmdsetHookContext,
  CreationHookContext,
  DropHookContext,
  Entity,
  EntityHooks,
  GetHookContext,
  GiveHookContext,
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
export { dropObject, getObject, giveObject } from "./world/transfer.js";
export type {
  DropRequest,
  DropResult,
  DropVetoStage,
  GetRequest,
  GetResult,
  GetVetoStage,
  GiveRequest,
  GiveResult,
  GiveVetoStage,
  TransferPorts,
} from "./world/transfer.js";
export { createObject } from "./world/creation.js";
export type { CreationPorts, CreationRequest } from "./world/creation.js";
export { assembleSources } from "./world/cmdset.js";
export { traversalSpec } from "./world/traverse.js";
export { atLook, lookSpec, returnAppearance } from "./world/look.js";
export type { ExitDigest, LookOutcome, RoomAppearance, StaticPresence } from "./world/look.js";
export { broadcastMessage } from "./world/message.js";
export type { BroadcastRequest, MessagePorts } from "./world/message.js";
export { say, saySpec } from "./world/say.js";
export type { SayRequest, SayResult, SayVetoStage } from "./world/say.js";
// The text surface (spec/05, issue #50): line shapes, display width, the
// kinsoku-aware folder, the viewport chunker and the five-type renderer —
// shipped with the engine so every host renders through one implementation.
export { lineOf, pushSpan } from "./text/line.js";
export type { OutputLine, OutputSpan, StyleName } from "./text/line.js";
export { charWidth, displayWidth, splitUnits } from "./text/width.js";
export type { WidthUnit } from "./text/width.js";
export { foldLine } from "./text/wrap.js";
export { chunkOutput } from "./text/chunk.js";
export type { Viewport } from "./text/chunk.js";
export { renderEvent } from "./text/render.js";
export type { ObserverState, RenderContent, RenderCopy } from "./text/render.js";
export { markupKey } from "./text/markup.js";
// The input-hardening gate (spec/05 §8.1, issue #54): the host rebuilds a
// player's raw line through this before it may enter the engine — the cap's
// value is the host's, the strip's categories are the engine's law.
export { sanitizePlayerInput } from "./input/sanitize.js";
export type { CombatSession, DotLedger, EntityState, WorldState } from "./state/tree.js";
export { restoreWorld, serializeWorld } from "./state/snapshot.js";
export type {
  EntityRecord,
  RestoredWorld,
  RestoreOptions,
  SaveDataV1,
  SaveDataV2,
  WorldMeta,
} from "./state/snapshot.js";
export { assembleWorld, collectMeta } from "./state/assembly.js";
export type { AssembledWorld, AssembleWorldOptions, WorldBundle } from "./state/assembly.js";
export { createCommandHarness, createTestClock, expectMessageSequence, testClockOver } from "./command/testing.js";
export type {
  CallOutcome,
  CommandHarness,
  CommandInput,
  EventSubset,
  ExpectedEvent,
  ExpectedMessage,
  HarnessOptions,
  TestClock,
} from "./command/testing.js";
export type {
  AppearanceEvent,
  ArrivedEvent,
  Authority,
  AccessTypeCode,
  Clock,
  Command,
  CommandRefusedEvent,
  CommandResult,
  CustomCode,
  CustomEvent,
  CustomEventDraft,
  DeathEvent,
  DepartedEvent,
  DispatchFailure,
  DotTickEvent,
  EngineEvent,
  EventMeta,
  EventSkeleton,
  GameEvent,
  GameListener,
  ParseReason,
  ReasonCode,
  RefusalReason,
  StrikeEvent,
  VerbReason,
  Rng,
  SaveStore,
  SayEvent,
  Snapshot,
} from "./types.js";
