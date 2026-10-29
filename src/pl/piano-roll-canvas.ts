// Piano roll berbasis canvas (hasil konversi dari piano-roll.html tunggal jadi komponen).
// Isinya sama persis dengan versi HTML: toolbar, grid, keyboard, ruler, velocity lane, seleksi + handle, undo/redo, copy/paste, zoom, pan inersia, pinch.
// Semua state ada di dalam closure mountPianoRoll(), jadi bisa dipasang lebih dari satu instance dan dibersihkan lewat destroy().
// Audio lewat audio-engine.ts (pratinjau masuk ke chain efek + channel clip yang diedit lewat opts.getOutput).

import { engine } from './audio-engine';
import { slideInfo, segsToSec } from './slide';
import './piano-roll-canvas.css';

export interface PRNote { key: number; beat: number; len: number; vel: number; slide?: boolean; }   // key = nomor MIDI 0..127, beat & len dalam ketukan, vel 1..255
export interface PianoRollCanvasOpts {
  notes?: PRNote[];
  clipLen?: number;            // panjang loop minimal (ketukan), default 16 (4 bar); selebihnya melebar otomatis per blok 4 bar mengikuti isi note
  bpm?: number;                // default 120
  theme?: 'light' | 'dark';    // default 'light'
  color?: string;              // warna note, default oranye
  clipOffset?: number;         // posisi awal clip di timeline (ketukan), default 0; snap dihitung relatif ke sini
  onChange?: () => void;       // dipanggil setelah note berubah (setelah gesture, menu, undo/redo, keyboard)
  onTransport?: (playing: boolean) => void;   // dipanggil saat play/stop
  onHistory?: () => void;      // riwayat undo / redo berubah (tombol Undo / Redo di bilah bawah ikut aktif / mati)
  playSample?: (key: number, vel: number, when: number | null | undefined, dur: number | undefined, segs?: { off: number; key: number; dur: number }[]) => { stop(at?: number): void; start?: number } | null;   // clip memakai vsynth: suara sampel, bukan oscillator bawaan (null = pakai oscillator)
  getOutput?: () => AudioNode | null;   // tujuan suara pratinjau (chain efek clip yang diedit); kosong = langsung ke master
  getKeyLabel?: (key: number) => string | null;   // nama di tuts keyboard (mis. nama sample drum); null = tuts biasa (nama nada). Dibaca tiap gambar ulang, harus murah.
}
export interface PianoRollCanvasHandle {
  destroy(): void;
  getNotes(): PRNote[];
  setNotes(notes: PRNote[]): void;
  resize(): void;
  setClipOffset(beats: number): void;
  setClipLen(beats: number): void;   // panjang loop minimal
  setColor(color: string): void;
  stop(): void;
  togglePlay(): void;          // play / stop (dipakai tombol Play di bilah bawah)
  rewind(): void;              // stop (kalau sedang play) dan kembalikan playhead ke titik tempat Play terakhir dimulai
  seekBars(d: number): void;   // tombol Maju di bilah bawah: loncat d bar
  isPlaying(): boolean;
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean;   // riwayat note (dipakai tombol Undo / Redo di bilah bawah)
  setBpm(bpm: number): void;   // tempo mengikuti project
  setMetronome(on: boolean): void;   // klik tiap ketukan saat play (aksen di ketukan pertama tiap bar)
  refresh(): void;                   // gambar ulang (mis. nama tuts berubah karena sample diganti)
  focusKey(key: number): void;       // gulung tampilan supaya tuts ini ada di dekat bagian atas
}

interface N extends PRNote { sel: boolean; }
interface Sel { beat: number; row: number; len: number; rows: number; }
interface Pt { x: number; y: number; }
type DragType = 'move' | 'resize' | 'stretch';
interface Drag { type: DragType; dBeat: number; dRow: number; dLen: number; scale: number; }
interface SelDrag { b0: number; r0: number; b1: number; r1: number; }
interface Voice { stop(at?: number): void; start?: number; }
interface Gs {
  id: number; x: number; y: number; sx: number; sy: number; t: number; mode: string;
  vx: number; vy: number; timer?: number; lastT?: number; p0?: { x: number; y: number; h: number; v: number };
  key?: number; vel?: number; changed?: boolean; last?: Pt;
  type?: DragType; s0?: Sel; start?: Pt; minBeat?: number; maxBeat?: number; minRow?: number; maxRow?: number; pv?: number | null;
  b0?: number; r0?: number;
}
interface Pinch { a: Gs; b: Gs; dx0: number; dy0: number; zH0: number; zV0: number; mb: number; mr: number; }

/* ---------- Token ---------- */
interface Theme {
  bg: string; rb: string; rw: string; rule: string; light: string;
  lat: string; latA: [number, number, number]; octLine: string; rowLine: string | null; rowText: string;
  noteLine: string; noteText: string | null; selFill: string;
  keyBg: string; keyW: string; keyB: string; keySep: string;
  rulerBg: string; rulerSel: string; tick: string; circle: string; circleText: string;
  selBorder: string; selBox: string; handleBg: string; handleFg: string;
  playhead: string; playShadow: string; playW: number;
  velSep: string; velBg: string; velLine: string; shadow: string;
  css: Record<string, string>;
}
const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {   // gaya Ableton Live: grid biru-hitam, note berwarna dengan label
    bg: '#2A2D34', rb: '#34373E', rw: '#3A3E46', rule: '#1D2226', light: '#C5C8D1',
    lat: '#1D2226', latA: [.3, .45, .75], octLine: '#1D2226', rowLine: 'rgba(0,0,0,.18)', rowText: 'rgba(200,205,212,.35)',
    noteLine: '#1D2226', noteText: '#1D2226', selFill: '#E4E7EB',
    keyBg: '#2A2D34', keyW: '#CDD2D8', keyB: '#2C3037', keySep: 'rgba(0,0,0,.45)',
    rulerBg: '#2F3239', rulerSel: '#3B4049', tick: '#6B7079', circle: '#8C939B', circleText: '#2A2D34',
    selBorder: '#E2E5EA', selBox: 'rgba(226,229,234,.18)', handleBg: '#C5C8D1', handleFg: '#2A2D34',
    playhead: '#C5C8D1', playShadow: 'rgba(42,45,52,.5)', playW: 1,
    velSep: '#2A2D34', velBg: '#34373E', velLine: 'rgba(0,0,0,.35)', shadow: 'rgba(0,0,0,.25)',
    css: { '--bg-dark': '#2A2D34', '--row-black': '#34373E', '--row-white': '#3A3E46', '--rule': '#1D2226', '--light': '#C5C8D1' }
  },
  light: {  // terang, gaya screenshot (baris abu-abu, note oranye + label)
    bg: '#B4B4B4', rb: '#B1B1B1', rw: '#C9C9C9', rule: '#8A8A8A', light: '#222222',
    lat: '#000000', latA: [.08, .15, .35], octLine: 'rgba(0,0,0,.35)', rowLine: 'rgba(0,0,0,.07)', rowText: 'rgba(0,0,0,.35)',
    noteLine: '#3B2808', noteText: '#3B2808', selFill: '#FFD84A',
    keyBg: '#8A8A8A', keyW: '#F1F1F1', keyB: '#2E2E2E', keySep: 'rgba(0,0,0,.35)',
    rulerBg: '#D2D2D2', rulerSel: '#B8B8B8', tick: '#7C7C7C', circle: '#2A2A2A', circleText: '#F1F1F1',
    selBorder: '#2A2A2A', selBox: 'rgba(0,0,0,.12)', handleBg: '#2A2A2A', handleFg: '#F1F1F1',
    playhead: '#1A1A1A', playShadow: 'rgba(255,255,255,.35)', playW: 1,
    velSep: '#9A9A9A', velBg: '#BDBDBD', velLine: 'rgba(0,0,0,.1)', shadow: 'rgba(0,0,0,.12)',
    css: { '--bg-dark': '#D2D2D2', '--row-black': '#C2C2C2', '--row-white': '#B4B4B4', '--rule': '#9A9A9A', '--light': '#222222' }
  }
};
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACKMASK = 0x54a;
const isBlack = (k: number): number => (BLACKMASK >> (k % 12)) & 1;
const MINLEN = 0.03125;   // 1/32 beat = 1/8 Step
const U = 1;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const isDarkHex = (hex: string): boolean => {   // warna channel gelap -> teks note dibuat terang
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255 <= 0.45;
};
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const near = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
const ZHMIN = 0.5, ZHMAX = 40, ZVMIN = 1 / 6, ZVMAX = 4;
const toPos = (v: number, mn: number, mx: number): number => Math.round(100 * Math.log(v / mn) / Math.log(mx / mn));
const fromPos = (p: number, mn: number, mx: number): number => mn * Math.pow(mx / mn, p / 100);

