import { zipSync, unzipSync, strToU8 } from 'fflate';
import type { ProjectRec } from './project-store';

/* Backup = FOLDER biasa (bukan ZIP) di perangkat, lewat File System Access API (Chrome / Edge desktop).
   Isi folder backup, satu subfolder per project:
     <folder backup>/<nama project>/project.json          (isi project: playlist + efek + daftar sample)
     <folder backup>/<nama project>/samples/<jalur>/<file> (HANYA sample yang dipakai project itu)
   Folder dipilih sekali; handle-nya diingat (IndexedDB). Setiap Save, subfolder project yang SAMA diperbarui
   (project.json ditimpa, sample baru ditambah, sample yang sudah tidak dipakai dihapus) - bukan bikin backup baru. */

export interface BackupNode { id: string; parent: string | null; name: string; kind: 'folder' | 'file'; mime: string; size: number; }
export interface NodeBlob { meta: BackupNode; blob: Blob | null; }
export interface RestoredProject { rec: ProjectRec; nodes: NodeBlob[]; }

/* tipe minimal File System Access API (belum ada di lib.dom TypeScript) */
interface FileH { kind: 'file'; name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(b: Blob | string): Promise<void>; close(): Promise<void> }>; }
interface DirH {
  kind: 'directory'; name: string;
  getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<DirH>;
  getFileHandle(n: string, o?: { create?: boolean }): Promise<FileH>;
  removeEntry(n: string, o?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<FileH | DirH>;
  queryPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}
type Picker = (o?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<DirH>;
const picker = (): Picker | null => (window as unknown as { showDirectoryPicker?: Picker }).showDirectoryPicker ?? null;

export const backupSupported = (): boolean => !!picker();

const VERSION = 2;
const safe = (s: string): string => (s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[. ]+|[. ]+$/g, '') || '_');

/* ---------- ingat folder backup (handle disimpan di IndexedDB) ---------- */
const DB = 'daw-starter-backup', STORE = 'kv', KEY = 'root';
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadRoot(): Promise<DirH | null> {
  try {
    const db = await idb();
    return await new Promise<DirH | null>(res => { const q = db.transaction(STORE).objectStore(STORE).get(KEY); q.onsuccess = () => res((q.result as DirH) ?? null); q.onerror = () => res(null); });
  } catch { return null; }
}
async function saveRoot(h: DirH): Promise<void> {
  try {
    const db = await idb();
    await new Promise<void>(res => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(h, KEY); t.oncomplete = () => res(); t.onerror = () => res(); });
  } catch { /* abaikan: folder harus dipilih lagi setelah reload */ }
}
async function writable(h: DirH, ask: boolean): Promise<boolean> {
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return ask && !!h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

export const backupFolder = {
  /** nama folder backup yang sedang dipakai (null = belum dipilih) */
  async name(): Promise<string | null> { return (await loadRoot())?.name ?? null; },
  /** pilih (atau ganti) folder backup; null = dibatalkan */
  async choose(): Promise<DirH | null> {
    const p = picker(); if (!p) return null;
    try { const h = await p({ mode: 'readwrite', id: 'daw-backup' }); await saveRoot(h); return h; }
    catch (e) { if ((e as DOMException).name === 'AbortError') return null; throw e; }
  },
  /** folder backup yang siap ditulis. ask=true boleh memunculkan dialog izin / pilih folder (harus dari ketukan user) */
  async ready(ask: boolean, pickIfMissing: boolean): Promise<DirH | null> {
    let h = await loadRoot();
    if (h && !(await writable(h, ask))) h = null;
    if (!h && ask && pickIfMissing) h = await this.choose();
    return h;
  }
};

/* ---------- sample apa saja yang dipakai project ---------- */
export function usedSampleIds(data: unknown): Set<string> {
  const ids = new Set<string>();
  const walk = (v: unknown, key: string): void => {
    if (Array.isArray(v)) { v.forEach(x => walk(x, key)); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if ((key === 'audio' || key === 'file' || key === 'samples') && typeof o.id === 'string') ids.add(o.id);   // clip audio, sampel vsynth, slot Drum Sequence
    for (const k of Object.keys(o)) walk(o[k], k);
  };
  walk(data, '');
  return ids;
}

/* ---------- tulis ke folder ---------- */
async function dirAt(root: DirH, segs: string[]): Promise<DirH> {
  let d = root;
  for (const s of segs) d = await d.getDirectoryHandle(s, { create: true });
  return d;
}
async function putFile(dir: DirH, name: string, data: Blob | string): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data); await w.close();
}
/** hapus file / folder kosong di samples/ yang tidak ada di daftar keep (jalur relatif huruf kecil) */
async function prune(dir: DirH, keep: Set<string>, prefix: string): Promise<boolean> {
  let empty = true;
  const items: (FileH | DirH)[] = [];
  for await (const e of dir.values()) items.push(e);
  for (const e of items) {
    const p = prefix + e.name;
    if (e.kind === 'directory') {
      if (await prune(e, keep, p + '/')) await dir.removeEntry(e.name, { recursive: true }); else empty = false;
    } else if (keep.has(p.toLowerCase())) empty = false;
    else await dir.removeEntry(e.name);
  }
  return empty;
}

