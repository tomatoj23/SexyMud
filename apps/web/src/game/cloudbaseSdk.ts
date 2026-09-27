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
 * ⚠️ **Why the casts**: `@cloudbase/js-sdk@3.10.1`'s TYPES lag its RUNTIME in
 * exactly the two places this binding needs — the v3 sign-in method names
 * (`signInWithPassword`/`signUp`, on the runtime auth object but absent from
 * `ICloudbaseAuth`) and `db.startTransaction()` (the runtime database object
 * has it; the `database.App` interface does not declare it, though
 * `ITransaction` exists). Both were verified against the shipped runtime
 * (`database/dist/index.js` exposes `startTransaction`/`runTransaction`;
 * `auth/dist/index.d.ts` declares the v3 `Auth` class). The casts below are
 * the whole gap; the behavior behind them is what `tests/cloudbase-e2e.test.ts`
 * smoke-tests against a real environment.
 */

/** The initialized `cloudbase.init()` app, as this binding consumes it. */
export type CloudbaseApp = unknown;

/** The SDK auth object's v3 surface (runtime truth; types incomplete). */
interface CloudbaseAuthSurface {
  signInWithPassword(credentials: { username: string; password: string }): Promise<unknown>;
  signUp(params: { username: string; password: string }): Promise<unknown>;
  getLoginState(): Promise<{ user?: CloudbaseUserLike } | null>;
  signOut(): Promise<unknown>;
}

/** The user fields a session can be read from (v1-compat and v3 shapes alike). */
interface CloudbaseUserLike {
  uid?: string;
  sub?: string;
  username?: string;
  email?: string;
}

/** Wraps the SDK auth object as the session manager's contract. */
export function createCloudbaseAuthClient(app: CloudbaseApp): CloudAuthClient {
  const auth = (app as { auth(): unknown }).auth() as CloudbaseAuthSurface;
  return {
    async signUp(username, password) {
      // Registration and sign-in are two calls on purpose: whether sign-up
      // lands a session is SDK policy, and a fresh SIGN-IN is the one state
      // this binding knows how to read a session out of.
      try {
        await auth.signUp({ username, password });
      } catch (error) {
        throw authFailure(error);
      }
      return establishedSession(auth, username, password);
    },
    async signIn(username, password) {
      try {
        await auth.signInWithPassword({ username, password });
      } catch (error) {
        throw authFailure(error);
      }
      return establishedSession(auth, username, password);
    },
    async getLoginState() {
      return sessionOf(await auth.getLoginState().catch(() => null));
    },
    async signOut() {
      await auth.signOut();
    },
  };
}

/** Wraps the SDK database object as the transport's contract (one cast, see above). */
export function createCloudbaseSaveDb(app: CloudbaseApp): CloudBaseDb {
  return (app as { database(): unknown }).database() as CloudBaseDb;
}

/** Reads the live session out of the SDK's login state. */
async function establishedSession(
  auth: CloudbaseAuthSurface,
  username: string,
  password: string,
): Promise<CloudAuthSession> {
  const session = sessionOf(await auth.getLoginState().catch(() => null));
  if (session) return session;
  // Some backends sign up without landing a session — sign in explicitly.
  try {
    await auth.signInWithPassword({ username, password });
  } catch (error) {
    throw authFailure(error);
  }
  const landed = sessionOf(await auth.getLoginState().catch(() => null));
  if (!landed) {
    throw new CloudAuthError("network", "登录成功但未获得会话");
  }
  return landed;
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

/**
 * Login-time failures for the FORM (decision D5's discipline, applied to the
 * sign-in edge): the SDK's documented categories decide the hint, everything
 * unknown is `network` (retryable is the safe reading).
 */
function authFailure(error: unknown): CloudAuthError {
  const e = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  const category = String(e["category"] ?? "");
  const code = String(e["code"] ?? "");
  if (code === "already_exists" || code === "ALREADY_EXISTS") {
    return new CloudAuthError("already-exists", "用户名已被注册");
  }
  if (
    category === "INVALID_CREDENTIALS" ||
    category === "USER_NOT_FOUND" ||
    category === "AUTH_METHOD_MISMATCH" ||
    code === "invalid_password" ||
    code === "invalid_credentials" ||
    code === "invalid_grant"
  ) {
    return new CloudAuthError("invalid-credentials", "用户名或密码错误");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CloudAuthError("network", `登录失败：${message}`);
}