const TEMPLATE = `
<div class="prc-bar">
  <button data-r="play">Play</button>
  <label>BPM <input data-r="bpm" type="number" min="40" max="240" value="120"></label>
  <label>Snap
    <select data-r="snap">
      <option value="auto">Otomatis</option>
      <option value="off">Tanpa snap</option>
      <option value="1/32">1/8 Step</option>
      <option value="1/16">1/4 Step</option>
      <option value="1/8">1/2 Step</option>
      <option value="1/6">1/6 Beat</option>
      <option value="1/4">1/4 Beat</option>
      <option value="1/3">1/3 Beat</option>
      <option value="1/2">1/2 Beat</option>
      <option value="1">1 Beat</option>
      <option value="4">1 Bar</option>
    </select>
  </label>
  <label>Tema
    <select data-r="theme">
      <option value="light">Terang</option>
      <option value="dark">Gelap (FLM)</option>
    </select>
  </label>
  <label>Warna
    <select data-r="color">
      <option value="#FE32CF">Pink</option>
      <option value="#33BB03">Hijau</option>
      <option value="#2D4793">Biru</option>
      <option value="#F96303">Oranye</option>
      <option value="#9741A2">Ungu</option>
      <option value="#C32862">Merah</option>
      <option value="#584893">Violet</option>
    </select>
  </label>
  <label>UI
    <select data-r="ui">
      <option value="0.75">75%</option>
      <option value="0.9">90%</option>
      <option value="1" selected>100%</option>
      <option value="1.25">125%</option>
      <option value="1.5">150%</option>
      <option value="1.75">175%</option>
      <option value="2">200%</option>
    </select>
  </label>
  <label>Zoom H <input data-r="zh" type="range" min="0" max="100" value="50"></label>
  <label>Zoom V <input data-r="zv" type="range" min="0" max="100" value="50"></label>
  <button data-r="vel">Velocity</button>
  <button data-r="slide" title="Note slide: pitch meluncur dari note sebelumnya. Pilih note lalu tekan; tanpa seleksi = note baru berupa slide">Slide</button>
  <button data-r="undo">Undo</button>
  <button data-r="redo">Redo</button>
  <button data-r="clear">Kosongkan</button>
  <span class="prc-hint">Tap: buat note &middot; Tahan 0,2 dtk: seleksi area &middot; Geser: scroll &middot; Pinch / Ctrl+scroll: zoom</span>
</div>
<div class="prc-stage">
  <canvas class="prc-cv"></canvas>
  <div class="prc-pop"></div>
</div>`;

// nada contoh dari versi HTML (progresi 4 akor, 8 bar) — dipakai kalau mau lihat tampilannya: mountPianoRoll(host, { notes: demoNotes() })
export function demoNotes(): PRNote[] {
  const out: PRNote[] = [];
  const chords = [[60, 63, 67], [56, 60, 63], [63, 67, 70], [58, 62, 65]];
  for (let bar = 0; bar < 8; bar++) {
    const ch = chords[bar % 4], b = bar * 4;
    out.push({ key: ch[0] - 24, beat: b, len: 2, vel: 200 });
    for (let i = 0; i < 8; i++) {
      out.push({ key: ch[i % 3] + (i % 6 >= 3 ? 12 : 0), beat: b + i * 0.5, len: 0.5, vel: i % 4 === 0 ? 210 : 150 });
    }
  }
  return out;
}

/* ---------- Clipboard bersama ---------- */
// Satu clipboard untuk semua piano roll (instrumen / clip mana pun): copy di satu instrumen bisa langsung di-paste di instrumen lain.
// Disimpan juga di localStorage supaya tetap ada setelah aplikasi dimuat ulang. Isinya posisi relatif (beat dihitung dari note paling kiri).
const CLIP_KEY = 'daw-starter-pr-clipboard';
let sharedClipboard: PRNote[] = (() => {
  try {
    const a = JSON.parse(localStorage.getItem(CLIP_KEY) || '[]') as PRNote[];
    return Array.isArray(a) ? a.filter(n => n && Number.isFinite(n.key) && Number.isFinite(n.beat) && Number.isFinite(n.len) && Number.isFinite(n.vel)) : [];
  } catch { return []; }
})();
function setSharedClipboard(a: PRNote[]): void {
  sharedClipboard = a;
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(a)); } catch { /* abaikan */ }
}

