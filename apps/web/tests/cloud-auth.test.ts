import { describe, expect, it } from "vitest";
import {
  CloudAuth,
  CloudAuthError,
  type AuthState,
  type CloudAuthClient,
  type CloudAuthSession,
} from "../src/game/cloudAuth.js";
import { probeFailureContract } from "./support.js";

/**
 * Cloud save identity and login (#30; spec/04 §1.6, ADR-0037) — the session
 * manager that answers "whose save is this" before any save is written. The
 * seam under test is the state machine above a contract-shaped auth client
 * (fake below); the CloudBase binding maps the SDK onto the same contract.
 *
 * What the tests pin is decision D6 and its neighbours:
 *
 *   - three states, and `expired` is NOT `signed-out` (decision D6): a dead
 *     session is a re-login prompt, a plain logout is a login form;
 *   - a wrong password is a LOGIN FAILURE, never an expiry (decision D6) —
 *     the state must not move on a rejected sign-in, and a rejected LOGOUT
 *     must not flip to "signed out" either;
 *   - expiry is OWNED by the session that died (decision D6) — a late
 *     failure from an old session can never expire the next one;
 *   - a slow boot probe never clobbers a newer transition;
 *   - registration is the backend's two-step OTP flow (decision D1): a
 *     registration in flight is not a session until `verify` lands;
 *   - anonymous identity is not offered at all (decision D2): the only way
 *     to a session is an account;
 *   - a FAILED probe is not "no session" (decision D1, #43) — the ruling is
 *     the shared probe-failure contract, run against this fake AND the real
 *     binding (cloudbase-sdk.test.ts).
 */

const session: CloudAuthSession = { uid: "uid-1", account: "侠客行" };
const otherSession: CloudAuthSession = { uid: "uid-2", account: "阿波" };

/** A contract-faithful fake: scripted sessions and failures, call records. */
class FakeAuthClient implements CloudAuthClient {
  /** What `getLoginState` reports — the persisted session of a previous visit. */
  restored: CloudAuthSession | null = null;
  /** What `signIn` hands out — override to mint a NEW object for a re-login. */
  signInSession: CloudAuthSession = session;
  /** When set, `signIn`/`signUp` reject with this error — wrong password, offline. */
  failing: CloudAuthError | null = null;
  /** When set, `signOut` rejects — a failed logout must not move the state. */
  signOutFailing: Error | null = null;
  /** When set, the sign-up completer rejects — the wrong verification code. */
  verifyFailing: CloudAuthError | null = null;
  /** When set, `getLoginState` rejects — a probe that cannot probe. */
  restoreFailing: Error | null = null;
  /** Deferred probe resolution — for racing a probe against a sign-in. */
  restoreGate: ((release: (session: CloudAuthSession | null) => void) => void) | null = null;
  signedOut = 0;
  calls: { method: string; account: string; password: string }[] = [];
  verifiedCodes: string[] = [];

  signIn(account: string, password: string): Promise<CloudAuthSession> {
    this.calls.push({ method: "signIn", account, password });
    if (this.failing) return Promise.reject(this.failing);
    return Promise.resolve(this.signInSession);
  }

  signUp(email: string, password: string): Promise<(code: string) => Promise<CloudAuthSession>> {
    this.calls.push({ method: "signUp", account: email, password });
    if (this.failing) return Promise.reject(this.failing);
    return Promise.resolve((code: string) => {
      this.verifiedCodes.push(code);
      if (this.verifyFailing) return Promise.reject(this.verifyFailing);
      return Promise.resolve(session);
    });
  }

  getLoginState(): Promise<CloudAuthSession | null> {
    if (this.restoreGate) {
      return new Promise((resolve) => this.restoreGate!(resolve));
    }
    if (this.restoreFailing) return Promise.reject(this.restoreFailing);
    return Promise.resolve(this.restored);
  }

  signOut(): Promise<void> {
    this.signedOut += 1;
    return this.signOutFailing ? Promise.reject(this.signOutFailing) : Promise.resolve();
  }
}

