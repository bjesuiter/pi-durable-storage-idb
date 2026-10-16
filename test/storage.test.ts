import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, StorageRequestError } from "@earendil-works/pi-durable";
import type { DocumentId, EntryId, StorageWrite, TaskId } from "@earendil-works/pi-durable";
import { deleteDB, openDB } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbStorage, openIndexedDbStorage } from "../src/index.js";
import type { DurableDatabase } from "../src/schema.js";

const context = BACKGROUND_CONTEXT;
const databases: string[] = [];
const storages: IndexedDbStorage[] = [];

async function open(name = `storage-${crypto.randomUUID()}`): Promise<IndexedDbStorage> {
  if (!databases.includes(name)) databases.push(name);
  const storage = await openIndexedDbStorage(name);
  storages.push(storage);
  return storage;
}

function databaseName(): string {
  return databases[databases.length - 1]!;
}

async function seed(storage: IndexedDbStorage) {
  await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
  const entryId = await storage.mintId<EntryId>();
  const taskId = await storage.mintId<TaskId<number>>();
  const documentId = await storage.mintId<DocumentId>();
  const writes: StorageWrite[] = [
    { type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "test.note", data: { text: "saved" } } },
    { type: "task", value: {
      id: taskId, conversationId: ROOT_CONVERSATION_ID, kind: "test.task", version: 1,
      input: {}, state: { status: "running", checkpoint: { phase: "next", count: 1 } },
      background: false, abortRequested: false,
    } },
    { type: "document.create", record: {
      id: documentId, kind: "test.document", scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
      history: "rewindable", fork: "asOf",
    }, content: { kind: "base", version: 1, value: { count: 1 } } },
  ];
  const seq = await storage.commit(writes, context);
  return { entryId, taskId, documentId, seq };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(storages.splice(0).map((storage) => storage.close(context)));
  await Promise.all(databases.splice(0).map((name) => deleteDB(name)));
});

