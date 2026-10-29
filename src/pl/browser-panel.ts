import './browser-panel.css';

/* Panel browser file di sisi kiri (gaya browser Ableton): pohon folder yang bisa dibuka/tutup.
   File disimpan di IndexedDB browser (offline, tetap ada setelah ditutup). */

export interface BackupNodeMeta { id: string; parent: string | null; name: string; kind: 'folder' | 'file'; mime: string; size: number; }
export interface BrowserHandle {
  toggle(): void; isOpen(): boolean; getBlob(id: string): Blob | null;
  exportAll(): { meta: BackupNodeMeta; blob: Blob | null }[];                               // untuk Backup
  importAll(items: { meta: BackupNodeMeta; blob: Blob | null }[]): Promise<number>;          // untuk Restore (id yang sudah ada dilewati); mengembalikan jumlah file baru
}
export interface BrowserOpts {
  onMessage(msg: string): void;
  onToggle?(open: boolean): void;
  onDropFile?(file: { id: string; name: string }, clientX: number, clientY: number): void;   // file audio diseret lalu dilepas di layar
}

interface FNode { id: string; parent: string | null; name: string; kind: 'folder' | 'file'; mime: string; size: number; blob: Blob | null; }

const DB_NAME = 'daw-starter-files', STORE = 'nodes';
const OPEN_KEY = 'daw-starter-browser-open', WIDTH_KEY = 'daw-starter-browser-w', EXP_KEY = 'daw-starter-browser-exp', SEED_KEY = 'daw-starter-browser-seeded';
const DEFAULT_FOLDERS = ['Clips', 'Defaults', 'Groove', 'Presets', 'Samples', 'Templates'];