/** Asserts the state carries exactly this status (discriminated, not duck-typed). */
function expectStatus(state: AuthState, status: AuthState["status"]): void {
  expect(state.status).toBe(status);
}

describe("CloudAuth — the three states (decision D6)", () => {
  it("restore finds a persisted session → signed-in with the account identity", async () => {
    const client = new FakeAuthClient();
    client.restored = session;

    const auth = new CloudAuth(client);
    expectStatus(await auth.restore(), "signed-in");
    expect(auth.session).toEqual(session);
  });

  it("restore finds nothing → plain signed-out, not 'expired' (no session ever died)", async () => {
    const auth = new CloudAuth(new FakeAuthClient());
    expectStatus(await auth.restore(), "signed-out");
    expect(auth.session).toBeNull();
  });

  // The failed-probe ruling as the SHARED contract (#43, decision D1/D4) —
  // the identical case runs against the real binding in cloudbase-sdk.test.ts.
  probeFailureContract(() => {
    const client = new FakeAuthClient();
    client.restoreFailing = new Error("unreachable");
    return client;
  });

  it("a slow probe never clobbers a newer sign-in — the probe's stale answer is discarded", async () => {
    const client = new FakeAuthClient();
    const auth = new CloudAuth(client);
    let release!: (session: CloudAuthSession | null) => void;
    client.restoreGate = (resolve) => {
      release = resolve;
    };

    const probe = auth.restore(); // hangs on getLoginState
    await auth.signIn("侠客行", "口令"); // the player acts first
    release(otherSession); // the stale probe answers with ANOTHER session
    await probe;

    expect(auth.session).toEqual(session); // the newer transition won
  });

  it("sign-in lands → signed-in, and the client saw the credentials", async () => {
    const client = new FakeAuthClient();
    const auth = new CloudAuth(client);

    expectStatus(await auth.signIn("侠客行", "口令"), "signed-in");
    expect(client.calls).toEqual([{ method: "signIn", account: "侠客行", password: "口令" }]);
    expect(auth.session).toEqual(session);
  });

  it("registration is two-step: nothing lands until the emailed code is verified (decision D1)", async () => {
    const client = new FakeAuthClient();
    const auth = new CloudAuth(client);

    const attempt = await auth.signUp("a@b.c", "口令");
    expectStatus(auth.state, "signed-out"); // a registration in flight is not a session
    expect(client.calls[0]).toEqual({ method: "signUp", account: "a@b.c", password: "口令" });

    expectStatus(await attempt.verify("123456"), "signed-in");
    expect(client.verifiedCodes).toEqual(["123456"]);
  });

  it("a wrong verification code rejects and the state does not move", async () => {
    const client = new FakeAuthClient();
    client.verifyFailing = new CloudAuthError("invalid-credentials", "验证码错误");
    const auth = new CloudAuth(client);

    const attempt = await auth.signUp("a@b.c", "口令");
    await expect(attempt.verify("000000")).rejects.toMatchObject({
      name: "CloudAuthError",
      kind: "invalid-credentials",
    });
    expectStatus(auth.state, "signed-out");
  });

  it("sign-out → signed-out, and the backend session is dropped too", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();

    await auth.signOut();
    expectStatus(auth.state, "signed-out");
    expect(client.signedOut).toBe(1);
    expect(auth.session).toBeNull();
  });

  it("a FAILED logout keeps the session — 'signed out' over a live backend session is a lie", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    client.signOutFailing = new Error("unreachable");
    const auth = new CloudAuth(client);
    await auth.restore();

    await expect(auth.signOut()).rejects.toThrow("unreachable");
    expectStatus(auth.state, "signed-in"); // the state must not move on a rejected logout
  });
});

