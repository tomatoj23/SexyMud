import { describe, expect, it } from "vitest";
import { CloudAuthError, type CloudAuthSession } from "../src/game/cloudAuth.js";
import {
  createCloudbaseAuthClient,
  createCloudbaseSaveDb,
  type CloudbaseApp,
} from "../src/game/cloudbaseSdk.js";
import { probeFailureContract } from "./support.js";

/**
 * The CloudBase SDK binding (#30, ADR-0037) — the seam where SDK REALITY is
 * absorbed: auth calls RESOLVE `{ data, error }` (they don't throw), sign-up
 * is a two-step OTP flow, sign-out can fail quietly. These tests pin the
 * mapping onto the game's contract (`CloudAuthClient`): failures become
 * classified {@link CloudAuthError}s, a session is read out of the login
 * state, and the account field dispatches to email or username.
 *
 * The regression each shape guards: awaiting these calls blindly used to
 * read a wrong password as "登录成功但未获得会话". A failed PROBE is the same
 * family of quiet lie — decision D1 (#43) rules it loud: "failure ≠ no
 * session", pinned here and by the shared probe-failure contract.
 */

const session: CloudAuthSession = { uid: "uid-1", account: "侠客行" };

/** A scripted SDK auth object in the SDK's RESOLVE-with-error shape. */
function stubAuth(
  overrides: Partial<{
    signInWithPassword: (credentials: unknown) => Promise<unknown>;
    signUp: (params: unknown) => Promise<unknown>;
    getLoginState: () => Promise<unknown>;
    signOut: () => Promise<unknown>;
  }> = {},
) {
  const calls: { method: string; arg: unknown }[] = [];
  const auth = {
    async signInWithPassword(credentials: unknown) {
      calls.push({ method: "signInWithPassword", arg: credentials });
      return overrides.signInWithPassword
        ? overrides.signInWithPassword(credentials)
        : { data: { user: null, session: null }, error: null };
    },
    async signUp(params: unknown) {
      calls.push({ method: "signUp", arg: params });
      return overrides.signUp ? overrides.signUp(params) : { data: {}, error: null };
    },
    async getLoginState() {
      calls.push({ method: "getLoginState", arg: null });
      return overrides.getLoginState ? overrides.getLoginState() : { user: { uid: "uid-1", username: "侠客行" } };
    },
    async signOut() {
      calls.push({ method: "signOut", arg: null });
      return overrides.signOut ? overrides.signOut() : { data: {}, error: null };
    },
  };
  const app: CloudbaseApp = { auth: () => auth };
  return { app, calls, client: createCloudbaseAuthClient(app) };
}

const sdkError = (shape: Record<string, unknown>) => ({ data: { user: null, session: null }, error: shape });

describe("cloudbaseSdk — the SDK's resolve-with-error channel becomes classified failures", () => {
  it("a wrong password comes back as an 'invalid-credentials' rejection — not a phantom session failure", async () => {
    const { client } = stubAuth({
      signInWithPassword: () => Promise.resolve(sdkError({ category: "INVALID_CREDENTIALS", message: "bad" })),
    });

    await expect(client.signIn("侠客行", "错")).rejects.toMatchObject({
      name: "CloudAuthError",
      kind: "invalid-credentials",
    });
  });

  it("a taken email at sign-up is 'already-exists' — the form asks for another address", async () => {
    const { client } = stubAuth({
      signUp: () => Promise.resolve(sdkError({ code: "already_exists", message: "taken" })),
    });

    await expect(client.signUp("a@b.c", "口令")).rejects.toMatchObject({ kind: "already-exists" });
  });

  it("an unclassifiable resolved error is 'network' — the safe reading of the unknown", async () => {
    const { client } = stubAuth({
      signInWithPassword: () => Promise.resolve(sdkError({ code: "internal", message: "boom" })),
    });

    await expect(client.signIn("侠客行", "口令")).rejects.toMatchObject({ kind: "network" });
  });

  it("a THROWN failure classifies the same way — offline is 'network'", async () => {
    const { client } = stubAuth({
      signInWithPassword: () => Promise.reject(new TypeError("Failed to fetch")),
    });

    await expect(client.signIn("侠客行", "口令")).rejects.toMatchObject({ kind: "network" });
  });

  it("a failed logout REJECTS — 'signed out' over a live backend session is a lie (decision D8's discipline)", async () => {
    const { client } = stubAuth({
      signOut: () => Promise.resolve({ data: {}, error: { code: "unavailable", message: "down" } }),
    });

    await expect(client.signOut()).rejects.toMatchObject({ name: "CloudAuthError" });
  });
});

