import type { JsonValue } from "@earendil-works/chord";
import type {
  ConversationRecord,
  DocumentContent,
  DocumentId,
  DocumentRecord,
  EntryRecord,
  Seq,
  SubmissionRecord,
  TaskRecord,
} from "@earendil-works/pi-durable";
import type { DBSchema, IDBPTransaction } from "idb";

export type RecordKind = "conversation" | "entry" | "task" | "submission" | "document";
export type StoredTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
export type StoredEntry = { id: number; conversationId: number; entry: EntryRecord; commitSeq: Seq };
export type DocumentRow = { id: DocumentId; record: DocumentRecord; scope: string; address: string };
export type RevisionRow = { documentId: DocumentId; seq: Seq; content: DocumentContent };
export type Metadata = { nextId: number; nextSeq: number };

export interface DurableDatabase extends DBSchema {
  metadata: { key: string; value: Metadata };
  identities: { key: number; value: RecordKind };
  conversations: {
    key: number;
    value: ConversationRecord;
    indexes: { ownerConversation: [number, number]; ownerTask: [number, number] };
  };
  entries: { key: number; value: StoredEntry; indexes: { conversation: [number, number] } };
  tasks: {
    key: number;
    value: StoredTask;
    indexes: { conversation: [number, number]; status: [string, number] };
  };
  submissions: {
    key: number;
    value: SubmissionRecord;
    indexes: {
      conversation: [number, number];
      status: [string, number];
      request: [number, string];
    };
  };
  documents: {
    key: number;
    value: DocumentRow;
    indexes: { scope: [string, number]; address: string };
  };
  revisions: { key: [number, number]; value: RevisionRow };
}

export const STORE_NAMES = [
  "metadata",
  "identities",
  "conversations",
  "entries",
  "tasks",
  "submissions",
  "documents",
  "revisions",
] as const;

export type ReadTransaction = IDBPTransaction<DurableDatabase, typeof STORE_NAMES, "readonly">;
export type WriteTransaction = IDBPTransaction<DurableDatabase, typeof STORE_NAMES, "readwrite">;
export type Transaction = ReadTransaction | WriteTransaction;

export function indexRange(prefix: string | number, lower = -Infinity, upper = Infinity): IDBKeyRange {
  return IDBKeyRange.bound([prefix, lower], [prefix, upper]);
}
