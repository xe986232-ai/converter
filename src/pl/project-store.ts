/* Daftar project yang disimpan di browser (localStorage): nama + isi project (playlist + efek). */

export interface ProjectRec { id: string; name: string; data: unknown; updated: number; backup?: boolean; }   // backup = project ini ditentukan ikut di-backup (Save otomatis memperbarui folder backup-nya)

const KEY = 'daw-starter-projects-v1';

function readAll(): ProjectRec[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]') as ProjectRec[];
    return Array.isArray(v) ? v.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string') : [];
  } catch { return []; }
}
function writeAll(list: ProjectRec[]): boolean {
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }   // false = penyimpanan penuh / tidak tersedia
}

export const projectStore = {
  list: (): ProjectRec[] => readAll(),
  get: (id: string): ProjectRec | null => readAll().find(r => r.id === id) ?? null,
  nameTaken: (name: string): boolean => readAll().some(r => r.name.toLowerCase() === name.trim().toLowerCase()),
  /** simpan (baru atau timpa); false kalau gagal */
  put(rec: ProjectRec): boolean {
    const all = readAll();
    const i = all.findIndex(r => r.id === rec.id);
    if (i >= 0) all[i] = rec; else all.push(rec);
    return writeAll(all);
  }
};
export const newProjectId = (): string => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
