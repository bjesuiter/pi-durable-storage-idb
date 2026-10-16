import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, defineExtension, defineTask, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { DocumentId, EntryId, TaskId } from "@earendil-works/pi-durable";
import { openIndexedDbStorage } from "../../src/index.js";
import type { IndexedDbStorage } from "../../src/index.js";

const context = BACKGROUND_CONTEXT;
const Counter = defineDoc({ kind: "test.counter", scope: "session", version: 1, initial: () => ({ count: 0 }) });
const ResumeTask = defineTask<Record<string, never>, { phase: "finish"; count: number }, number>({
  name: "test.resume",
  version: 1,
  initial: () => ({ phase: "finish", count: 0 }),
  phases: {
    finish: async (task, runtime, context) => {
      await runtime.commit(async (transaction) => {
        const counter = await transaction.doc(Counter);
        counter.count = task.state.checkpoint.count + 1;
        await transaction.appendEntry(ROOT_CONVERSATION_ID, { kind: "test.resumed", data: { count: counter.count } });
        return { status: "terminal", outcome: { status: "completed", result: counter.count } };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
  },
});

let storage: IndexedDbStorage | undefined;
let pending = false;

const api = {
  async seed(name: string) {
    storage = await openIndexedDbStorage(name);
    const entryId = await storage.mintId<EntryId>();
    const taskId = await storage.mintId<TaskId<number>>();
    const documentId = await storage.mintId<DocumentId>();
    await storage.commit([
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      { type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "test.before", data: { count: 41 } } },
      { type: "task", value: {
        id: taskId, conversationId: ROOT_CONVERSATION_ID, kind: ResumeTask.definition.name, version: 1,
        input: {}, state: { status: "running", checkpoint: { phase: "finish", count: 41 } },
        background: false, abortRequested: false,
      } },
      { type: "document.create", record: { id: documentId, kind: Counter.definition.kind, scope: { kind: "session" } },
        content: { kind: "base", version: 1, value: { count: 41 } } },
    ], context);
    return { entryId, taskId };
  },

  async resume(name: string) {
    storage = await openIndexedDbStorage(name);
    const tasks = await storage.scanTasks({ kind: ResumeTask.definition.name }, 10, undefined, context);
    const task = tasks.items[0];
    if (task === undefined) throw new Error("Persisted task is missing");
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test", tasks: [ResumeTask] }));
    const harness = await Harness.open(storage, { models: createModels(), registry }, context);
    try {
      harness.resume();
      const settled = await harness.waitForTask(task.id, context);
      const snapshot = await harness.snapshot(Counter, context);
      const transcript = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 10, undefined, context);
      return { outcome: settled.state.outcome, counter: snapshot, entries: transcript.items.map((entry) => entry.kind) };
    } finally {
      await harness.close(context);
    }
  },

  async interrupt() {
    if (storage === undefined) throw new Error("Seed storage first");
    const entryId = await storage.mintId<EntryId>();
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, key) {
      const request = put.call(this, value, key);
      if (this.name === "metadata") {
        request.addEventListener("success", () => {
          pending = true;
          const keepAlive = () => {
            this.get("state").addEventListener("success", keepAlive);
          };
          keepAlive();
        });
      }
      return request;
    };
    void storage.commit([{ type: "entry", value: { id: entryId, conversationId: ROOT_CONVERSATION_ID, kind: "test.uncommitted" } }], context).catch(() => undefined);
    return entryId;
  },

  isPending: () => pending,
};

declare global {
  interface Window {
    durableTest: typeof api;
  }
}

window.durableTest = api;
