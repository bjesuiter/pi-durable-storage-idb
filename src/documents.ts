import { applyImmutableBatches } from "@earendil-works/chord/delta";
import type { Op } from "@earendil-works/chord/delta";
import { StorageRequestError } from "@earendil-works/pi-durable";
import type {
  DocumentAddress,
  DocumentContent,
  DocumentCreate,
  DocumentId,
  DocumentPoint,
  DocumentRecord,
  Seq,
  StorageWrite,
  StoredDocument,
} from "@earendil-works/pi-durable";
import { indexRange } from "./schema.js";
import type { DocumentRow, Transaction, WriteTransaction } from "./schema.js";

type DocumentAction = { create?: DocumentCreate; content?: DocumentContent; retire: boolean };

export function scopeKey(scope: DocumentRecord["scope"]): string {
  if (scope.kind === "session") return JSON.stringify(["session"]);
  return JSON.stringify([scope.kind, scope.kind === "conversation" ? scope.conversationId : scope.taskId]);
}

export function addressKey(address: DocumentAddress): string {
  return JSON.stringify([address.kind, scopeKey(address.scope), address.key === undefined ? [] : [address.key]]);
}

export function aliveAt(record: DocumentRecord, at: DocumentPoint): boolean {
  return at === "current" ? record.retiredAt === undefined
    : record.createdAt <= at && (record.retiredAt === undefined || at < record.retiredAt);
}

function currentOnly(record: DocumentRecord): boolean {
  return record.scope.kind !== "conversation" || record.history === "latest";
}

export async function materialize(transaction: Transaction, id: DocumentId, at: DocumentPoint): Promise<StoredDocument | undefined> {
  const row = await transaction.objectStore("documents").get(id);
  if (row === undefined) return undefined;
  if (at !== "current" && currentOnly(row.record)) {
    throw new StorageRequestError(`Document ${id} does not retain historical content`);
  }
  if (!aliveAt(row.record, at)) return undefined;
  let cursor = await transaction.objectStore("revisions").openCursor(indexRange(id, -Infinity, at === "current" ? Infinity : at), "prev");
  const tail: Extract<DocumentContent, { kind: "delta" }>[] = [];
  while (cursor !== null) {
    const content = cursor.value.content;
    if (content.kind === "base") {
      const batches: (readonly Op[])[] = [];
      for (const delta of tail.reverse()) {
        if (delta.version !== content.version) throw new Error(`Document ${id} crosses a stored version boundary without a base`);
        batches.push(delta.ops);
      }
      return { record: row.record, version: content.version, value: applyImmutableBatches(content.value, batches), deltasSinceBase: tail.length };
    }
    tail.push(content);
    cursor = await cursor.continue();
  }
  throw new Error(`Document ${id} is missing a required base`);
}

export async function resolveCopies(transaction: WriteTransaction, writes: readonly StorageWrite[]): Promise<StorageWrite[]> {
  const changed = new Set<DocumentId>();
  for (const write of writes) {
    if (write.type === "document.create" || write.type === "document.copy") changed.add(write.record.id);
    if (write.type === "document.change" || write.type === "document.retire") changed.add(write.id);
  }
  const resolved: StorageWrite[] = [];
  for (const write of writes) {
    if (write.type !== "document.copy") {
      resolved.push(write);
      continue;
    }
    if (changed.has(write.source.id)) throw new Error(`Fork source document ${write.source.id} is changed in the copy batch`);
    const source = await materialize(transaction, write.source.id, write.source.at);
    if (source === undefined) throw new Error(`Fork source document ${write.source.id} cannot be read`);
    if (source.record.scope.kind !== "conversation" || write.record.scope.kind !== "conversation" ||
      source.record.kind !== write.record.kind || source.record.key !== write.record.key ||
      source.record.history !== write.record.history || source.record.fork !== write.record.fork) {
      throw new Error(`Fork source document ${write.source.id} does not match the copied record`);
    }
    resolved.push({
      type: "document.create",
      record: write.record,
      content: { kind: "base", version: source.version, value: source.value },
    });
  }
  return resolved;
}

export async function writeDocuments(transaction: WriteTransaction, writes: readonly StorageWrite[], seq: Seq): Promise<void> {
  const actions = new Map<DocumentId, DocumentAction>();
  for (const write of writes) {
    if (write.type !== "document.create" && write.type !== "document.change" && write.type !== "document.retire") continue;
    const id = write.type === "document.create" ? write.record.id : write.id;
    let action = actions.get(id);
    if (action === undefined) {
      action = { retire: false };
      actions.set(id, action);
    }
    if (write.type === "document.retire") {
      if (action.retire) throw new Error(`Document ${id} is retired more than once`);
      action.retire = true;
    } else {
      if (action.content !== undefined) throw new Error(`Document ${id} has more than one content command`);
      action.content = write.content;
      if (write.type === "document.create") action.create = write.record;
    }
  }

  const documents = transaction.objectStore("documents");
  const revisions = transaction.objectStore("revisions");
  const rows = new Map<DocumentId, DocumentRow>();
  const liveCounts = new Map<string, number>();
  for (const [id, action] of actions) {
    const existing = await documents.get(id);
    if (action.create === undefined && existing === undefined) throw new Error(`Unknown document: ${id}`);
    if (action.create !== undefined && existing !== undefined) throw new Error(`Document ${id} already exists`);
    if (existing?.record.retiredAt !== undefined) throw new Error(`Document ${id} is retired`);
    if (action.content?.kind === "delta") {
      const previous = await revisions.openCursor(indexRange(id), "prev");
      if (previous === null) throw new Error(`Document ${id} delta has no base`);
      if (previous.value.content.version !== action.content.version) throw new Error(`Document ${id} version transition requires a base`);
    }
    const record: DocumentRecord = action.create === undefined ? existing!.record : { ...action.create, createdAt: seq };
    const address = addressKey(record);
    let count = liveCounts.get(address);
    if (count === undefined) {
      const incarnations = await documents.index("address").getAll(address);
      count = incarnations.filter((row) => row.record.retiredAt === undefined).length;
    }
    if (action.retire && existing !== undefined) count--;
    if (action.create !== undefined && !action.retire) count++;
    liveCounts.set(address, count);
    rows.set(id, { id, record, address, scope: scopeKey(record.scope) });
  }
  if ([...liveCounts.values()].some((count) => count > 1)) throw new Error("Document address already has a current incarnation");

  for (const [id, action] of actions) {
    const row = rows.get(id)!;
    const reclaim = currentOnly(row.record) && (action.retire || action.content?.kind === "base");
    if (reclaim) await revisions.delete(indexRange(id));
    if (action.content !== undefined && !(action.retire && currentOnly(row.record))) {
      await revisions.add({ documentId: id, seq, content: action.content });
    }
    if (action.retire) row.record = { ...row.record, retiredAt: seq };
    await documents.put(row);
  }
}
