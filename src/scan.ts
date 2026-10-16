import { StorageRequestError } from "@earendil-works/pi-durable";
import type { Cursor, Page, ScanOrder } from "@earendil-works/pi-durable";

export type ScanStart = { order: ScanOrder; after?: number };
export interface ValueCursor<Value> {
  readonly value: Value;
  continue(): Promise<ValueCursor<Value> | null>;
}

export function scanStart(requested: ScanOrder | undefined, cursor: Cursor | undefined, fallback: ScanOrder): ScanStart {
  if (requested !== undefined && requested !== "ascending" && requested !== "descending") {
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  }
  if (cursor === undefined) return { order: requested ?? fallback };
  const { after, order } = cursor;
  if (typeof after !== "number" || !Number.isSafeInteger(after) ||
    (order !== undefined && order !== "ascending" && order !== "descending")) {
    throw new StorageRequestError("Invalid storage cursor");
  }
  const selected = order ?? fallback;
  if (requested !== undefined && requested !== selected) {
    throw new StorageRequestError(`The cursor continues a ${selected} scan; the query asks for ${requested}`);
  }
  return { order: selected, after };
}

export function page<Value extends { readonly id: number }>(values: Value[], limit: number, order: ScanOrder): Page<Value, Cursor> {
  const items = values.slice(0, limit);
  return values.length > limit && items.length > 0
    ? { items, next: { after: items[items.length - 1]!.id, order } }
    : { items };
}

export async function scan<Value extends { readonly id: number }>(
  openCursor: () => Promise<ValueCursor<Value> | null>,
  start: ScanStart,
  limit: number,
  matches: (value: Value) => boolean,
): Promise<Page<Value, Cursor>> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new StorageRequestError("Scan limit must be a positive integer");
  let cursor = await openCursor();
  const values: Value[] = [];
  while (cursor !== null) {
    const value = cursor.value;
    const pastCursor = start.after === undefined ||
      (start.order === "ascending" ? value.id > start.after : value.id < start.after);
    if (pastCursor && matches(value)) values.push(value);
    if (values.length > limit) break;
    cursor = await cursor.continue();
  }
  return page(values, limit, start.order);
}

export function cursorRange(start: ScanStart, prefix?: string | number): IDBKeyRange | undefined {
  if (prefix === undefined) {
    if (start.after === undefined) return undefined;
    return start.order === "ascending" ? IDBKeyRange.lowerBound(start.after, true) : IDBKeyRange.upperBound(start.after, true);
  }
  const ascending = start.order === "ascending";
  return IDBKeyRange.bound(
    [prefix, ascending ? start.after ?? -Infinity : -Infinity],
    [prefix, ascending ? Infinity : start.after ?? Infinity],
    ascending && start.after !== undefined,
    !ascending && start.after !== undefined,
  );
}
