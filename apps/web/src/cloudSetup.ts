import cloudbase from "@cloudbase/js-sdk";
import { CloudAuth, type CloudAuthSession } from "./game/cloudAuth.js";
import { CloudSaveStore } from "./game/cloudSaveStore.js";
import { CloudSync } from "./game/cloudSync.js";
import { CloudBaseSaveTransport } from "./game/cloudbaseTransport.js";
import {
  createCloudbaseAuthClient,
  createCloudbaseSaveDb,
  type CloudbaseApp,
} from "./game/cloudbaseSdk.js";
import { LocalSaveStore } from "./game/localSaveStore.js";

/**
 * The host's cloud wiring (#30, ADR-0037): one CloudBase app, one session
 * manager, and a sync stack BUILT PER LOGIN — a transport is bound to one
 * authenticated session (decision D1 of #29), so a re-login (possibly as a
 * different account) rebuilds the transport and its `CloudSync` around the
 * new session (decision D6). The revision minter is supplied HERE, at the
 * platform edge, so `game/` stays free of unseeded randomness (host-purity).
 */

/** The one save slot the host uses today. */
export const SAVE_SLOT_KEY = "save-slot-1";

export interface CloudStack {
  auth: CloudAuth;
  /** The sync instance for one session — rebuilt per login (decision D6). */
  openSync(session: CloudAuthSession): CloudSync;
}

/**
 * Builds the stack for a CloudBase environment. Returns `null` without an
 * env id — cloud save is then simply not configured (the local store still
 * is; a missing feature is not a failed save).
 */
export function setupCloud(envId: string | undefined): CloudStack | null {
  if (!envId) return null;
  const app: CloudbaseApp = cloudbase.init({ env: envId });
  const auth = new CloudAuth(createCloudbaseAuthClient(app));
  const db = createCloudbaseSaveDb(app);
  return {
    auth,
    openSync(session: CloudAuthSession): CloudSync {
      const transport = new CloudBaseSaveTransport(db, session, {
        mintRevision: () => crypto.randomUUID(),
      });
      return new CloudSync(new CloudSaveStore(transport, SAVE_SLOT_KEY), new LocalSaveStore(SAVE_SLOT_KEY), auth);
    },
  };
}
