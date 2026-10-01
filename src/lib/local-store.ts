import { createProjectState, validateState, type EditDocument, type ProjectState } from "./editor";

export type MediaDescription = { name: string; type: string; size: number; lastModified: number | null };
export type LocalDocument = EditDocument & {
  id: string; source: MediaDescription; musicAssets: Record<string, MediaDescription>;
  past: EditDocument[]; future: EditDocument[]; updatedAt: string;
};
/** Bound both revision count and serialized history size, keeping the closest undo/redo steps. */
export function boundHistory(past: EditDocument[], future: EditDocument[]) {
  const result = { past: past.slice(-100), future: future.slice(-100) };
  const sizes = { past: result.past.map((item) => JSON.stringify(item).length * 2), future: result.future.map((item) => JSON.stringify(item).length * 2) };
  let pastBytes = sizes.past.reduce((sum, size) => sum + size, 0), futureBytes = sizes.future.reduce((sum, size) => sum + size, 0);
  while (pastBytes + futureBytes > 16 * 1024 * 1024 || result.past.length + result.future.length > 100) {
    if (pastBytes >= futureBytes) { pastBytes -= sizes.past.shift()!; result.past.shift(); }
    else { futureBytes -= sizes.future.shift()!; result.future.shift(); }
  }
  return result;
}

export function advanceHistory(past: EditDocument[], future: EditDocument[], previous: EditDocument, mode: "edit" | "undo" | "redo") {
  if (mode === "undo") return boundHistory(past.slice(0, -1), [...future, previous]);
  return boundHistory([...past, previous], mode === "redo" ? future.slice(0, -1) : []);
}

const files = new Map<string, File>();
let database: Promise<IDBDatabase> | undefined;

function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("rough-cut-local", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("projects", { keyPath: "id" });
    open.onerror = () => { database = undefined; reject(open.error); };
    open.onsuccess = () => {
      open.result.onversionchange = () => { open.result.close(); database = undefined; };
      resolve(open.result);
    };
  });
}

export async function getLocalProject(id: string): Promise<LocalDocument | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("projects").objectStore("projects").get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function describe(file: File): MediaDescription { return { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified }; }
export function localFile(projectId: string, asset = "source") { return files.get(`${projectId}:${asset}`); }

/** Relinking is an explicit human choice, never a file supplied by an agent. */
export function linkLocalFile(projectId: string, asset: string, file: File, expected: MediaDescription) {
  if (file.size !== expected.size || file.name !== expected.name || expected.lastModified !== null && file.lastModified !== expected.lastModified) throw new Error(`Select the original ${expected.name} (${expected.size} bytes). Relinking a different file is not supported.`);
  files.set(`${projectId}:${asset}`, file);
}

export async function createLocalProject(file: File, durationMs: number) {
  const id = crypto.randomUUID();
  const name = (file.name.replace(/\.[^.]+$/, "") || "Untitled").slice(0, 120);
  const state = createProjectState(id, name, durationMs);
  validateState(state);
  const document: LocalDocument = { id, state, transcript: [], source: describe(file), musicAssets: {}, past: [], future: [], updatedAt: new Date().toISOString() };
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("projects", "readwrite", { durability: "strict" });
    tx.objectStore("projects").add(document);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("Could not save local project"));
  });
  files.set(`${id}:source`, file);
  return id;
}

/** Read/version-check/write/history are one IndexedDB transaction, including across tabs. */
export async function saveLocalProject(id: string, expectedVersion: number, next: EditDocument, mode: "edit" | "undo" | "redo" = "edit") {
  validateState(next.state);
  if (next.state.id !== id || next.state.version !== expectedVersion + 1) throw new Error("Invalid local revision");
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("projects", "readwrite", { durability: "strict" });
    let failure: Error | undefined;
    const store = tx.objectStore("projects");
    const request = store.get(id);
    request.onsuccess = () => {
      const current = request.result as LocalDocument | undefined;
      if (!current || current.state.version !== expectedVersion) {
        failure = new Error(`STALE_VERSION:${current?.state.version ?? "missing"}. Another tab changed this project.`);
        tx.abort(); return;
      }
      const previous = { state: current.state, transcript: current.transcript };
      Object.assign(current, advanceHistory(current.past, current.future, previous, mode));
      store.put({ ...current, ...next, updatedAt: new Date().toISOString() });
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure || tx.error || new Error("Local save failed"));
  });
}

export async function addLocalMusic(id: string, file: File) {
  const assetId = crypto.randomUUID();
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("projects", "readwrite", { durability: "strict" });
    const store = tx.objectStore("projects");
    const request = store.get(id);
    request.onsuccess = () => {
      const document = request.result as LocalDocument | undefined;
      if (!document) { tx.abort(); return; }
      document.musicAssets[assetId] = describe(file);
      store.put(document);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("Could not store music metadata"));
  });
  files.set(`${id}:${assetId}`, file);
  return assetId;
}

export async function deleteLocalProject(id: string) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("projects", "readwrite");
    tx.objectStore("projects").delete(id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  for (const key of files.keys()) if (key.startsWith(`${id}:`)) files.delete(key);
}

/** Backup includes edits/history and media descriptions, not original media bytes. */
export async function importLocalProject(value: unknown) {
  const document = value as LocalDocument;
  validateState(document?.state);
  const validMedia = (media: MediaDescription) => media && typeof media.name === "string" && media.name.length > 0 && typeof media.type === "string" && Number.isSafeInteger(media.size) && media.size > 0 && (media.lastModified === null || Number.isFinite(media.lastModified) && media.lastModified >= 0);
  if (!validMedia(document.source) || !document.musicAssets || typeof document.musicAssets !== "object" || Array.isArray(document.musicAssets) || Object.values(document.musicAssets).some((media) => !validMedia(media))) throw new Error("Invalid media descriptions in backup");
  if (document.state.music.some((clip) => !Object.hasOwn(document.musicAssets, clip.assetId))) throw new Error("Missing music description in backup");
  const id = crypto.randomUUID();
  const restore = (value: EditDocument): EditDocument => {
    validateState(value?.state);
    if (value.state.music.some((clip) => !Object.hasOwn(document.musicAssets, clip.assetId))) throw new Error("Missing historical music description");
    if (value.state.id !== document.state.id || value.state.durationMs !== document.state.durationMs || !Array.isArray(value.transcript) || value.transcript.some((word) => !word || typeof word.id !== "string" || !word.id || typeof word.word !== "string" || !word.word.trim() || !Number.isFinite(word.startMs) || word.startMs < 0 || !Number.isFinite(word.endMs) || word.endMs <= word.startMs || word.confidence !== undefined && (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1)) || new Set(value.transcript.map((word) => word.id)).size !== value.transcript.length) throw new Error("Invalid edit document in backup");
    return { state: { ...value.state, id }, transcript: value.transcript };
  };
  const restored = restore(document);
  const history = (items: EditDocument[] | undefined) => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 100) throw new Error("Invalid backup history");
    return items.map(restore);
  };
  const { past, future } = boundHistory(history(document.past), history(document.future));
  const state: ProjectState = { ...restored.state, version: 0 };
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("projects", "readwrite", { durability: "strict" });
    tx.objectStore("projects").add({ id, state, transcript: restored.transcript, source: document.source, musicAssets: document.musicAssets, past, future, updatedAt: new Date().toISOString() } satisfies LocalDocument);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  return id;
}
