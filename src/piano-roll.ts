// Piano roll DERIZ: tampilan + logika editor dari piano-roll-canvas.ts (berasal dari repo "akuhanya"),
// sedangkan penyimpanan nada per pattern, pratinjau suara (instrumen DERIZ / Supersaw lewat main.ts), playhead, dan pengaturan grid
// tetap di sini dengan nama fungsi yang sama seperti sebelumnya, jadi main.ts dan menu-panel.ts tidak perlu berubah.
// Piano roll ini TIDAK punya audio sendiri: sample / synth selalu diambil lewat handler pratinjau (setPianoRollPreviewHandler).
import { velOf } from './velocity';
import { mountPianoRoll, type PianoRollCanvasHandle, type PRNote } from './piano-roll-canvas';

export interface PianoRollOpts {
  id?: string;        // kunci pattern supaya nada tersimpan per pattern
  track: string;
  pattern: string;
  color?: string;
  // Opsi di bawah ini dipertahankan supaya pemanggil lama tetap valid; tampilan baru tidak memakainya (ghost note / dropdown plugin tidak ada).
  ghosts?: Ghost[];
  keepView?: boolean; // dipanggil saat pindah antar VST: pertahankan zoom & scroll
  ghostChoices?: () => GhostChoice[];
  plugins?: () => PluginChoice[];
  plugin?: string;
  ghostScope?: string;
}
export interface Ghost { key: string; color: string; open?: () => void; }
export interface PluginChoice { label: string; active: boolean; open?: () => void; }
export interface GhostChoice { id: string; label: string; kind: 'pattern' | 'plugin'; sources: Ghost[]; }
export interface NoteData { p: number; s: number; l: number; sl?: boolean; v?: number; }   // bentuk nada yang disimpan / dimainkan

const BEATS_PER_BAR = 4;
// Panjang grid (bar) bisa diatur di Pengaturan: 4..50, bawaan 15. Disimpan di browser; tidak pernah lebih pendek dari nada terjauh.
export const PR_BARS_MIN = 4, PR_BARS_MAX = 50, PR_BARS_DEFAULT = 15, PR_BARS_KEY = 'derizmp3.prBars';
let BARS = (() => { try { const n = parseInt(localStorage.getItem(PR_BARS_KEY) || '', 10); return Number.isFinite(n) ? Math.min(PR_BARS_MAX, Math.max(PR_BARS_MIN, n)) : PR_BARS_DEFAULT; } catch { return PR_BARS_DEFAULT; } })();
let total = BARS * BEATS_PER_BAR;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const THEME_KEY = 'derizmp3.prcTheme';
const loadTheme = (): 'light' | 'dark' => 'dark';   // selalu memakai tema default web (Ink Rose); pilihan Tema di toolbar disembunyikan

// ---------- penyimpanan nada per pattern ----------
const states = new Map<string, NoteData[]>();
// sl / v hanya ikut kalau bukan nilai awal (velocity 1 = tidak disimpan), jadi data project lama tetap sama
const extras = (n: {sl?: boolean; v?: number}) => ({...(n.sl ? {sl: true} : {}), ...(n.v !== undefined && n.v < 1 ? {v: Math.round(velOf(n.v) * 1000) / 1000} : {})});
const toPR = (ns: NoteData[]): PRNote[] => ns.map(n => ({key: n.p, beat: n.s, len: n.l, vel: Math.max(1, Math.round(velOf(n.v) * 255)), ...(n.sl ? {slide: true} : {})}));
const fromPR = (ns: PRNote[]): NoteData[] => ns.map(n => ({p: n.key, s: n.beat, l: n.len, ...extras({sl: n.slide, v: n.vel >= 255 ? undefined : Math.round(n.vel / 255 * 1000) / 1000})}));

