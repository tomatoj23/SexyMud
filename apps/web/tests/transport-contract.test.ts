import type { CloudSaveRecord } from "../src/game/cloudSaveStore.js";
import { alice, FakeDb, FakeTransport, makeTransport } from "./support.js";
import {
  cloudSaveTransportContract,
  type TransportRig,
  type TransportTarget,
} from "./transport-contract.js";

/**
 * The contract suite's two IN-MEMORY targets (#44, decision D1/D3): the RAM
 * fake transport and the CloudBase transport over `FakeDb`. Both are fakes a
 * case can fault at will — which is exactly why the third target, the CloudBase
 * transport against a REAL backend, is registered in `cloudbase-e2e.test.ts`
 * instead of here: that file already owns the env gate and the test account's
 * session, and one file owning the real backend keeps parallel test files from
 * fighting over it (each `open()` there takes a per-case key).
 */

const KEY = "save-slot-1";

/**
 * Target one — the RAM fake transport. Its knob speaks the contract's
 * vocabulary directly (an injected `CloudSaveError` is what a conforming
 * transport throws), so `classify` is off: there is no adapter here to judge
 * raw backend shapes. `failWith` stamps every device over the shared backend —
 * "the backend is down" is not one device's opinion.
 */
function ramTarget(): TransportTarget {
  return {
    can: { seedRecord: true, faults: true },
    open() {
      const backend = new Map<string, CloudSaveRecord>();
      const devices: FakeTransport[] = [];
      let fault: Error | null = null;
      const make = (): FakeTransport => {
        const device = new FakeTransport(backend);
        device.failing = fault;
        devices.push(device);
        return device;
      };
      const rig: TransportRig = {
        key: KEY,
        transport: make(),
        other: make,
        seedRecord: (row) => {
          backend.set(KEY, row);
        },
        failWith: (error) => {
          fault = error;
          for (const device of devices) device.failing = error;
        },
      };
      return rig;
    },
  };
}

/** Target two — the CloudBase transport over the shared `FakeDb` baseline. */
function fakedbTarget(): TransportTarget {
  return {
    can: { seedRecord: true, faults: true, classify: true },
    open() {
      const db = new FakeDb();
      return {
        key: KEY,
        transport: makeTransport(db),
        other: () => makeTransport(db),
        seedRecord: (row) => {
          db.rows.set(`${alice.uid}~${KEY}`, row as unknown as { text: unknown; revision: unknown });
        },
        failWith: (error) => {
          db.failing = error;
        },
      };
    },
  };
}

cloudSaveTransportContract("the RAM fake transport", ramTarget());
cloudSaveTransportContract("CloudBase transport × FakeDb", fakedbTarget());
