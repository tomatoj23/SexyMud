import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CloudSaveError, CloudSaveStore } from "../src/game/cloudSaveStore.js";
import type { CloudAuthClient, CloudAuthSession } from "../src/game/cloudAuth.js";
import { CloudBaseSaveTransport } from "../src/game/cloudbaseTransport.js";
import type { CloudBaseDb } from "../src/game/cloudbaseTransport.js";
import {
  createCloudbaseAuthClient,
  createCloudbaseSaveDb,
  type CloudbaseApp,
} from "../src/game/cloudbaseSdk.js";
import { snapshotFixture } from "./support.js";
import { cloudSaveTransportContract, type TransportTarget } from "./transport-contract.js";

/**
 * The real-backend smoke (#30 AC: "真实 CloudBase 后端上 load/save 端到端跑通") —
 * everything else in this suite pins the semantics against fakes; THIS is the
 * check that the adapter's calls, error signals and CAS shape match a real
 * CloudBase environment. It runs ONLY when the environment is configured:
 *
 *   CLOUDBASE_ENV_ID       the CloudBase environment id
 *   CLOUDBASE_TEST_USER    a throwaway username (sign-up runs on first use)
 *   CLOUDBASE_TEST_PASSWORD
 *
 * Console checklist to get there (deployment, not code):
 *   1. 腾讯云 CloudBase 控制台建环境，把环境 id 填进上面的变量
 *      （网页宿主另需 `apps/web/.env.local` 的 `VITE_CLOUDBASE_ENV_ID`）；
 *   2. 身份认证开启账密登录（decision D1），并**在控制台建一个测试用户**
 *      （邮箱／用户名 + 密码——SDK 的自助注册是邮箱验证码两步流，冒烟不走它）；
 *   3. 云数据库建集合 `save_slots`，安全规则只许本人读写
 *      （`_id` 是 `uid~key` 形态（decision D4），规则是第二把锁）；
 *   4. `corepack pnpm --filter @sexymud/web test tests/cloudbase-e2e.test.ts`
 *
 * Smoke calibration points (残余风险 E1) — the places fake-based tests
 * cannot vouch for: ①错误分类信号（UNAUTHENTICATED 16 / "unauthenticated" /
 * 401）对真后端错误形状是否成立；②条件更新 `updated` 计数与事务 create 的
 * 真语义；③文档 id 的 `~` 拼接在真实 REST 路径上的通行；④探测失败的分辨
 * （#43 D1）——SDK 门面把探测失败吞成 `null`（3.10.1 实装查证），真机上
 * 「探测失败」与「无会话」在门面缝合流；binding 已不自吞、裁定住缝上，
 * 冒烟时留意此残余。If any misbehaves, the failure is loud here — never
 * silent.
 *
 * Since #44 this file also carries the transport contract suite's THIRD
 * target — the CloudBase transport against this same real backend (decision
 * D3: the real adapter enters the contract, the smoke above is retained). The
 * contract's live-unauth case is calibration point ① 的常驻钉：the real
 * backend's own unauthenticated signal must classify `auth`, and it fails
 * loudly if the real error shape is not the table's. One file owns the real
 * backend on purpose — parallel test files must never fight over the test
 * account's session — and each contract case takes its own slot key.
 */

const envId = process.env["CLOUDBASE_ENV_ID"];
const testUser = process.env["CLOUDBASE_TEST_USER"];
const testPassword = process.env["CLOUDBASE_TEST_PASSWORD"];
const configured = Boolean(envId && testUser && testPassword);

