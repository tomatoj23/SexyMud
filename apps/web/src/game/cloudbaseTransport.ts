import { CloudSaveError } from "./cloudSaveStore.js";
import type { CloudSaveFailureKind, CloudSaveRecord, CloudSaveTransport } from "./cloudSaveStore.js";
import type { CloudAuthSession } from "./cloudAuth.js";
import { isAlreadyExists, signalOf, type CloudbaseSignal } from "./cloudbaseSignals.js";

/**
 * The CloudBase transport — the real backend adapter behind
 * {@link CloudSaveTransport} (ADR-0036 D4's obligations, #30; the store
 * semantics live in `cloudSaveStore.ts`, #29). CloudBase carries the save
 * rows (ADR-0002 §2's adapter route, still valid inside "cloud save only");
 * everything vendor-specific is sealed in this file and the SDK binding.
 *
 * **CAS shape (decision D4)** — the compare-and-swap the store's contract
 * demands, in the two forms CloudBase can express:
 *
 *   - UPDATE is a CONDITIONAL UPDATE guarded on the observed revision
 *     (`where({_id, revision}).update(…)`) that reads the `updated` count —
 *     a guard that misses applies NOTHING and is a `conflict`;
 *   - CREATE cannot be a conditional update ("insert only if absent" has no
 *     query form), so it is a TRANSACTION: `get` refuses an occupied slot,
 *     `create` is insert-only, and the commit is the atomic apply. This is
 *     the ticket's "做不到原子就上事务" half.
 *
 * **Revision (decision D4)** is an opaque token minted fresh at write time
 * and stored atomically with the text. It is compared, never edited, never
 * derived from its predecessor and never read back — a read-back would race
 * (another write landing in between would make this session adopt ITS
 * revision), which is exactly the lost-update CAS exists to prevent.
 *
 * **Namespace (decision D4)**: the document id is `${uid}~${key}` — one
 * transport is bound to ONE owner's session (decision D1 of #29) and serves
 * every save slot of that owner, so two accounts can never collide on a slot
 * key. Both segments are restricted to `[A-Za-z0-9._-]` and `~` cannot occur
 * inside them, so the composition is unambiguous — AND url-safe, which
 * matters because the SDK concatenates the doc id RAW into its REST path
 * (`/documents/{id}`), so a `/` in the id silently 404s into "no save". The
 * snapshot itself still carries no account id: the identity lives in the
 * storage namespace, not in the save document.
 *
 * **Failure classification (decision D5)** judges the SDK's DOCUMENTED
 * signals through `cloudbaseSignals.ts` — the one table (#43): the
 * session-class signals → `auth`; the backend's create-collision signal on a
 * raced create names the CAS condition itself → `conflict`; everything else
 * → `network` (the unknown⇒network rule lives with that table, one home).
 * No error string guessing beyond those documented enums. ⚠️ Coded gateway
 * failures RESOLVE instead of throwing (verified in the SDK runtime) — every
 * result is checked for `code` before use, because a coded read flowing out
 * as "absent" is exactly the silent degrade D8 bans.
 */

/** A gateway result: success data plus the CARRIED error channel. */
export interface CloudBaseDbResult {
  /** Coded failures RESOLVE with this set — never assume a resolved call succeeded. */
  code?: unknown;
  message?: unknown;
}
export interface CloudBaseDbGetResult extends CloudBaseDbResult {
  /** Non-transaction: row array. In-transaction: one row or `null`. Coded failure: absent. */
  data?: unknown;
}
export interface CloudBaseDbUpdateResult extends CloudBaseDbResult {
  updated?: number;
}
export interface CloudBaseDbDocument {
  get(): Promise<CloudBaseDbGetResult>;
}
export interface CloudBaseDbFiltered {
  update(data: Record<string, unknown>): Promise<CloudBaseDbUpdateResult>;
}
export interface CloudBaseDbCollection {
  doc(id: string): CloudBaseDbDocument;
  where(filter: Record<string, unknown>): CloudBaseDbFiltered;
}
export interface CloudBaseDbTransactionDocument {
  get(): Promise<CloudBaseDbGetResult>;
  create(data: Record<string, unknown>): Promise<unknown>;
}
export interface CloudBaseDbTransaction {
  collection(name: string): { doc(id: string): CloudBaseDbTransactionDocument };
  commit(): Promise<CloudBaseDbResult | void>;
  rollback(reason?: unknown): Promise<unknown>;
}
export interface CloudBaseDb {
  collection(name: string): CloudBaseDbCollection;
  startTransaction(): Promise<CloudBaseDbTransaction>;
}

export interface CloudBaseSaveTransportOptions {
  /** The slot collection (deployment config). Default `save_slots`. */
  collection?: string;
  /** Mints the next opaque revision token at write time. */
  mintRevision: () => string;
}

