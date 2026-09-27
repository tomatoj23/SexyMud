import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSaveStore } from "../src/game/localSaveStore.js";
import { memoryStorage, snapshotFixture } from "./support.js";

/**
 * `LocalSaveStore` at its own seam (spec/07 **G6**, #29): the localStorage
 * STRING round-trip. E3 covers the engine's pure JSON round-trip
 * (`migrations.test.ts` asserts `"少侠"` survives); this file covers the host
 * half — the save text through a `Storage`, where a WebView can mangle
 * surrogate pairs if anyone on this side of the seam is sloppy.
 *
 * What is pinned is our side of the seam: the stored string is exactly the
 * exportable JSON document, and it parses back to an equal snapshot for
 * surrogate pairs (`𠮷`), emoji, CJK and even a lone surrogate (which
 * `JSON.stringify` escapes, so it survives too). The storage layer itself is
 * the environment's business — a RAM `Storage` here, the browser's there.
 *
 * The contrast with `CloudSaveStore` is deliberate: the local slot is
 * last-write-wins (one machine, one writer), which is exactly why the cloud
 * store's writes are compare-and-swap instead (decision D2). "Corrupt" reads
 * the SAME in both stores — one envelope check for both (saveText.ts).
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalSaveStore — the localStorage string seam (G6)", () => {
  it("save → load round-trips surrogate pairs, emoji, CJK and a lone surrogate unchanged", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const store = new LocalSaveStore("save-slot-1");
    const snapshot = snapshotFixture({ flags: ["少侠", "𠮷野家", "🎮", "\uD800"] });

    await store.save(snapshot);

    // The stored string IS the exportable document, unmangled…
    expect(localStorage.getItem("save-slot-1")).toBe(JSON.stringify(snapshot));
    // …and it comes back equal — nothing is lost to the text seam.
    await expect(store.load()).resolves.toEqual(snapshot);
  });

  it("a missing save reads as null — absence is not failure", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const store = new LocalSaveStore("save-slot-1");
    await expect(store.load()).resolves.toBeNull();
  });

  it("a corrupt save fails loudly — never a silent fresh start that autosaves over the damage", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const store = new LocalSaveStore("save-slot-1");

    // Each damage class names its own door (saveText.ts) — an "it threw"
    // assertion would pass through either class silently disappearing.
    localStorage.setItem("save-slot-1", "{oops");
    await expect(store.load()).rejects.toThrow("save: stored text is not JSON");
    localStorage.setItem("save-slot-1", JSON.stringify({ hello: "world" }));
    await expect(store.load()).rejects.toThrow("save: stored text is not a snapshot envelope");
  });

  it("a second save replaces the first — the local slot is last-write-wins (one machine, one writer)", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const store = new LocalSaveStore("save-slot-1");

    await store.save(snapshotFixture({ flags: ["first"] }));
    await store.save(snapshotFixture({ flags: ["second"] }));
    await expect(store.load()).resolves.toEqual(snapshotFixture({ flags: ["second"] }));
  });
});