describe("IndexedDB persistence and transactions", () => {
  it("reopens records, deltas, sequence numbers, and uncommitted minted IDs", async () => {
    const storage = await open();
    const { entryId, taskId, documentId, seq } = await seed(storage);
    const changedAt = await storage.commit([{ type: "document.change", id: documentId,
      content: { kind: "delta", version: 1, ops: [["s", ["count"], 2]] } }], context);
    const unusedId = await storage.mintId();
    await storage.close(context);
    const reopened = await open(databaseName());
    expect(await reopened.entry(entryId, context)).toMatchObject({ commitSeq: seq, entry: { data: { text: "saved" } } });
    expect(await reopened.task(taskId, context)).toMatchObject({ state: { status: "running", checkpoint: { count: 1 } } });
    expect(await reopened.document(documentId, seq, context)).toMatchObject({ value: { count: 1 }, deltasSinceBase: 0 });
    expect(await reopened.document(documentId, "current", context)).toMatchObject({ value: { count: 2 }, deltasSinceBase: 1 });
    expect(await reopened.mintId()).toBeGreaterThan(unusedId);
    expect(await reopened.commit([], context)).toBeGreaterThan(changedAt);
  });

  it("rolls back all stores when an IndexedDB write fails after earlier requests succeeded", async () => {
    const storage = await open();
    const { taskId, documentId, seq } = await seed(storage);
    const entryId = await storage.mintId<EntryId>();
    const add = IDBObjectStore.prototype.add;
    const fault = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === "revisions") throw new DOMException("Injected quota failure", "QuotaExceededError");
      return add.call(this, value, key);
    });
    await expect(storage.commit([
      { type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "must-roll-back" } },
      { type: "document.change", id: documentId, content: { kind: "delta", version: 1, ops: [["s", ["count"], 99]] } },
    ], context)).rejects.toThrow("Injected quota failure");
    fault.mockRestore();
    await storage.close(context);
    const reopened = await open(databaseName());
    expect(await reopened.entry(entryId, context)).toBeUndefined();
    expect(await reopened.document(documentId, "current", context)).toMatchObject({ value: { count: 1 } });
    expect(await reopened.task(taskId, context)).toBeDefined();
    expect(await reopened.commit([], context)).toBe(seq + 1);
  });

  it("rejects an aborted transaction even after the final write request succeeds", async () => {
    const storage = await open();
    const { documentId } = await seed(storage);
    const put = IDBObjectStore.prototype.put;
    const fault = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = put.call(this, value, key);
      if (this.name === "metadata") request.addEventListener("success", () => this.transaction.abort());
      return request;
    });
    await expect(storage.commit([{ type: "document.change", id: documentId,
      content: { kind: "base", version: 1, value: { count: 99 } } }], context)).rejects.toThrow();
    fault.mockRestore();
    await storage.close(context);
    const reopened = await open(databaseName());
    expect(await reopened.document(documentId, "current", context)).toMatchObject({ value: { count: 1 } });
  });

  it("waits for transaction completion and requests strict durability by default", async () => {
    const storage = await open();
    let completed = false;
    let durability: IDBTransactionDurability | undefined;
    const transaction = IDBDatabase.prototype.transaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, stores, mode, options) {
      const current = transaction.call(this, stores, mode, options);
      if (mode === "readwrite") {
        durability = options?.durability;
        current.addEventListener("complete", () => { completed = true; });
      }
      return current;
    });
    await storage.commit([], context);
    expect(completed).toBe(true);
    expect(durability).toBe("strict");
  });

  it("close waits for admitted commits and rejects new work", async () => {
    const storage = await open();
    const pending = storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
    await storage.close(context);
    await expect(pending).resolves.toBe(1);
    await expect(storage.mintId()).rejects.toThrow("closed");
    const reopened = await open(databaseName());
    expect(await reopened.conversation(ROOT_CONVERSATION_ID, context)).toEqual({ id: ROOT_CONVERSATION_ID });
  });

  it("allocates unique IDs across overlapping transactions and reopening", async () => {
    const storage = await open();
    const ids = await Promise.all(Array.from({ length: 20 }, () => storage.mintId()));
    expect(new Set(ids).size).toBe(20);
    expect(Math.min(...ids)).toBe(2);
    await storage.close(context);
    const reopened = await open(databaseName());
    expect(await reopened.mintId()).toBe(22);
  });

  it("opens without loading records or document history", async () => {
    const storage = await open();
    await seed(storage);
    await storage.close(context);
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const cursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
    await open(databaseName());
    expect(getAll).not.toHaveBeenCalled();
    expect(cursor).not.toHaveBeenCalled();
  });

  it("closes its connection when another client upgrades the database", async () => {
    const storage = await open();
    await seed(storage);
    const upgraded = await openDB(databaseName(), 2);
    try {
      await expect(storage.mintId()).rejects.toThrow("closed");
    } finally {
      upgraded.close();
    }
    await expect(openIndexedDbStorage(databaseName())).rejects.toMatchObject({ name: "VersionError" });
  });

  it("propagates corruption instead of returning absent document content", async () => {
    const storage = await open();
    const { documentId } = await seed(storage);
    const database = await openDB<DurableDatabase>(databaseName(), 1);
    try {
      await database.clear("revisions");
      await expect(storage.document(documentId, "current", context)).rejects.toThrow("missing a required base");
    } finally {
      database.close();
    }
  });

  it("reclaims latest-only bases and retired content while retaining membership metadata", async () => {
    const storage = await open();
    const id = await storage.mintId<DocumentId>();
    const createdAt = await storage.commit([{ type: "document.create", record: { id, kind: "latest", scope: { kind: "session" } },
      content: { kind: "base", version: 1, value: { count: 1 } } }], context);
    await storage.commit([{ type: "document.change", id, content: { kind: "base", version: 1, value: { count: 2 } } }], context);
    const database = await openDB<DurableDatabase>(databaseName(), 1);
    try {
      expect(await database.count("revisions")).toBe(1);
      await storage.commit([{ type: "document.retire", id }], context);
      expect(await database.count("revisions")).toBe(0);
      expect(await storage.findDocument({ kind: "latest", scope: { kind: "session" } }, createdAt, context)).toMatchObject({ id });
      await expect(storage.document(id, createdAt, context)).rejects.toBeInstanceOf(StorageRequestError);
    } finally {
      database.close();
    }
  });

  it("rejects malformed cursors and invalid limits as request errors", async () => {
    const storage = await open();
    await seed(storage);
    await expect(storage.scanTasks({}, 10, { after: "bad" }, context)).rejects.toBeInstanceOf(StorageRequestError);
    await expect(storage.scanTasks({}, 0, undefined, context)).rejects.toBeInstanceOf(StorageRequestError);
    await expect(storage.scanConversations({}, 0, undefined, context)).rejects.toBeInstanceOf(StorageRequestError);
    await expect(storage.scanSubmissions({}, 0, undefined, context)).rejects.toBeInstanceOf(StorageRequestError);
    await expect(storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 0, undefined, context)).rejects.toBeInstanceOf(StorageRequestError);
    await expect(storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, -1, undefined, context)).rejects.toBeInstanceOf(StorageRequestError);
  });

  it("rejects empty names", async () => {
    await expect(openIndexedDbStorage("")).rejects.toThrow("name is required");
  });
});