describe("cloudbaseSdk — account dispatch and session extraction", () => {
  it("an email account signs in with the email shape, a username with the username shape", async () => {
    const email = stubAuth();
    await email.client.signIn("a@b.c", "口令");
    expect(email.calls[0]!.arg).toEqual({ email: "a@b.c", password: "口令" });

    const user = stubAuth();
    await user.client.signIn("侠客行", "口令");
    expect(user.calls[0]!.arg).toEqual({ username: "侠客行", password: "口令" });
  });

  it("the session comes from the login state — uid first, then the OAuth sub", async () => {
    const viaSub = stubAuth({
      getLoginState: () => Promise.resolve({ user: { sub: "sub-9", email: "a@b.c" } }),
    });
    await expect(viaSub.client.signIn("a@b.c", "口令")).resolves.toEqual({ uid: "sub-9", account: "a@b.c" });
  });

  it("a user without any id reads as NO session — no uid, no save namespace (decision D4)", async () => {
    const { client } = stubAuth({
      getLoginState: () => Promise.resolve({ user: { username: "侠客行" } }),
    });

    await expect(client.getLoginState()).resolves.toBeNull();
  });

  it("a login state that fails to load REJECTS — a failed probe is not 'no session' (decision D1, #43)", async () => {
    const { client } = stubAuth({
      getLoginState: () => Promise.reject(new TypeError("unreachable")),
    });

    await expect(client.getLoginState()).rejects.toMatchObject({
      name: "CloudAuthError",
      kind: "network",
    });
  });
});

describe("cloudbaseSdk — a failed probe is loud, never a verdict (decision D1, #43)", () => {
  // The seam ruling as the SHARED contract — the identical case runs against
  // the seam's fake in cloud-auth.test.ts.
  probeFailureContract(() =>
    stubAuth({ getLoginState: () => Promise.reject(new TypeError("unreachable")) }).client,
  );

  it("a probe failure after sign-in is never swallowed into '登录成功但未获得会话'", async () => {
    const { client, calls } = stubAuth({
      getLoginState: () => Promise.reject(new TypeError("unreachable")),
    });

    const error: unknown = await client.signIn("侠客行", "口令").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as Error).message).toContain("获取登录态失败");
    expect((error as Error).message).not.toContain("登录成功但未获得会话");
    // The failure stops the flow at the first probe — no phantom re-login.
    expect(calls.filter((call) => call.method === "signInWithPassword")).toHaveLength(1);
  });

  it("a probe failure on the SECOND probe (after the explicit re-login) is loud too", async () => {
    let probes = 0;
    const { client } = stubAuth({
      getLoginState: () => {
        probes += 1;
        return probes === 1 ? Promise.resolve(null) : Promise.reject(new TypeError("unreachable"));
      },
    });

    const error: unknown = await client.signIn("侠客行", "口令").then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as Error).message).toContain("获取登录态失败");
    expect((error as Error).message).not.toContain("登录成功但未获得会话");
  });

  it("the '登录成功但未获得会话' verdict is reserved for a probe that RAN and found nothing", async () => {
    const { client, calls } = stubAuth({
      getLoginState: () => Promise.resolve(null),
    });

    await expect(client.signIn("侠客行", "口令")).rejects.toThrow("登录成功但未获得会话");
    // The explicit re-login ran before the second probe answered empty.
    expect(calls.filter((call) => call.method === "signInWithPassword")).toHaveLength(2);
  });
});

describe("cloudbaseSdk — sign-up is the backend's two-step OTP flow (decision D1)", () => {
  it("sign-up mails a code and hands back the completer; verifying lands the session", async () => {
    const tokens: string[] = [];
    const { client, calls } = stubAuth({
      signUp: () =>
        Promise.resolve({
          data: {
            verifyOtp: ({ token }: { token: string }) => {
              tokens.push(token);
              return Promise.resolve({ data: {}, error: null });
            },
          },
          error: null,
        }),
    });

    const complete = await client.signUp("a@b.c", "口令");
    expect(calls[0]!.arg).toEqual({ email: "a@b.c", password: "口令" });
    await expect(complete("123456")).resolves.toEqual(session);
    expect(tokens).toEqual(["123456"]);
  });

  it("a sign-up without the completer is a classified failure — the flow cannot be completed", async () => {
    const { client } = stubAuth({ signUp: () => Promise.resolve({ data: {}, error: null }) });

    await expect(client.signUp("a@b.c", "口令")).rejects.toMatchObject({ kind: "network" });
  });

  it("a wrong verification code rejects as 'invalid-credentials' — the state never moved (decision D6)", async () => {
    const { client } = stubAuth({
      signUp: () =>
        Promise.resolve({
          data: {
            verifyOtp: () => Promise.resolve(sdkError({ category: "INVALID_CREDENTIALS", message: "bad code" })),
          },
          error: null,
        }),
    });

    const complete = await client.signUp("a@b.c", "口令");
    await expect(complete("000000")).rejects.toMatchObject({ kind: "invalid-credentials" });
  });
});

describe("cloudbaseSdk — the database wrapper is a straight hand-off (decision D4)", () => {
  it("createCloudbaseSaveDb hands back the SDK's database object", () => {
    const db = { collection: () => undefined };
    const app: CloudbaseApp = { database: () => db };
    expect(createCloudbaseSaveDb(app)).toBe(db);
  });
});