/* rencana isi backup SATU project: sample yang dipakai (jalur + isi) + project.json. Dipakai bareng oleh backup folder dan Download. */
function plan(rec: ProjectRec, all: NodeBlob[]): { files: { path: string; blob: Blob }[]; json: string } {
  const byId = new Map(all.map(n => [n.meta.id, n]));
  const chain = (m: BackupNode): BackupNode[] => {
    const c: BackupNode[] = [m];
    for (let p = m.parent, g = 0; p && g < 64; g++) { const pm = byId.get(p)?.meta; if (!pm) break; c.unshift(pm); p = pm.parent; }
    return c;
  };
  const used = [...usedSampleIds(rec.data)].map(id => byId.get(id)).filter((n): n is NodeBlob => !!n && n.meta.kind === 'file' && !!n.blob);
  const nodes = new Map<string, BackupNode & { path?: string }>();
  const seen = new Set<string>();
  const files: { path: string; blob: Blob }[] = [];
  for (const n of used) {
    const c = chain(n.meta);
    for (const a of c.slice(0, -1)) nodes.set(a.id, { ...a });   // folder induk, supaya struktur browser ikut pulih
    let path = c.map(x => safe(x.name)).join('/');
    if (seen.has(path.toLowerCase())) path = path.replace(/(\.[^./]*)?$/, `_${n.meta.id.slice(0, 6)}$1`);
    seen.add(path.toLowerCase());
    nodes.set(n.meta.id, { ...n.meta, path });
    files.push({ path, blob: n.blob as Blob });
  }
  const json = JSON.stringify({ version: VERSION, project: { id: rec.id, name: rec.name, updated: rec.updated, data: rec.data }, nodes: [...nodes.values()] });
  return { files, json };
}

/** Perbarui folder backup SATU project: project.json ditimpa, sample baru ditambah, yang tak terpakai dihapus. Mengembalikan jumlah sample. */
export async function syncProject(root: DirH, rec: ProjectRec, all: NodeBlob[]): Promise<number> {
  const { files, json } = plan(rec, all);
  const pdir = await root.getDirectoryHandle(safe(rec.name), { create: true });
  const sdir = await pdir.getDirectoryHandle('samples', { create: true });
  for (const f of files) {
    const segs = f.path.split('/'), fname = segs.pop() as string;
    const d = await dirAt(sdir, segs);
    let same = false;
    try { same = (await (await d.getFileHandle(fname)).getFile()).size === f.blob.size; } catch { /* belum ada */ }
    if (!same) await putFile(d, fname, f.blob);   // sudah ada & ukuran sama = lewati (cepat)
  }
  await prune(sdir, new Set(files.map(f => f.path.toLowerCase())), '');
  await putFile(pdir, 'project.json', json);
  return files.length;
}

/** Download SATU project (isi sama dengan folder backup-nya) sebagai satu file; browser tidak bisa mengunduh folder, jadi dibungkus .zip */
export async function makeProjectZip(rec: ProjectRec, all: NodeBlob[]): Promise<{ blob: Blob; name: string; count: number }> {
  const { files, json } = plan(rec, all);
  const base = safe(rec.name);
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = { [`${base}/project.json`]: strToU8(json) };
  for (const f of files) entries[`${base}/samples/${f.path}`] = [new Uint8Array(await f.blob.arrayBuffer()), { level: 0 }];   // audio sudah terkompres: simpan saja
  return { blob: new Blob([zipSync(entries as never) as BlobPart], { type: 'application/zip' }), name: `${base}.zip`, count: files.length };
}