describe("CloudAuth — a wrong password is a login failure, never an expiry (decision D6)", () => {
  it("a rejected sign-in leaves the state exactly where it was", async () => {
    const client = new FakeAuthClient();
    client.failing = new CloudAuthError("invalid-credentials", "账号或密码错误");
    const auth = new CloudAuth(client);

    await expect(auth.signIn("侠客行", "错口令")).rejects.toMatchObject({
      name: "CloudAuthError",
      kind: "invalid-credentials",
    });
    expectStatus(auth.state, "signed-out"); // NOT "expired" — nothing ever expired
  });

  it("an offline sign-in is classified separately from a wrong password", async () => {
    const client = new FakeAuthClient();
    client.failing = new CloudAuthError("network", "网络不通");
    const auth = new CloudAuth(client);

    await expect(auth.signIn("侠客行", "口令")).rejects.toMatchObject({ kind: "network" });
    expectStatus(auth.state, "signed-out");
  });

  it("a taken email at sign-up is its own kind — the form asks for another address, not a retry", async () => {
    const client = new FakeAuthClient();
    client.failing = new CloudAuthError("already-exists", "该邮箱已被注册");
    const auth = new CloudAuth(client);

    await expect(auth.signUp("a@b.c", "口令")).rejects.toMatchObject({ kind: "already-exists" });
    expectStatus(auth.state, "signed-out");
  });
});

describe("CloudAuth — expiry is a re-login prompt, owned by the session that died (decision D6)", () => {
  it("an auth failure during a cloud save marks the session expired, keeping the account for the prompt", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();

    auth.markExpired(session); // what CloudSync reports on CloudSaveError("auth")
    expectStatus(auth.state, "expired");
    expect(auth.state).toEqual({ status: "expired", account: session.account });
  });

  it("'expired' is distinguishable from 'signed-out' — a dead session is guidance, a logout is a login form", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();
    auth.markExpired(session);

    expect(auth.state.status).not.toBe("signed-out");
    expect(auth.session).toBeNull(); // the dead session grants NO identity
  });

  it("a LATE failure from an old session never expires the next one — expiry carries its owner's id", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();
    auth.markExpired(session);
    await auth.signIn("侠客行", "口令"); // re-login — possibly as another account

    auth.markExpired(otherSession); // …and THEN the old session's failure lands
    expectStatus(auth.state, "signed-in"); // the player's new session survives
  });

  it("a re-login of the SAME account is a new session — the old login's late failure must not expire it", async () => {
    const client = new FakeAuthClient();
    client.restored = session; // one login…
    const auth = new CloudAuth(client);
    await auth.restore();
    await auth.signOut();
    client.signInSession = { uid: session.uid, account: session.account }; // …a NEW login, same uid
    await auth.signIn("侠客行", "口令");

    auth.markExpired(session); // the OLD login's failure finally lands

    expectStatus(auth.state, "signed-in"); // uid names the account; the session object is the identity
  });

  it("signing back in from 'expired' returns to signed-in — the re-login the prompt asks for", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();
    auth.markExpired(session);

    expectStatus(await auth.signIn("侠客行", "口令"), "signed-in");
    expect(auth.session).toEqual(session);
  });

  it("marking expiry without a session changes nothing — 'expired' names a session that died", async () => {
    const auth = new CloudAuth(new FakeAuthClient());
    auth.markExpired(session);
    expectStatus(auth.state, "signed-out");
  });

  it("marking expiry twice is one transition (idempotent)", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();

    auth.markExpired(session);
    auth.markExpired(session);
    expect(auth.state).toEqual({ status: "expired", account: session.account });
  });
});

describe("CloudAuth — state changes are observable (the UI follows, never polls)", () => {
  it("every transition notifies subscribers, and unsubscribing stops the noise", async () => {
    const client = new FakeAuthClient();
    const auth = new CloudAuth(client);
    const seen: AuthState["status"][] = [];
    const unsubscribe = auth.subscribe(() => seen.push(auth.state.status));

    await auth.signIn("侠客行", "口令");
    auth.markExpired(session);
    await auth.signOut();
    unsubscribe();
    await auth.signIn("侠客行", "口令");

    expect(seen).toEqual(["signed-in", "expired", "signed-out"]);
  });
});
