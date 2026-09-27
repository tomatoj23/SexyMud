import { describe, expect, it } from "vitest";
import {
  CloudAuth,
  CloudAuthError,
  type AuthState,
  type CloudAuthClient,
  type CloudAuthSession,
} from "../src/game/cloudAuth.js";

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
 *     the state must not move on a rejected sign-in;
 *   - a re-login out of `expired` re-arms identity (decision D6) — that is
 *     also what rebuilds the save transport bound to the new session;
 *   - anonymous identity is not offered at all (decision D2): the only way
 *     to a session is an account.
 */

const session: CloudAuthSession = { uid: "uid-1", account: "侠客行" };

/** A contract-faithful fake: scripted sessions and failures, call records. */
class FakeAuthClient implements CloudAuthClient {
  /** What `getLoginState` reports — the persisted session of a previous visit. */
  restored: CloudAuthSession | null = null;
  /** When set, `signIn`/`signUp` reject with this error — wrong password, offline. */
  failing: CloudAuthError | null = null;
  signedOut = 0;
  calls: { method: string; username: string; password: string }[] = [];

  private record(method: string, username: string, password: string): CloudAuthSession {
    this.calls.push({ method, username, password });
    if (this.failing) throw this.failing;
    return session;
  }

  signUp(username: string, password: string): Promise<CloudAuthSession> {
    return Promise.resolve(this.record("signUp", username, password));
  }

  signIn(username: string, password: string): Promise<CloudAuthSession> {
    return Promise.resolve(this.record("signIn", username, password));
  }

  getLoginState(): Promise<CloudAuthSession | null> {
    return Promise.resolve(this.restored);
  }

  signOut(): Promise<void> {
    this.signedOut += 1;
    return Promise.resolve();
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

  it("sign-in lands → signed-in, and the client saw the credentials", async () => {
    const client = new FakeAuthClient();
    const auth = new CloudAuth(client);

    expectStatus(await auth.signIn("侠客行", "口令"), "signed-in");
    expect(client.calls).toEqual([{ method: "signIn", username: "侠客行", password: "口令" }]);
    expect(auth.session).toEqual(session);
  });

  it("sign-up lands → signed-in through the same channel (an account is the only path, decision D2)", async () => {
    const client = new FakeAuthClient();
    const auth = new CloudAuth(client);

    expectStatus(await auth.signUp("侠客行", "口令"), "signed-in");
    expect(client.calls[0]!.method).toBe("signUp");
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
});

describe("CloudAuth — a wrong password is a login failure, never an expiry (decision D6)", () => {
  it("a rejected sign-in leaves the state exactly where it was", async () => {
    const client = new FakeAuthClient();
    client.failing = new CloudAuthError("invalid-credentials", "用户名或密码错误");
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

  it("a taken username at sign-up is its own kind — the form asks for another name, not a retry", async () => {
    const client = new FakeAuthClient();
    client.failing = new CloudAuthError("already-exists", "用户名已被注册");
    const auth = new CloudAuth(client);

    await expect(auth.signUp("侠客行", "口令")).rejects.toMatchObject({ kind: "already-exists" });
    expectStatus(auth.state, "signed-out");
  });
});

describe("CloudAuth — expiry is a re-login prompt, and re-login re-arms (decision D6)", () => {
  it("an auth failure during a cloud save marks the session expired, keeping the account for the prompt", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();

    auth.markExpired(); // what CloudSync reports on CloudSaveError("auth")
    expectStatus(auth.state, "expired");
    expect(auth.state).toEqual({ status: "expired", account: session.account });
  });

  it("'expired' is distinguishable from 'signed-out' — a dead session is guidance, a logout is a login form", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();
    auth.markExpired();

    expect(auth.state.status).not.toBe("signed-out");
    expect(auth.session).toBeNull(); // the dead session grants NO identity
  });

  it("signing back in from 'expired' returns to signed-in — the re-login the prompt asks for", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();
    auth.markExpired();

    expectStatus(await auth.signIn("侠客行", "口令"), "signed-in");
    expect(auth.session).toEqual(session);
  });

  it("marking expiry without a session changes nothing — 'expired' names a session that died", async () => {
    const auth = new CloudAuth(new FakeAuthClient());
    auth.markExpired();
    expectStatus(auth.state, "signed-out");
  });

  it("marking expiry twice is one transition (idempotent)", async () => {
    const client = new FakeAuthClient();
    client.restored = session;
    const auth = new CloudAuth(client);
    await auth.restore();

    auth.markExpired();
    auth.markExpired();
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
    auth.markExpired();
    await auth.signOut();
    unsubscribe();
    await auth.signIn("侠客行", "口令");

    expect(seen).toEqual(["signed-in", "expired", "signed-out"]);
  });
});