/* ---------- Restore ---------- */
async function parseProject(text: string, blobAt: (path: string) => Promise<Blob | null>, onProgress?: (done: number, total: number) => void): Promise<RestoredProject | null> {
  let j: { version?: number; project?: ProjectRec; nodes?: (BackupNode & { path?: string })[] };
  try { j = JSON.parse(text); } catch { return null; }
  if (j.version !== VERSION || !j.project?.id || typeof j.project.name !== 'string' || !Array.isArray(j.nodes)) return null;
  const list = j.nodes;
  const nodes: NodeBlob[] = new Array(list.length);
  const total = list.filter(f => f.kind === 'file' && f.path).length;
  let done = 0, next = 0;
  onProgress?.(0, total);
  // Chrome Android lambat per operasi folder: baca beberapa sample sekaligus, bukan satu per satu
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++; if (i >= list.length) return;
      const { path, ...meta } = list[i];
      const isFile = meta.kind === 'file' && !!path;
      let blob: Blob | null = isFile ? await blobAt(path as string) : null;   // file hilang = blob null (dilewati)
      if (blob) {
        // salin isi file ke memori sekarang: File dari folder hanya penunjuk ke berkas di HP, dan dibaca ulang tiap sample diputar / didecode
        // (di Chrome Android bisa gagal / kosong => project bisu tanpa pesan). Project buatan sendiri sudah berupa Blob di memori; ini menyamakannya.
        try { blob = new Blob([await blob.arrayBuffer()], { type: meta.mime || blob.type }); }
        catch (err) { throw new Error(`sample "${meta.name || path}" tidak bisa dibaca (${(err as Error)?.message || err})`); }
      }
      nodes[i] = { meta, blob };
      if (isFile) onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, Math.max(1, list.length)) }, worker));
  return { rec: j.project, nodes };
}
/** pembaca sample dari subfolder samples/ milik satu folder project */
const dirBlobAt = (pdir: DirH) => {
  const dirs = new Map<string, Promise<DirH>>();
  const dirOf = (segs: string[]): Promise<DirH> => {
    if (!segs.length) return Promise.resolve(pdir);
    const key = segs.join('/');
    let d = dirs.get(key);
    if (!d) { d = dirOf(segs.slice(0, -1)).then(parent => parent.getDirectoryHandle(segs[segs.length - 1])); dirs.set(key, d); }
    return d;
  };
  return async (path: string): Promise<Blob | null> => {
    try {
      const segs = path.split('/'), fname = segs.pop() as string;
      const d = await dirOf(['samples', ...segs]);
      return await (await d.getFileHandle(fname)).getFile();
    } catch { return null; }
  };
};
async function readProject(pdir: DirH): Promise<RestoredProject | null> {
  let text: string;
  try { text = await (await (await pdir.getFileHandle('project.json')).getFile()).text(); } catch { return null; }
  return parseProject(text, dirBlobAt(pdir));
}

/** satu project di folder backup: nama saja dulu (ringan), isi + sample baru dibaca saat load() */
export interface BackupEntry { id: string; name: string; updated: number; load(onProgress?: (done: number, total: number) => void): Promise<RestoredProject | null>; }
async function entryOf(pdir: DirH): Promise<BackupEntry | null> {
  let text: string;
  try { text = await (await (await pdir.getFileHandle('project.json')).getFile()).text(); } catch { return null; }
  let j: { version?: number; project?: ProjectRec; nodes?: unknown };
  try { j = JSON.parse(text); } catch { return null; }
  if (j.version !== VERSION || !j.project?.id || typeof j.project.name !== 'string' || !Array.isArray(j.nodes)) return null;
  return { id: j.project.id, name: j.project.name, updated: Number(j.project.updated) || 0, load: onProgress => parseProject(text, dirBlobAt(pdir), onProgress) };
}

/** baca file .zip hasil Download (untuk browser yang tidak bisa pilih folder) */
export async function readProjectZip(file: File): Promise<RestoredProject[]> {
  const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const out: RestoredProject[] = [];
  for (const key of Object.keys(z)) {
    if (!/(^|\/)project\.json$/.test(key)) continue;
    const prefix = key.slice(0, key.length - 'project.json'.length);
    const text = new TextDecoder().decode(z[key]);
    const r = await parseProject(text, async path => { const data = z[prefix + 'samples/' + path]; return data ? new Blob([data as BlobPart]) : null; });
    if (r) out.push(r);
  }
  return out;
}

/** pilih folder backup (atau satu subfolder project) lalu baca semua project di dalamnya; null = dibatalkan */
export async function readBackupFolder(): Promise<RestoredProject[] | null> {
  const p = picker(); if (!p) return null;
  let root: DirH;
  try { root = await p({ mode: 'read', id: 'daw-backup' }); } catch (e) { if ((e as DOMException).name === 'AbortError') return null; throw e; }
  const out: RestoredProject[] = [];
  const self = await readProject(root);
  if (self) out.push(self);
  else for await (const e of root.values()) if (e.kind === 'directory') { const r = await readProject(e); if (r) out.push(r); }
  return out;
}

/** Load project from folder: pilih folder backup (atau satu subfolder project), kembalikan daftar project di dalamnya tanpa memuat sample dulu; null = dibatalkan */
export async function listBackupFolder(): Promise<BackupEntry[] | null> {
  const p = picker(); if (!p) return null;
  let root: DirH;
  try { root = await p({ mode: 'read', id: 'daw-backup' }); } catch (e) { if ((e as DOMException).name === 'AbortError') return null; throw e; }
  const self = await entryOf(root);
  if (self) return [self];
  const out: BackupEntry[] = [];
  for await (const e of root.values()) if (e.kind === 'directory') { const r = await entryOf(e); if (r) out.push(r); }
  return out.sort((a, b) => b.updated - a.updated);   // terbaru di atas
}
/** bungkus hasil baca .zip jadi daftar yang sama dengan listBackupFolder */
export const entriesOf = (found: RestoredProject[]): BackupEntry[] =>
  found.map(r => ({ id: r.rec.id, name: r.rec.name, updated: Number(r.rec.updated) || 0, load: async () => r })).sort((a, b) => b.updated - a.updated);