describe.skipIf(!configured)("CloudBase e2e — the adapter against a real backend (skipped without env)", () => {
  it("sign-in → CAS create / update / refused stale write, end to end", async () => {
    const cloudbase = (await import("@cloudbase/js-sdk")).default;
    const app: CloudbaseApp = cloudbase.init({ env: envId! });
    const auth = createCloudbaseAuthClient(app);
    const db: CloudBaseDb = createCloudbaseSaveDb(app);

    // The test user is PRE-PROVISIONED in the console (see the checklist) —
    // the SDK's self-serve sign-up is a two-step email-OTP flow the smoke
    // deliberately does not drive.
    const session = await auth.signIn(testUser!, testPassword!);
    expect(typeof session.uid).toBe("string");
    expect(session.uid.length).toBeGreaterThan(0);

    // A per-run slot: the smoke never clobbers a player's save.
    const key = `e2e-${Date.now()}`;
    const transport = new CloudBaseSaveTransport(db, session, { mintRevision: randomUUID });
    const deviceA = new CloudSaveStore(transport, key);
    const deviceB = new CloudSaveStore(
      new CloudBaseSaveTransport(db, session, { mintRevision: randomUUID }),
      key,
    );

    // An empty slot is absence, not failure.
    await expect(deviceA.load()).resolves.toBeNull();

    // Create (CAS against "absent") and round-trip the exportable text.
    const first = snapshotFixture({ nowTick: 20 });
    await deviceA.save(first);
    await expect(deviceB.load()).resolves.toEqual(first);

    // Two sessions, one observation: the loser hears "conflict", loudly.
    await deviceB.save(snapshotFixture({ nowTick: 30 }));
    await expect(deviceA.save(snapshotFixture({ nowTick: 40 }))).rejects.toMatchObject({
      name: "CloudSaveError",
      kind: "conflict",
    } satisfies Partial<CloudSaveError>);

    // The deliberate replace (observe first) lands — and reads back.
    const replacement = snapshotFixture({ nowTick: 50 });
    await deviceA.load();
    await deviceA.save(replacement);
    await expect(deviceB.load()).resolves.toEqual(replacement);
  });

  cloudSaveTransportContract("CloudBase transport × real backend", realBackendTarget());
});

/**
 * The contract's third target (#44 D3): the same real backend, opened lazily
 * for one sign-in shared by every case here. `cloudbase.init` is a factory —
 * the shipped `init` of `@cloudbase/js-sdk@3.10.1` constructs a fresh app per
 * call (its own request instance), so this app living beside the smoke's own
 * is sound. The smoke above signs in for itself and is therefore immune to
 * whatever order the two blocks run in; the live-unauth case signs the shared
 * session out LAST and drops the cache, so nothing after it depends on a dead
 * session either. Fault injection is absent here by nature — a real backend
 * cannot be told to be offline — and those cases are skipped, visibly.
 */
/** The signed-in real backend every contract case here shares. */
interface RealBackend {
  auth: CloudAuthClient;
  db: CloudBaseDb;
  session: CloudAuthSession;
}

let realSession: Promise<RealBackend> | null = null;
let realCase = 0;

function signedInBackend(): Promise<RealBackend> {
  realSession ??= (async () => {
    const cloudbase = (await import("@cloudbase/js-sdk")).default;
    const app: CloudbaseApp = cloudbase.init({ env: envId! });
    const auth = createCloudbaseAuthClient(app);
    return {
      auth,
      db: createCloudbaseSaveDb(app),
      session: await auth.signIn(testUser!, testPassword!),
    };
  })();
  return realSession;
}

function realBackendTarget(): TransportTarget {
  return {
    can: { liveUnauth: true },
    async open() {
      const { auth, db, session } = await signedInBackend();
      // A per-case slot: the contract never clobbers another case's rows (the
      // smoke's own `e2e-…` keys stay untouched too), and no cleanup is
      // attempted — same as the smoke, these rows are the test env's to keep.
      const key = `ct-${Date.now()}-${++realCase}`;
      return {
        key,
        transport: new CloudBaseSaveTransport(db, session, { mintRevision: randomUUID }),
        other: () => new CloudBaseSaveTransport(db, session, { mintRevision: randomUUID }),
        expireSession: async () => {
          realSession = null; // this session is dead — a later case signs in afresh
          await auth.signOut();
        },
      };
    },
  };
}
