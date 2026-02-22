import Dexie, { type Table } from "dexie";

export type LocalReadState = {
  id: string;        // itemId
  readAt: string;    // ISO
};

export type LocalSavedState = {
  id: string;        // itemId
  savedAt: string;   // ISO
};

export type LocalSavedItem = {
  id: string;          // itemId
  savedAt: string;     // ISO
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  source?: string | null;
};

export type LocalCachedItem = {
  id: string;          // itemId
  cachedAt: string;    // ISO
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  source?: string | null;
};

export type LocalSavedPage = {
  id: string;        // page key
  savedAt: string;   // ISO
  title: string;
  url: string;
  source?: string | null;
  countySlug?: string | null;
};

class LocalDB extends Dexie {
  read!: Table<LocalReadState, string>;
  saved!: Table<LocalSavedState, string>;
  savedItems!: Table<LocalSavedItem, string>;
  cached!: Table<LocalCachedItem, string>;
  savedPages!: Table<LocalSavedPage, string>;

  constructor() {
    super("feedreader_local");
    this.version(3).stores({
      read: "id, readAt",
      saved: "id, savedAt",
      savedItems: "id, savedAt",
      cached: "id, cachedAt",
      savedPages: "id, savedAt, countySlug"
    });
  }
}

export const localDb = new LocalDB();

export async function markRead(id: string) {
  await localDb.read.put({ id, readAt: new Date().toISOString() });
}

export async function markUnread(id: string) {
  await localDb.read.delete(id);
}

export async function isRead(id: string) {
  const row = await localDb.read.get(id);
  return !!row;
}

export async function toggleSaved(item: {
  id: string;
  title: string;
  url: string;
  author?: string | null;
  published_at?: string | null;
  summary?: string | null;
  content?: string | null;
  image_url?: string | null;
  source?: string | null;
}) {
  const existing = await localDb.savedItems.get(item.id);
  if (existing) {
    await localDb.savedItems.delete(item.id);
    await localDb.saved.delete(item.id);
    return false;
  }
  const savedAt = new Date().toISOString();
  await localDb.saved.put({ id: item.id, savedAt });
  await localDb.savedItems.put({ ...item, savedAt });
  return true;
}

export async function isSaved(id: string) {
  return !!(await localDb.savedItems.get(id) || await localDb.saved.get(id));
}

export async function listSavedItems(limit = 200) {
  return localDb.savedItems.orderBy("savedAt").reverse().limit(limit).toArray();
}

export async function toggleSavedPage(page: {
  id: string;
  title: string;
  url: string;
  source?: string | null;
  countySlug?: string | null;
}) {
  const existing = await localDb.savedPages.get(page.id);
  if (existing) {
    await localDb.savedPages.delete(page.id);
    return false;
  }

  const savedAt = new Date().toISOString();
  await localDb.savedPages.put({ ...page, savedAt });
  return true;
}

export async function isSavedPage(id: string) {
  return !!(await localDb.savedPages.get(id));
}

export async function cacheLastOpened(item: Omit<LocalCachedItem, "cachedAt">, maxItems = 30) {
  await localDb.cached.put({ ...item, cachedAt: new Date().toISOString() });

  // keep last N by cachedAt
  const all = await localDb.cached.orderBy("cachedAt").reverse().toArray();
  if (all.length > maxItems) {
    const toDelete = all.slice(maxItems);
    await localDb.cached.bulkDelete(toDelete.map((x) => x.id));
  }
}

export async function getCachedItem(id: string) {
  return localDb.cached.get(id);
}

export async function bulkIsRead(ids: string[]) {
  if (!ids.length) return new Map<string, boolean>();
  const rows = await localDb.read.bulkGet(ids);
  const m = new Map<string, boolean>();
  ids.forEach((id, i) => m.set(id, !!rows[i]));
  return m;
}
