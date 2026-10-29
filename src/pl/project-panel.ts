import './project-panel.css';

/* Panel project di sisi kanan (kebalikan panel browser file di kiri): tombol Save + New di atas, di bawahnya daftar project.
   New membuka popup nama project; setelah OK, nama muncul di daftar. */

export interface ProjectItem { id: string; name: string; }
export interface ProjectPanelHandle {
  toggle(): void; isOpen(): boolean;
  setProjects(items: ProjectItem[], activeId: string | null): void;
  /** popup nama project; validate mengembalikan teks error (atau '' kalau valid). null = dibatalkan */
  askName(validate: (name: string) => string): Promise<string | null>;
  /** popup pilih salah satu dari daftar; null = dibatalkan */
  askChoice(title: string, items: { id: string; label: string; sub?: string }[]): Promise<string | null>;
}
export interface ProjectPanelOpts { onToggle?(open: boolean): void; onSave(): void; onNew(): void; onOpen(id: string): void; onBackupProject(id: string): void; onDownloadProject(id: string): void; onBackupFolder(): void; onRestore(): void; onLoad(): void; }

const OPEN_KEY = 'daw-starter-project-panel-open', WIDTH_KEY = 'daw-starter-project-panel-w';
const lsGet = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* abaikan */ } };
const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export function mountProjectPanel(host: HTMLElement, opts: ProjectPanelOpts): ProjectPanelHandle {
  const stored = lsGet(OPEN_KEY);
  let open = stored == null ? window.innerWidth >= 700 : stored === '1';
  let width = Math.min(420, Math.max(140, Number(lsGet(WIDTH_KEY)) || 220));

  host.classList.add('pw');
  host.innerHTML =
    '<div class="pw-act"><button data-a="save">Save</button><button data-a="new">New</button></div>' +
    '<div class="pw-list" role="listbox"></div>' +
    '<div class="pw-act"><button data-a="folder" title="Pilih / ganti folder backup">Folder</button><button data-a="restore" title="Pulihkan project dari backup">Restore</button><button data-a="load" title="Buka project dari folder backup">Load</button></div>' +
    '<div class="pw-grip"></div>';
  const list = host.querySelector('.pw-list') as HTMLElement;
  const grip = host.querySelector('.pw-grip') as HTMLElement;
  host.style.setProperty('--pw-w', width + 'px');
  host.hidden = !open;

  (host.querySelector('[data-a="save"]') as HTMLElement).onclick = () => opts.onSave();
  (host.querySelector('[data-a="new"]') as HTMLElement).onclick = () => opts.onNew();
  (host.querySelector('[data-a="folder"]') as HTMLElement).onclick = () => opts.onBackupFolder();
  (host.querySelector('[data-a="restore"]') as HTMLElement).onclick = () => opts.onRestore();
  (host.querySelector('[data-a="load"]') as HTMLElement).onclick = () => opts.onLoad();
  /* menu titik tiga per project: Backup + Download */
  const menu = document.createElement('div');
  menu.className = 'pw-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  menu.innerHTML = '<button data-m="backup" role="menuitem">Backup</button><button data-m="download" role="menuitem">Download</button>';
  document.body.appendChild(menu);
  let menuId: string | null = null;
  const closeMenu = (): void => { menu.hidden = true; menuId = null; };
  menu.addEventListener('click', e => {
    const m = (e.target as HTMLElement).closest<HTMLElement>('[data-m]')?.dataset.m, id = menuId;
    closeMenu();
    if (!id) return;
    if (m === 'backup') opts.onBackupProject(id); else if (m === 'download') opts.onDownloadProject(id);
  });
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target as Node)) closeMenu(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  list.addEventListener('scroll', closeMenu);
  list.addEventListener('click', e => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('.pw-row');
    if (!row?.dataset.id) return;
    if (t.closest('.pw-more')) {   // titik tiga: buka menu, jangan buka project
      const id = row.dataset.id;
      if (!menu.hidden && menuId === id) { closeMenu(); return; }
      menuId = id; menu.hidden = false;
      const r = t.closest('.pw-more')!.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
      menu.style.left = Math.max(4, Math.min(window.innerWidth - mw - 4, r.right - mw)) + 'px';
      menu.style.top = Math.max(4, Math.min(window.innerHeight - mh - 4, r.bottom + 2)) + 'px';
      return;
    }
    opts.onOpen(row.dataset.id);
  });

  function setProjects(items: ProjectItem[], activeId: string | null): void {
    closeMenu();
    list.innerHTML = items.length
      ? items.map(p => `<div class="pw-row${p.id === activeId ? ' sel' : ''}" role="option" data-id="${esc(p.id)}"><span class="pw-n">${esc(p.name)}</span><button class="pw-more" aria-label="Menu project" aria-haspopup="menu">&#8942;</button></div>`).join('')
      : '<span class="pw-empty">Belum ada project</span>';
  }
  setProjects([], null);

  /* ---------- Popup nama project ---------- */
  const dlg = document.createElement('div');
  dlg.className = 'pw-dlg';
  dlg.hidden = true;
  dlg.innerHTML =
    '<div class="pw-dlg-card" role="dialog" aria-modal="true" aria-labelledby="pw-dlg-t" tabindex="-1">' +
    '<div class="pw-dlg-title" id="pw-dlg-t">Nama project</div>' +
    '<input class="pw-dlg-in" type="text" maxlength="60" placeholder="Nama project" autocomplete="off" aria-label="Nama project">' +
    '<div class="pw-dlg-err" role="alert"></div>' +
    '<div class="pw-dlg-btns"><button data-a="cancel">Batal</button><button data-a="ok" class="ok">OK</button></div>' +
    '</div>';
  document.body.appendChild(dlg);
  const input = dlg.querySelector('.pw-dlg-in') as HTMLInputElement;
  const err = dlg.querySelector('.pw-dlg-err') as HTMLElement;
  let settle: ((v: string | null) => void) | null = null;
  let check: (n: string) => string = () => '';
  const close = (v: string | null): void => { dlg.hidden = true; const s = settle; settle = null; s?.(v); };
  const submit = (): void => {
    const n = input.value.trim();
    const m = n ? check(n) : 'Isi nama project dulu.';
    if (m) { err.textContent = m; input.focus(); return; }
    close(n);
  };
  (dlg.querySelector('[data-a="ok"]') as HTMLElement).onclick = submit;
  (dlg.querySelector('[data-a="cancel"]') as HTMLElement).onclick = () => close(null);
  dlg.addEventListener('pointerdown', e => { if (e.target === dlg) close(null); });   // ketuk di luar kartu = batal
  dlg.addEventListener('keydown', e => {
    e.stopPropagation();   // Spasi / tombol lain di popup tidak ikut menjalankan play
    if (e.key === 'Enter') { e.preventDefault(); submit(); } else if (e.key === 'Escape') close(null);
  });
  input.addEventListener('input', () => { err.textContent = ''; });

  function askName(validate: (name: string) => string): Promise<string | null> {
    if (settle) close(null);
    check = validate;
    input.value = ''; err.textContent = '';
    dlg.hidden = false;
    input.focus({ preventScroll: true });
    return new Promise(res => { settle = res; });
  }

  /* ---------- Popup pilih project (Load dari folder) ---------- */
  const pick = document.createElement('div');
  pick.className = 'pw-dlg';
  pick.hidden = true;
  pick.innerHTML =
    '<div class="pw-dlg-card" role="dialog" aria-modal="true" aria-labelledby="pw-pick-t" tabindex="-1">' +
    '<div class="pw-dlg-title" id="pw-pick-t"></div>' +
    '<div class="pw-pick-list" role="listbox"></div>' +
    '<div class="pw-dlg-btns"><button data-a="cancel">Batal</button></div>' +
    '</div>';
  document.body.appendChild(pick);
  const pickTitle = pick.querySelector('.pw-dlg-title') as HTMLElement;
  const pickList = pick.querySelector('.pw-pick-list') as HTMLElement;
  let pickSettle: ((v: string | null) => void) | null = null;
  const pickClose = (v: string | null): void => { pick.hidden = true; const s = pickSettle; pickSettle = null; s?.(v); };
  (pick.querySelector('[data-a="cancel"]') as HTMLElement).onclick = () => pickClose(null);
  pick.addEventListener('pointerdown', e => { if (e.target === pick) pickClose(null); });
  pick.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') pickClose(null); });
  pickList.addEventListener('click', e => { const id = (e.target as HTMLElement).closest<HTMLElement>('.pw-pick-row')?.dataset.id; if (id != null) pickClose(id); });

  function askChoice(title: string, items: { id: string; label: string; sub?: string }[]): Promise<string | null> {
    if (pickSettle) pickClose(null);
    pickTitle.textContent = title;
    pickList.innerHTML = items.map(i => `<button class="pw-pick-row" role="option" data-id="${esc(i.id)}"><span class="pw-n">${esc(i.label)}</span>${i.sub ? `<span class="pw-pick-sub">${esc(i.sub)}</span>` : ''}</button>`).join('');
    pick.hidden = false;
    (pickList.querySelector('button') as HTMLElement | null)?.focus({ preventScroll: true });
    return new Promise(res => { pickSettle = res; });
  }

  /* geser lebar panel (grip di tepi kiri: tarik ke kiri = melebar) */
  grip.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = host.getBoundingClientRect().width;
    const move = (ev: PointerEvent): void => {
      width = Math.min(420, Math.max(140, Math.round(w0 - (ev.clientX - x0))));
      host.style.setProperty('--pw-w', width + 'px');
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

  return {
    toggle(): void { open = !open; host.hidden = !open; lsSet(OPEN_KEY, open ? '1' : '0'); opts.onToggle?.(open); },
    isOpen: () => open,
    setProjects,
    askName,
    askChoice
  };
}
