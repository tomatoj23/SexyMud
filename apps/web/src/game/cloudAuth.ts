/**
 * Cloud save identity — the session the save transport is bound to (#30,
 * spec/04 §1.6, ADR-0037). #29 decided identity lives in the TRANSPORT, not
 * in the save store (decision D1 there): a transport is constructed already
 * bound to one authenticated session. This module is where such a session
 * comes from — an ACCOUNT, because cross-device continuation needs an
 * identity that outlives a device (a device id covers one machine only).
 *
 * **Login method (decision D1)**: account + password against CloudBase's
 * built-in identity — no third-party registration gates (a WeChat web login
 * needs an open-platform business account; phone login needs SMS signature
 * and template approvals). The account is an EMAIL or a USERNAME (the SDK
 * takes both). REGISTRATION is the backend's two-step OTP flow (it demands a
 * verifiable email or phone — see `cloudbaseSdk.ts`): `signUp` mails a code,
 * `verify` completes the account. Phone / WeChat / custom-login are later
 * identity SOURCES on the same session shape; none of this module's callers
 * change.
 *
 * **Anonymous identity is not offered (decision D2)**: an anonymous session
 * is device-scoped, so a save behind it silently dies with the device — the
 * "thought it was saved" hole #29 exists to close, wearing a different hat.
 * The cloud button must always mean "continues on my other device", so it
 * always means an account. Logged out, the host runs `LocalSaveStore` alone.
 *
 * **Expiry is not logout (decision D6)**: a dead session is a RE-LOGIN
 * PROMPT with the account it belonged to; a logout is a plain login form.
 * A wrong password is a LOGIN FAILURE and never an expiry — the state does
 * not move on a rejected sign-in. Nothing here retries on its own; the
 * player's re-login is the only way back, and it re-arms identity for the
 * transport the host rebuilds around the new session. Expiry is OWNED by the
 * session that died: a late failure from an old session can never expire the
 * next one.
 */

/**
 * The one authenticated session a save transport binds to (decision D1 of
 * #29, decided there; produced here). `uid` is the CROSS-DEVICE account id
 * and scopes the storage namespace; `account` is for display only.
 */
export interface CloudAuthSession {
  /** The cross-device account id — "whose save is this", answered once here. */
  readonly uid: string;
  /** How the player is addressed (username or email), display-only. */
  readonly account: string;
}

/**
 * A login-time failure, classified for the FORM's message — never for state.
 * The kind drives the hint: `invalid-credentials` / `already-exists` mean
 * "fix your input", `network` means "try again later" (decision D6: a login
 * failure is not an expiry — the state never moves on a rejected sign-in).
 */
export class CloudAuthError extends Error {
  constructor(
    readonly kind: "invalid-credentials" | "already-exists" | "network",
    message: string,
  ) {
    super(message);
    this.name = "CloudAuthError";
  }
}

/**
 * The seam between the session manager and whatever identity backend carries
 * it (CloudBase auth, per ADR-0002 §2 — the SDK binding is `cloudbaseSdk.ts`).
 * Failures reject with {@link CloudAuthError}: `invalid-credentials` for a
 * wrong account/password (the form says so), `already-exists` for a taken
 * email at sign-up, `network` for offline (retry the login later).
 * Anything else the binding cannot classify is `network`.
 */
export interface CloudAuthClient {
  /**
   * Starts registration — a TWO-STEP by the backend's design: it mails a
   * verification code and returns the completer. Rejects `already-exists`
   * for a taken email.
   */
  signUp(email: string, password: string): Promise<(code: string) => Promise<CloudAuthSession>>;
  /** Signs in an existing account (email or username); rejects `invalid-credentials` on a wrong password. */
  signIn(account: string, password: string): Promise<CloudAuthSession>;
  /** The persisted session of a previous visit, or `null` when there is none. */
  getLoginState(): Promise<CloudAuthSession | null>;
  /** Drops the backend session (logout). */
  signOut(): Promise<void>;
}

/** A registration in flight — the code is on its way to the player's inbox. */
export interface SignUpAttempt {
  /** Completes registration with the emailed code and lands signed-in. */
  verify(code: string): Promise<AuthState>;
}

/**
 * The three states of the session (decision D6) — `expired` is NOT
 * `signed-out`: the first is guidance ("sign in again to keep your cloud
 * save"), the second is the ordinary login form. `session` is the identity a
 * transport binds to; it exists only in `signed-in`, because a dead or
 * logged-out session must grant NO identity at all.
 */
export type AuthState =
  | { status: "signed-out" }
  | { status: "signed-in"; session: CloudAuthSession }
  | { status: "expired"; account: string };

export class CloudAuth {
  private current: AuthState = { status: "signed-out" };
  private listeners = new Set<() => void>();
  /** Bumped by every transition — `restore` uses it to not clobber newer state. */
  private epoch = 0;

  constructor(private readonly client: CloudAuthClient) {}

  get state(): AuthState {
    return this.current;
  }

  /** The live session, or `null` outside `signed-in` — what the transport binds to. */
  get session(): CloudAuthSession | null {
    return this.current.status === "signed-in" ? this.current.session : null;
  }

  /** Notifies on every transition; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Boot-time probe for a persisted session. A missing session reads as
   * `signed-out`, never `expired` — "expired" names a session that DIED; one
   * that never existed is just the login form. A slow probe never clobbers a
   * newer transition: if the player signed in (or out) while it was in
   * flight, the probe's answer is discarded.
   */
  async restore(): Promise<AuthState> {
    const seen = this.epoch;
    const session = await this.client.getLoginState();
    if (this.epoch !== seen) return this.current;
    return this.transition(session ? { status: "signed-in", session } : { status: "signed-out" });
  }

  /**
   * Signs in (or re-logs-in from `expired`). A rejection is a LOGIN FAILURE:
   * {@link CloudAuthError} bubbles to the form and the state does not move —
   * a wrong password is not an expiry (decision D6).
   */
  async signIn(account: string, password: string): Promise<AuthState> {
    const session = await this.client.signIn(account, password);
    return this.transition({ status: "signed-in", session });
  }

  /**
   * Starts registration (decision D1: the backend's two-step OTP flow). The
   * returned attempt completes it; until `verify` lands, the state machine
   * does not move — a registration in flight is not a session.
   */
  async signUp(email: string, password: string): Promise<SignUpAttempt> {
    const complete = await this.client.signUp(email, password);
    return {
      verify: async (code: string) => {
        const session = await complete(code);
        return this.transition({ status: "signed-in", session });
      },
    };
  }

  async signOut(): Promise<AuthState> {
    await this.client.signOut();
    return this.transition({ status: "signed-out" });
  }

  /**
   * A session died mid-flight — a cloud operation failed `auth` (decision
   * D6). One transition to `expired`, keeping the account for the prompt —
   * but only for the session that DIED: a late failure from an old session
   * must never expire the one the player holds now. Without a live session
   * there is nothing to expire.
   */
  markExpired(session: CloudAuthSession): void {
    if (this.current.status === "signed-in" && this.current.session.uid === session.uid) {
      this.transition({ status: "expired", account: session.account });
    }
  }

  private transition(next: AuthState): AuthState {
    this.epoch += 1;
    this.current = next;
    for (const listener of this.listeners) listener();
    return next;
  }
}
