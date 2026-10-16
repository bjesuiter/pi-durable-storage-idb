import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { deleteDB } from "idb";
import { describe, expect, it } from "vitest";
import { openIndexedDbStorage } from "../src/index.js";

registerStorageConformance({ describe, expect, it }, "IndexedDbStorage", async (use) => {
  const name = `conformance-${crypto.randomUUID()}`;
  const storage = await openIndexedDbStorage(name);
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    await deleteDB(name);
  }
});