// ---------- Ghost Note (menu titik tiga): nada pattern / plugin lain, digambar putih transparan di belakang nada yang diedit ----------
// Pilihan disimpan per pattern (ghostScope) selama aplikasi terbuka. Belum pernah dipilih = semua plugin aktif tampil, pattern lain tersembunyi (perilaku lama).
let ghostSrc: Ghost[] = [], ghostFn: (() => GhostChoice[]) | null = null, ghostLegacy: Ghost[] = [], ghostScope = '', ghostList: GhostChoice[] = [];
const ghostPicks = new Map<string, Set<string>>();
const ghostPickOf = (): Set<string> => ghostPicks.get(ghostScope) ?? new Set(ghostList.filter(c => c.kind === 'plugin').map(c => c.id));
function applyGhosts() {
  const pick = ghostPickOf(), out: Ghost[] = [];
  const add = (g: Ghost) => { if (g.key !== curKey && !out.some(o => o.key === g.key)) out.push(g); };
  if (!ghostFn) ghostLegacy.forEach(add);
  else for (const c of ghostList) if (pick.has(c.id)) c.sources.forEach(add);
  ghostSrc = out;
  inst?.setGhosts(out.flatMap(g => (states.get(g.key) ?? []).map(n => ({ key: n.p, beat: n.s, len: n.l, open: g.open }))));
  const btn = root?.querySelector<HTMLElement>('.prc-bar [data-r="ghost"]');
  btn?.classList.toggle('on', out.length > 0);
}
function refreshGhosts() { ghostList = ghostFn ? ghostFn() : []; applyGhosts(); }
const escH = (t: string) => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const CHECK = '<svg class="prc-ghostchk" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
function buildGhostMenu(bar: HTMLElement) {
  const btn = bar.querySelector<HTMLButtonElement>('[data-r="ghost"]'); if (!btn) return;
  const list = document.createElement('div'); list.className = 'prc-ghostlist'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Ghost Note');
  btn.after(list);
  btn.setAttribute('aria-haspopup', 'true'); btn.setAttribute('aria-expanded', 'false');
  const row = (id: string, label: string, on: boolean) =>
    '<button type="button" role="menuitemcheckbox" class="prc-ghostrow" data-g="' + escH(id) + '" aria-checked="' + on + '"><span>' + escH(label) + '</span>' + CHECK + '</button>';
  const html = () => {
    if (!ghostList.length) return '<div class="prc-ghostempty">Belum ada pattern lain yang berisi nada</div>';
    const pick = ghostPickOf(), pats = ghostList.filter(c => c.kind === 'pattern'), plgs = ghostList.filter(c => c.kind === 'plugin');
    const sep = '<div class="prc-ghostsep" role="separator"></div>';
    return row('*', 'Semua', ghostList.every(c => pick.has(c.id))) +
      (pats.length ? sep + pats.map(c => row(c.id, c.label, pick.has(c.id))).join('') : '') +
      (plgs.length ? sep + plgs.map(c => row(c.id, c.label, pick.has(c.id))).join('') : '');
  };
  const setOpen = (open: boolean) => {
    if (open) { refreshGhosts(); list.innerHTML = html(); }   // pattern / plugin bisa berubah sejak piano roll dibuka
    list.classList.toggle('is-open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) requestAnimationFrame(() => list.scrollIntoView({ block: 'nearest' }));
  };
  btn.addEventListener('click', () => setOpen(!list.classList.contains('is-open')));
  list.addEventListener('click', e => {
    const it = (e.target as HTMLElement).closest<HTMLElement>('[data-g]'); if (!it) return;
    const id = it.dataset.g!, cur = new Set(ghostPickOf());
    if (id === '*') { if (ghostList.every(x => cur.has(x.id))) cur.clear(); else ghostList.forEach(x => cur.add(x.id)); }
    else if (cur.has(id)) cur.delete(id); else cur.add(id);
    ghostPicks.set(ghostScope, cur);
    applyGhosts(); list.innerHTML = html();
  });
}

let root: HTMLElement | null = null;
let inst: PianoRollCanvasHandle | null = null;
let curKey = '', trackColor = '', noteColor: string | null = null;
let onHistory: (() => void) | null = null, onClose: (() => void) | null = null, onChange: ((id: string) => void) | null = null;
let onSeek: ((beats: number, final: boolean) => void) | null = null;
let phBeat = 0, phMo: {perSec: number; delay: number} | null = null;   // playhead terakhir dari main.ts (dipasang lagi saat piano roll dibuka)

export const setPianoRollChangeHandler = (fn: (id: string) => void) => { onChange = fn; };
let onTogglePlay: (() => void) | null = null, playingNow = false;
export const setPianoRollTogglePlayHandler = (fn: () => void) => { onTogglePlay = fn; };   // tombol Play di atas playhead piano roll = transport utama (main.ts)
export function setPianoRollPlaying(on: boolean) { playingNow = on; inst?.setPlaying(on); }   // tombol Play di atas playhead tersembunyi saat play
export const setPianoRollSeekHandler = (fn: (beats: number, final: boolean) => void) => { onSeek = fn; };

// ---------- preview suara: nada berbunyi lewat instrumen pemilik piano roll (DERIZ / Supersaw) ----------
// main.ts yang tahu instrumen mana yang sedang diedit; piano roll hanya memberi tahu nada (MIDI) mana yang harus bunyi / dilepas.
export interface PianoRollPreview { on(midi: number): void; off(midi: number): void; }
let pv: PianoRollPreview | null = null;
const pvCount = new Map<number, number>();   // satu nada bisa ditahan oleh beberapa suara (tap + tuts): dilepas setelah yang terakhir selesai
export const setPianoRollPreviewHandler = (h: PianoRollPreview | null) => { pv = h; };
function pvVoice(key: number, dur?: number): {stop(): void} {
  const c = (pvCount.get(key) ?? 0) + 1; pvCount.set(key, c);
  if (c === 1) pv?.on(key);
  let done = false, timer = 0;
  const stop = () => {
    if (done) return; done = true; window.clearTimeout(timer);
    const n = (pvCount.get(key) ?? 1) - 1;
    if (n <= 0) { pvCount.delete(key); pv?.off(key); } else pvCount.set(key, n);
  };
  if (dur != null) timer = window.setTimeout(stop, Math.max(0.12, dur) * 1000);   // tap: bunyi singkat lalu lepas sendiri
  return {stop};
}

// ---------- panjang grid ----------
export let PR_BEATS = total;   // lebar grid piano roll (ketukan); live binding, ikut berubah kalau panjang grid diganti
export const getPianoRollBars = (): number => BARS;
// jumlah bar minimal supaya semua nada (semua pattern) tetap di dalam grid
export function pianoRollNeededBars(): number {
  let m = 0;
  for (const ns of states.values()) for (const n of ns) m = Math.max(m, n.s + n.l);
  return Math.max(PR_BARS_MIN, Math.ceil(m / BEATS_PER_BAR - 1e-9));
}
function applyBars(v: number): boolean {
  if (v === BARS) return false;
  BARS = v; total = BARS * BEATS_PER_BAR; PR_BEATS = total;
  inst?.setMaxBeats(total);
  document.dispatchEvent(new CustomEvent('prbarschange'));  // main.ts menggambar ulang note mini di semua pattern; menu Pengaturan menyamakan tampilannya
  return true;
}
// dari Pengaturan: mengembalikan nilai yang benar-benar dipakai (dijepit ke 4..50 dan ke nada terjauh)
export function setPianoRollBars(n: number, save = true): number {
  const v = clamp(Math.round(n) || PR_BARS_DEFAULT, Math.min(PR_BARS_MAX, Math.max(PR_BARS_MIN, pianoRollNeededBars())), PR_BARS_MAX);
  if (save) { try { localStorage.setItem(PR_BARS_KEY, String(v)); } catch { /* penyimpanan diblokir: tetap berlaku sampai halaman ditutup */ } }
  applyBars(v);
  return v;
}

// ---------- data nada (dipakai main.ts: simpan / muat project, salin pattern, dll.) ----------
const refreshOpen = (id: string) => { if (inst && id === curKey) inst.setNotes(toPR(states.get(id) ?? []), true); };
export function getPianoRollNotes(id: string): NoteData[] {
  const x = states.get(id);
  return x ? x.map(n => ({p: n.p, s: n.s, l: n.l, ...extras(n)})) : [];
}
// isi nada satu kunci dari data yang disimpan (memuat project)
export function setPianoRollNotes(id: string, notes: NoteData[]) {
  states.set(id, notes.map(n => ({p: n.p, s: n.s, l: n.l, ...extras(n)})));
  const need = pianoRollNeededBars(); if (need > BARS) applyBars(Math.min(PR_BARS_MAX, need));   // project berisi nada lebih jauh dari grid pengaturan ini: grid melebar sementara (pengaturan tersimpan tidak berubah), nada tidak pernah tersembunyi
  refreshOpen(id);
  onChange && onChange(id);
}
// salin nada dari satu pattern ke pattern lain (rentang ketukan [fromBeat, toBeat), digeser supaya mulai dari 0)
export function copyPianoRollNotes(from: string, to: string, fromBeat = 0, toBeat = Infinity) {
  const src = states.get(from); if (!src) return;
  const dst: NoteData[] = [];
  for (const n of src) {
    const a = Math.max(n.s, fromBeat), b = Math.min(n.s + n.l, toBeat);
    if (b > a + 1e-9) dst.push({p: n.p, s: a - fromBeat, l: b - a, ...extras(n)});
  }
  states.set(to, dst);
}
export function clearPianoRollNotes(id: string) { if (states.delete(id)) { refreshOpen(id); onChange && onChange(id); } }   // kosongkan nada satu kunci (mis. pemilik kunci polos dihapus)
export function dropPianoRollNotesOf(suffix: string) {   // buang semua nada berkunci "<pattern>@<suffix>" dan kabarkan perubahannya
  for (const k of [...states.keys()]) if (k.endsWith('@' + suffix)) { states.delete(k); refreshOpen(k); onChange && onChange(k); }
}
// nada milik DERIZ lain di pattern yang sama disimpan dengan kunci "<id pattern>@<id track DERIZ>"; daftar kunci tambahan itu untuk id ini
export const pianoRollExtraKeys = (id: string): string[] => [...states.keys()].filter(k => k.startsWith(id + '@') && states.get(k)!.length);
export function trimPianoRollNotes(id: string, toBeat: number) {   // buang / potong nada yang melewati toBeat
  const x = states.get(id); if (!x) return;
  states.set(id, x.filter(n => n.s < toBeat - 1e-9).map(n => ({...n, l: Math.min(n.l, toBeat - n.s)})));
  refreshOpen(id);
}
export function shiftPianoRollNotes(id: string, delta: number) {   // geser semua nada sebesar delta ketukan (awal pattern berpindah); yang jatuh sebelum ketukan 0 dipotong / dibuang
  const x = states.get(id); if (!x) return;
  states.set(id, x.map(n => ({...n, s: n.s + delta})).filter(n => n.s + n.l > 1e-9).map(n => n.s < 0 ? {...n, l: n.l + n.s, s: 0} : n));
  refreshOpen(id);
}

// ---------- playhead (diatur main.ts dari transport utama) ----------
// motion (opsional): playhead sedang berjalan dari `beats` dengan kecepatan perSec ketukan/detik, mulai setelah `delay` detik (count-in)
export function setPianoRollPlayhead(beats: number, motion?: {perSec: number; delay: number}) {
  phBeat = beats; phMo = motion ?? null;
  inst?.setPlayhead(beats, motion);
}

// ---------- warna nada global (pilihan Color; ikut tersimpan di file project) ----------
const defaultColor = () => '#ff5c9e';   // aksen default web
const curColor = () => noteColor || trackColor || defaultColor();
export const getNoteColor = (): string | null => noteColor;
export function setNoteColor(c: string | null) {   // dipakai saat project dimuat; piano roll yang sedang terbuka langsung ikut
  noteColor = c || null;
  if (inst) inst.setColor(curColor());
}

// ---------- buka / tutup ----------
function build(): HTMLElement {
  const el = document.createElement('section');
  el.id = 'pianoRoll'; el.className = 'pr'; el.setAttribute('aria-label', 'Piano roll'); el.hidden = true;
  return el;
}
function mount(el: HTMLElement) {
  inst = mountPianoRoll(el, {
    notes: [], theme: loadTheme(), color: curColor(), clipLen: total, maxBeats: total, clipOffset: 0,   // snap relatif awal pattern (beat 0 = awal pattern)
    onChange: () => {
      if (!inst || !curKey) return;
      states.set(curKey, fromPR(inst.getNotes()));
      onChange && onChange(curKey);
    },
    onHistory: () => { onHistory && onHistory(); },   // riwayat undo / redo note berubah: tombol Undo / Redo di card transport ikut
    onSeek: (b, final) => { onSeek && onSeek(b, final); },
    onTogglePlay: () => { onTogglePlay && onTogglePlay(); },
    onColor: c => { noteColor = c; },
    onTheme: t => { try { localStorage.setItem(THEME_KEY, t); } catch { /* abaikan */ } },
    playSample: (key, _vel, _when, dur) => pvVoice(key, dur),
  });
  const stage = el.querySelector<HTMLElement>('.prc-stage');
  if (stage) {   // tombol X di pojok kiri atas (di atas area kosong di samping penggaris) = tutup piano roll
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'prc-x'; x.title = 'Tutup piano roll'; x.setAttribute('aria-label', 'Tutup piano roll');
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18"/></svg>';
    x.addEventListener('click', closePianoRoll);
    stage.appendChild(x);
  }
  const bar = el.querySelector<HTMLElement>('.prc-bar');
  if (bar) {   // toolbar atas dipindah jadi menu vertikal (dibuka dari titik tiga di bar transport bawah); tombol tutup jadi baris pertama menu
    bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Menu piano roll');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'prc-close'; b.textContent = 'Tutup piano roll'; b.title = 'Tutup piano roll'; b.setAttribute('aria-label', 'Tutup piano roll');
    b.addEventListener('click', closePianoRoll);
    bar.prepend(b);
    buildGhostMenu(bar);
    bar.querySelector('[data-r="clear"]')?.addEventListener('click', () => setMenu(false));
  }
}

// ---------- menu vertikal piano roll: tombol titik tiga di bar transport bawah (#btnPrMenu, hanya tampil saat piano roll terbuka) ----------
let menuBtn: HTMLButtonElement | null = null;
const menuBar = (): HTMLElement | null => root?.querySelector<HTMLElement>('.prc-bar') ?? null;
const isMenuOpen = (): boolean => !!menuBar()?.classList.contains('is-menu-open');
function setMenu(open: boolean) {
  const bar = menuBar();
  if (bar && root && open) {   // menu muncul tepat di atas tombol titik tiga, dijepit ke dalam layar piano roll
    const rr = root.getBoundingClientRect(), br = menuBtn?.getBoundingClientRect();
    if (br) bar.style.left = Math.max(8, Math.min(br.left - rr.left, rr.width - bar.offsetWidth - 8)) + 'px';
  }
  bar?.classList.toggle('is-menu-open', open);
  menuBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
}
export function bindPianoRollMenu(btn: HTMLButtonElement) {
  menuBtn = btn;
  btn.addEventListener('click', () => { if (isPianoRollOpen()) setMenu(!isMenuOpen()); });
  document.addEventListener('pointerdown', e => {   // ketukan di luar menu menutupnya; kalau jatuh di piano roll, ketukan itu tidak ikut membuat / menggeser nada
    if (!isMenuOpen()) return;
    const t = e.target as Node;
    if (menuBar()!.contains(t) || btn.contains(t)) return;
    setMenu(false);
    if (root && root.contains(t)) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

export function openPianoRoll(opts: PianoRollOpts, host: HTMLElement = document.querySelector('.stage') as HTMLElement) {
  if (!root) root = build();
  if (!root.parentElement) host.appendChild(root);
  const key = opts.id || opts.track + '/' + opts.pattern;
  const keep = !!opts.keepView && isPianoRollOpen();   // pindah antar VST saat piano roll sudah terbuka: tampilan tidak direset
  trackColor = opts.color || '';
  const notes = toPR(states.get(key) ?? []);
  if (!states.has(key)) states.set(key, []);
  curKey = key;
  root.setAttribute('aria-label', opts.track + ' – ' + opts.pattern);
  root.hidden = false;
  if (!inst) mount(root);
  inst!.setPlaying(playingNow);
  inst!.setEnabled(true);
  inst!.setMaxBeats(total);
  inst!.setColor(curColor());
  inst!.setNotes(notes, keep);
  ghostFn = opts.ghostChoices || null; ghostLegacy = opts.ghosts || []; ghostScope = opts.ghostScope || key;
  refreshGhosts();   // nada instrumen / pattern lain sebagai ghost putih transparan
  inst!.setPlayhead(phBeat, phMo ?? undefined);
  void root.offsetWidth; root.classList.add('is-open');
  requestAnimationFrame(() => inst && inst.resize());
  inst!.resize();
  onHistory && onHistory();   // piano roll baru terbuka: tombol Undo / Redo di card transport pindah ke riwayat note
}

export function closePianoRoll() {
  if (!root || root.hidden) return;
  setMenu(false);
  root.querySelector('.prc-ghostlist')?.classList.remove('is-open');
  const r = root, i = inst;
  i && i.setEnabled(false);   // lepas nada yang masih ditahan + tidak menanggapi keyboard selama animasi tutup
  r.classList.remove('is-open');
  setTimeout(() => {
    if (r.classList.contains('is-open')) return;   // dibuka lagi sebelum animasi selesai
    r.hidden = true;
    if (inst === i && inst) { inst.destroy(); inst = null; }
  }, 200);
  onClose && onClose();
  onHistory && onHistory();   // piano roll tertutup: tombol Undo / Redo kembali ke riwayat playlist
}
export const isPianoRollOpen = () => !!root && !root.hidden && root.classList.contains('is-open');
export const setPianoRollCloseHandler = (fn: () => void) => { onClose = fn; };
// Undo / Redo note: dipakai tombol Undo / Redo di card transport bawah saat piano roll terbuka
export const setPianoRollHistoryHandler = (fn: () => void) => { onHistory = fn; };
export const pianoRollUndo = () => { inst?.undo(); };
export const pianoRollRedo = () => { inst?.redo(); };
export const pianoRollCanUndo = (): boolean => !!inst && inst.canUndo();
export const pianoRollCanRedo = (): boolean => !!inst && inst.canRedo();

// ---------- tombol keyboard saat piano roll terbuka: Esc menutup (ditangani komponen untuk seleksi / menu) ----------
document.addEventListener('keydown', e => {
  if (!isPianoRollOpen() || e.key !== 'Escape') return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (isMenuOpen()) { setMenu(false); return; }   // menu vertikal terbuka: Esc hanya menutup menu
  if (document.querySelector('#pianoRoll .prc-pop[style*="display: flex"], #pianoRoll .prc-pop[style*="display: grid"]')) return;   // menu popup terbuka: Esc hanya menutup menu
  closePianoRoll();
});
