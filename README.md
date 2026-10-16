# pi-durable-storage-idb

Transactional IndexedDB storage for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable), built with [idb](https://github.com/jakearchibald/idb).

Implements the complete Pi Durable **1.3.0** `Storage` contract. The upstream API is experimental, so the peer dependencies are pinned to the tested version.

## Usage

The repository is not published on npm yet. Build it locally with `npm ci && npm run build` and link it into your application, or install a built package made with `npm pack`.

```typescript
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openIndexedDbStorage } from "pi-durable-storage-idb";

const context = BACKGROUND_CONTEXT;
const storage = await openIndexedDbStorage("my-agent");
const harness = await Harness.open(storage, {
  models: createModels(),
  registry: createRegistry(),
}, context);

const root = await harness.root(context);
harness.resume();

await harness.close(context);
```

`IndexedDbStorage.open(name, options)` is also available. Each database name selects one independent storage, scoped to the browser origin/profile.
Configure model providers and browser-compatible tools before submitting input.

Options:

- `durability`: native IndexedDB durability hint, default `"strict"`. Set `"relaxed"` or `"default"` only if their weaker guarantees are acceptable.
- `blocked(currentVersion, blockedVersion)`: notification when an older connection prevents opening/upgrading the database.
- `terminated()`: notification if the browser unexpectedly terminates the connection. Reopen storage and the Harness to recover.

The adapter closes its connection on `versionchange` so it does not block another client's upgrade. All subsequent operations reject. `close(context)` waits for admitted operations to settle and is safe to repeat.

## Persistence and atomicity

- Every commit uses one native `readwrite` transaction spanning records, document revisions, global ID ownership, and sequence/ID counters. A failure or abort rolls the entire batch back.
- A commit or ID allocation resolves only after **`tx.done`**, not merely after an individual request succeeds. ID allocations survive reopening even if the ID has not been used in a commit.
- Only IndexedDB request promises are awaited inside transactions. There are no network requests, timers, filesystem writes, debounced saves, or in-memory replay logs in the persistence path.
- Conversation/entry immutability, global IDs, fork ancestry caps, ordered cursors, task/submission filters, request-key lookup, document copies, historical reads, and incarnation retirement follow the upstream contract.
- Copies read committed pre-batch document state and store an independent base. Latest-only bases replace obsolete content; retirement removes latest-only content but retains membership metadata. Rewindable document history is retained.
- Opening does not scan records or replay history into memory. Reads use IndexedDB lookups/indexes. Document materialization reads only the selected document's newest applicable base and subsequent deltas. Pagination seeks past the previous ID rather than rescanning earlier pages.

Schema version 1 contains `metadata`, `identities`, `conversations`, `entries`, `tasks`, `submissions`, `documents`, and `revisions` object stores. Conversation ownership, entry conversation, task/submission conversation and status, submission request keys, and document scope/address have indexes. This database is owned by the adapter; do not write to its stores directly.

## Boundaries

**One active Harness owner per database**, as required by Pi Durable. The adapter does not elect an owner or coordinate independent Harness caches across tabs/workers. The host must provide that coordination, for example with the Web Locks API. Native transaction serialization alone does not make multiple independent Harness instances safe.

This package provides storage, not a complete browser execution environment, filesystem, PWA loader, or background scheduler. The tests exercise a real browser Harness and a resumable custom task without model calls. They do not establish compatibility of every Pi Durable extension or model provider with a browser.

IndexedDB availability and quota depend on the browser. Strict durability is a browser/storage-system hint, not a promise against every power failure. Site-data deletion, eviction, device loss, and origin changes can still lose or isolate data. Request persistent storage where appropriate and provide application-level backup/export and recovery. This adapter does not implement those features.

## Development and tests

Use Node.js 24 or newer for development.

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run check
```

- `npm test`: all 24 upstream storage-conformance cases plus IndexedDB-specific persistence, lifecycle, corruption, rollback, and completion tests using `fake-indexeddb`.
- `npm run test:browser`: the same cases against native IndexedDB in Chromium, Firefox, and WebKit.
- `npm run test:e2e`: real Harness task recovery after reload, page replacement, and a browser restart with a persistent profile. Chromium additionally tests a renderer crash during an unfinished transaction; the CDP-specific crash case is skipped in Firefox and WebKit.
- `npm run typecheck` and `npm run build`: strict TypeScript checks and an ESM package with declarations and source maps.

Fault injection verifies both a failed write after earlier writes succeeded and an abort after the final request succeeded. The crash test keeps a native transaction open, crashes the renderer, then checks that the earlier committed task/document/transcript survive and the unfinished entry does not. No test simulates an OS crash or power loss.

GitHub Actions runs these checks on pushes and pull requests. There is no npm publishing workflow. No open-source license has been selected yet; the package is currently marked `UNLICENSED`.

## Contract references

- [Pi Durable storage documentation](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#storage)
- [Pi Durable storage contract](https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md#10-storage-contract)
- [idb transaction lifetime and completion](https://github.com/jakearchibald/idb#transaction-lifetime)
