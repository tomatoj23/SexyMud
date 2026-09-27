import { CloudAuthError, type CloudAuthClient, type CloudAuthSession } from "./cloudAuth.js";
import type { CloudBaseDb } from "./cloudbaseTransport.js";

/**
 * The CloudBase SDK binding (#30, ADR-0037) — the one place `@cloudbase/js-sdk`
 * is touched, mapping the SDK onto the two structural ports the game layer
 * speaks: {@link CloudAuthClient} (identity, decision D1) and
 * {@link CloudBaseDb} (save rows, decision D4). Everything vendor-shaped
 * stays behind this file; `cloudbaseSdk` is what the transport port and the
 * session manager never have to know about (ADR-0002 §2/§21: swap the SDK
 * adapter, not the game).
 *
 * ⚠️ **SDK realities this binding exists to absorb** (verified against
 * `@cloudbase/js-sdk@3.10.1`'s shipped runtime):
 *
 *   - auth calls **resolve** `{ data, error: AuthError }` — they do NOT throw
 *     (`AuthResult<D> = {data, error:null} | {data:nulls, error}`). Awaiting
 *     alone would read a wrong password as success;
 *   - `signUp` is a **two-step OTP flow** by construction (its validator
 *     demands `email` or `phone`): `signUp({email, password})` mails a code
 *     and returns `data.verifyOtp({token})`; the username+password pair rides
 *     along on completion. Username-only sign-up does not exist in this SDK —
 *     accounts are created through this flow or pre-provisioned (decision D1,
 *     ADR-0037);
 *   - `signOut` also resolves with `error` — a failed logout MUST surface, or
 *     the UI says "signed out" while the backend session lives on.
 */

/** The error channel the SDK returns instead of throwing (the `AuthResult`). */
interface CloudbaseAuthErrorLike {
  code?: unknown;
  category?: unknown;
  errorCode?: unknown;
  message?: unknown;
}

interface CloudbaseAuthResultLike {
  data?: unknown;
  error?: CloudbaseAuthErrorLike | null;
}

/** The completer `signUp` hands back after mailing its code. */
type CloudbaseSignUpCompleter = (params: { token: string }) => Promise<CloudbaseAuthResultLike>;

/** The SDK auth object's surface, as this binding consumes it. */
interface CloudbaseAuthSurface {
  signInWithPassword(
    credentials: { email: string; password: string } | { username: string; password: string },
  ): Promise<CloudbaseAuthResultLike>;
  signUp(params: {
    email: string;
    password: string;
  }): Promise<CloudbaseAuthResultLike & { data?: { verifyOtp?: CloudbaseSignUpCompleter } }>;
  getLoginState(): Promise<{ user?: CloudbaseUserLike } | null>;
  signOut(): Promise<CloudbaseAuthResultLike>;
}

/** The user fields a session can be read from (v1-compat and v3 shapes alike). */
interface CloudbaseUserLike {
  uid?: string;
  sub?: string;
  username?: string;
  email?: string;
}

/** The initialized `cloudbase.init()` app, as this binding consumes it. */
export type CloudbaseApp = unknown;

/** Wraps the SDK auth object as the session manager's contract. */
export function createCloudbaseAuthClient(app: CloudbaseApp): CloudAuthClient {
  const auth = (app as { auth(): unknown }).auth() as CloudbaseAuthSurface;
  return {
    async signUp(email, password) {
      const result = requireOk(
        await call(() => auth.signUp({ email, password })),
        "注册",
      );
      const verifyOtp = (result.data as { verifyOtp?: CloudbaseSignUpCompleter } | undefined)?.verifyOtp;
      if (!verifyOtp) {
        throw new CloudAuthError("network", "注册未返回验证码校验步骤");
      }
      return async (code: string) => {
        requireOk(await call(() => verifyOtp({ token: code })), "注册");
        return establishedSession(auth, { email, password });
      };
    },
    async signIn(account, password) {
      const credentials = credentialsFor(account, password);
      requireOk(await call(() => auth.signInWithPassword(credentials)), "登录");
      return establishedSession(auth, credentials);
    },
    async getLoginState() {
      // A failed probe reads as "no session": signing in again is the same
      // fix either way, and this keeps a flaky boot out of the player's face.
      return sessionOf(await auth.getLoginState().catch(() => null));
    },
    async signOut() {
      // A failed logout REJECTS — "signed out" over a live backend session is
      // exactly the quiet lie this project bans (decision D8's discipline).
      requireOk(await call(() => auth.signOut()), "退出");
    },
  };
}

/** Wraps the SDK database object as the transport's contract (one cast, see above). */
export function createCloudbaseSaveDb(app: CloudbaseApp): CloudBaseDb {
  return (app as { database(): unknown }).database() as CloudBaseDb;
}

/** The account field doubles as email or username — the SDK distinguishes by shape. */
function credentialsFor(
  account: string,
  password: string,
): { email: string; password: string } | { username: string; password: string } {
  return account.includes("@") ? { email: account, password } : { username: account, password };
}

/** Reads the live session out of the SDK's login state. */
async function establishedSession(
  auth: CloudbaseAuthSurface,
  credentials: { email: string; password: string } | { username: string; password: string },
): Promise<CloudAuthSession> {
  const landed = sessionOf(await auth.getLoginState().catch(() => null));
  if (landed) return landed;
  // Some flows report success without landing a local session — sign in explicitly.
  requireOk(await call(() => auth.signInWithPassword(credentials)), "登录");
  const session = sessionOf(await auth.getLoginState().catch(() => null));
  if (!session) {
    throw new CloudAuthError("network", "登录成功但未获得会话");
  }
  return session;
}

/**
 * The session out of a login state. A user without any id reads as "no
 * session" — such a session could not bind a save transport (no uid, no
 * namespace), and signing in again is the same fix either way.
 */
function sessionOf(state: { user?: CloudbaseUserLike } | null): CloudAuthSession | null {
  const user = state?.user;
  const uid = user?.uid ?? user?.sub;
  if (!uid) return null;
  return { uid, account: user?.username ?? user?.email ?? uid };
}

/** Runs one SDK call, converting a THROWN failure to the form's vocabulary. */
async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw authFailure(error);
  }
}

/** The SDK's error channel: an `AuthResult` carrying `error` is a failure. */
function requireOk(result: CloudbaseAuthResultLike, what: string): CloudbaseAuthResultLike {
  if (result?.error) throw authFailure(result.error, what);
  return result;
}

/**
 * Login-time failures for the FORM (decision D5's discipline, applied to the
 * sign-in edge): the SDK's documented category/code VOCABULARY decides the
 * hint — enum words, not string guessing — everything unknown is `network`
 * (retryable is the safe reading).
 */
function authFailure(error: unknown, what = "登录"): CloudAuthError {
  const e = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const category = String(e["category"] ?? "");
  const code = String(e["code"] ?? "");
  if (code === "already_exists" || code === "ALREADY_EXISTS") {
    return new CloudAuthError("already-exists", "该邮箱已被注册");
  }
  if (
    category === "INVALID_CREDENTIALS" ||
    category === "USER_NOT_FOUND" ||
    category === "AUTH_METHOD_MISMATCH" ||
    code === "invalid_password" ||
    code === "invalid_credentials" ||
    code === "invalid_grant"
  ) {
    return new CloudAuthError("invalid-credentials", "账号或密码错误");
  }
  const message = error instanceof Error ? error.message : String(e["message"] ?? error);
  return new CloudAuthError("network", `${what}失败：${message}`);
}
