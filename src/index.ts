import type { Context } from "@earendil-works/chord";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type {
  ConversationId, ConversationQuery, ConversationRecord, Cursor,
  DocumentAddress, DocumentId, DocumentPoint, DocumentQuery, DocumentRecord,
  EntryId, EntryQuery, EntryRecord, Id, Page, Seq, Storage, StorageWrite,
  StoredDocument, SubmissionId, SubmissionQuery, SubmissionRecord, TaskId, TaskQuery,
} from "@earendil-works/pi-durable";
import { openDB } from "idb";
import type { IDBPDatabase, IDBPTransaction } from "idb";
import { addressKey, aliveAt, materialize, resolveCopies, scopeKey, writeDocuments } from "./documents.js";
import { cursorRange, page, scan, scanStart } from "./scan.js";
import { indexRange, STORE_NAMES } from "./schema.js";
import type { DurableDatabase, ReadTransaction, RecordKind, StoredTask, Transaction, WriteTransaction } from "./schema.js";

export interface IndexedDbStorageOptions {
  durability?: IDBTransactionDurability;
  blocked?: (currentVersion: number, blockedVersion: number | null) => void;
  terminated?: () => void;
}

export class IndexedDbStorage implements Storage {
  private closed = false;
  private readonly active = new Set<Promise<unknown>>();

  private constructor(
    private readonly database: IDBPDatabase<DurableDatabase>,
    private readonly durability: IDBTransactionDurability,
  ) {}

  static async open(name: string, options: IndexedDbStorageOptions = {}): Promise<IndexedDbStorage> {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB is unavailable in this environment");
    if (name.length === 0) throw new Error("An IndexedDB database name is required");
    let storage: IndexedDbStorage | undefined;
    const database = await openDB<DurableDatabase>(name, 1, {
      upgrade(database) {
        database.createObjectStore("metadata");
        database.createObjectStore("identities");
        const conversations = database.createObjectStore("conversations", { keyPath: "id" });
        conversations.createIndex("ownerConversation", ["owner.conversationId", "id"]);
        conversations.createIndex("ownerTask", ["owner.taskId", "id"]);
        const entries = database.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("conversation", ["conversationId", "id"]);
        const tasks = database.createObjectStore("tasks", { keyPath: "id" });
        tasks.createIndex("conversation", ["conversationId", "id"]);
        tasks.createIndex("status", ["state.status", "id"]);
        const submissions = database.createObjectStore("submissions", { keyPath: "id" });
        submissions.createIndex("conversation", ["conversationId", "id"]);
        submissions.createIndex("status", ["status", "id"]);
        submissions.createIndex("request", ["conversationId", "requestId"]);
        const documents = database.createObjectStore("documents", { keyPath: "id" });
        documents.createIndex("scope", ["scope", "id"]);
        documents.createIndex("address", "address");
        database.createObjectStore("revisions", { keyPath: ["documentId", "seq"] });
      },
      blocked: options.blocked,
      blocking() {
        if (storage !== undefined) void storage.close();
        else database.close();
      },
      terminated() {
        if (storage !== undefined) storage.closed = true;
        options.terminated?.();
      },
    });
    storage = new IndexedDbStorage(database, options.durability ?? "strict");
    return storage;
  }

