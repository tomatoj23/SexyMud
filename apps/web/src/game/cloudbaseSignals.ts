/**
 * The CloudBase SDK's error SIGNAL table — the one place its documented
 * vocabulary is judged (#43, decision D2). The SDK's error shapes arrive in
 * two spellings of the same enums (`code`/`category`/`errorCode`/HTTP
 * status); this module normalizes them into the four signals the game layer
 * speaks, so `cloudbaseSdk` and `cloudbaseTransport` keep only a thin map
 * "signal → my failure kind" each and `already_exists` is judged ONCE. The
 * table lives in `apps/web`, not in core: SDK vocabulary is host-integration
 * vocabulary (ADR-0002 §2) and `packages/core` must never learn CloudBase.
 *
 * ⚠️ **The classification rule's ONE home** — everything the table above
 * does not name is `network`: an unexpected backend error is a `network`
 * one (retryable is the safe reading of "unknown"). The bindings APPLY the
 * rule in their signal maps; they never restate the rationale — four copied
 * comment wordings were folded into this one (#43), the wording taken from
 * the seam contract where it first appeared (`cloudSaveStore.ts`).
 */

/**
 * The SDK's documented failure signals, in the normalized vocabulary the
 * bindings map from (ADR-0037 D5's enum words, never string guessing):
 *
 *   - `already-exists` — the backend refusing a duplicate (`already_exists`
 *     on a raced create names the CAS condition itself; a taken email names
 *     the form's next step);
 *   - `invalid-credentials` — the credential-class enum words (the form says
 *     "check your input", not "try again later");
 *   - `unauthenticated` — the session-class enum words (retrying will not
 *     help; re-login will);
 *   - `unknown` — everything else, the rule's `network` default above.
 */
export type CloudbaseSignal = "already-exists" | "invalid-credentials" | "unauthenticated" | "unknown";

/** The raw error channel shapes the SDK puts its signals in. */
interface SignalShape {
  code?: unknown;
  category?: unknown;
  errorCode?: unknown;
  statusCode?: unknown;
  status?: unknown;
}

/**
 * Classifies a raw SDK error (thrown or carried) into the documented signals.
 * Precedence when ONE carrier names several signals: `already-exists`
 * outranks `invalid-credentials` outranks `unauthenticated` — the more
 * specific operational signal wins (such a carrier is contradictory; the
 * table answers with the specific verdict, not the generic one).
 *
 * Domain: the judgments read plain primitive fields off the SDK's error
 * carriers. JS-object-level hostility — boxed strings, array codes, throwing
 * getters — is outside this table's contract, same as the "never throws"
 * reader contracts are scoped to the JSON channel (#46's domain discipline).
 */
export function signalOf(error: unknown): CloudbaseSignal {
  if (isAlreadyExists(error)) return "already-exists";
  if (isInvalidCredentials(error)) return "invalid-credentials";
  if (isUnauthenticated(error)) return "unauthenticated";
  return "unknown";
}

/** The one error string this adapter family honors — it names a condition, not a mood. */
export function isAlreadyExists(error: unknown): boolean {
  const code = shapeOf(error).code;
  return code === "already_exists" || code === "ALREADY_EXISTS";
}

/** The documented credential-class signals (decision D5) — enum words, not string guessing. */
export function isInvalidCredentials(error: unknown): boolean {
  const e = shapeOf(error);
  return (
    e.category === "INVALID_CREDENTIALS" ||
    e.category === "USER_NOT_FOUND" ||
    e.category === "AUTH_METHOD_MISMATCH" ||
    e.code === "invalid_password" ||
    e.code === "invalid_credentials" ||
    e.code === "invalid_grant"
  );
}

/** The documented unauthenticated signals (decision D5). */
export function isUnauthenticated(error: unknown): boolean {
  const e = shapeOf(error);
  if (e.errorCode === 16) return true; // AuthErrorCode.UNAUTHENTICATED
  if (e.code === "unauthenticated" || e.code === "UNAUTHENTICATED" || e.code === "login_required") return true;
  return e.statusCode === 401 || e.status === 401 || e.status === "401"; // HTTP 401
}

/** The signal carrier out of anything the SDK throws or resolves carrying. */
function shapeOf(error: unknown): SignalShape {
  return (typeof error === "object" && error !== null ? error : {}) as SignalShape;
}