/** Id segments stay `[A-Za-z0-9._-]` so `~` is a collision-proof, url-safe join. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export class CloudBaseSaveTransport implements CloudSaveTransport {
  private readonly collectionName: string;
  private readonly mintRevision: () => string;

  constructor(
    private readonly db: CloudBaseDb,
    private readonly session: CloudAuthSession,
    options: CloudBaseSaveTransportOptions,
  ) {
    // Identity is the storage namespace: without a uid there is no "whose
    // save is this", and a transport that cannot answer that must not exist.
    if (!session.uid) {
      throw new Error("CloudBaseSaveTransport: an authenticated session with a uid is required");
    }
    if (!SEGMENT.test(session.uid)) {
      throw new Error("CloudBaseSaveTransport: uid must be url-safe [A-Za-z0-9._-] — it is part of the document id");
    }
    this.collectionName = options.collection ?? "save_slots";
    this.mintRevision = options.mintRevision;
  }

  /** The owner-scoped document id: the account namespace plus the slot key. */
  private docId(key: string): string {
    if (!SEGMENT.test(key)) {
      throw new Error("CloudBaseSaveTransport: slot key must be url-safe [A-Za-z0-9._-] — it is part of the document id");
    }
    return `${this.session.uid}~${key}`;
  }

  async read(key: string): Promise<CloudSaveRecord | null> {
    const id = this.docId(key); // outside the try: a bad key is a programmer error, not a backend failure
    try {
      const result = await this.db.collection(this.collectionName).doc(id).get();
      const row = rowsOf(result)[0];
      if (row === undefined || row === null) return null;
      // The row's fields pass through UNJUDGED: `CloudSaveStore` owns the one
      // verdict for "corrupt" whichever store is plugged in (#29's envelope
      // check), and a transport that pre-judged would fork that verdict.
      const { text, revision } = row as { text?: unknown; revision?: unknown };
      return { text: text as string, revision: revision as string };
    } catch (error) {
      throw asSaveError(error, "read");
    }
  }

  async write(key: string, text: string, expectedRevision: string | null): Promise<string> {
    const id = this.docId(key);
    try {
      const revision = this.mintRevision();
      return expectedRevision === null
        ? await this.create(id, text, revision)
        : await this.update(id, text, expectedRevision, revision);
    } catch (error) {
      throw asSaveError(error, "write");
    }
  }

  /** CAS update: the conditional update's `updated` count is the apply-or-not. */
  private async update(id: string, text: string, expectedRevision: string, revision: string): Promise<string> {
    const result = await this.db
      .collection(this.collectionName)
      .where({ _id: id, revision: expectedRevision })
      .update({ text, revision });
    throwIfCoded(result);
    // `updated !== 1` covers both "guard missed" and "no count came back" —
    // reading either as success would risk a silent lost update, which is
    // the one thing this whole adapter exists to prevent.
    if (result.updated !== 1) {
      throw new CloudSaveError(
        "conflict",
        `cloud save: conditional update applied ${result.updated ?? 0} of 1 rows`,
      );
    }
    return revision;
  }

  /** CAS create: a transaction, because "insert only if absent" has no query form. */
  private async create(id: string, text: string, revision: string): Promise<string> {
    const transaction = await this.db.startTransaction();
    try {
      const existing = await transaction.collection(this.collectionName).doc(id).get();
      if (rowsOf(existing).length > 0) {
        throw new CloudSaveError("conflict", "cloud save: slot already exists");
      }
      throwIfCoded(await transaction.collection(this.collectionName).doc(id).create({ text, revision }));
      throwIfCoded((await transaction.commit()) ?? {});
      return revision;
    } catch (error) {
      // Best-effort: the transaction applies all or nothing, and a failed
      // commit has already applied nothing.
      await transaction.rollback().catch(() => undefined);
      // `already_exists` is the backend naming the CAS condition — another
      // session created the slot between our `get` and our `create`.
      if (isAlreadyExists(error)) {
        throw new CloudSaveError("conflict", "cloud save: slot was created by another session");
      }
      throw error;
    }
  }
}

/**
 * The rows out of a get — the SDK's two shapes (non-transaction: array;
 * in-transaction: one row or null) plus the CARRIED error channel, which must
 * be surfaced BEFORE any shape reading (a coded failure flowing out as "no
 * rows" is the silent degrade decision D8 bans).
 */
function rowsOf(result: CloudBaseDbGetResult): unknown[] {
  throwIfCoded(result);
  const data = result.data;
  return Array.isArray(data) ? data : data ? [data] : [];
}

/** A coded gateway failure RESOLVED — turn it into the thrown error it should be. */
function throwIfCoded(result: unknown): void {
  const carried = (typeof result === "object" && result !== null ? result : {}) as CloudBaseDbResult;
  if (carried.code !== undefined && carried.code !== null && carried.code !== "") {
    throw Object.assign(new Error(String(carried.message ?? carried.code)), { code: carried.code });
  }
}

/** The thin map (decision D5, #43): the table's signal → the contract's failure kind. */
const SAVE_KIND: Record<CloudbaseSignal, CloudSaveFailureKind> = {
  // A duplicate is the create gate's `conflict` before it can reach here, and
  // a login failure leaking through the wire is not this adapter's vocabulary
  // — both fall to `network`, as before for SINGLE-signal carriers. ⚠️ The
  // one consolidation delta (#43 复查轮, A/B-probed): a CONTRADICTORY carrier
  // naming a session signal beside another used to read `auth` (this adapter
  // judged unauthenticated alone); the table answers with the specific signal
  // (signalOf's precedence) → `network`.
  "already-exists": "network",
  "invalid-credentials": "network",
  unauthenticated: "auth",
  unknown: "network",
};

/**
 * Turns a thrown backend failure into the contract's classified rejection —
 * the map above applied and nothing else (#43). An already-classified
 * {@link CloudSaveError} — a CAS `conflict`, chiefly — passes through
 * untouched.
 */
function asSaveError(error: unknown, operation: string): CloudSaveError | unknown {
  if (error instanceof CloudSaveError) return error;
  const kind = SAVE_KIND[signalOf(error)];
  const message = error instanceof Error ? error.message : String(error);
  return new CloudSaveError(kind, `cloud save: ${operation} failed: ${message}`);
}