  async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    const detached = structuredClone(writes);
    return this.write(async (transaction) => {
      const metadata = await transaction.objectStore("metadata").get("state") ?? { nextId: 2, nextSeq: 1 };
      if (!Number.isSafeInteger(metadata.nextSeq)) throw new Error("Commit sequence space is exhausted");
      const seq = metadata.nextSeq as Seq;
      const resolved = await resolveCopies(transaction, detached);
      const identities = transaction.objectStore("identities");
      const claimed = new Map<number, RecordKind>();
      for (const write of resolved) {
        if (write.type === "document.change" || write.type === "document.retire") continue;
        if (write.type === "document.copy") throw new Error("Unresolved document copy");
        const kind = write.type === "document.create" ? "document" : write.type;
        const id = write.type === "document.create" ? write.record.id : write.value.id;
        const existing = await identities.get(id);
        const previous = claimed.get(id);
        if (existing !== undefined && (existing !== kind || kind === "conversation" || kind === "entry" || kind === "document")) {
          throw new Error(`ID ${id} already belongs to ${existing}`);
        }
        if (previous !== undefined && (previous !== kind || kind === "conversation" || kind === "entry" || kind === "document")) {
          throw new Error(`ID ${id} is written more than once or as two record types`);
        }
        claimed.set(id, kind);
        metadata.nextId = Math.max(metadata.nextId, id + 1);
        await identities.put(kind, id);
        switch (write.type) {
          case "conversation": await transaction.objectStore("conversations").add(write.value); break;
          case "entry":
            await transaction.objectStore("entries").add({ id, conversationId: write.value.conversationId, entry: write.value, commitSeq: seq });
            break;
          case "task": await transaction.objectStore("tasks").put(write.value); break;
          case "submission": await transaction.objectStore("submissions").put(write.value); break;
        }
      }
      await writeDocuments(transaction, resolved, seq);
      await transaction.objectStore("metadata").put({ ...metadata, nextSeq: metadata.nextSeq + 1 }, "state");
      return seq;
    });
  }

  async mintId<Identity extends Id<string>>(): Promise<Identity> {
    return this.write(async (transaction) => {
      const store = transaction.objectStore("metadata");
      const metadata = await store.get("state") ?? { nextId: 2, nextSeq: 1 };
      if (!Number.isSafeInteger(metadata.nextId)) throw new Error("ID space is exhausted");
      const id = metadata.nextId;
      await store.put({ ...metadata, nextId: id + 1 }, "state");
      return id as Identity;
    });
  }

  async conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    return this.read((transaction) => transaction.objectStore("conversations").get(id));
  }

  async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<ConversationRecord, Cursor>> {
    const start = scanStart(query.order, cursor, "ascending");
    return this.read((transaction) => {
      const store = transaction.objectStore("conversations");
      const direction = start.order === "ascending" ? "next" : "prev";
      const rows = () => query.ownerTaskId !== undefined ? store.index("ownerTask").openCursor(cursorRange(start, query.ownerTaskId), direction)
        : query.ownerConversationId !== undefined ? store.index("ownerConversation").openCursor(cursorRange(start, query.ownerConversationId), direction)
        : store.openCursor(cursorRange(start), direction);
      return scan(rows, start, limit, (value) =>
        (query.ownerConversationId === undefined || value.owner?.conversationId === query.ownerConversationId) &&
        (query.ownerTaskId === undefined || value.owner?.taskId === query.ownerTaskId));
    });
  }

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  async entry(idOrConversation: EntryId | ConversationId, idOrContext: EntryId | Context, context?: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    return this.read(async (transaction) => {
      const id = context === undefined ? idOrConversation : idOrContext;
      if (typeof id !== "number") throw new StorageRequestError("Storage.entry() requires an entry ID");
      if (context !== undefined) {
        const segments = await this.segments(transaction, idOrConversation as ConversationId, id, id);
        const row = await transaction.objectStore("entries").get(id);
        if (row === undefined || !segments.some((segment) => row.conversationId === segment.id && id <= segment.upper)) return undefined;
        return { entry: row.entry, commitSeq: row.commitSeq };
      }
      const row = await transaction.objectStore("entries").get(id);
      return row === undefined ? undefined : { entry: row.entry, commitSeq: row.commitSeq };
    });
  }

  async findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, _context: Context): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.read(async (transaction) => {
      const segments = await this.segments(transaction, conversationId, -Infinity, atOrBeforeEntryId ?? Infinity);
      for (const segment of segments) {
        let cursor = await transaction.objectStore("entries").index("conversation").openCursor(indexRange(segment.id, -Infinity, segment.upper), "prev");
        while (cursor !== null) {
          if (cursor.value.entry.head !== undefined) return { ...cursor.value.entry, head: cursor.value.entry.head };
          cursor = await cursor.continue();
        }
      }
      return undefined;
    });
  }

  async scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<EntryRecord, Cursor>> {
    const start = scanStart(query.order, cursor, "descending");
    if (!Number.isSafeInteger(limit) || limit < 1) throw new StorageRequestError("Scan limit must be a positive integer");
    return this.read(async (transaction) => {
      const lower = Math.max(query.minEntryId ?? -Infinity, start.order === "ascending" && start.after !== undefined ? start.after + 1 : -Infinity);
      const upper = Math.min(query.maxEntryId ?? Infinity, start.order === "descending" && start.after !== undefined ? start.after - 1 : Infinity);
      const segments = await this.segments(transaction, query.conversationId, lower, upper);
      if (start.order === "ascending") segments.reverse();
      const entries: EntryRecord[] = [];
      for (const segment of segments) {
        if (lower > segment.upper) continue;
        let current = await transaction.objectStore("entries").index("conversation").openCursor(indexRange(segment.id, lower, segment.upper), start.order === "ascending" ? "next" : "prev");
        while (current !== null) {
          entries.push(current.value.entry);
          if (entries.length > limit) return page(entries, limit, start.order);
          current = await current.continue();
        }
      }
      return page(entries, limit, start.order);
    });
  }

  async task(id: TaskId, _context: Context): Promise<StoredTask | undefined> {
    return this.read((transaction) => transaction.objectStore("tasks").get(id));
  }

  async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<StoredTask, Cursor>> {
    const start = scanStart(query.order, cursor, "ascending");
    return this.read((transaction) => {
      const store = transaction.objectStore("tasks");
      const direction = start.order === "ascending" ? "next" : "prev";
      const rows = () => query.conversationId !== undefined ? store.index("conversation").openCursor(cursorRange(start, query.conversationId), direction)
        : query.status !== undefined ? store.index("status").openCursor(cursorRange(start, query.status), direction)
        : store.openCursor(cursorRange(start), direction);
      return scan(rows, start, limit, (value) =>
        (query.conversationId === undefined || value.conversationId === query.conversationId) &&
        (query.kind === undefined || value.kind === query.kind) &&
        (query.status === undefined || value.state.status === query.status) &&
        (query.abortRequested === undefined || value.abortRequested === query.abortRequested) &&
        (query.background === undefined || value.background === query.background));
    });
  }

  async submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    return this.read((transaction) => transaction.objectStore("submissions").get(id));
  }

  async scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<SubmissionRecord, Cursor>> {
    const start = scanStart(query.order, cursor, "ascending");
    return this.read((transaction) => {
      const store = transaction.objectStore("submissions");
      const direction = start.order === "ascending" ? "next" : "prev";
      const rows = () => query.conversationId !== undefined ? store.index("conversation").openCursor(cursorRange(start, query.conversationId), direction)
        : query.status !== undefined ? store.index("status").openCursor(cursorRange(start, query.status), direction)
        : store.openCursor(cursorRange(start), direction);
      return scan(rows, start, limit, (value) =>
        (query.conversationId === undefined || value.conversationId === query.conversationId) &&
        (query.status === undefined || value.status === query.status));
    });
  }

  async submissionByRequest(conversationId: ConversationId, requestId: string, _context: Context): Promise<SubmissionRecord | undefined> {
    return this.read((transaction) => transaction.objectStore("submissions").index("request").get([conversationId, requestId]));
  }

  async findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
    return this.read(async (transaction) => {
      const rows = await transaction.objectStore("documents").index("address").getAll(addressKey(address));
      return rows.find((row) => aliveAt(row.record, at))?.record;
    });
  }

  async document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    return this.read((transaction) => materialize(transaction, id, at));
  }

  async scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<DocumentRecord, Cursor>> {
    const start = scanStart(undefined, cursor, "ascending");
    return this.read(async (transaction) => {
      const result = await scan(() => transaction.objectStore("documents").index("scope").openCursor(cursorRange(start, scopeKey(query.scope))), start, limit,
        (row) => (query.kind === undefined || row.record.kind === query.kind) && aliveAt(row.record, query.at));
      return { items: result.items.map((row) => row.record), ...(result.next === undefined ? {} : { next: result.next }) };
    });
  }

  async close(_context?: Context): Promise<void> {
    this.closed = true;
    this.database.close();
    await Promise.allSettled([...this.active]);
  }

  private async segments(transaction: Transaction, conversationId: ConversationId, lower: number, upper: number): Promise<{ id: ConversationId; upper: number }[]> {
    const result: { id: ConversationId; upper: number }[] = [];
    const visited = new Set<ConversationId>();
    let currentId = conversationId;
    while (true) {
      if (visited.has(currentId)) throw new Error("Conversation ancestry contains a cycle");
      visited.add(currentId);
      const conversation = await transaction.objectStore("conversations").get(currentId);
      if (conversation === undefined) {
        if (currentId === conversationId) throw new StorageRequestError(`Unknown conversation: ${conversationId}`);
        throw new Error(`Missing ancestor conversation: ${currentId}`);
      }
      result.push({ id: currentId, upper });
      if (conversation.parent === undefined) break;
      upper = Math.min(upper, conversation.parent.at);
      if (upper < lower) break;
      currentId = conversation.parent.conversationId;
    }
    return result;
  }

  private read<Result>(operation: (transaction: ReadTransaction) => Promise<Result>): Promise<Result> {
    return this.run("readonly", operation);
  }

  private write<Result>(operation: (transaction: WriteTransaction) => Promise<Result>): Promise<Result> {
    return this.run("readwrite", operation);
  }

  private run<Result, Mode extends "readonly" | "readwrite">(
    mode: Mode,
    operation: (transaction: IDBPTransaction<DurableDatabase, typeof STORE_NAMES, Mode>) => Promise<Result>,
  ): Promise<Result> {
    if (this.closed) return Promise.reject(new Error("IndexedDbStorage is closed"));
    const transaction = this.database.transaction(STORE_NAMES, mode, mode === "readwrite" ? { durability: this.durability } : undefined);
    const done = transaction.done;
    void done.catch(() => undefined);
    const pending = (async () => {
      try {
        const result = await operation(transaction);
        await done;
        return result;
      } catch (error) {
        try { transaction.abort(); } catch {}
        await done.catch(() => undefined);
        throw error;
      }
    })();
    this.active.add(pending);
    void pending.then(() => this.active.delete(pending), () => this.active.delete(pending));
    return pending;
  }
}

export function openIndexedDbStorage(name: string, options?: IndexedDbStorageOptions): Promise<IndexedDbStorage> {
  return IndexedDbStorage.open(name, options);
}