export function mountPianoRoll(host: HTMLElement, opts: PianoRollCanvasOpts = {}): PianoRollCanvasHandle {
  const root = document.createElement('div');
  root.className = 'prc';
  root.innerHTML = TEMPLATE;
  host.appendChild(root);

  const $ = <T extends HTMLElement>(r: string): T => root.querySelector<T>(`[data-r="${r}"]`)!;
  const cv = root.querySelector<HTMLCanvasElement>('.prc-cv')!;
  const ctx = cv.getContext('2d')!;
  const stage = root.querySelector<HTMLElement>('.prc-stage')!;
  const pop = root.querySelector<HTMLElement>('.prc-pop')!;
  const bPlay = $<HTMLButtonElement>('play'), bVel = $<HTMLButtonElement>('vel'), bSlide = $<HTMLButtonElement>('slide');
  const bUndo = $<HTMLButtonElement>('undo'), bRedo = $<HTMLButtonElement>('redo'), bClear = $<HTMLButtonElement>('clear');
  const snapSel = $<HTMLSelectElement>('snap'), themeEl = $<HTMLSelectElement>('theme'), colorEl = $<HTMLSelectElement>('color');
  const uiEl = $<HTMLSelectElement>('ui'), bpmEl = $<HTMLInputElement>('bpm');
  const zhEl = $<HTMLInputElement>('zh'), zvEl = $<HTMLInputElement>('zv');

  let C: Theme = THEMES.light;

  /* ---------- State ---------- */
  // Panjang area note seperti editor FL Studio Mobile: terbuka per blok 4 bar (BLOCK = 16 ketukan). Isi note sampai bar 5 -> loop jadi 8 bar, sampai bar 9 -> 12 bar, dst.
  // loopLen = panjang loop (yang diputar, di luar itu bayangan); clipLen = batas area yang bisa diedit = loopLen + 1 blok kosong berikutnya, supaya blok baru bisa diisi.
  const BLOCK = 16, MAXLEN = 512;
  const S = {
    notes: [] as N[], minLoop: Math.max(BLOCK, Math.ceil((opts.clipLen ?? BLOCK) / BLOCK) * BLOCK), loopLen: BLOCK, clipLen: BLOCK * 2, spb: 4, bpb: 4, bpm: opts.bpm ?? 120,
    zH: 4, zV: 0.75, posH: 0, posV: 51,
    color: opts.color ?? '#FE32CF', lastLen: 1, lastVel: 0.7, slideNew: false, clipOffset: opts.clipOffset ?? 0,
    sel: null as Sel | null, handles: false
  };
  let drag: Drag | null = null;          // preview drag
  let selDrag: SelDrag | null = null;    // kotak seleksi yang sedang digambar
  let inertia: { vx: number; vy: number } | null = null;
  let dirty = true;
  const invalidate = (): void => { dirty = true; };
  let lastSnap = '';
  const sig = (): string => JSON.stringify(S.notes.map(n => [n.key, n.beat, n.len, n.vel, n.slide ? 1 : 0]));
  function refit(): void {   // hitung ulang panjang loop dari isi note (membesar maupun mengecil per blok 4 bar)
    let end = 0;
    for (const n of S.notes) end = Math.max(end, n.beat + n.len);
    S.loopLen = Math.min(MAXLEN - BLOCK, Math.max(S.minLoop, Math.ceil(end / BLOCK - 1e-9) * BLOCK));
    S.clipLen = S.loopLen + BLOCK;
    if (playhead > S.loopLen) playhead = 0;
    clampView();
  }
  const notify = (): void => {   // beri tahu host hanya bila isi note benar-benar berubah
    refit();
    const s = sig();
    if (s === lastSnap) return;
    lastSnap = s; opts.onChange?.();
  };

  let W = 0, H = 0, dpr = 1, cell = 24, V = 2, uiScale = 1;
  let kbW = 0, rulerH = 0, areaX = 0, areaY = 0, areaW = 0, areaH = 0, velOn = false, velY = 0, velH = 0;

  const toN = (n: PRNote): N => ({ key: n.key, beat: n.beat, len: n.len, vel: n.vel, ...(n.slide ? { slide: true } : {}), sel: false });

  /* ---------- Tata letak ---------- */
  function layout(): void {
    cell = Math.max(16, Math.round(24 * uiScale * dpr));
    V = Math.max(1, Math.round(cell / 16));
    kbW = Math.round(cell * 2.5);
    rulerH = Math.round(cell * 1.5);
    areaX = kbW; areaY = rulerH; areaW = Math.max(10, W - kbW);
    const tot = Math.max(10, H - rulerH);
    if (velOn) {
      velH = Math.min(Math.max(Math.round(tot * 0.28), Math.round(cell * 2)), Math.round(tot * 0.6));
      areaH = tot - velH - 4 * U;
      velY = areaY + areaH + 4 * U;
    } else {
      velH = 0; areaH = tot; velY = areaY + areaH;
    }
    clampView();
    invalidate();
  }
  const pxBeat = (): number => S.zH * cell;
  const rowH = (): number => S.zV * cell;
  const bx = (b: number): number => areaX + (b - S.posH) * pxBeat();
  const ry = (r: number): number => areaY + (r - S.posV) * rowH();
  const xToBeat = (x: number): number => (x - areaX) / pxBeat() + S.posH;
  const yToRow = (y: number): number => (y - areaY) / rowH() + S.posV;

  function clampView(): void {
    const vr = areaH / rowH();
    S.posV = clamp(S.posV, 0, Math.max(0, 128 - vr));
    const vb = areaW / pxBeat();
    S.posH = clamp(S.posH, 0, Math.max(0, S.clipLen - vb * 0.25));
  }

  function resize(): void {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    const nw = Math.max(50, Math.round(r.width * dpr)), nh = Math.max(50, Math.round(r.height * dpr));
    if (nw === cv.width && nh === cv.height && dpr === lastDpr) return;   // ukuran sama: jangan hapus canvas
    lastDpr = dpr;
    cv.width = nw; cv.height = nh;   // mengubah ukuran menghapus isi canvas
    W = cv.width; H = cv.height;   // semua koordinat dalam piksel perangkat asli (tajam, tanpa scaling)
    layout();
    if (!dead) { dirty = false; draw(); }   // gambar ulang sekarang juga (sebelum frame tampil), kalau tidak satu frame kosong = berkedip
  }
  let lastDpr = 0;
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  /* ---------- Snap & lattice ---------- */
  function latticeStep(): number {
    let s = 1 / S.spb; const minPx = cell * 0.6;
    while (s * pxBeat() < minPx) s *= 2;
    return s;
  }
  function fineStep(): number {
    let s = 1 / (S.spb * 32); const minPx = cell * 0.6;
    while (s * pxBeat() < minPx) s *= 2;
    return s;
  }
  function stepBeats(): number {
    const v = snapSel.value;
    if (v === 'off') return 0;
    if (v === 'auto') return fineStep();
    const p = v.split('/');
    return p.length === 2 ? (+p[0]) / (+p[1]) : +p[0];
  }
  function align(b: number, mode: 'round' | 'floor' | 'ceil' = 'round'): number {
    const st = stepBeats();
    if (!st) return b;
    const off = S.clipOffset;   // snap relatif awal clip, bukan awal timeline
    return r6(Math[mode]((b + off) / st + 1e-9) * st - off);
  }
  function kind(b: number): number {
    if (near(b / S.bpb)) return 2;
    if (near(b)) return 1;
    return 0;
  }

  /* ---------- Audio ---------- */
  // AudioContext, master, dan routing dipegang audio-engine.ts; pratinjau lewat chain efek + channel milik clip yang sedang diedit (opts.getOutput)
  let ac: AudioContext | null = null;
  function audio(): AudioContext { ac = engine.context(); return ac; }
  function voice(key: number, vel: number, when?: number | null, dur?: number, segs?: { off: number; key: number; dur: number }[]): Voice {
    const sv = opts.playSample?.(key, vel, when, dur, segs); if (sv) return sv;   // vsynth
    const a = audio();
    const t = when == null ? a.currentTime : when;
    const f = 440 * Math.pow(2, (key - 69) / 12);
    const g = a.createGain(), g2 = a.createGain();
    const o1 = a.createOscillator(), o2 = a.createOscillator();
    o1.type = 'triangle'; o2.type = 'sine';
    o1.frequency.value = f; o2.frequency.value = f * 2;
    let fc = f;
    for (const g of segs ?? []) {   // note slide: osilator yang sama terus berbunyi, nadanya meluncur linear dalam semiton (exponential di Hz)
      const fg = 440 * Math.pow(2, (g.key - 69) / 12);
      o1.frequency.setValueAtTime(fc, t + g.off); o1.frequency.exponentialRampToValueAtTime(fg, t + g.off + g.dur);
      o2.frequency.setValueAtTime(fc * 2, t + g.off); o2.frequency.exponentialRampToValueAtTime(fg * 2, t + g.off + g.dur);
      fc = fg;
    }
    g2.gain.value = 0.25;
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(opts.getOutput?.() ?? engine.master());
    o1.onended = () => g.disconnect();
    const peak = 0.21 * Math.max(0.05, vel);   // 0,3 x 0,7: headroom untuk instrumen (master tidak lagi memotong level)
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.008);
    g.gain.setTargetAtTime(peak * 0.6, t + 0.01, 0.25);
    o1.start(t); o2.start(t);
    let stopped = false;
    const release = (te: number): void => {
      g.gain.cancelScheduledValues(te);
      g.gain.setTargetAtTime(0, te, 0.04);
      o1.stop(te + 0.4); o2.stop(te + 0.4);
    };
    const stop = (at?: number): void => {
      if (stopped) return; stopped = true;
      const now = a.currentTime;
      if (at == null && now < t) { try { o1.stop(t); o2.stop(t); } catch { /* abaikan */ } g.disconnect(); return; }   // belum mulai: batalkan tanpa bunyi
      release(Math.max(at == null ? now : at, t + 0.02));
    };
    if (dur != null) release(t + dur);   // jadwal akhir note; stop() manual (Stop / seek) tetap bisa memotong lebih awal
    return { stop, start: t };
  }
  const held = new Map<number, Voice>();
  const flashKeys = new Set<number>();
  const flashTimers = new Set<number>();
  function flash(key: number, vel: number): void {
    voice(key, vel, null, 0.25);
    flashKeys.add(key); invalidate();
    const id = window.setTimeout(() => { flashTimers.delete(id); flashKeys.delete(key); invalidate(); }, 250);
    flashTimers.add(id);
  }
  function pressed(): Set<number> {
    const s = new Set<number>(held.keys());
    flashKeys.forEach(k => s.add(k));
    if (playing) {
      const ph = curBeat();
      for (const n of S.notes) if (ph >= n.beat && ph < n.beat + n.len) s.add(n.key);
    }
    return s;
  }

  /* ---------- Transport ---------- */
  let playing = false, playStartAbs = 0, playT0 = 0, schedAbs = 0, timer: number | null = null, playhead = 0;
  let live: Voice[] = [];
  function curBeat(): number {
    if (!playing) return playhead;
    const abs = playStartAbs + (ac!.currentTime - playT0) * S.bpm / 60;
    return ((abs % S.loopLen) + S.loopLen) % S.loopLen;
  }
  function absNow(): number { return playStartAbs + (ac!.currentTime - playT0) * S.bpm / 60; }
  // Metronom (sama dengan playlist): klik tiap ketukan, aksen di ketukan pertama tiap bar (dihitung dari posisi clip di timeline), keluar ke Master.
  let metroOn = false, metroNext = 0;
  const clicks: { o: OscillatorNode; g: GainNode }[] = [];
  function click(when: number, accent: boolean): void {
    const a = ac!, o = a.createOscillator(), g = a.createGain(), peak = accent ? 0.35 : 0.25;
    o.type = 'sine'; o.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
    o.connect(g); g.connect(engine.master());
    const item = { o, g };
    clicks.push(item);
    o.onended = () => { const i = clicks.indexOf(item); if (i >= 0) clicks.splice(i, 1); o.disconnect(); g.disconnect(); };
    o.start(when); o.stop(when + 0.07);
  }
  function cancelClicks(): void {
    for (const c of clicks.splice(0)) { try { c.o.stop(); } catch { /* sudah berhenti */ } c.o.disconnect(); c.g.disconnect(); }
  }
  function scheduleClicks(B: number): void {
    if (!metroOn) return;
    const bps = S.bpm / 60, now = ac!.currentTime, L = S.loopLen, off = Math.round(S.clipOffset);
    for (; metroNext < B; metroNext++) {
      const when = playT0 + (metroNext - playStartAbs) / bps;
      if (when < now - 0.02) continue;   // sudah lewat
      const pos = ((metroNext % L) + L) % L;
      click(Math.max(when, now), (off + pos) % S.bpb === 0);
    }
  }
  function applyBpm(v: number): void {   // posisi saat ini dipertahankan (dihitung dengan tempo lama), lalu dilanjutkan dengan tempo baru
    const nb = clamp(Math.round(v) || 120, 40, 240);
    bpmEl.value = String(nb);
    if (nb === S.bpm) return;
    const a = playing ? absNow() : 0;
    S.bpm = nb;
    if (playing) { playStartAbs = a; playT0 = ac!.currentTime; schedAbs = a; cancelClicks(); metroNext = Math.ceil(a - 1e-9); live.forEach(x => { if ((x.start ?? 0) > ac!.currentTime) x.stop(); }); live = live.filter(x => (x.start ?? 0) <= ac!.currentTime); }
  }
  function scheduler(): void {
    if (!playing) return;
    const bps = S.bpm / 60;
    const A = schedAbs, B = absNow() + 0.15 * bps;
    scheduleClicks(B);
    if (B <= A) return;
    const L = S.loopLen;
    const k0 = Math.floor(A / L), k1 = Math.floor(B / L);
    const si = slideInfo(S.notes);   // note slide: note slide menempel ke voice yang sedang berbunyi (sampel sama, nada pindah)
    for (let k = k0; k <= k1; k++) {
      for (let i = 0; i < S.notes.length; i++) {
        const n = S.notes[i];
        if (si[i].skip) continue;   // note slide yang menempel: tidak dimainkan sendiri
        const nb = n.beat + k * L;
        if (nb >= A && nb < B) {
          const when = Math.max(playT0 + (nb - playStartAbs) / bps, ac!.currentTime);
          live.push(voice(n.key, n.vel / 255, when, si[i].len / bps, segsToSec(si[i].segs, bps)));
        }
      }
    }
    if (live.length > 200) live = live.slice(-100);
    schedAbs = B;
  }
  function startPlay(): void {
    const a = audio();
    playing = true; playStartAbs = playhead; playT0 = a.currentTime + 0.05; schedAbs = playStartAbs;
    metroNext = Math.ceil(playStartAbs - 1e-9);
    timer = window.setInterval(scheduler, 25); scheduler();
    bPlay.textContent = 'Stop'; bPlay.classList.add('on'); invalidate();
    opts.onTransport?.(true);
  }
  function stopPlay(): void {
    const was = playing;
    playing = false; if (timer != null) clearInterval(timer); timer = null;
    live.forEach(v => v.stop()); live = []; cancelClicks();
    bPlay.textContent = 'Play'; bPlay.classList.remove('on'); invalidate();
    if (was) opts.onTransport?.(false);
  }
  function togglePlay(): void { playing ? stopPlay() : startPlay(); }
  // playhead piano roll hanya berpindah lewat seek (bukan ikut jalan saat play), jadi `playhead` = titik tempat Play terakhir dimulai
  function rewind(): void {
    stopPlay();
    const vb = areaW / pxBeat();
    if (playhead < S.posH || playhead > S.posH + vb) { S.posH = playhead - vb * 0.1; clampView(); }
    invalidate();
  }
  function seekBars(d: number): void {
    const b = clamp((Math.floor(curBeat() / S.bpb + 1e-6) + d) * S.bpb, 0, S.loopLen);   // dalam loop yang diputar
    if (playing) { playStartAbs = b; playT0 = ac!.currentTime; schedAbs = b; live.forEach(v => v.stop()); live = []; cancelClicks(); metroNext = Math.ceil(b - 1e-9); }
    else {
      playhead = b;
      const vb = areaW / pxBeat();
      if (b < S.posH || b > S.posH + vb) { S.posH = b - vb * 0.1; clampView(); }
    }
    invalidate();
  }
  function seekTo(x: number): void {
    const ls = latticeStep();
    const b = clamp(Math.round(xToBeat(x) / ls) * ls, 0, S.clipLen);
    if (playing) { playStartAbs = b; playT0 = ac!.currentTime; schedAbs = b; live.forEach(v => v.stop()); live = []; cancelClicks(); metroNext = Math.ceil(b - 1e-9); }
    else playhead = b;
    invalidate();
  }

  /* ---------- Undo ---------- */
  const undoS: string[] = [], redoS: string[] = [];
  const snapshot = (): string => JSON.stringify(S.notes.map(n => ({ key: n.key, beat: n.beat, len: n.len, vel: n.vel, slide: n.slide ? true : undefined })));
  function updUndo(): void {
    bUndo.disabled = !undoS.length;
    bRedo.disabled = !redoS.length;
    opts.onHistory?.();
  }
  function saveUndo(): void { undoS.push(snapshot()); if (undoS.length > 200) undoS.shift(); redoS.length = 0; updUndo(); }
  function cancelUndo(): void { undoS.pop(); updUndo(); }
  function loadSnap(s: string): void {
    S.notes = (JSON.parse(s) as PRNote[]).map(toN);
    refit();
    resetSel(); updUndo(); invalidate();
  }
  function undo(): void { if (!undoS.length) return; redoS.push(snapshot()); loadSnap(undoS.pop()!); }
  function redo(): void { if (!redoS.length) return; undoS.push(snapshot()); loadSnap(redoS.pop()!); }

  /* ---------- Seleksi ---------- */
  function bound(arr: PRNote[]): Sel {
    const minB = Math.min(...arr.map(n => n.beat));
    const maxE = Math.max(...arr.map(n => n.beat + n.len));
    const minR = Math.min(...arr.map(n => 127 - n.key));
    const maxR = Math.max(...arr.map(n => 127 - n.key));
    return { beat: minB, row: minR, len: maxE - minB, rows: maxR - minR + 1 };
  }
  function resetSel(): void { S.notes.forEach(n => n.sel = false); S.sel = null; S.handles = false; selDrag = null; invalidate(); }
  function selectOnly(n: N): void {
    S.notes.forEach(x => x.sel = false); n.sel = true;
    S.sel = bound([n]); S.handles = true; invalidate();
  }
  const selNotes = (): N[] => S.notes.filter(n => n.sel);
  function refreshSel(): void {
    const a = selNotes();
    if (!a.length) resetSel();
    invalidate();
  }

  /* ---------- Note: koordinat tunggal ---------- */
  function shifted(n: N): { beat: number; row: number; len: number } {
    let beat = n.beat, row = 127 - n.key, len = n.len;
    if (drag && n.sel) {
      if (drag.type === 'move') { beat += drag.dBeat; row += drag.dRow; }
      else if (drag.type === 'resize') { len = Math.max(MINLEN, len + drag.dLen); }
      else if (drag.type === 'stretch') {
        const a = S.sel!.beat;
        beat = a + (beat - a) * drag.scale; len = Math.max(MINLEN, len * drag.scale);
      }
    }
    return { beat, row, len };
  }
  function noteRectPx(n: N): { x: number; y: number; w: number; h: number; s: { beat: number; row: number; len: number } } {
    const s = shifted(n);
    const x0 = Math.round(bx(s.beat)), x1 = Math.round(bx(s.beat + s.len));
    const y0 = Math.round(ry(s.row)), y1 = Math.round(ry(s.row + 1));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, s };
  }
  function selDisp(): Sel | null {
    const s = S.sel; if (!s) return null;
    let { beat, row, len, rows } = s;
    if (drag) {
      if (drag.type === 'move') { beat += drag.dBeat; row += drag.dRow; }
      else if (drag.type === 'resize') len = Math.max(MINLEN, len + drag.dLen);
      else if (drag.type === 'stretch') len = Math.max(MINLEN, len * drag.scale);
    }
    return { beat, row, len, rows };
  }
  function hitNote(x: number, y: number): N | null {
    for (let i = S.notes.length - 1; i >= 0; i--) {
      const n = S.notes[i], r = noteRectPx(n);
      if (x >= r.x && x < r.x + Math.max(r.w, 8 * dpr) && y >= r.y && y < r.y + r.h) return n;
    }
    return null;
  }

  /* ---------- Menggambar ---------- */
  function drawLattice(y: number, h: number): void {
    const ls = latticeStep(), pb = pxBeat();
    const k0 = Math.floor(S.posH / ls), k1 = Math.ceil((S.posH + areaW / pb) / ls);
    ctx.fillStyle = C.lat;
    for (let k = k0; k <= k1; k++) {
      const b = k * ls, x = bx(b), kd = kind(b);
      const w = kd === 2 ? 4 * U : kd === 1 ? 2 * U : U;
      const off = kd === 2 ? 2 * U : U;
      ctx.globalAlpha = C.latA[kd];
      ctx.fillRect(Math.round(x - off), y, w, h);
    }
    ctx.globalAlpha = 1;
  }
  function drawShadow(y: number, h: number): void {
    const x = bx(S.loopLen);
    if (x < areaX + areaW) {
      const x0 = Math.max(areaX, Math.round(x));
      ctx.fillStyle = C.shadow;
      ctx.fillRect(x0, y, areaX + areaW - x0, h);
    }
  }
  // potong teks dengan "…" supaya muat di lebar maxW (font canvas sudah di-set oleh pemanggil)
  function fitText(t: string, maxW: number): string {
    if (ctx.measureText(t).width <= maxW) return t;
    let n = t.length;
    while (n > 1 && ctx.measureText(t.slice(0, n) + '…').width > maxW) n--;
    return t.slice(0, n) + '…';
  }
  function drawClipBox(P: Set<number>): void {
    const rh = rowH();
    const r0 = Math.max(0, Math.floor(S.posV)), r1 = Math.min(127, Math.ceil(S.posV + areaH / rh));
    const cx0 = Math.max(areaX, Math.round(bx(0))), cx1 = Math.min(areaX + areaW, Math.round(bx(S.clipLen)));
    const yEnd = Math.min(areaY + areaH, Math.round(ry(128)));
    if (cx1 > cx0) {
      ctx.fillStyle = C.rb; ctx.fillRect(cx0, areaY, cx1 - cx0, yEnd - areaY);
    }
    const allNames = rh > cell * 0.6, cNames = rh > cell * 0.3;
    ctx.font = Math.round(cell * 0.42) + 'px system-ui,sans-serif';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (let r = r0; r <= r1; r++) {
      const key = 127 - r, y0 = Math.round(ry(r)), y1 = Math.round(ry(r + 1));
      if (cx1 > cx0) {
        if (!isBlack(key)) { ctx.fillStyle = C.rw; ctx.fillRect(cx0, y0, cx1 - cx0, y1 - y0); }
        if (P.has(key)) { ctx.globalAlpha = .1; ctx.fillStyle = S.color; ctx.fillRect(cx0, y0, cx1 - cx0, y1 - y0); ctx.globalAlpha = 1; }
        if (C.rowLine) { ctx.fillStyle = C.rowLine; ctx.fillRect(cx0, y1 - U, cx1 - cx0, U); }
        if (key % 12 === 0) { ctx.fillStyle = C.octLine; ctx.fillRect(cx0, y1 - 2 * U, cx1 - cx0, 2 * U); }
      }
      const isC = key % 12 === 0, lab = opts.getKeyLabel?.(key) ?? null;
      if (lab != null ? cNames : (allNames || (cNames && isC))) {
        ctx.fillStyle = C.rowText;
        const txt = lab ?? (isC ? NAMES[0] + Math.floor(key / 12) : NAMES[key % 12]);
        ctx.fillText(txt, areaX + 11 + V, (y0 + y1) / 2);
      }
    }
    drawLattice(areaY, areaH);
  }
  function drawNotes(): void {
    const ph = playing ? curBeat() : -1;
    const sel = S.notes.filter(n => n.sel);
    bSlide.classList.toggle('on', sel.length ? sel.every(n => n.slide) : S.slideNew);
    const si = S.notes.some(n => n.slide) ? slideInfo(S.notes) : null;
    for (let i = 0; i < S.notes.length; i++) {
      const n = S.notes[i];
      const r = noteRectPx(n);
      if (r.x + r.w < areaX || r.x > areaX + areaW || r.y + r.h < areaY || r.y > areaY + areaH) continue;
      let { x, y, w, h } = r;
      if (y < areaY) { h -= areaY - y; y = areaY; }
      w = Math.max(w, U); h = Math.max(1, h - 2 * U);
      const on = n.sel || (playing && ph >= n.beat && ph < n.beat + n.len);
      const o = C.noteText ? Math.max(1, Math.round(dpr)) : 1;
      ctx.fillStyle = C.noteLine; ctx.fillRect(x - o, y - o, w + 2 * o, h + 2 * o);
      ctx.fillStyle = on ? C.selFill : S.color; ctx.fillRect(x, y, w, h);
      if (C.noteText && w > 14 * dpr && h > 9 * dpr) {
        const key = 127 - Math.round(r.s.row), t = opts.getKeyLabel?.(key) ?? (NAMES[key % 12] + Math.floor(key / 12));
        ctx.font = 'bold ' + Math.round(cell * 0.34) + 'px system-ui,sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        if (ctx.measureText(t).width + 6 * dpr <= w) { ctx.fillStyle = !on && isDarkHex(S.color) ? '#E6E8EE' : C.noteText; ctx.fillText(t, x + 3 * dpr, y + h / 2 + 1); }
      }
      if (n.slide) {   // penanda slide: garis dari nada asal (voice yang sedang berbunyi) ke nada note ini + segitiga di tepi kiri
        const from = si?.[i].skip ? si[i].from : undefined;
        ctx.save();
        ctx.beginPath(); ctx.rect(areaX, areaY, areaW, areaH); ctx.clip();
        ctx.strokeStyle = C.noteLine; ctx.fillStyle = C.noteLine; ctx.lineWidth = Math.max(2, Math.round(2 * dpr)); ctx.lineCap = 'round';
        const yTo = y + h / 2;
        if (from != null && from !== n.key) {
          const yFrom = ry(127 - from) + rowH() / 2;
          ctx.beginPath(); ctx.moveTo(x, yFrom); ctx.lineTo(x + Math.min(w, Math.max(cell * 0.6, 8 * dpr)), yTo); ctx.stroke();
        }
        const tw = Math.min(w, Math.max(5 * dpr, cell * 0.28));
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + tw, yTo); ctx.lineTo(x, y + h); ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
  }
  function drawKeyboard(P: Set<number>): void {
    const rh = rowH();
    const r0 = Math.max(0, Math.floor(S.posV)), r1 = Math.min(127, Math.ceil(S.posV + areaH / rh));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, areaY, kbW, areaH); ctx.clip();
    ctx.fillStyle = C.keyBg; ctx.fillRect(0, areaY, kbW, areaH);
    const x = -11 * U, w = kbW + 10 * U;
    for (let r = r0; r <= r1; r++) {
      const key = 127 - r, y0 = Math.round(ry(r)), y1 = Math.round(ry(r + 1)), h = y1 - y0;
      if (P.has(key)) {
        ctx.fillStyle = C.keySep; ctx.fillRect(x, y0 - 1, w, h + 2);
        ctx.fillStyle = S.color; ctx.fillRect(x, y0, w, h);
      } else if (isBlack(key)) {
        ctx.fillStyle = C.keyB; ctx.fillRect(x, y0, w, h);
      } else {
        ctx.fillStyle = C.keySep; ctx.fillRect(x, y0 - 1, w, h + 2);
        ctx.fillStyle = C.keyW; ctx.fillRect(x, y0, w, h);
      }
    }
    // nama di tuts (mis. nama sample drum): ditulis di dalam tuts supaya kelihatan sample mana di tuts mana
    if (opts.getKeyLabel && rh >= cell * 0.3) {
      ctx.font = 'bold ' + Math.round(Math.min(rh * 0.62, cell * 0.38)) + 'px system-ui,sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const pad = Math.round(4 * dpr), maxW = kbW - pad * 2 - 2 * U;
      for (let r = r0; r <= r1; r++) {
        const key = 127 - r, lab = opts.getKeyLabel(key);
        if (lab == null) continue;
        const y0 = Math.round(ry(r)), y1 = Math.round(ry(r + 1));
        ctx.fillStyle = P.has(key) ? (isDarkHex(S.color) ? '#E6E8EE' : '#1D2226') : isBlack(key) ? '#E6E8EE' : '#1D2226';
        ctx.fillText(fitText(lab, maxW), pad, (y0 + y1) / 2 + 1);
      }
    }
    ctx.restore();
  }
  function drawRuler(): void {
    const pb = pxBeat();
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, 0, areaW, rulerH); ctx.clip();
    ctx.fillStyle = C.rulerBg; ctx.fillRect(areaX, 0, areaW, rulerH);
    const cx = Math.round(bx(0));
    ctx.fillStyle = S.color; ctx.fillRect(cx, 0, 2 * U, Math.round(rulerH * 0.3));
    const sd = selDisp();
    if (sd) {
      const x0 = Math.round(bx(sd.beat)), x1 = Math.round(bx(sd.beat + sd.len));
      ctx.fillStyle = C.rulerSel; ctx.fillRect(x0, 0, Math.max(x1 - x0, 2), rulerH);
    }
    const ls = latticeStep();
    const k0 = Math.floor(S.posH / ls), k1 = Math.ceil((S.posH + areaW / pb) / ls);
    ctx.fillStyle = C.tick;
    for (let k = k0; k <= k1; k++) {
      const b = k * ls, x = bx(b), kd = kind(b);
      const h = Math.round(rulerH * (kd ? 0.3 : 0.2));
      const w = kd === 2 ? 2 * V : V;
      ctx.fillRect(Math.round(x - w / 2), rulerH - h, w, h);
    }
    // nomor bar
    let m = 1; while (S.bpb * m * pb < cell * 1.6) m *= 2;
    const i0 = Math.floor(S.posH / (S.bpb * m)), i1 = Math.ceil((S.posH + areaW / pb) / (S.bpb * m));
    ctx.font = 'bold ' + Math.round(cell * 0.42) + 'px system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = i0; i <= i1; i++) {
      const b = i * S.bpb * m; if (b < 0 || b >= S.clipLen) continue;
      const x = bx(b), ccx = x + 6 * V + U, ccy = rulerH * 0.38;
      ctx.fillStyle = C.circle; ctx.beginPath(); ctx.arc(ccx, ccy, 6 * V, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.circleText; ctx.fillText(String(i * m + 1), ccx, ccy + 1);
    }
    ctx.fillStyle = C.tick; ctx.fillRect(areaX, rulerH - V, areaW, V);
    if (sd) {
      const x0 = Math.round(bx(sd.beat)), x1 = Math.round(bx(sd.beat + sd.len));
      ctx.fillStyle = S.color;
      ctx.fillRect(x0, 0, 2 * U, Math.round(rulerH * 0.5));
      ctx.fillRect(x1 - 2 * U, 0, 2 * U, Math.round(rulerH * 0.5));
    }
    ctx.restore();
  }
  function drawSelBox(b0: number, r0: number, len: number, rows: number): void {
    const x0 = Math.round(bx(b0)), x1 = Math.round(bx(b0 + len));
    const y0 = Math.round(ry(r0)), y1 = Math.round(ry(r0 + rows));
    const w = Math.max(x1 - x0, V * 2), h = y1 - y0;
    ctx.fillStyle = C.selBox; ctx.fillRect(x0, y0, w, h);
    ctx.fillStyle = C.selBorder;
    ctx.fillRect(x0, y0, w, V); ctx.fillRect(x0, y0 + h - V, w, V);
    ctx.fillRect(x0, y0, V, h); ctx.fillRect(x0 + w - V, y0, V, h);
  }
  type HandleKind = 'move' | 'menu' | 'resize' | 'stretch';
  function handlePos(): Record<HandleKind, Pt> {
    const sd = selDisp()!, r = cell * 0.45;
    const x0 = bx(sd.beat), x1 = bx(sd.beat + sd.len), y0 = ry(sd.row), y1 = ry(sd.row + sd.rows);
    const cl = (p: Pt): Pt => ({ x: clamp(p.x, areaX + r, areaX + areaW - r), y: clamp(p.y, areaY + r, areaY + areaH - r) });
    return {
      move: cl({ x: (x0 + x1) / 2, y: y1 + cell * 0.75 }),
      menu: cl({ x: (x0 + x1) / 2, y: y0 - cell * 0.8 }),
      resize: cl({ x: x1 + cell * 0.65, y: (y0 + y1) / 2 }),
      stretch: cl({ x: x1 + cell * 0.65, y: y1 + cell * 0.65 })
    };
  }
  function drawHandle(kindName: HandleKind, p: Pt): void {
    const r = cell * 0.45, a = r * 0.5;
    ctx.fillStyle = C.handleBg; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = C.handleFg; ctx.fillStyle = C.handleFg; ctx.lineWidth = Math.max(2, Math.round(1.5 * dpr)); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    const k3 = 3 * dpr;
    const head = (x: number, y: number, dx: number, dy: number): void => { ctx.moveTo(x - dx * k3 - dy * k3, y - dy * k3 + dx * k3); ctx.lineTo(x, y); ctx.lineTo(x - dx * k3 + dy * k3, y - dy * k3 - dx * k3); };
    if (kindName === 'move') {
      ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y); ctx.moveTo(p.x, p.y - a); ctx.lineTo(p.x, p.y + a);
      head(p.x + a, p.y, 1, 0); head(p.x - a, p.y, -1, 0); head(p.x, p.y + a, 0, 1); head(p.x, p.y - a, 0, -1);
      ctx.stroke();
    } else if (kindName === 'resize') {
      ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y);
      head(p.x + a, p.y, 1, 0); head(p.x - a, p.y, -1, 0);
      ctx.stroke();
    } else if (kindName === 'stretch') {
      ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y);
      ctx.moveTo(p.x - a, p.y - a * .7); ctx.lineTo(p.x - a, p.y + a * .7);
      ctx.moveTo(p.x + a, p.y - a * .7); ctx.lineTo(p.x + a, p.y + a * .7);
      ctx.stroke();
    } else {
      for (const dx of [-a, 0, a]) { ctx.beginPath(); ctx.arc(p.x + dx, p.y, 2 * dpr, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  function drawSelector(): void {
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, areaY, areaW, areaH); ctx.clip();
    if (selDrag) {
      const b0 = Math.min(selDrag.b0, selDrag.b1), b1 = Math.max(selDrag.b0, selDrag.b1);
      const r0 = Math.min(selDrag.r0, selDrag.r1), r1 = Math.max(selDrag.r0, selDrag.r1);
      drawSelBox(b0, r0, Math.max(b1 - b0, 0), r1 - r0 + 1);
    }
    const sd = selDisp();
    if (sd) {
      drawSelBox(sd.beat, sd.row, sd.len, sd.rows);
      if (S.handles) {
        const hp = handlePos();
        drawHandle('menu', hp.menu); drawHandle('move', hp.move);
        drawHandle('resize', hp.resize); drawHandle('stretch', hp.stretch);
      }
    }
    ctx.restore();
  }
  function drawPlayhead(): void {
    const ph = curBeat();
    if (!playing && (ph < 0 || ph > S.loopLen)) return;
    const x = Math.round(bx(ph));
    if (x < areaX || x > areaX + areaW) return;
    const pw = Math.max(U, Math.round(C.playW * V)), h0 = Math.floor(pw / 2);
    ctx.fillStyle = C.playShadow; ctx.fillRect(x - h0 - U, 0, pw + 2 * U, areaY + areaH);
    ctx.fillStyle = C.playhead; ctx.fillRect(x - h0, 0, pw, areaY + areaH);
  }
  function drawVel(): void {
    if (!velOn) return;
    ctx.fillStyle = C.velSep; ctx.fillRect(0, velY - 4 * U, W, velH + 4 * U);
    ctx.fillStyle = S.color; ctx.fillRect(0, velY - 3 * U, W, 2 * U);
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, velY, areaW, velH); ctx.clip();
    ctx.fillStyle = C.velBg; ctx.fillRect(areaX, velY, areaW, velH);
    ctx.fillStyle = C.velLine;
    for (let i = 0; i < 10; i++) ctx.fillRect(areaX, Math.round(velY + i * 0.1 * velH), areaW, U);
    drawLattice(velY, velH);
    drawShadow(velY, velH);
    const bottom = velY + velH;
    for (const pass of [false, true]) {
      for (const n of S.notes) {
        if (n.sel !== pass) continue;
        const s = shifted(n);
        const x = Math.round(bx(s.beat)), w = Math.max(Math.round(s.len * pxBeat()), 4 * U);
        if (x + w < areaX || x > areaX + areaW) continue;
        const top = Math.round(bottom - (n.vel / 255) * velH);
        ctx.fillStyle = n.sel ? C.selFill : S.color;
        ctx.fillRect(x, top, 4 * U, bottom - top);
        ctx.fillRect(x, top, w, 2 * U);
      }
    }
    ctx.restore();
  }
  function drawCorner(): void {
    ctx.fillStyle = C.rulerBg; ctx.fillRect(0, 0, kbW, rulerH);
    const cx = kbW / 2, cy = rulerH / 2, r = Math.min(kbW, rulerH) * 0.38;
    ctx.fillStyle = C.handleBg; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.handleFg;
    if (playing) { const a = r * 0.45; ctx.fillRect(cx - a, cy - a, a * 2, a * 2); }
    else {
      const a = r * 0.5;
      ctx.beginPath(); ctx.moveTo(cx - a * 0.6, cy - a); ctx.lineTo(cx + a, cy); ctx.lineTo(cx - a * 0.6, cy + a); ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = C.tick; ctx.fillRect(0, rulerH - V, kbW, V);
  }
  function draw(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    const P = pressed();
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, areaY, areaW, areaH); ctx.clip();
    drawClipBox(P);
    drawShadow(areaY, areaH);
    drawNotes();
    ctx.restore();
    drawKeyboard(P);
    drawRuler();
    drawSelector();
    drawPlayhead();
    drawVel();
    drawCorner();
  }

  /* ---------- Operasi note ---------- */
  function createNote(beat: number, row: number): void {
    saveUndo();
    const b = clamp(align(beat, 'floor'), 0, S.clipLen - MINLEN);
    const n: N = { key: 127 - row, beat: b, len: Math.min(S.lastLen, S.clipLen - b), vel: Math.round(S.lastVel * 255), ...(S.slideNew ? { slide: true } : {}), sel: false };
    S.notes.push(n);
    flash(n.key, S.lastVel);
    invalidate();
  }
  function deleteSel(): void {
    if (!selNotes().length) return;
    saveUndo();
    S.notes = S.notes.filter(n => !n.sel);
    resetSel();
  }
  // Slide: ada seleksi -> semua note terpilih jadi slide (atau semuanya dimatikan kalau sudah slide semua); tanpa seleksi -> mode "note baru = slide"
  function toggleSlide(): void {
    const a = selNotes();
    if (!a.length) { S.slideNew = !S.slideNew; invalidate(); return; }
    saveUndo();
    const on = !a.every(n => n.slide);
    for (const n of a) { if (on) n.slide = true; else delete n.slide; }
    invalidate(); notify();
  }
  function copySel(): void {
    const a = selNotes(); if (!a.length) return;
    const minB = Math.min(...a.map(n => n.beat));
    setSharedClipboard(a.map(n => ({ key: n.key, beat: r6(n.beat - minB), len: n.len, vel: n.vel, ...(n.slide ? { slide: true } : {}) })));
  }
  function cutSel(): void { if (!selNotes().length) return; copySel(); deleteSel(); }
  // Tempel di posisi `beat`. Batas = panjang maksimum loop (bukan clipLen saat ini), karena area edit melebar sendiri mengikuti isi note;
  // jadi hasil copy yang lebih panjang dari clip tujuan tetap utuh.
  function pasteAt(beat: number): void {
    if (!sharedClipboard.length) return;
    const lim = MAXLEN - BLOCK;
    saveUndo();
    S.notes.forEach(n => n.sel = false);
    const added: N[] = [];
    for (const c of sharedClipboard) {
      const nb = r6(beat + c.beat);
      if (nb >= lim) continue;
      const n: N = { key: clamp(Math.round(c.key), 0, 127), beat: nb, len: Math.min(c.len, lim - nb), vel: c.vel, ...(c.slide ? { slide: true } : {}), sel: true };
      S.notes.push(n); added.push(n);
    }
    if (!added.length) { cancelUndo(); return; }
    refit();
    S.sel = bound(added); S.handles = true; invalidate();
  }
  function duplicateSel(): void {
    const a = selNotes(); if (!a.length || !S.sel) return;
    const l = S.sel.len > 0 ? S.sel.len : 1;
    saveUndo();
    const added: N[] = [];
    for (const n of a) {
      const nb = r6(n.beat + l); n.sel = false;
      if (nb >= S.clipLen) continue;
      const c: N = { key: n.key, beat: nb, len: Math.min(n.len, S.clipLen - nb), vel: n.vel, ...(n.slide ? { slide: true } : {}), sel: true };
      S.notes.push(c); added.push(c);
    }
    if (!added.length) { resetSel(); return; }
    S.sel = { ...S.sel, beat: r6(S.sel.beat + l) }; S.handles = true; invalidate();
  }
  function insertSpace(): void {
    if (!S.sel || S.sel.len <= 0) return;
    saveUndo();
    const s = S.sel.beat, l = S.sel.len;
    for (const n of S.notes) if (n.beat >= s - 1e-9) n.beat = r6(n.beat + l);
    S.notes = S.notes.filter(n => n.beat < S.clipLen);
    S.sel = { ...S.sel, beat: r6(s + l) };
    refreshSel();
  }
  function deleteSpace(): void {
    if (!S.sel || S.sel.len <= 0) return;
    saveUndo();
    const s = S.sel.beat, l = S.sel.len, e = s + l;
    const out: N[] = [];
    for (const n of S.notes) {
      if (n.beat >= e - 1e-9) { n.beat = r6(n.beat - l); out.push(n); }
      else if (n.beat >= s - 1e-9) continue;
      else { if (n.beat + n.len > s) n.len = Math.max(MINLEN, r6(s - n.beat)); out.push(n); }
    }
    S.notes = out;
    resetSel();
  }
  function trimSel(): void {
    if (!S.sel || S.sel.len <= 0) return;
    const s = S.sel.beat, e = s + S.sel.len;
    saveUndo();
    const out: N[] = [];
    for (const n of S.notes) {
      if (!n.sel) { out.push(n); continue; }
      const b0 = Math.max(n.beat, s), b1 = Math.min(n.beat + n.len, e);
      if (b1 - b0 < 1e-6) continue;
      n.beat = r6(b0); n.len = Math.max(MINLEN, r6(b1 - b0)); out.push(n);
    }
    S.notes = out;
    refreshSel();
  }
  function selectAll(): void {
    if (!S.notes.length) return;
    S.notes.forEach(n => n.sel = true);
    S.sel = bound(S.notes); S.handles = true; invalidate();
  }

  /* ---------- Popup ---------- */
  function closePop(): void { pop.style.display = 'none'; }
  // Popup muncul tepat di bawah jari (saat titik tiga ditekan). Di layar sentuh, begitu jari diangkat browser mengirim event "click"
  // ke elemen yang ada di bawah jari = salah satu tombol popup, sehingga popup langsung menutup dan aksinya ikut jalan.
  // Klik yang datang sesaat setelah popup dibuka itu sisa gestur pembukanya, bukan pilihan pengguna, jadi diabaikan.
  const POP_GUARD_MS = 400;
  let popOpenedAt = 0;
  function showPop(x: number, y: number, items: Array<[string, () => void]>, title = 'Note'): void {
    pop.innerHTML = '';
    popOpenedAt = performance.now();
    const head = document.createElement('div');
    head.className = 'prc-pop-head'; head.textContent = title;
    pop.appendChild(head);
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        if (performance.now() - popOpenedAt < POP_GUARD_MS) return;
        closePop(); fn(); notify();
      };
      pop.appendChild(b);
    }
    pop.style.gridTemplateColumns = '';
    pop.style.display = 'flex';
    // layar pendek: tampilkan semua item dengan beberapa kolom, tanpa scroll (display diatur inline supaya closePop tetap bisa menyembunyikan)
    for (let n = 2; n <= 4 && pop.offsetHeight > H / dpr - 8; n++) {
      pop.style.display = 'grid'; pop.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    }
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(x / dpr - pw / 2, 4, W / dpr - pw - 4) + 'px';
    pop.style.top = clamp(y / dpr - ph / 2, 4, H / dpr - ph - 4) + 'px';
  }
  function openMenu(p: Pt): void {
    showPop(p.x, p.y, [
      ['Deselect', resetSel],
      ['Insert space', insertSpace],
      ['Slide on/off', toggleSlide],
      ['Copy', copySel],
      ['Cut', cutSel],
      ['Duplicate', duplicateSel],
      ['Delete', deleteSel],
      ['Delete space', deleteSpace],
      ['Trim selection', trimSel]
    ], 'Note');
  }

  /* ---------- Pointer / gesture ---------- */
  const ptrs = new Map<number, Gs>();
  let pinch: Pinch | null = null;
  const pt = (e: { clientX: number; clientY: number }): Pt => { const r = cv.getBoundingClientRect(); const k = cv.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
  const inArea = (x: number, y: number): boolean => x >= areaX && x < areaX + areaW && y >= areaY && y < areaY + areaH;

  function keyDown(gs: Gs, q: Pt): void {
    const key = 127 - clamp(Math.floor(yToRow(q.y)), 0, 127);
    gs.key = key; gs.vel = clamp(q.x / kbW, 0.05, 1);
    if (held.has(key)) held.get(key)!.stop();
    held.set(key, voice(key, gs.vel)); invalidate();
  }
  function keyMove(gs: Gs, q: Pt): void {
    const key = 127 - clamp(Math.floor(yToRow(q.y)), 0, 127);
    if (key === gs.key) return;
    releaseKey(gs.key!);
    gs.key = key; held.set(key, voice(key, gs.vel!)); invalidate();
  }
  function releaseKey(k: number): void {
    const v = held.get(k); if (v) { v.stop(); held.delete(k); }
    invalidate();
  }

  function velApply(gs: Gs, a: Pt, b: Pt): void {
    const x0 = Math.min(a.x, b.x) - 1, x1 = Math.max(a.x, b.x) + 1;
    const bottom = velY + velH;
    for (const n of S.notes) {
      const nx = bx(n.beat);
      if (nx + 6 * dpr < x0 || nx - 2 * dpr > x1) continue;
      const t = b.x === a.x ? 1 : clamp((nx + 2 - a.x) / (b.x - a.x), 0, 1);
      const y = a.y + (b.y - a.y) * t;
      const frac = clamp((bottom - y) / velH, 1 / 127, 1);
      const v = Math.round(frac * 255);
      if (v !== n.vel) { n.vel = v; gs.changed = true; S.lastVel = v / 255; }
    }
    invalidate();
  }

  function beginDrag(gs: Gs, type: DragType, q: Pt): void {
    saveUndo();
    const sn = selNotes();
    gs.mode = 'drag'; gs.type = type; gs.s0 = { ...S.sel! }; gs.start = q;
    gs.minBeat = Math.min(...sn.map(n => n.beat));
    gs.maxBeat = Math.max(...sn.map(n => n.beat));
    gs.minRow = Math.min(...sn.map(n => 127 - n.key));
    gs.maxRow = Math.max(...sn.map(n => 127 - n.key));
    drag = { type, dBeat: 0, dRow: 0, dLen: 0, scale: 1 };
    invalidate();
  }
  function dragMove(gs: Gs, q: Pt): void {
    const d = drag!;
    const pb = pxBeat(), rh = rowH(), s0 = gs.s0!;
    const dx = q.x - gs.start!.x, dy = q.y - gs.start!.y;
    if (gs.type === 'move') {
      let dB = r6(align(s0.beat + dx / pb) - s0.beat);
      dB = clamp(dB, -gs.minBeat!, S.clipLen - MINLEN - gs.maxBeat!);
      let dR = Math.round(dy / rh);
      dR = clamp(dR, -gs.minRow!, 127 - gs.maxRow!);
      if (dR !== d.dRow) {
        if (gs.pv != null) releaseKey(gs.pv);
        gs.pv = 127 - (s0.row + dR);
        held.set(gs.pv, voice(gs.pv, 0.7));
      }
      d.dBeat = dB; d.dRow = dR;
    } else {
      const end = align(s0.beat + s0.len + dx / pb);
      const newLen = Math.max(MINLEN, end - s0.beat);
      if (gs.type === 'resize') d.dLen = r6(newLen - s0.len);
      else d.scale = clamp(newLen / Math.max(s0.len, MINLEN), 0.2, 10);
    }
    invalidate();
  }
  function commitDrag(gs: Gs): void {
    const d = drag!; drag = null;
    if (gs.pv != null) { releaseKey(gs.pv); gs.pv = null; }
    const changed = d.dBeat || d.dRow || d.dLen || d.scale !== 1;
    if (!changed) { cancelUndo(); invalidate(); return; }
    const a = S.sel!.beat;
    for (const n of S.notes) {
      if (!n.sel) continue;
      if (d.type === 'move') { n.beat = r6(Math.max(0, n.beat + d.dBeat)); n.key -= d.dRow; }
      else if (d.type === 'resize') n.len = Math.max(MINLEN, r6(n.len + d.dLen));
      else { n.beat = r6(a + (n.beat - a) * d.scale); n.len = Math.max(MINLEN, r6(n.len * d.scale)); }
    }
    if (d.type === 'move') S.sel = { ...S.sel!, beat: r6(S.sel!.beat + d.dBeat), row: S.sel!.row + d.dRow };
    else if (d.type === 'resize') { S.sel = { ...S.sel!, len: Math.max(MINLEN, r6(S.sel!.len + d.dLen)) }; S.lastLen = selNotes()[0].len; }
    else { S.sel = { ...S.sel!, len: Math.max(MINLEN, r6(S.sel!.len * d.scale)) }; S.lastLen = selNotes()[0].len; }
    invalidate();
  }

  function beginSelect(gs: Gs): void {
    gs.mode = 'select';
    const b = clamp(align(xToBeat(gs.sx)), 0, S.clipLen);
    const r = clamp(Math.floor(yToRow(gs.sy)), 0, 127);
    gs.b0 = b; gs.r0 = r;
    selDrag = { b0: b, r0: r, b1: b, r1: r };
    S.notes.forEach(n => n.sel = false); S.sel = null; S.handles = false;
    invalidate();
  }
  function finishSelect(gs: Gs, q: Pt): void {
    const moved = Math.hypot(q.x - gs.sx, q.y - gs.sy) > 6 * dpr;
    const sd = selDrag; selDrag = null;
    if (!moved || !sd) {
      resetSel();
      if (sharedClipboard.length) {
        const beat = align(xToBeat(q.x), 'floor');
        showPop(q.x, q.y - cell, [['Paste', () => pasteAt(clamp(beat, 0, S.clipLen))]], 'Piano roll');
      }
      return;
    }
    const b0 = Math.min(sd.b0, sd.b1), b1 = Math.max(sd.b0, sd.b1);
    const r0 = Math.min(sd.r0, sd.r1), r1 = Math.max(sd.r0, sd.r1);
    let any = false;
    for (const n of S.notes) {
      const row = 127 - n.key;
      const inT = (b1 - b0 < 1e-6) ? (n.beat <= b0 && n.beat + n.len > b0) : (n.beat < b1 && n.beat + n.len > b0);
      n.sel = inT && row >= r0 && row <= r1;
      if (n.sel) any = true;
    }
    if (!any) { resetSel(); return; }
    S.sel = { beat: b0, row: r0, len: b1 - b0, rows: r1 - r0 + 1 };
    S.handles = true; invalidate();
  }

  function handleTap(q: Pt): void {
    const beat = xToBeat(q.x), row = Math.floor(yToRow(q.y));
    if (row < 0 || row > 127 || beat < 0 || beat >= S.clipLen) { if (S.sel) resetSel(); return; }
    const hit = hitNote(q.x, q.y);
    if (hit) { selectOnly(hit); return; }
    if (S.sel && S.handles) { resetSel(); return; }
    createNote(beat, row);
  }

  function startPinch(a: Gs, b: Gs): void {
    clearTimeout(a.timer); selDrag = null;
    a.mode = 'pinch'; b.mode = 'pinch';
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pinch = {
      a, b, dx0: Math.abs(a.x - b.x), dy0: Math.abs(a.y - b.y),
      zH0: S.zH, zV0: S.zV, mb: xToBeat(mx), mr: yToRow(my)
    };
  }
  function doPinch(): void {
    const { a, b } = pinch!;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    if (pinch!.dx0 >= 30 * dpr) S.zH = clamp(pinch!.zH0 * dx / pinch!.dx0, ZHMIN, ZHMAX);
    if (pinch!.dy0 >= 30 * dpr) S.zV = clamp(pinch!.zV0 * dy / pinch!.dy0, ZVMIN, ZVMAX);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.posH = pinch!.mb - (mx - areaX) / pxBeat();
    S.posV = pinch!.mr - (my - areaY) / rowH();
    clampView(); syncZoomUI(); invalidate();
  }

  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    // klik kanan mouse di area note: menu Paste di titik itu (sama seperti klik-tahan di layar sentuh)
    if (e.pointerType === 'mouse' && e.button === 2) {
      closePop();
      const rq = pt(e);
      if (inArea(rq.x, rq.y) && sharedClipboard.length) {
        const beat = clamp(align(xToBeat(rq.x), 'floor'), 0, S.clipLen);
        showPop(rq.x, rq.y - cell, [['Paste', () => pasteAt(beat)]], 'Piano roll');
      }
      return;
    }
    cv.setPointerCapture(e.pointerId);
    closePop(); inertia = null; audio();
    const q = pt(e);
    const gs: Gs = { id: e.pointerId, x: q.x, y: q.y, sx: q.x, sy: q.y, t: performance.now(), mode: 'none', vx: 0, vy: 0 };
    if (ptrs.size === 1 && inArea(q.x, q.y)) {
      const o = [...ptrs.values()][0];
      if (['pending', 'pan', 'select'].includes(o.mode)) { ptrs.set(gs.id, gs); startPinch(o, gs); return; }
    }
    ptrs.set(gs.id, gs);
    if (ptrs.size > 1) { gs.mode = 'dead'; return; }

    if (q.x < kbW && q.y < rulerH) { gs.mode = 'corner'; togglePlay(); return; }
    if (q.y < rulerH) { gs.mode = 'ruler'; seekTo(q.x); return; }
    if (q.x < kbW && q.y < areaY + areaH) { gs.mode = 'key'; keyDown(gs, q); return; }
    if (velOn && q.y >= velY && q.x >= areaX) {
      gs.mode = 'vel'; saveUndo(); gs.changed = false; gs.last = q; velApply(gs, q, q); return;
    }
    if (!inArea(q.x, q.y)) { gs.mode = 'dead'; return; }
    if (S.sel && S.handles) {
      const hp = handlePos();
      for (const k of ['menu', 'move', 'resize', 'stretch'] as HandleKind[]) {
        const p = hp[k];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= cell * 0.6) {
          if (k === 'menu') { gs.mode = 'dead'; openMenu(p); } else beginDrag(gs, k, q);
          return;
        }
      }
    }
    const hit = hitNote(q.x, q.y);
    if (hit && hit.sel && S.sel) { beginDrag(gs, 'move', q); return; }
    gs.mode = 'pending';
    gs.timer = window.setTimeout(() => { if (gs.mode === 'pending') beginSelect(gs); }, 200);
  });

  cv.addEventListener('pointermove', e => {
    const gs = ptrs.get(e.pointerId); if (!gs) return;
    const q = pt(e);
    const now = performance.now();
    const px = gs.x, py = gs.y, pt0 = gs.lastT || gs.t;
    gs.x = q.x; gs.y = q.y;
    switch (gs.mode) {
      case 'pinch': doPinch(); break;
      case 'ruler': seekTo(q.x); break;
      case 'key': keyMove(gs, q); break;
      case 'vel': velApply(gs, gs.last!, q); gs.last = q; break;
      case 'drag': dragMove(gs, q); break;
      case 'select':
        selDrag!.b1 = clamp(align(xToBeat(q.x)), 0, S.clipLen);
        selDrag!.r1 = clamp(Math.floor(yToRow(q.y)), 0, 127);
        invalidate(); break;
      case 'pending':
        if (Math.hypot(q.x - gs.sx, q.y - gs.sy) > 6 * dpr) {
          clearTimeout(gs.timer);
          gs.mode = 'pan'; gs.p0 = { x: q.x, y: q.y, h: S.posH, v: S.posV }; gs.vx = 0; gs.vy = 0;
        }
        break;
      case 'pan': {
        S.posH = gs.p0!.h - (q.x - gs.p0!.x) / pxBeat();
        S.posV = gs.p0!.v - (q.y - gs.p0!.y) / rowH();
        const dt = Math.max(1, now - pt0);
        gs.vx = 0.8 * ((q.x - px) / dt) + 0.2 * gs.vx;
        gs.vy = 0.8 * ((q.y - py) / dt) + 0.2 * gs.vy;
        gs.lastT = now;
        clampView(); syncZoomUI(); invalidate(); break;
      }
    }
  });

  function endPointer(e: PointerEvent): void {
    const gs = ptrs.get(e.pointerId); if (!gs) return;
    ptrs.delete(e.pointerId);
    clearTimeout(gs.timer);
    const q = pt(e);
    switch (gs.mode) {
      case 'pending': handleTap(q); break;
      case 'select': finishSelect(gs, q); break;
      case 'pan':
        if (performance.now() - (gs.lastT || 0) < 60 && Math.hypot(gs.vx, gs.vy) > 0.05) inertia = { vx: gs.vx, vy: gs.vy };
        break;
      case 'key': releaseKey(gs.key!); break;
      case 'vel':
        if (!gs.changed) cancelUndo();
        break;
      case 'drag': commitDrag(gs); break;
      case 'pinch':
        pinch = null;
        for (const o of ptrs.values()) if (o.mode === 'pinch') o.mode = 'dead';
        break;
    }
    invalidate();
    notify();
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('contextmenu', e => e.preventDefault());

  /* ---------- Zoom / scroll ---------- */
  function syncZoomUI(): void {
    zhEl.value = String(toPos(S.zH, ZHMIN, ZHMAX));
    zvEl.value = String(toPos(S.zV, ZVMIN, ZVMAX));
  }
  function zoomAt(axis: 'h' | 'v', f: number, ax: number, ay: number): void {
    if (axis === 'h') {
      const b = xToBeat(ax); S.zH = clamp(S.zH * f, ZHMIN, ZHMAX);
      S.posH = b - (ax - areaX) / pxBeat();
    } else {
      const r = yToRow(ay); S.zV = clamp(S.zV * f, ZVMIN, ZVMAX);
      S.posV = r - (ay - areaY) / rowH();
    }
    clampView(); syncZoomUI(); invalidate();
  }
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const q = pt(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.altKey ? 'v' : 'h', f, q.x, q.y);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      S.posH += (e.deltaX || e.deltaY) * dpr / pxBeat(); clampView(); invalidate();
    } else {
      S.posV += e.deltaY * dpr / rowH(); clampView(); invalidate();
    }
  }, { passive: false });
  zhEl.addEventListener('input', () => {
    const b = xToBeat(areaX + areaW / 2);
    S.zH = fromPos(+zhEl.value, ZHMIN, ZHMAX);
    S.posH = b - (areaW / 2) / pxBeat(); clampView(); invalidate();
  });
  zvEl.addEventListener('input', () => {
    const r = yToRow(areaY + areaH / 2);
    S.zV = fromPos(+zvEl.value, ZVMIN, ZVMAX);
    S.posV = r - (areaH / 2) / rowH(); clampView(); invalidate();
  });

  /* ---------- Toolbar & keyboard ---------- */
  function setTheme(name: 'light' | 'dark'): void {
    C = THEMES[name];
    for (const k in C.css) root.style.setProperty(k, C.css[k]);
    themeEl.value = name;
    invalidate();
  }
  function setColor(c: string): void {
    S.color = c;
    root.style.setProperty('--note', c);
    if ([...colorEl.options].some(o => o.value === c)) colorEl.value = c;
    invalidate();
  }
  themeEl.addEventListener('change', () => setTheme(themeEl.value as 'light' | 'dark'));
  bPlay.onclick = togglePlay;
  bpmEl.addEventListener('input', () => applyBpm(+bpmEl.value));
  colorEl.addEventListener('change', () => setColor(colorEl.value));
  uiEl.addEventListener('change', () => { uiScale = +uiEl.value; layout(); });
  snapSel.addEventListener('change', invalidate);
  bSlide.onclick = toggleSlide;
  bVel.onclick = () => { velOn = !velOn; bVel.classList.toggle('on', velOn); layout(); };
  bUndo.onclick = () => { undo(); notify(); };
  bRedo.onclick = () => { redo(); notify(); };
  bClear.onclick = () => { if (!S.notes.length) return; saveUndo(); S.notes = []; resetSel(); notify(); };

  const onKey = (e: KeyboardEvent): void => {
    const t = (e.target as HTMLElement | null)?.tagName;
    if (t === 'INPUT' || t === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
    else if (k === 'escape') { resetSel(); closePop(); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
    else if (mod && k === 'c') { e.preventDefault(); copySel(); }
    else if (mod && k === 'x') { e.preventDefault(); cutSel(); }
    else if (mod && k === 'v') { e.preventDefault(); pasteAt(clamp(align(S.posH, 'ceil'), 0, S.clipLen)); }
    notify();
  };
  window.addEventListener('keydown', onKey);

  /* ---------- Loop render ---------- */
  let lastT = 0, raf = 0, dead = false;
  function frame(t: number): void {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, t - lastT); lastT = t;
    if (inertia) {
      S.posH -= inertia.vx * dt / pxBeat();
      S.posV -= inertia.vy * dt / rowH();
      const f = Math.pow(0.95, dt / 16.7);
      inertia.vx *= f; inertia.vy *= f;
      if (Math.hypot(inertia.vx, inertia.vy) < 0.02) inertia = null;
      clampView(); syncZoomUI(); dirty = true;
    }
    if (dirty || playing) { dirty = false; draw(); }
  }

  /* ---------- Posisi awal saat dibuka ---------- */
  // Ada note: scroll ke baris nada tertinggi + 2 dan ke beat note pertama. Kosong: ke MIDI 70 di beat 0. Zoom dikembalikan ke bawaan.
  function setInitialView(): void {
    S.zH = 4; S.zV = 0.75;
    if (S.notes.length) {
      const hi = Math.max(...S.notes.map(n => n.key));
      S.posV = 127 - Math.min(127, hi + 2);
      S.posH = Math.min(...S.notes.map(n => n.beat));
    } else { S.posV = 127 - 70; S.posH = 0; }
    clampView(); syncZoomUI(); invalidate();
  }

  /* ---------- Init ---------- */
  S.notes = (opts.notes ?? []).map(toN);
  refit();
  lastSnap = sig();
  setInitialView();
  bpmEl.value = String(S.bpm);
  setTheme(opts.theme ?? 'light');
  setColor(S.color);
  syncZoomUI(); updUndo();
  resize();
  raf = requestAnimationFrame(frame);

  /* ---------- Handle ---------- */
  return {
    destroy(): void {
      dead = true;
      cancelAnimationFrame(raf);
      stopPlay();
      held.forEach(v => v.stop()); held.clear();
      flashTimers.forEach(id => clearTimeout(id)); flashTimers.clear();
      for (const g of ptrs.values()) clearTimeout(g.timer);
      ptrs.clear();
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      ac = null;   // AudioContext milik engine bersama: jangan ditutup di sini
      root.remove();
    },
    getNotes(): PRNote[] { return S.notes.map(n => ({ key: n.key, beat: n.beat, len: n.len, vel: n.vel, ...(n.slide ? { slide: true } : {}) })); },
    setNotes(notes: PRNote[]): void {
      S.notes = notes.map(toN);
      refit();
      lastSnap = sig();
      undoS.length = 0; redoS.length = 0; updUndo();
      resetSel(); setInitialView();
    },
    resize,
    setClipOffset(beats: number): void { S.clipOffset = beats; invalidate(); },
    setClipLen(beats: number): void { S.minLoop = Math.max(BLOCK, Math.ceil(beats / BLOCK) * BLOCK); refit(); invalidate(); },
    setColor(c: string): void { setColor(c); },
    stop(): void { stopPlay(); },
    togglePlay,
    rewind,
    seekBars,
    isPlaying: () => playing,
    undo: () => { undo(); notify(); }, redo: () => { redo(); notify(); }, canUndo: () => undoS.length > 0, canRedo: () => redoS.length > 0,
    setBpm: applyBpm,
    setMetronome(on: boolean): void {
      metroOn = on;
      if (!on) cancelClicks(); else if (playing) metroNext = Math.ceil(absNow() - 1e-9);
    },
    refresh(): void { invalidate(); },
    focusKey(key: number): void { S.posV = 127 - Math.min(127, key + 2); clampView(); invalidate(); }
  };
}