const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* abaikan */ } };
const newId = (): string => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const isAudio = (n: FNode): boolean => n.kind === 'file' && (n.mime.startsWith('audio/') || /\.(wav|mp3|ogg|oga|flac|m4a|aac)$/i.test(n.name));

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => { rq.result.createObjectStore(STORE, { keyPath: 'id' }); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function dbAll(db: IDBDatabase): Promise<FNode[]> {
  return new Promise((res, rej) => {
    const rq = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    rq.onsuccess = () => res(rq.result as FNode[]);
    rq.onerror = () => rej(rq.error);
  });
}
function dbWrite(db: IDBDatabase, fn: (s: IDBObjectStore) => void): Promise<void> {
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, 'readwrite');
    fn(t.objectStore(STORE));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export function mountBrowser(host: HTMLElement, opts: BrowserOpts): BrowserHandle {
  const nodes = new Map<string, FNode>();
  let db: IDBDatabase | null = null;
  let selected: string | null = null;
  const expanded = new Set<string>((() => { try { return JSON.parse(lsGet(EXP_KEY) || '[]') as string[]; } catch { return []; } })());
  const stored = lsGet(OPEN_KEY);
  let open = stored == null ? window.innerWidth >= 700 : stored === '1';
  let width = Math.min(420, Math.max(140, Number(lsGet(WIDTH_KEY)) || 220));

  host.classList.add('bw');
  host.innerHTML =
    '<div class="bw-head"><span class="bw-name">Name</span>' +
    '<button data-a="search" class="bw-sbtn" title="Cari file / folder" aria-label="Cari"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5"/></svg>Cari</button>' +
    '<button data-a="importfile" title="Impor file audio (mp3, wav, ogg, flac, m4a, aac) atau midi / json dari penyimpanan HP ke folder yang dipilih">Impor File</button>' +
    '<button data-a="importdir" title="Impor satu folder beserta isinya dari penyimpanan HP">Impor Folder</button></div>' +
    '<div class="bw-search" hidden><input type="search" placeholder="Cari nama file / folder" enterkeyhint="search" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Cari">' +
    '<button data-a="searchclose" title="Tutup pencarian" aria-label="Tutup pencarian">✕</button></div>' +
    '<div class="bw-list" role="tree"></div>' +
    '<div class="bw-act" hidden><button data-a="play">Putar</button><button data-a="rename">Nama</button><button data-a="del">Hapus</button></div>' +
    '<div class="bw-grip"></div>' +
    '<input type="file" multiple hidden webkitdirectory data-in="dir">' +
    '<input type="file" multiple hidden accept="audio/*,.wav,.mp3,.ogg,.oga,.flac,.m4a,.aac,.mid,.midi,.json" data-in="file">';
  const q = <T extends HTMLElement>(s: string): T => host.querySelector(s) as T;
  const list = q<HTMLElement>('.bw-list'), act = q<HTMLElement>('.bw-act'), grip = q<HTMLElement>('.bw-grip');
  const dirIn = q<HTMLInputElement>('input[data-in="dir"]'), fileIn = q<HTMLInputElement>('input[data-in="file"]');
  const sbar = q<HTMLElement>('.bw-search'), sin = q<HTMLInputElement>('.bw-search input'), sbtn = q<HTMLButtonElement>('[data-a="search"]');
  let query = '';   // kata kunci pencarian (huruf kecil); kosong = tampilkan pohon biasa
  const playBtn = q<HTMLButtonElement>('[data-a="play"]');
  host.style.setProperty('--bw-w', width + 'px');
  host.hidden = !open;

  /* ---------- Putar pratinjau ---------- */
  let audio: HTMLAudioElement | null = null, audioUrl = '', playingId: string | null = null;
  function stopPreview(): void {
    if (audio) { audio.pause(); audio.removeAttribute('src'); audio = null; }
    if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = ''; }
    playingId = null;
  }
  function startPreview(n: FNode): void {
    stopPreview();
    if (!n.blob) return;
    audioUrl = URL.createObjectURL(n.blob);
    audio = new Audio(audioUrl);
    playingId = n.id;
    audio.onended = () => { stopPreview(); render(); };
    audio.play().catch(() => { opts.onMessage('File ini tidak bisa diputar.'); stopPreview(); render(); });
  }
  function togglePreview(n: FNode): void { if (playingId === n.id) stopPreview(); else startPreview(n); }

  /* ---------- Data ---------- */
  function byParent(): Map<string | null, FNode[]> {
    const m = new Map<string | null, FNode[]>();
    for (const n of nodes.values()) { const a = m.get(n.parent); if (a) a.push(n); else m.set(n.parent, [n]); }
    for (const a of m.values()) a.sort((x, y) => x.kind !== y.kind ? (x.kind === 'folder' ? -1 : 1) : x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
    return m;
  }
  function uniqueName(parent: string | null, name: string, excludeId?: string): string {
    const taken = new Set<string>();
    for (const n of nodes.values()) if (n.parent === parent && n.id !== excludeId) taken.add(n.name.toLowerCase());
    if (!taken.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) { const c = `${base} (${i})${ext}`; if (!taken.has(c.toLowerCase())) return c; }
  }
  async function persist(fn: (s: IDBObjectStore) => void): Promise<void> {
    if (!db) return;
    try { await dbWrite(db, fn); } catch { opts.onMessage('Gagal menyimpan ke penyimpanan browser (penuh?).'); }
  }
  function targetFolder(): string | null {
    const n = selected ? nodes.get(selected) : undefined;
    return !n ? null : n.kind === 'folder' ? n.id : n.parent;
  }
  function saveExpanded(): void { lsSet(EXP_KEY, JSON.stringify([...expanded])); }

  /* ---------- Tampilan ---------- */
  function mk(cls: string, text = ''): HTMLSpanElement {
    const s = document.createElement('span'); s.className = cls; if (text) s.textContent = text; return s;
  }
  function render(): void {
    const by = byParent();
    const frag = document.createDocumentFragment();
    // mode cari: tampilkan hanya yang namanya cocok + folder induknya (induk otomatis terbuka, tanpa mengubah status buka/tutup tersimpan)
    let shown: Set<string> | null = null;
    if (query) {
      const hit = new Set<string>();
      shown = hit;
      for (const n of nodes.values()) {
        if (!n.name.toLowerCase().includes(query)) continue;
        for (let c: FNode | undefined = n; c && !hit.has(c.id); c = c.parent ? nodes.get(c.parent) : undefined) hit.add(c.id);
      }
    }
    const walk = (parent: string | null, depth: number): void => {
      for (const n of by.get(parent) ?? []) {
        if (shown && !shown.has(n.id)) continue;
        const isOpen = n.kind === 'folder' && (shown ? !!by.get(n.id)?.some(c => shown!.has(c.id)) : expanded.has(n.id));
        const row = document.createElement('div');
        row.className = 'bw-row' + (n.id === selected ? ' sel' : '') + (isOpen ? ' open' : '') + (n.id === playingId ? ' playing' : '');
        row.dataset.id = n.id;
        row.style.paddingLeft = 6 + depth * 14 + 'px';
        row.append(mk('bw-tri', n.kind === 'folder' ? (isOpen ? '▼' : '▶') : ''), mk('bw-ico ' + n.kind), mk('bw-n', n.name));
        frag.append(row);
        if (isOpen) {
          if (by.get(n.id)?.length) walk(n.id, depth + 1);
          else if (!shown) { const e = mk('bw-empty', '(kosong)'); e.style.paddingLeft = 26 + (depth + 1) * 14 + 'px'; frag.append(e); }
        }
      }
    };
    walk(null, 0);
    if (shown && !shown.size) frag.append(mk('bw-empty', 'Tidak ada hasil untuk "' + sin.value.trim() + '".'));
    else if (!nodes.size) frag.append(mk('bw-empty', 'Belum ada file. Ketuk Impor File atau Impor Folder.'));
    list.textContent = '';
    list.append(frag);
    const sel = selected ? nodes.get(selected) : undefined;
    act.hidden = !sel;
    playBtn.hidden = !sel || !isAudio(sel);
    playBtn.textContent = sel && playingId === sel.id ? 'Stop' : 'Putar';
    sbtn.classList.toggle('on', !sbar.hidden);
  }

  /* ---------- Cari ---------- */
  function setSearch(on: boolean): void {
    sbar.hidden = !on;
    if (on) { sin.focus(); sin.select(); }
    else { sin.value = ''; query = ''; sin.blur(); }
    render();
  }
  sin.addEventListener('input', () => { query = sin.value.trim().toLowerCase(); render(); });
  sin.addEventListener('keydown', e => {
    if (e.key === 'Enter') sin.blur();              // tutup keyboard HP, hasil tetap tampil
    else if (e.key === 'Escape') setSearch(false);
  });

  /* ---------- Aksi ---------- */
  list.addEventListener('click', e => {
    if (suppressClick) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.bw-row');
    const n = row?.dataset.id ? nodes.get(row.dataset.id) : undefined;
    if (!n) return;
    selected = n.id;
    if (n.kind === 'folder') { if (!query) { if (expanded.has(n.id)) expanded.delete(n.id); else expanded.add(n.id); saveExpanded(); } }
    else if (isAudio(n)) togglePreview(n);
    render();
  });

  async function importFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    const parent = targetFolder();
    const added: FNode[] = files.map(f => ({ id: newId(), parent, name: '', kind: 'file' as const, mime: f.type, size: f.size, blob: f }));
    added.forEach((n, i) => { n.name = uniqueName(parent, files[i].name); nodes.set(n.id, n); });
    if (parent) expanded.add(parent);
    saveExpanded(); render();
    await persist(s => { added.forEach(n => { s.put(n); }); });
    opts.onMessage(`${added.length} file diimpor.`);
  }
  // Impor satu folder dari penyimpanan HP: struktur subfolder dibuat ulang di panel, hanya audio / midi / json yang disalin
  const wanted = (f: File): boolean => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|oga|flac|m4a|aac|mid|midi|json)$/i.test(f.name);
  async function importFolder(all: File[]): Promise<void> {
    if (!all.length) { opts.onMessage('Tidak ada file terpilih. Browser ini mungkin tidak mendukung pilih folder; pakai Impor File.'); return; }
    const withPath = all.filter(f => (f.webkitRelativePath || '').includes('/'));
    if (!withPath.length) {   // browser mengabaikan pilih folder dan hanya memberi daftar file: impor datar
      opts.onMessage('Browser ini tidak mendukung pilih folder, jadi file diimpor tanpa struktur folder.');
      await importFiles(all.filter(wanted));
      return;
    }
    const files = withPath.filter(wanted);
    if (!files.length) { opts.onMessage('Tidak ada file audio / midi / json di folder itu.'); return; }
    const root = targetFolder();
    const dirs = new Map<string, string>();   // jalur folder relatif -> id
    const added: FNode[] = [];
    let firstTop: string | null = null;
    const folderFor = (segs: string[]): string | null => {
      let parent = root, path = '';
      for (const name of segs) {
        path += '/' + name;
        let id = dirs.get(path);
        if (!id) {
          const same = [...nodes.values()].find(n => n.kind === 'folder' && n.parent === parent && n.name.toLowerCase() === name.toLowerCase());
          if (same) id = same.id;
          else {
            const n: FNode = { id: newId(), parent, name, kind: 'folder', mime: '', size: 0, blob: null };
            nodes.set(n.id, n); added.push(n); id = n.id;
          }
          dirs.set(path, id);
          if (parent === root && !firstTop) firstTop = id;
        }
        parent = id;
      }
      return parent;
    };
    for (const f of files) {
      const segs = f.webkitRelativePath.split('/');
      const parent = folderFor(segs.slice(0, -1));
      const n: FNode = { id: newId(), parent, name: '', kind: 'file', mime: f.type, size: f.size, blob: f };
      n.name = uniqueName(parent, segs[segs.length - 1]);
      nodes.set(n.id, n); added.push(n);
    }
    if (root) expanded.add(root);
    if (firstTop) { expanded.add(firstTop); selected = firstTop; }
    saveExpanded(); render();
    for (let i = 0; i < added.length; i += 40) { const chunk = added.slice(i, i + 40); await persist(st => { chunk.forEach(n => { st.put(n); }); }); }
    const skipped = withPath.length - files.length;
    opts.onMessage(`${files.length} file diimpor dari folder.` + (skipped ? ` ${skipped} file lain dilewati.` : ''));
  }
  async function renameSel(): Promise<void> {
    const n = selected ? nodes.get(selected) : undefined;
    if (!n) return;
    const name = prompt('Ganti nama:', n.name)?.trim();
    if (!name || name === n.name) return;
    n.name = uniqueName(n.parent, name, n.id);
    render();
    await persist(s => { s.put(n); });
  }
  async function deleteSel(): Promise<void> {
    const n = selected ? nodes.get(selected) : undefined;
    if (!n) return;
    if (!confirm(`Hapus "${n.name}"${n.kind === 'folder' ? ' beserta isinya' : ''}?`)) return;
    const by = byParent();
    const ids: string[] = [];
    const collect = (id: string): void => { ids.push(id); for (const c of by.get(id) ?? []) collect(c.id); };
    collect(n.id);
    if (playingId && ids.includes(playingId)) stopPreview();
    ids.forEach(id => { nodes.delete(id); expanded.delete(id); });
    selected = null; saveExpanded(); render();
    await persist(s => { ids.forEach(id => { s.delete(id); }); });
  }
  host.addEventListener('click', e => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'search') setSearch(!!sbar.hidden);
    else if (a === 'searchclose') setSearch(false);
    else if (a === 'importfile') fileIn.click();
    else if (a === 'importdir') dirIn.click();
    else if (a === 'rename') void renameSel();
    else if (a === 'del') void deleteSel();
    else if (a === 'play') { const n = selected ? nodes.get(selected) : undefined; if (n) { togglePreview(n); render(); } }
  });
  fileIn.onchange = () => {
    const all = [...(fileIn.files ?? [])]; fileIn.value = '';
    const ok = all.filter(wanted);
    if (!ok.length) { if (all.length) opts.onMessage('Format file tidak didukung. Pakai mp3, wav, ogg, flac, m4a, aac, midi, atau json.'); return; }
    void importFiles(ok).then(() => { if (ok.length < all.length) opts.onMessage(`${ok.length} file diimpor. ${all.length - ok.length} file lain dilewati (format tidak didukung).`); });
  };
  dirIn.onchange = () => { const f = [...(dirIn.files ?? [])]; dirIn.value = ''; void importFolder(f); };

  /* ---------- Seret file audio ke playlist ---------- */
  // Sentuhan: tahan baris file sebentar (long-press) lalu geser; mouse: langsung geser. Lepas di playlist = jadi clip audio.
  let suppressClick = false;
  list.addEventListener('contextmenu', e => e.preventDefault());
  list.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.bw-row');
    const n = row?.dataset.id ? nodes.get(row.dataset.id) : undefined;
    if (!n || !isAudio(n) || !n.blob || !opts.onDropFile) return;
    const pid = e.pointerId, x0 = e.clientX, y0 = e.clientY, touch = e.pointerType !== 'mouse';
    let dragging = false, ghost: HTMLElement | null = null, timer = 0;
    const blockScroll = (ev: TouchEvent): void => { if (dragging && ev.cancelable) ev.preventDefault(); };
    const moveGhost = (x: number, y: number): void => { if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; } };
    const begin = (x: number, y: number): void => {
      dragging = true; suppressClick = true;
      stopPreview();
      ghost = document.createElement('div');
      ghost.className = 'bw-ghost'; ghost.textContent = n.name;
      document.body.appendChild(ghost);
      moveGhost(x, y);
      if (navigator.vibrate) navigator.vibrate(15);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', blockScroll);
      ghost?.remove(); ghost = null;
      setTimeout(() => { suppressClick = false; }, 60);
    };
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return;
      if (!dragging) {
        const d = Math.hypot(ev.clientX - x0, ev.clientY - y0);
        if (touch && d > 10) { cleanup(); return; }      // sentuhan bergeser sebelum long-press = scroll daftar biasa
        if (!touch && d > 5) begin(ev.clientX, ev.clientY);
        return;
      }
      moveGhost(ev.clientX, ev.clientY);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== pid) return;
      const was = dragging;
      cleanup();
      if (was) opts.onDropFile?.({ id: n.id, name: n.name }, ev.clientX, ev.clientY);
    };
    const cancel = (ev: PointerEvent): void => { if (ev.pointerId === pid) cleanup(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('touchmove', blockScroll, { passive: false });
    if (touch) timer = window.setTimeout(() => begin(x0, y0), 320);
  });

  /* ---------- Geser lebar panel ---------- */
  grip.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = host.getBoundingClientRect().width;
    const move = (ev: PointerEvent): void => {
      width = Math.min(420, Math.max(140, Math.round(w0 + ev.clientX - x0)));
      host.style.setProperty('--bw-w', width + 'px');
    };
    const up = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      lsSet(WIDTH_KEY, String(width));
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });

  /* ---------- Muat dari penyimpanan ---------- */
  function seed(): void {
    if (nodes.size || lsGet(SEED_KEY)) return;
    const created = DEFAULT_FOLDERS.map(name => ({ id: newId(), parent: null, name, kind: 'folder' as const, mime: '', size: 0, blob: null }));
    created.forEach(n => nodes.set(n.id, n));
    lsSet(SEED_KEY, '1');
    void persist(s => { created.forEach(n => { s.put(n); }); });
  }
  openDb()
    .then(async d => { db = d; (await dbAll(d)).forEach(n => nodes.set(n.id, n)); })
    .catch(() => { opts.onMessage('Penyimpanan file tidak tersedia di browser ini (hanya sementara).'); })
    .finally(() => { seed(); render(); });
  render();

  return {
    toggle(): void {
      open = !open; host.hidden = !open;
      lsSet(OPEN_KEY, open ? '1' : '0');
      opts.onToggle?.(open);
    },
    isOpen: () => open,
    getBlob: id => nodes.get(id)?.blob ?? null,
    exportAll: () => [...nodes.values()].map(n => ({ meta: { id: n.id, parent: n.parent, name: n.name, kind: n.kind, mime: n.mime, size: n.size }, blob: n.blob })),
    async importAll(items): Promise<number> {
      const added: FNode[] = [];
      for (const { meta, blob } of items) {
        if (nodes.has(meta.id)) continue;
        if (meta.kind === 'file' && !blob) continue;   // isi file tidak ada di backup
        const n: FNode = { ...meta, blob: meta.kind === 'file' ? blob : null };
        nodes.set(n.id, n); added.push(n);
      }
      for (const n of added) if (n.parent && !nodes.has(n.parent)) n.parent = null;   // folder induk tidak ada: taruh di akar
      for (const n of added) if (n.kind === 'folder') expanded.add(n.id);
      saveExpanded(); render();
      await persist(st => { added.forEach(n => { st.put(n); }); });
      return added.filter(n => n.kind === 'file').length;
    }
  };
}
