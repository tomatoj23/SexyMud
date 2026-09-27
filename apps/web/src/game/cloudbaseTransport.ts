import { CloudSaveError } from "./cloudSaveStore.js";
import type { CloudSaveFailureKind, CloudSaveRecord, CloudSaveTransport } from "./cloudSaveStore.js";
import type { CloudAuthSession } from "./cloudAuth.js";

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
 * **Namespace (decision D4)**: the document id is `${uid}/${key}` — one
 * transport is bound to ONE owner's session (decision D1 of #29) and serves
 * every save slot of that owner, so two accounts can never collide on a slot
 * key. The snapshot itself still carries no account id: the identity lives
 * in the storage namespace, not in the save document.
 *
 * **Failure classification (decision D5)** uses the SDK's DOCUMENTED
 * signals — `AuthErrorCode.UNAUTHENTICATED = 16`, `ErrorType
 * "unauthenticated"` / `"login_required"`, HTTP 401 → `auth`; the backend's
 * `already_exists` on a raced create names the CAS condition itself →
 * `conflict`; everything else (including every unknown backend error) →
 * `network`, because retryable is the safe reading of "unknown". No error
 * string guessing beyond those documented enums.
 */

/**
 * The slice of the CloudBase database API this adapter touches, in the
 * SDK's own call/result shapes (`collection().doc().get()`,
 * `where().update()` returning `updated`, a transaction whose `create` is
 * insert-only). Declared structurally so the SDK binding is one narrow cast
 * and the tests run against a contract-faithful fake.
 */
export interface CloudBaseDbGetResult {
  data: unknown[];
}
export interface CloudBaseDbUpdateResult {
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
  commit(): Promise<void>;
  rollback(reason?: unknown): Promise<void>;
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
    this.collectionName = options.collection ?? "save_slots";
    this.mintRevision = options.mintRevision;
  }

  /** The owner-scoped document id: the account namespace plus the slot key. */
  private docId(key: string): string {
    return `${this.session.uid}/${key}`;
  }

  async read(key: string): Promise<CloudSaveRecord | null> {
    try {
      const result = await this.db.collection(this.collectionName).doc(this.docId(key)).get();
      const row = result.data?.[0];
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
    const revision = this.mintRevision();
    try {
      return expectedRevision === null
        ? await this.create(key, text, revision)
        : await this.update(key, text, expectedRevision, revision);
    } catch (error) {
      throw asSaveError(error, "write");
    }
  }

  /** CAS update: the conditional update's `updated` count is the apply-or-not. */
  private async update(key: string, text: string, expectedRevision: string, revision: string): Promise<string> {
    const result = await this.db
      .collection(this.collectionName)
      .where({ _id: this.docId(key), revision: expectedRevision })
      .update({ text, revision });
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
  private async create(key: string, text: string, revision: string): Promise<string> {
    const transaction = await this.db.startTransaction();
    try {
      const existing = await transaction.collection(this.collectionName).doc(this.docId(key)).get();
      if (existing.data?.length) {
        throw new CloudSaveError("conflict", "cloud save: slot already exists");
      }
      await transaction
        .collection(this.collectionName)
        .doc(this.docId(key))
        .create({ text, revision });
      await transaction.commit();
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

/** The one error string this adapter honors — it names the CAS condition itself. */
function isAlreadyExists(error: unknown): boolean {
  const code = errorCode(error);
  return code === "already_exists" || code === "ALREADY_EXISTS";
}

/** The documented unauthenticated signals (decision D5). */
function isUnauthenticated(error: unknown): boolean {
  const e = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  if (e["errorCode"] === 16) return true; // AuthErrorCode.UNAUTHENTICATED
  const code = errorCode(error);
  if (code === "unauthenticated" || code === "UNAUTHENTICATED" || code === "login_required") return true;
  return e["statusCode"] === 401 || e["status"] === 401 || e["status"] === "401"; // HTTP 401
}

function errorCode(error: unknown): unknown {
  return (typeof error === "object" && error !== null ? (error as Record<string, unknown>)["code"] : undefined);
}

/**
 * Turns a thrown backend failure into the contract's classified rejection:
 * `auth` for the documented unauthenticated signals, `network` for everything
 * unknown (decision D5). An already-classified {@link CloudSaveError} — a CAS
 * `conflict`, chiefly — passes through untouched.
 */
function asSaveError(error: unknown, operation: string): CloudSaveError | unknown {
  if (error instanceof CloudSaveError) return error;
  const kind: CloudSaveFailureKind = isUnauthenticated(error) ? "auth" : "network";
  const message = error instanceof Error ? error.message : String(error);
  return new CloudSaveError(kind, `cloud save: ${operation} failed: ${message}`);
}
