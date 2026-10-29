// Playlist / timeline berbasis canvas, pola yang sama dengan piano-roll-canvas.ts.
// Mengikuti hasil bedah CTracksEditor FL Studio Mobile 3.4.5: baris track + celah 1 px, lattice 3 tingkat adaptif,
// clip dengan outline/halo clip aktif, mini note berskala rentang nada, loop 2^k bar dengan segitiga (+ fade ubin non-kursor),
// tanpa header track di kiri, tap kosong = tombol "+Clip",
// double-tap = buka editor, menu region (Insert space / Delete space / Trim), copy/paste, mute, zoom+scroll ikut tersimpan.
// Semua state ada di dalam closure mountPlaylist(), jadi bisa dipasang lebih dari satu instance dan dibersihkan lewat destroy().
// Audio lewat audio-engine.ts: tiap clip -> chain efek pattern -> strip channel track -> master.

import { engine } from './audio-engine';
import { buildPyramid, getPeaks, type Pyramid } from './waveform';
import { clampPitch, pitchRatio, createPitchCache } from './pitch';
import { slideInfo, segsToSec, type SlideSeg } from './slide';
import { TRACK_COLORS } from './ui-util';
import './playlist-canvas.css';

export interface PLNote { key: number; beat: number; len: number; vel?: number; slide?: boolean; }   // beat relatif awal clip, vel 1..255
export type PLTrackKind = 'instrument' | 'audio';
export interface PLTrack { id: number; name: string; color: string; kind?: PLTrackKind; }
// id = file di panel browser, dur = durasi file (detik), off = awal potongan (detik, dalam waktu file)
// pitch = geser nada dalam semitone bulat (-24..24, default 0); sync = false: varispeed (durasi ikut berubah), true: nada digeser tanpa mengubah durasi (dirender dulu, lihat pitch.ts)
// rev = diputar terbalik; off = posisi awal di buffer yang diputar (buffer terbalik kalau rev aktif)
// fi / fo = fade in / fade out (dalam ketukan, dihitung dari awal / ujung clip; default 0 = tanpa fade): volume naik linear (tanjakan) / turun linear (turunan)
// vol = volume clip 0..1 (1 = level asli file = default, tidak disimpan): knob Volume di tab Sample, berlaku real-time
// bpm = tempo acuan mode Auto (sync): tempo project saat Auto dinyalakan. Tempo project berubah -> audio di-time-stretch sebesar bpm / tempo baru supaya clip tetap pas di ketukan yang sama (nada tidak berubah)
export interface PLAudio { id: string; dur: number; off?: number; pitch?: number; sync?: boolean; bpm?: number; rev?: boolean; fi?: number; fo?: number; vol?: number; }
export interface PLClip { id?: number; track: number; beat: number; len: number; name: string; notes?: PLNote[]; muted?: boolean; audio?: PLAudio; }
export interface PLView { posH: number; posV: number; zH: number; zV: number; }   // zoom/scroll ikut tersimpan di song
export interface PlaylistState { tracks: PLTrack[]; clips: PLClip[]; view?: PLView; bpm?: number; }
export interface PlaylistCanvasOpts {
  tracks?: PLTrack[];
  clips?: PLClip[];
  songLen?: number;            // panjang lagu minimum (ketukan), default 64
  bpm?: number;                // default 120
  theme?: 'light' | 'dark';    // default 'dark'
  title?: string;              // judul lagu (belum ditampilkan; header track sudah dihapus)
  onOpenClip?: (clip: PLClip & { id: number }) => void;   // double-tap pada clip (buka piano roll)
  onChange?: () => void;       // dipanggil setiap data track/clip berubah
  getAudioBlob?: (fileId: string) => Promise<Blob | null>;   // ambil isi file audio dari panel browser (untuk diputar dan digambar)
  onSelectClip?: (clipId: number | null) => void;   // clip yang dipilih berubah (null = tidak ada clip terpilih)
  onTransport?: (playing: boolean) => void;   // dipanggil saat play/stop
  onHistory?: () => void;      // riwayat undo / redo berubah (tombol Undo / Redo di bilah bawah ikut aktif / mati)
  onPitchUpdate?: () => void;  // render pitch (mode Auto) maju / selesai: panel Pitch menyegarkan tampilannya
  playSample?: (clipId: number, key: number, vel: number, when: number | null | undefined, dur: number | undefined, segs?: { off: number; key: number; dur: number }[]) => Voice | null;   // clip instrumen yang memakai vsynth: suara sampel, bukan oscillator bawaan (null = pakai oscillator)
}
export interface PitchTarget { id: number; name: string; pitch: number; auto: boolean; busy: boolean; rev: boolean; progress: number | null; len: number; fadeIn: number; fadeOut: number; vol: number; }
export interface PlaylistCanvasHandle {
  destroy(): void;
  getState(): PlaylistState;
  getSelTrack(): number;       // id track yang sedang dipilih (ringan; dipakai keyboard komputer untuk membunyikan instrumen track itu)
  getTracks(): PLTrack[];      // hanya daftar track (ringan, tanpa menyalin clip); dipakai mixer
  setTrackColor(trackId: number, color: string): void;   // ganti warna satu track: semua clip di track itu (juga yang terpecah-pecah) ikut; satu langkah Undo
  getBpm(): number;
  getClipsInfo(): { id: number; name: string; track: number; audio: boolean }[];   // daftar clip ringan (tanpa note); dipakai panel efek
  setState(s: PlaylistState): void;
  setClipNotes(clipId: number, notes: PLNote[]): void;
  getPitchTarget(): PitchTarget | null;        // clip audio terpilih yang diatur panel Pitch (null kalau tidak ada)
  setClipPitch(st: number): void;              // geser nada clip terpilih (semitone bulat)
  setClipAuto(on: boolean): void;              // Auto: clip ikut tempo project (time-stretch otomatis) dan pitch tidak mengubah kecepatan
  setClipReverse(on: boolean): void;           // putar clip terbalik
  setClipFade(kind: 'in' | 'out', beats: number, live?: boolean): void;   // fade in / out clip audio terpilih (ketukan; 0 = mati); live = bagian dari seretan knob (satu entri undo untuk satu seretan)
  endClipFade(): void;   // seretan knob fade selesai
  setClipVolume(v: number, live?: boolean): void;   // volume clip terpilih 0..1 (1 = level asli); live = dipanggil terus selama knob diseret
  endClipVolume(): void;   // seretan knob volume selesai
  addAudioClip(fileId: string, name: string, clientX: number, clientY: number): Promise<boolean>;   // jatuhkan file audio di posisi layar; false kalau di luar playlist
  resize(): void;
  stop(): void;
  setBpm(bpm: number): void;   // tempo project (40..240); ikut tersimpan di file project
  setMetronome(on: boolean): void;   // klik tiap ketukan saat playlist berjalan (aksen di ketukan pertama tiap bar)
  randomizeTrackColors(): void;      // Playlist Setting: acak warna SEMUA track (palet TRACK_COLORS, sebisa mungkin tanpa kembar); satu langkah Undo
  applyTrackGradient(top: string, bottom: string): void;   // Playlist Setting: warna track dari atas (warna atas) ke bawah (warna bawah) berurutan, dicampur rata; satu langkah Undo
  togglePlay(): void;          // play / stop playhead (dipakai tombol Play di bilah bawah)
  rewind(): void;              // stop (kalau sedang play) dan kembalikan playhead ke titik tempat Play terakhir dimulai
  seekBars(d: number): void;   // tombol Maju di bilah bawah: loncat d bar (ke garis bar berikutnya / sebelumnya); saat play, suara ikut pindah
  isPlaying(): boolean;
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean;   // riwayat playlist (dipakai tombol Undo / Redo di bilah bawah)
}

interface TR extends PLTrack { kind: PLTrackKind; disp: number; tgt: number; }
interface CL { id: number; track: number; beat: number; len: number; name: string; notes: PLNote[]; sel: boolean; muted: boolean; audio?: PLAudio; }
interface Sel { beat: number; row: number; len: number; rows: number; }
interface Pt { x: number; y: number; }
type DragType = 'move' | 'resize' | 'resizeL';   // resizeL = tarik tepi kiri clip (awal clip bergeser, ujung kanan tetap)
interface Drag { type: DragType; dBeat: number; dRow: number; dLen: number; }
interface SelDrag { b0: number; r0: number; b1: number; r1: number; }
// aud = penanda suara clip audio (awal absolut, panjang, offset file) supaya perubahan panjang clip saat play bisa mengenali suara yang sudah berjalan
interface AEv { id: string; off: number; st: number; sync: boolean; rev: boolean; rate: number; str: number; fi: number; fo: number; vol: number; }   // rate = file-detik per detik timeline (varispeed: 2^(st/12); Auto: 1 / str); str = faktor time-stretch Auto (acuan bpm / bpm project, 1 kalau Auto mati)
interface AudMeta { clip: number; start: number; len: number; off: number; st: number; sync: boolean; str: number; rev: boolean; fi: number; fo: number; vol: number; fb?: boolean; }   // fb = suara cadangan (varispeed) selama hasil stretch belum siap
interface Voice { stop(at?: number): void; start?: number; aud?: AudMeta; setVol?(v: number): void; }   // setVol = ubah volume clip yang sedang berbunyi (tanpa menjadwalkan ulang)
interface Ev { key: number; beat: number; len: number; vel: number; trk: number; clip: number; a?: AEv; segs?: SlideSeg[]; }   // a = clip audio
interface ClipItem { row: number; beat: number; len: number; name: string; notes: PLNote[]; muted: boolean; audio?: PLAudio; }
interface Gs {
  id: number; x: number; y: number; sx: number; sy: number; t: number; mode: string;
  vx: number; vy: number; timer?: number; lastT?: number; p0?: { x: number; y: number; h: number; v: number };
  type?: DragType; s0?: Sel; start?: Pt; minBeat?: number; maxBeat?: number; minRow?: number; maxRow?: number;
  kMin?: number; kMax?: number;   // batas geser tepi kiri (ketukan) untuk resizeL
  row?: number; held?: boolean; trk?: TR; row0?: number; dropIdx?: number; moved?: boolean; off?: number;
}
interface Pinch { a: Gs; b: Gs; dx0: number; dy0: number; zH0: number; zV0: number; mb: number; mr: number; }

/* ---------- Token ---------- */
interface Theme {
  bg: string; rb: string; rw: string; rule: string; light: string;
  lat: string; latA: [number, number, number]; clipLine: string; shadow: string;
  rulerBg: string; tick: string; circle: string; circleText: string;
  selBorder: string; selBox: string; handleBg: string; handleFg: string;
  playhead: string; playShadow: string; playW: number;
  abl: boolean;   // gaya clip solid: seluruh clip satu warna channel, nama di atas, note berupa garis tipis
  css: Record<string, string>;
}
const THEMES: Record<'dark' | 'light', Theme> = {
  dark: {   // abu-abu kebiruan, clip warna solid dibatasi garis lurus, playhead tipis
    bg: '#2A2D34', rb: '#34373E', rw: '#3A3E46', rule: '#1D2226', light: '#C5C8D1',
    lat: '#1D2226', latA: [.3, .45, .75], clipLine: 'rgba(14,16,20,.8)', shadow: 'rgba(0,0,0,.18)',
    rulerBg: '#2F3239', tick: '#6B7079', circle: '#8C939B', circleText: '#2A2D34',
    selBorder: '#E2E5EA', selBox: 'rgba(226,229,234,.18)', handleBg: '#C5C8D1', handleFg: '#2A2D34',
    playhead: '#C5C8D1', playShadow: 'rgba(42,45,52,.5)', playW: 1, abl: true,
    css: { '--bg-dark': '#2A2D34', '--row-black': '#34373E', '--row-white': '#3A3E46', '--rule': '#1D2226', '--light': '#C5C8D1' }
  },
  light: {
    bg: '#B4B4B4', rb: '#B1B1B1', rw: '#C9C9C9', rule: '#8A8A8A', light: '#222222',
    lat: '#000000', latA: [.08, .15, .35], clipLine: 'rgba(0,0,0,.35)', shadow: 'rgba(0,0,0,.12)',
    rulerBg: '#D2D2D2', tick: '#7C7C7C', circle: '#2A2A2A', circleText: '#F1F1F1',
    selBorder: '#2A2A2A', selBox: 'rgba(0,0,0,.12)', handleBg: '#2A2A2A', handleFg: '#F1F1F1',
    playhead: '#1A1A1A', playShadow: 'rgba(255,255,255,.35)', playW: 1, abl: false,
    css: { '--bg-dark': '#D2D2D2', '--row-black': '#C2C2C2', '--row-white': '#B4B4B4', '--rule': '#9A9A9A', '--light': '#222222' }
  }
};
const NOTE_INK = '#0E1014';   // warna note mini di dalam clip (hitam, tidak mengikuti warna track)
const MINLEN = 0.25;
const MINW = 3;                    // lebar clip minimum (px, kelipatan U)
const U = 1;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const near = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
// batas zoom dalam satuan "cell": px/beat 1/12..100 cell (2..2400 px bila cell 24), tinggi baris 2..4,17 cell
const ZHMIN = 1 / 12, ZHMAX = 100, ZVMIN = 2, ZVMAX = 1 / 0.24;
function tint(hex: string, t: number): string {   // campur warna ke putih (t 0..1)
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number): number => Math.round(v + (255 - v) * t);
  return `rgb(${c(n >> 16 & 255)},${c(n >> 8 & 255)},${c(n & 255)})`;
}
function ink(hex: string): string {   // warna nama & note di atas clip: gelap di warna terang, terang di warna gelap
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.45 ? darken(hex, 0.28) : tint(hex, 0.62);
}
const CORNER_CELLS = 1.5;   // lebar tombol play di pojok kiri ruler
const toPos = (v: number, mn: number, mx: number): number => Math.round(100 * Math.log(v / mn) / Math.log(mx / mn));
const fromPos = (p: number, mn: number, mx: number): number => mn * Math.pow(mx / mn, p / 100);

function darken(hex: string, k: number): string {   // warna channel x 0,65 untuk isi clip
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number): number => Math.round(clamp(v * k, 0, 255));
  return `rgb(${c(n >> 16 & 255)},${c(n >> 8 & 255)},${c(n & 255)})`;
}

const TEMPLATE = `
<div class="plc-bar">
  <button data-r="play">Play</button>
  <label>BPM <input data-r="bpm" type="number" min="40" max="240" value="120"></label>
  <label>Snap
    <select data-r="snap">
      <option value="auto">Otomatis</option>
      <option value="off">Tanpa snap</option>
      <option value="1/4">1/4 Beat</option>
      <option value="1/2">1/2 Beat</option>
      <option value="1">1 Beat</option>
      <option value="4">1 Bar</option>
    </select>
  </label>
  <label>Tema
    <select data-r="theme">
      <option value="dark">Gelap (FLM)</option>
      <option value="light">Terang</option>
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
  <button data-r="addtrack">+ Track</button>
  <button data-r="paste">Paste</button>
  <button data-r="undo">Undo</button>
  <button data-r="redo">Redo</button>
  <span class="plc-hint">Tap baris: pilih &middot; Tap lagi: tombol +Clip &middot; Double-tap clip: buka editor &middot; Tahan 0,2 dtk: seleksi &middot; Ctrl+C/X/V: salin/potong/tempel</span>
</div>
<div class="plc-stage">
  <canvas class="plc-cv"></canvas>
  <button class="plc-add" data-r="add">+Clip</button>
  <button class="plc-addtrack" data-r="addtrack2" aria-label="Tambah track">+</button>
  <div class="plc-pop"></div>
</div>`;

// palet warna track (20) ada di ui-util.ts supaya mixer ikut memakainya; diekspor ulang di sini
export { TRACK_COLORS };

// contoh: 4 track, beberapa clip dengan pola note
export function demoState(): PlaylistState {
  const tracks: PLTrack[] = [
    { id: 1, name: 'Kick', color: '#FE32CF' }, { id: 2, name: 'Chords', color: '#9741A2' },
    { id: 3, name: 'Lead', color: '#2D4793' }, { id: 4, name: 'Bass', color: '#C32862' }
  ];
  const chords = [[60, 63, 67], [56, 60, 63], [63, 67, 70], [58, 62, 65]];
  const chordNotes: PLNote[] = [];
  chords.forEach((ch, bar) => ch.forEach(k => chordNotes.push({ key: k, beat: bar * 4, len: 4, vel: 170 })));
  const lead: PLNote[] = [];
  for (let i = 0; i < 16; i++) lead.push({ key: 72 + [0, 3, 7, 10][i % 4] + (i % 8 > 3 ? 2 : 0), beat: i * 0.5, len: 0.5, vel: 190 });
  const kick: PLNote[] = [0, 1, 2, 3].map(b => ({ key: 36, beat: b, len: 0.25, vel: 230 }));
  const bass: PLNote[] = [0, 4, 8, 12].map((b, i) => ({ key: [36, 32, 39, 34][i], beat: b, len: 3.5, vel: 200 }));
  return {
    tracks,
    clips: [
      { track: 1, beat: 0, len: 32, name: 'Kick', notes: kick },
      { track: 2, beat: 0, len: 16, name: 'Chords A', notes: chordNotes },
      { track: 2, beat: 16, len: 16, name: 'Chords A', notes: chordNotes },
      { track: 3, beat: 8, len: 8, name: 'Lead', notes: lead },
      { track: 3, beat: 24, len: 8, name: 'Lead', notes: lead },
      { track: 4, beat: 0, len: 32, name: 'Bass', notes: bass }
    ]
  };
}

export function mountPlaylist(host: HTMLElement, opts: PlaylistCanvasOpts = {}): PlaylistCanvasHandle {
  const root = document.createElement('div');
  root.className = 'plc';
  root.innerHTML = TEMPLATE;
  host.appendChild(root);

  const $ = <T extends HTMLElement>(r: string): T => root.querySelector<T>(`[data-r="${r}"]`)!;
  const cv = root.querySelector<HTMLCanvasElement>('.plc-cv')!;
  const ctx = cv.getContext('2d')!;
  const stage = root.querySelector<HTMLElement>('.plc-stage')!;
  const pop = root.querySelector<HTMLElement>('.plc-pop')!;
  const bPlay = $<HTMLButtonElement>('play'), bAddTrack = $<HTMLButtonElement>('addtrack');
  const bUndo = $<HTMLButtonElement>('undo'), bRedo = $<HTMLButtonElement>('redo'), bAdd = $<HTMLButtonElement>('add');
  const bPaste = $<HTMLButtonElement>('paste');
  const snapSel = $<HTMLSelectElement>('snap'), themeEl = $<HTMLSelectElement>('theme');
  const uiEl = $<HTMLSelectElement>('ui'), bpmEl = $<HTMLInputElement>('bpm');
  const zhEl = $<HTMLInputElement>('zh'), zvEl = $<HTMLInputElement>('zv');

  let C: Theme = THEMES.dark;

  /* ---------- State ---------- */
  let nextClipId = 1, nextTrackId = 1;
  const S = {
    tracks: [] as TR[], clips: [] as CL[], len: opts.songLen ?? 64, spb: 4, bpb: 4, bpm: opts.bpm ?? 120,
    zH: 4, zV: 2.08, posH: 0, posV: 0,
    lastLen: 4, selTrack: 0, cur: 0,                 // cur = id clip aktif (0 = tidak ada)
    sel: null as Sel | null, handles: false,
  };
  let drag: Drag | null = null;
  let selDrag: SelDrag | null = null;
  let inertia: { vx: number; vy: number } | null = null;
  let dirty = true, evDirty = true;
  let addAt: { beat: number; row: number } | null = null;
  let lastTap: { id: number; t: number } | null = null;
  let tapBeat = -1;                                   // beat yang terakhir di-tap (posisi paste + ubin loop yang disorot)
  let clipboard: { items: ClipItem[]; len: number } | null = null;
  const invalidate = (): void => { dirty = true; notifySel(); };
  const touch = (): void => { evDirty = true; dirty = true; opts.onChange?.(); notifySel(); };
  // beri tahu pemakai kalau clip utama yang terpilih berganti (dipakai panel efek per pattern)
  let lastSelId: number | null | undefined;
  function notifySel(): void {
    const c = S.clips.find(x => x.sel && x.id === S.cur) ?? S.clips.find(x => x.sel);
    const id = c ? c.id : null;
    if (id === lastSelId) return;
    lastSelId = id;
    opts.onSelectClip?.(id);
  }

  let W = 0, H = 0, dpr = 1, cell = 24, V = 2, uiScale = 1;
  let hdrW = 0, rulerH = 0, areaX = 0, areaY = 0, areaW = 0, areaH = 0;

  const trackIdx = (id: number): number => S.tracks.findIndex(t => t.id === id);
  const trackById = (id: number): TR | undefined => S.tracks.find(t => t.id === id);
  const toTR = (t: PLTrack, i: number): TR => ({ id: t.id, name: t.name, color: t.color, kind: t.kind === 'audio' ? 'audio' : 'instrument', disp: i, tgt: i });
  const toCL = (c: PLClip): CL => ({ id: c.id ?? nextClipId++, track: c.track, beat: c.beat, len: c.len, name: c.name,
    notes: (c.notes ?? []).map(n => ({ ...n })), sel: false, muted: !!c.muted, audio: c.audio ? { ...c.audio } : undefined });
  function loadState(s: PlaylistState): void {
    S.tracks = s.tracks.map(toTR);
    for (const c of s.clips) if (c.audio) void ensureAudio(c.audio.id).then(() => { for (const x of S.clips) if (x.audio?.sync) prewarm(x); });
    nextTrackId = Math.max(0, ...s.tracks.map(t => t.id)) + 1;
    nextClipId = Math.max(0, ...s.clips.map(c => c.id ?? 0)) + 1;
    S.clips = s.clips.filter(c => s.tracks.some(t => t.id === c.track)).map(toCL);
    S.selTrack = S.tracks.length ? S.tracks[0].id : 0;
    S.bpm = clamp(Math.round(s.bpm ?? opts.bpm ?? 120), 40, 240); bpmEl.value = String(S.bpm);
    for (const c of S.clips) if (c.audio?.sync && !(Number(c.audio.bpm) > 0)) c.audio.bpm = S.bpm;   // project lama: clip Auto belum punya tempo acuan -> pakai tempo tersimpan (tidak ada perubahan bunyi)
    S.cur = 0; S.sel = null; S.handles = false; tapBeat = -1;
    if (s.view) { S.posH = s.view.posH; S.posV = s.view.posV; S.zH = s.view.zH; S.zV = s.view.zV; }
  }
  const songLen = (): number => {
    const mx = Math.max(0, ...S.clips.map(c => c.beat + c.len));
    return Math.max(S.len, Math.ceil(mx / S.bpb) * S.bpb);
  };

  /* ---------- Tata letak ---------- */
  function layout(): void {
    cell = Math.max(16, Math.round(24 * uiScale * dpr));
    V = Math.max(1, Math.round(cell / 16));
    hdrW = 0;   // tanpa header track di kiri
    rulerH = Math.round(cell * 1.5);
    areaX = hdrW; areaY = rulerH; areaW = Math.max(10, W - hdrW);
    areaH = Math.max(10, H - rulerH);
    clampView(); invalidate();
  }
  const pxBeat = (): number => S.zH * cell;
  const rowH = (): number => S.zV * cell;
  const bx = (b: number): number => areaX + (b - S.posH) * pxBeat();
  const ry = (r: number): number => areaY + (r - S.posV) * rowH();
  const xToBeat = (x: number): number => (x - areaX) / pxBeat() + S.posH;
  const yToRow = (y: number): number => (y - areaY) / rowH() + S.posV;

  function clampView(): void {
    S.zH = clamp(S.zH, ZHMIN, ZHMAX); S.zV = clamp(S.zV, ZVMIN, ZVMAX);
    const rows = S.tracks.length + 1, vr = areaH / rowH();
    S.posV = clamp(S.posV, 0, Math.max(0, rows + 0.5 - vr));
    const vb = areaW / pxBeat();
    S.posH = clamp(S.posH, 0, Math.max(0, songLen() - vb * 0.25));
  }

  function resize(): void {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    const nw = Math.max(50, Math.round(r.width * dpr)), nh = Math.max(50, Math.round(r.height * dpr));
    if (nw === cv.width && nh === cv.height && dpr === lastDpr) return;   // ukuran sama: jangan hapus canvas
    lastDpr = dpr;
    cv.width = nw; cv.height = nh;   // mengubah ukuran menghapus isi canvas
    W = cv.width; H = cv.height;
    layout();
    if (!dead) { dirty = false; draw(); }   // gambar ulang sekarang juga (sebelum frame tampil), kalau tidak satu frame kosong = berkedip
  }
  let lastDpr = 0;
  const ro = new ResizeObserver(resize);
  ro.observe(stage);

  /* ---------- Snap & lattice ---------- */
  function latticeStep(): number {   // langkah digandakan selama lebar pikselnya < 0,6 cell
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
    return r6(Math[mode](b / st + 1e-9) * st);
  }
  function kind(b: number): number {
    if (near(b / S.bpb)) return 2;
    if (near(b)) return 1;
    return 0;
  }
  function loopPeriod(c: CL): number {   // kelipatan 4 bar terkecil (min 4 bar) yang >= panjang alami isi clip; sama dengan panjang loop di piano roll
    const blk = S.bpb * 4, nat = c.notes.length ? Math.max(...c.notes.map(n => n.beat + n.len)) : blk;
    return Math.max(blk, Math.ceil(nat / blk - 1e-9) * blk);
  }

  /* ---------- Audio ---------- */
  // AudioContext, master, dan routing dipegang audio-engine.ts (dipakai bersama piano roll, mixer, dan panel efek)
  let ac: AudioContext | null = null;
  function audio(): AudioContext { ac = engine.context(); return ac; }
  function voice(key: number, vel: number, when?: number | null, dur?: number, clip?: number, segs?: { off: number; key: number; dur: number }[]): Voice {
    if (clip != null) { const sv = opts.playSample?.(clip, key, vel, when, dur, segs); if (sv) return sv; }   // vsynth
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
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(clip != null ? engine.pattern(clip) : engine.master());
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

  /* ---------- Clip audio: decode file, gelombang, suara ---------- */
  interface AudioEntry { buf: AudioBuffer | null; pyr: Pyramid | null; loading: Promise<void> | null; rev: AudioBuffer | null; rpyr: Pyramid | null; rbuild: boolean; }   // rev / rpyr = versi terbalik (dibuat saat dibutuhkan)
  const bufs = new Map<string, AudioEntry>();
  function ensureAudio(id: string): Promise<void> {
    let e = bufs.get(id);
    if (e?.buf) return Promise.resolve();
    if (e?.loading) return e.loading;
    if (!e) { e = { buf: null, pyr: null, loading: null, rev: null, rpyr: null, rbuild: false }; bufs.set(id, e); }
    const entry = e;
    entry.loading = (async () => {
      try {
        const blob = await opts.getAudioBlob?.(id);
        if (!blob) return;
        const data = await blob.arrayBuffer();
        const buf = await audio().decodeAudioData(data);
        entry.buf = buf;   // bisa langsung diputar; piramid peak dibangun bertahap di belakang (tidak menahan UI)
        void buildPyramid(buf).then(p => { entry.pyr = p; invalidate(); }).catch(() => { /* waveform gagal: clip tetap bisa diputar */ });
        invalidate();
      } catch { /* file tidak bisa di-decode: clip tetap ada tanpa gelombang / suara */ }
      finally { entry.loading = null; }
    })();
    return entry.loading;
  }
  // Pitch clip audio (hasil bedah FL Studio Mobile; detail di pitch.ts):
  //  - sync mati  : varispeed, playbackRate = 2^(semitone/12); durasi ikut berubah
  //  - sync aktif : buffer dirender offline (stretch x pitch lalu resample), di-cache dengan kunci (file, stretch, pitch), diputar normal
  const pitchOf = (a?: PLAudio): number => { const v = Number(a?.pitch); return Number.isFinite(v) ? clampPitch(v) : 0; };
  // Auto (sync): stretch = tempo acuan clip / tempo project sekarang (>1 = diperlambat, <1 = dipercepat), jadi isi clip tetap pas di ketukan yang sama
  const strOf = (a?: PLAudio): number => {
    if (!a || !a.sync) return 1;
    const ref = Number(a.bpm);
    return ref > 0 && Number.isFinite(ref) ? ref / S.bpm : 1;
  };
  const rateOf = (a?: PLAudio): number => (!a ? 1 : a.sync ? 1 / strOf(a) : pitchRatio(pitchOf(a)));   // file-detik per detik timeline (waveform, offset, split)
  const needsRender = (a?: PLAudio): boolean => !!a && !!a.sync && (pitchOf(a) !== 0 || Math.abs(strOf(a) - 1) > 1e-6);
  // fade in / out efektif (ketukan): tidak boleh melebihi panjang clip, dan keduanya tidak saling tumpang tindih
  const fadeOf = (a: PLAudio | undefined, len: number): { fi: number; fo: number } => {
    const fi = Math.max(0, Math.min(Number(a?.fi) || 0, len)), fo = Math.max(0, Math.min(Number(a?.fo) || 0, len - fi));
    return { fi, fo };
  };
  const volOf = (a?: PLAudio): number => { const v = Number(a?.vol); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1; };   // volume clip 0..1, kosong = 1 (level asli)
  const aEv = (a: PLAudio, len: number): AEv => ({ id: a.id, off: a.off ?? 0, st: pitchOf(a), sync: !!a.sync, rev: !!a.rev, rate: rateOf(a), str: strOf(a), vol: volOf(a), ...fadeOf(a, len) });
  // versi terbalik dari file (dibuat sekali, di-cache di entri). Cache pitch memakai kunci terpisah untuk versi terbalik.
  function reversedOf(e: AudioEntry): AudioBuffer | null {
    if (!e.buf) return null;
    if (e.rev) return e.rev;
    const b = e.buf, out = audio().createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c).slice(); d.reverse(); out.copyToChannel(d as Float32Array<ArrayBuffer>, c); }
    return (e.rev = out);
  }
  const pkey = (id: string, rev?: boolean): string => (rev ? id + '~r' : id);
  let pUiQueued = false;   // kemajuan render datang sangat sering: segarkan panel paling banyak sekali per frame
  const pitchUi = (): void => { if (pUiQueued) return; pUiQueued = true; requestAnimationFrame(() => { pUiQueued = false; opts.onPitchUpdate?.(); }); };
  const pcache = createPitchCache(() => { evDirty = true; dirty = true; opts.onPitchUpdate?.(); }, undefined, pitchUi);   // render selesai: jadwalkan ulang suara yang tadinya diam   // render selesai: jadwalkan ulang suara yang tadinya diam
  function prewarm(c: CL): void {   // mulai render lebih awal (saat pitch / sync diubah atau project dibuka) supaya siap sebelum diputar
    const a = c.audio, e = a && bufs.get(a.id);
    const src = a && e ? (a.rev ? reversedOf(e) : e.buf) : null;
    if (a && src && needsRender(a)) pcache.get(pkey(a.id, a.rev), src, audio(), strOf(a), pitchOf(a));
  }
  const pitchBusy = (a?: PLAudio): boolean => !!a && needsRender(a) && pcache.busy(pkey(a.id, a.rev), strOf(a), pitchOf(a));
  const pitchProgress = (a?: PLAudio): number | null => (a && needsRender(a) ? pcache.progress(pkey(a.id, a.rev), strOf(a), pitchOf(a)) : null);
  // Tempo baru diketik / diklik beruntun: render stretch baru ditunda sampai tempo "mengendap" (SETTLE ms), selama itu clip Auto
  // diputar dengan suara cadangan (varispeed, tetap di ketukan yang benar) supaya tidak diam dan tidak merender tiap angka perantara.
  const SETTLE = 350;
  let settleUntil = 0, settleTimer = 0;
  const settling = (): boolean => performance.now() < settleUntil;
  // hasil stretch / pitch clip Auto siap dipakai (memulai render bila belum ada, kecuali masih menunggu tempo mengendap)
  function renderReady(id: string, rev: boolean, str: number, st: number): boolean {
    const e = bufs.get(id), src = e && (rev ? reversedOf(e) : e.buf);
    return !!src && !settling() && !!pcache.get(pkey(id, rev), src, audio(), str, st);
  }
  function audioVoice(ev: AEv, off: number, when: number, dur: number, clip: number, aud?: AudMeta, p0 = 0, T = dur + p0): Voice {   // p0 = posisi awal di dalam clip (detik timeline, > 0 kalau mulai dari tengah), T = panjang penuh clip (detik)
    const entry = bufs.get(ev.id), base = entry?.buf ? (ev.rev ? reversedOf(entry) : entry.buf) : null;
    if (!base) return { stop() { /* belum siap */ } };
    // buf = buffer yang diputar; rate = playbackRate; boff = posisi awal di buf (detik buf).
    // Auto + stretch/pitch: buffer hasil render (durasi = file x str), diputar normal, posisi file x str. Selain itu: file asli dengan laju ev.rate.
    let buf = base, rate = ev.rate, boff = off, fb = false;
    if (ev.sync && (ev.str !== 1 || ev.st !== 0)) {
      const r = settling() ? null : pcache.get(pkey(ev.id, ev.rev), base, audio(), ev.str, ev.st);
      if (r) { buf = r; rate = 1; boff = off * ev.str; }
      else if (ev.str !== 1) fb = true;   // tempo berubah, hasil belum siap: file asli dibaca pada laju 1 / str (varispeed) -> tetap di ketukan, nada sementara ikut tempo
      else return { stop() { /* masih dirender: diam dulu, dijadwalkan ulang begitu selesai */ } };
    }
    if (aud) aud.fb = fb;
    if (boff >= buf.duration) return { stop() { /* di luar ujung file */ } };
    const a = audio(), src = a.createBufferSource(), g = a.createGain(), vg = a.createGain();   // g = envelope fade, vg = volume clip (terpisah supaya knob Volume berlaku real-time)
    src.buffer = buf;
    src.playbackRate.value = rate;
    vg.gain.value = ev.vol;
    src.connect(g); g.connect(vg); vg.connect(engine.pattern(clip));
    src.onended = () => { g.disconnect(); vg.disconnect(); };
    // level asli file (unity, seperti pratinjau di panel browser); fade pendek di awal dan akhir supaya tidak ada klik
    // len = detik timeline; sisa file (detik file) dibagi laju baca. Argumen durasi start() dalam detik file, jadi dikali laju lagi.
    const len = Math.min(dur, (buf.duration - boff) / rate), end = when + len, ci = Math.min(0.004, len / 2), co = Math.min(0.008, len / 2);
    // envelope clip: fade in = tanjakan linear 0 -> 1, fade out = turunan linear 1 -> 0 (posisi dihitung dalam waktu clip, jadi mulai dari tengah pun benar)
    const bps = S.bpm / 60, fiS = ev.fi / bps, foS = ev.fo / bps;
    const gAt = (t: number): number => Math.max(0, Math.min(1, fiS > 0 ? t / fiS : 1, foS > 0 ? (T - t) / foS : 1));
    let last = when + ci;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gAt(p0 + ci), last);
    for (const tb of [fiS, T - foS]) {   // titik patah envelope (akhir fade in, awal fade out)
      const t = when + (tb - p0);
      if (tb > p0 && t > last + 1e-6 && t < end - co - 1e-6) { g.gain.linearRampToValueAtTime(gAt(tb), t); last = t; }
    }
    if (end - co > last + 1e-6) g.gain.linearRampToValueAtTime(gAt(p0 + len - co), end - co);
    g.gain.linearRampToValueAtTime(0, end);
    src.start(when, boff, len * rate);
    let stopped = false;
    return { stop(at?: number): void {
      if (stopped) return; stopped = true;
      if (at == null && a.currentTime < when) { try { src.stop(when); } catch { /* abaikan */ } g.disconnect(); vg.disconnect(); return; }   // belum mulai: batalkan tanpa bunyi
      const te = Math.max(at == null ? a.currentTime : at, when);
      if (typeof g.gain.cancelAndHoldAtTime === 'function') g.gain.cancelAndHoldAtTime(te); else g.gain.cancelScheduledValues(te);   // tahan level di tengah fade, jangan melompat
      g.gain.setTargetAtTime(0, te, 0.008);   // berhenti dengan fade, bukan dipotong keras
      try { src.stop(te + 0.06); } catch { /* sudah berhenti */ }
    }, setVol(v: number): void { vg.gain.setTargetAtTime(v, a.currentTime, 0.015); }, start: when, aud };
  }
  const audioOf = (c: CL): AudioEntry | undefined => (c.audio ? bufs.get(c.audio.id) : undefined);

  /* ---------- Transport ---------- */
  let events: Ev[] = [];
  function compile(): void {   // ratakan semua clip (termasuk pengulangan loop) jadi daftar note absolut; clip mute dilewati
    events = [];
    for (const c of S.clips) {
      if (c.audio && !c.muted) { events.push({ key: -1, beat: c.beat, len: c.len, vel: 0.8, trk: c.track, clip: c.id, a: aEv(c.audio, c.len) }); continue; }
      if (!c.notes.length || c.muted) continue;
      const per = loopPeriod(c), si = slideInfo(c.notes.map(n => ({ key: n.key, beat: n.beat, len: n.len, slide: n.slide })));   // note slide
      for (let t = 0; t < c.len - 1e-9; t += per) {
        for (let i = 0; i < c.notes.length; i++) {
          const n = c.notes[i], b = t + n.beat;
          if (si[i].skip || b >= c.len - 1e-9) continue;   // note slide yang menempel ke voice lain tidak dimainkan sendiri
          events.push({ key: n.key, beat: c.beat + b, len: Math.min(si[i].len, c.len - b), vel: (n.vel ?? 180) / 255, trk: c.track, clip: c.id, segs: si[i].segs });
        }
      }
    }
    evDirty = false;
  }
  let playing = false, playStartAbs = 0, playT0 = 0, schedAbs = 0, timer: number | null = null, playhead = 0;
  let returnTo = 0;   // titik awal play: tap penggaris saat play mengembalikan playhead ke sini lalu stop
  // Lookahead dalam: note dijadwalkan ke AudioContext (thread audio) 1 detik lebih awal, jadi UI yang berat / GC tidak membuat audio patah
  // (padanan ULTRASAFE: audio tidak bergantung pada thread UI). Perubahan clip saat play dijadwalkan ulang di scheduler().
  const LOOKAHEAD = 1.0;
  let live: Voice[] = [];
  function curBeat(): number {
    if (!playing) return playhead;
    const L = songLen();
    return ((absNow() % L) + L) % L;
  }
  function absNow(): number { return playStartAbs + (ac!.currentTime - playT0) * S.bpm / 60; }
  // Metronom: klik pendek tiap ketukan (aksen di ketukan pertama tiap bar), dijadwalkan ke AudioContext bersama lookahead seperti note, keluar ke Master.
  // metroNext = ketukan bulat berikutnya yang belum dijadwalkan; direset tiap kali garis waktu berubah (play / seek / ganti BPM).
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
  function cancelClicks(): void {   // klik yang sudah dijadwalkan tapi belum (selesai) berbunyi dibatalkan
    for (const c of clicks.splice(0)) { try { c.o.stop(); } catch { /* sudah berhenti */ } c.o.disconnect(); c.g.disconnect(); }
  }
  function scheduleClicks(B: number): void {
    if (!metroOn) return;
    const bps = S.bpm / 60, now = ac!.currentTime;
    for (; metroNext < B; metroNext++) {
      const when = playT0 + (metroNext - playStartAbs) / bps;
      if (when < now - 0.02) continue;   // sudah lewat
      click(Math.max(when, now), metroNext % S.bpb === 0);
    }
  }
  // ganti tempo: posisi saat ini dipertahankan (dihitung dengan tempo lama), lalu garis waktu dilanjutkan dengan tempo baru
  function applyBpm(v: number): void {
    const nb = clamp(Math.round(v) || 120, 40, 240);
    bpmEl.value = String(nb);
    if (nb === S.bpm) return;
    const a = playing ? absNow() : 0;
    S.bpm = nb;
    if (S.clips.some(c => c.audio?.sync && c.audio.bpm !== nb)) {   // ada clip Auto yang harus di-stretch: tunggu tempo mengendap, lalu render + jadwalkan ulang
      settleUntil = performance.now() + SETTLE;
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => { for (const c of S.clips) if (c.audio?.sync) prewarm(c); evDirty = true; dirty = true; opts.onPitchUpdate?.(); }, SETTLE + 20);
    }
    if (playing) { playStartAbs = a; playT0 = ac!.currentTime; schedAbs = a; cancelClicks(); metroNext = Math.ceil(a - 1e-9); }
    touch();   // evDirty: jadwal note / audio dihitung ulang dengan tempo baru; panel lain (vsynth) ikut disiapkan ulang
  }
  function scheduler(): void {
    if (!playing) return;
    const bps = S.bpm / 60, L = songLen();
    if (evDirty) {
      compile();
      // clip / note diubah saat play: batalkan suara yang sudah dijadwalkan tapi belum mulai, lalu jadwalkan ulang dari sekarang
      if (schedAbs > playStartAbs + 1e-9) {
        const tNow = ac!.currentTime;
        live = live.filter(v => { if ((v.start ?? 0) > tNow) { v.stop(); return false; } return true; });
        schedAbs = Math.max(playStartAbs, playStartAbs + (tNow - playT0) * bps);
      }
      syncRunningAudio();
    }
    const A = schedAbs, B = absNow() + LOOKAHEAD * bps;
    scheduleClicks(B);
    if (B <= A) return;
    const k0 = Math.floor(A / L), k1 = Math.floor(B / L);
    for (let k = k0; k <= k1; k++) {
      for (const e of events) {
        const nb = e.beat + k * L;
        if (nb >= A && nb < B) {
          const when = Math.max(playT0 + (nb - playStartAbs) / bps, ac!.currentTime);
          live.push(e.a ? audioVoice(e.a, e.a.off, when, e.len / bps, e.clip, { clip: e.clip, start: nb, len: e.len, off: e.a.off, st: e.a.st, sync: e.a.sync, str: e.a.str, rev: e.a.rev, fi: e.a.fi, fo: e.a.fo, vol: e.a.vol }) : voice(e.key, e.vel, when, e.len / bps, e.clip, segsToSec(e.segs, bps)));
        }
      }
    }
    if (live.length > 2000) live = live.slice(-1000);
    schedAbs = B;
  }
  function startMidAudio(abs: number, skip?: Set<number>): void {   // clip audio yang sedang berjalan di posisi abs: mulai dari tengah file
    if (evDirty) compile();
    const bps = S.bpm / 60, L = songLen(), pos = ((abs % L) + L) % L, k = Math.floor(abs / L);
    for (const e of events) {
      if (e.a && e.beat < pos - 1e-9 && e.beat + e.len > pos + 1e-9 && !skip?.has(e.clip)) {
        live.push(audioVoice(e.a, e.a.off + (pos - e.beat) / bps * e.a.rate, Math.max(playT0, ac!.currentTime), (e.beat + e.len - pos) / bps, e.clip,
          { clip: e.clip, start: e.beat + k * L, len: e.len, off: e.a.off, st: e.a.st, sync: e.a.sync, str: e.a.str, rev: e.a.rev, fi: e.a.fi, fo: e.a.fo, vol: e.a.vol }, (pos - e.beat) / bps, e.len / bps));
      }
    }
  }
  // Clip audio diubah saat play (dipendekkan / dipanjangkan / dimute / dihapus / digeser): suara yang SUDAH berjalan tidak ikut berubah
  // karena sudah dijadwalkan ke AudioContext dengan panjang lamanya, jadi tetap berbunyi sampai ujung lama. Di sini suara yang
  // pengaturannya berbeda dari clip sekarang dihentikan, lalu clip yang masih melewati playhead dimulai ulang dari tengah file
  // dengan panjang terbaru (berhenti tepat di ujung baru). Suara yang tidak berubah dibiarkan supaya tidak ada klik.
  function syncRunningAudio(): void {
    const abs = absNow(), keep = new Set<number>();
    live = live.filter(v => {
      const m = v.aud; if (!m) return true;
      if (m.start + m.len <= abs + 1e-6) return false;              // sudah selesai dengan sendirinya
      const e = events.find(x => x.a && x.clip === m.clip);
      const same = !!e && !!e.a && Math.abs(e.len - m.len) < 1e-6 && Math.abs(e.a.off - m.off) < 1e-9 && e.a.st === m.st && e.a.sync === m.sync && Math.abs(e.a.str - m.str) < 1e-9 && e.a.rev === m.rev && Math.abs(e.a.fi - m.fi) < 1e-9 && Math.abs(e.a.fo - m.fo) < 1e-9
        && !(m.fb && renderReady(e.a.id, e.a.rev, e.a.str, e.a.st))   // suara cadangan diganti hasil stretch begitu siap
        && Math.abs((e.beat + Math.floor(m.start / songLen() + 1e-9) * songLen()) - m.start) < 1e-6;
      if (same) {   // hanya volume yang berubah: langsung ke suara yang berbunyi, tanpa memulai ulang
        const nv = e?.a?.vol;
        if (nv != null && Math.abs(nv - m.vol) > 1e-9) { v.setVol?.(nv); m.vol = nv; }
        keep.add(m.clip); return true;
      }
      v.stop(); return false;
    });
    startMidAudio(abs, keep);
  }
  function startPlay(): void {
    const a = audio();
    playing = true; playStartAbs = playhead; playT0 = a.currentTime + 0.05; schedAbs = playStartAbs; returnTo = playhead;
    startMidAudio(playStartAbs);
    metroNext = Math.ceil(playStartAbs - 1e-9);
    timer = window.setInterval(scheduler, 50); scheduler();
    bPlay.textContent = 'Stop'; bPlay.classList.add('on'); invalidate();
    opts.onTransport?.(true);
  }
  function stopPlay(): void {
    const was = playing;
    if (playing) playhead = curBeat();
    playing = false; if (timer != null) clearInterval(timer); timer = null;
    live.forEach(v => v.stop()); live = []; cancelClicks();
    bPlay.textContent = 'Play'; bPlay.classList.remove('on'); invalidate();
    if (was) opts.onTransport?.(false);
  }
  function togglePlay(): void { playing ? stopPlay() : startPlay(); }
  function seekTo(x: number): number {
    const ls = latticeStep();
    const b = clamp(Math.round(xToBeat(x) / ls) * ls, 0, songLen());
    if (playing) { playStartAbs = b; playT0 = ac!.currentTime; schedAbs = b; live.forEach(v => v.stop()); live = []; cancelClicks(); metroNext = Math.ceil(b - 1e-9); startMidAudio(b); }
    else playhead = b;
    invalidate();
    return b;
  }
  // tombol Maju / Mundur di bilah bawah: pindah ke garis bar berikutnya (d > 0) / sebelumnya (d < 0); layar digulung bila titik itu keluar tampilan
  function seekBars(d: number): void {
    const b = clamp((Math.floor(curBeat() / S.bpb + 1e-6) + d) * S.bpb, 0, songLen());
    if (playing) { playStartAbs = b; playT0 = ac!.currentTime; schedAbs = b; live.forEach(v => v.stop()); live = []; cancelClicks(); metroNext = Math.ceil(b - 1e-9); startMidAudio(b); }
    else {
      playhead = b;
      const vb = areaW / pxBeat();
      if (b < S.posH || b > S.posH + vb) { S.posH = b - (cell * CORNER_CELLS / 2) / pxBeat(); clampView(); syncZoomUI(); }
    }
    invalidate();
  }
  // tap penggaris saat play: berhenti (bukan play) dan playhead kembali ke titik awal play; layar digulung bila titik itu di luar tampilan
  function stopAndReturn(): void {
    stopPlay();
    playhead = returnTo;
    const vb = areaW / pxBeat();
    if (playhead < S.posH || playhead > S.posH + vb) {
      S.posH = playhead - (cell * CORNER_CELLS / 2) / pxBeat(); clampView(); syncZoomUI();
    }
    invalidate();
  }

  /* ---------- Undo ---------- */
  const undoS: string[] = [], redoS: string[] = [];
  const snapshot = (): string => JSON.stringify({
    tracks: S.tracks.map(t => ({ id: t.id, name: t.name, color: t.color, kind: t.kind })),
    clips: S.clips.map(c => ({ id: c.id, track: c.track, beat: c.beat, len: c.len, name: c.name, notes: c.notes, muted: c.muted, audio: c.audio })),
    selTrack: S.selTrack
  });
  function updUndo(): void { bUndo.disabled = !undoS.length; bRedo.disabled = !redoS.length; opts.onHistory?.(); }
  function saveUndo(): void { undoS.push(snapshot()); if (undoS.length > 200) undoS.shift(); redoS.length = 0; updUndo(); }
  function cancelUndo(): void { undoS.pop(); updUndo(); }
  function loadSnap(s: string): void {
    const o = JSON.parse(s) as PlaylistState & { selTrack: number };
    const keep = nextClipId;
    loadState(o); nextClipId = Math.max(nextClipId, keep);
    S.selTrack = trackById(o.selTrack) ? o.selTrack : (S.tracks[0]?.id ?? 0);
    updUndo(); clampView(); touch();
  }
  function undo(): void { if (!undoS.length) return; redoS.push(snapshot()); loadSnap(undoS.pop()!); }
  function redo(): void { if (!redoS.length) return; undoS.push(snapshot()); loadSnap(redoS.pop()!); }

  /* ---------- Seleksi ---------- */
  const selClips = (): CL[] => S.clips.filter(c => c.sel);
  // clip audio yang diatur panel Pitch: clip utama yang terpilih (sama seperti panel efek), hanya kalau berisi audio
  const pitchClip = (): CL | null => { const c = S.clips.find(x => x.sel && x.id === S.cur) ?? S.clips.find(x => x.sel); return c && c.audio ? c : null; };
  function bound(arr: CL[]): Sel {
    const rows = arr.map(c => trackIdx(c.track));
    const minB = Math.min(...arr.map(c => c.beat)), maxE = Math.max(...arr.map(c => c.beat + c.len));
    const minR = Math.min(...rows), maxR = Math.max(...rows);
    return { beat: minB, row: minR, len: maxE - minB, rows: maxR - minR + 1 };
  }
  function resetSel(): void { S.clips.forEach(c => c.sel = false); S.sel = null; S.handles = false; selDrag = null; tapBeat = -1; invalidate(); }
  function selectOnly(c: CL): void {
    S.clips.forEach(x => x.sel = false); c.sel = true;
    S.cur = c.id; S.selTrack = c.track; S.sel = bound([c]); S.handles = true; hideAdd(); invalidate();
  }
  function refreshSel(): void {
    const a = selClips();
    if (!a.length) resetSel(); else S.sel = bound(a);
    invalidate();
  }
  function hideAdd(): void { addAt = null; bAdd.style.display = 'none'; }

  /* ---------- Clip: koordinat tunggal ---------- */
  function shifted(c: CL): { beat: number; row: number; len: number } {
    const base = trackIdx(c.track);
    let beat = c.beat, len = c.len, idx = base;
    if (drag && c.sel) {
      if (drag.type === 'move') { beat += drag.dBeat; idx = clamp(base + drag.dRow, 0, S.tracks.length - 1); }
      else if (drag.type === 'resizeL') { beat += drag.dBeat; len = Math.max(MINLEN, len + drag.dLen); }
      else len = Math.max(MINLEN, len + drag.dLen);
    }
    const t = S.tracks[idx];
    return { beat, row: t ? (drag && c.sel && drag.type === 'move' ? t.disp : (trackById(c.track)?.disp ?? idx)) : idx, len };
  }
  function clipRectPx(c: CL): { x: number; y: number; w: number; h: number } {
    const s = shifted(c);
    const x0 = Math.round(bx(s.beat)), x1 = Math.round(bx(s.beat + s.len));
    const y0 = Math.round(ry(s.row)) + U, y1 = Math.round(ry(s.row + 1)) - 2 * U;   // lane dikurangi celah 1 px, clip masuk 1 px
    return { x: x0, y: y0, w: Math.max(x1 - x0, MINW * U), h: y1 - y0 };
  }
  function selDisp(): Sel | null {
    const s = S.sel; if (!s) return null;
    let { beat, row, len, rows } = s;
    if (drag) {
      if (drag.type === 'move') { beat += drag.dBeat; row += drag.dRow; }
      else if (drag.type === 'resizeL') { beat += drag.dBeat; len = Math.max(MINLEN, len + drag.dLen); }
      else len = Math.max(MINLEN, len + drag.dLen);
    }
    return { beat, row, len, rows };
  }
  function hitClip(x: number, y: number): CL | null {
    for (let i = S.clips.length - 1; i >= 0; i--) {
      const c = S.clips[i], r = clipRectPx(c);
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return c;
    }
    return null;
  }

  /* ---------- Menggambar ---------- */
  function lanes(): { y0: number; y1: number } {   // rentang vertikal lattice: baris pertama sampai baris kosong ekstra
    const top = Math.max(areaY, Math.round(ry(0)));
    const bot = Math.min(areaY + areaH, Math.round(ry(S.tracks.length + 1)) - U);
    return { y0: top, y1: bot };
  }
  function drawLattice(): void {
    const ls = latticeStep(), pb = pxBeat();
    const k0 = Math.floor(S.posH / ls), k1 = Math.ceil((S.posH + areaW / pb) / ls);
    const { y0, y1 } = lanes();
    if (y1 <= y0) return;
    ctx.fillStyle = C.lat;
    for (let k = k0; k <= k1; k++) {
      const b = k * ls;
      if (b < -1e-9) continue;
      const x = bx(b), kd = kind(b);
      const w = kd === 2 ? 4 * U : kd === 1 ? 2 * U : U;
      const off = kd === 2 ? 2 * U : U;
      ctx.globalAlpha = C.latA[kd];
      ctx.fillRect(Math.round(x - off), y0, w, y1 - y0);
    }
    ctx.globalAlpha = 1;
  }
  function drawRows(): void {
    const x0 = Math.max(areaX, Math.round(bx(0)));
    for (const t of S.tracks) {
      const y0 = Math.round(ry(t.disp)), y1 = Math.round(ry(t.disp + 1)) - U;   // celah 1 px antar baris
      if (y1 < areaY || y0 > areaY + areaH) continue;
      ctx.fillStyle = t.id === S.selTrack && S.tracks.length > 1 ? C.rw : C.rb;
      ctx.fillRect(x0, y0, areaX + areaW - x0, y1 - y0);
    }
  }
  function drawShadow(): void {
    const x = bx(songLen());
    if (x < areaX + areaW) {
      const x0 = Math.max(areaX, Math.round(x)), { y0, y1 } = lanes();
      ctx.fillStyle = C.shadow; ctx.fillRect(x0, y0, areaX + areaW - x0, y1 - y0);
    }
  }
  const shiftedBeat = (c: CL): number => shifted(c).beat;
  function drawClipContent(c: CL, r: { x: number; y: number; w: number; h: number }, beatLen: number, col: string, cursor: number): void {
    if (!c.notes.length) return;
    const pb = pxBeat(), per = loopPeriod(c), ga = ctx.globalAlpha;
    let lo = 127, hi = 0;
    for (const n of c.notes) { lo = Math.min(lo, n.key); hi = Math.max(hi, n.key); }
    const step = r.h / (hi - lo + 2);   // rentang nada + 2 baris cadangan memenuhi tinggi clip
    ctx.fillStyle = col;
    const first = Math.max(0, Math.floor(Math.max(0, S.posH - c.beat) / per));
    for (let t = first * per; t < beatLen - 1e-9; t += per) {
      const tx = bx(c.beat + t + (shiftedBeat(c) - c.beat));
      if (tx > areaX + areaW) break;
      if (tx + per * pb < areaX) continue;
      if (t > 0) {   // segitiga kecil di batas pengulangan
        const px = Math.round(tx);
        ctx.fillStyle = C.bg;
        ctx.beginPath(); ctx.moveTo(px - 2 * V, r.y); ctx.lineTo(px + 2 * V, r.y); ctx.lineTo(px, r.y + 2 * V); ctx.closePath(); ctx.fill();
      }
      // ada beat kursor: ubin yang tidak memuat kursor dipudarkan ke alpha 0,25
      const active = cursor < 0 || (cursor >= t - 1e-9 && cursor < t + per - 1e-9);
      ctx.globalAlpha = active ? ga : ga * 0.25;
      ctx.fillStyle = col;
      for (const n of c.notes) {
        const b = t + n.beat;
        if (b >= beatLen - 1e-9) continue;
        const nx = Math.round(tx + n.beat * pb);
        const nw = Math.max(Math.round(Math.min(n.len, beatLen - b) * pb), U);
        if (nx + nw < areaX || nx > areaX + areaW) continue;
        const ny = Math.round(r.y + (hi - n.key + 1) * step - V / 2);
        ctx.fillRect(nx, ny, nw, V);
      }
      ctx.globalAlpha = ga;
    }
  }
  // Waveform clip audio mengikuti FL Studio Mobile (StudioUI::DrawAudioWave): envelope min/max dari piramid peak,
  // satu batang 1 px per kolom, garis nol di tengah, stereo = dua lajur (kiri atas, kanan bawah), skala linear tanpa normalisasi.
  // Hanya kolom yang terlihat di layar yang dihitung, jadi biayanya sebanding lebar layar, bukan panjang file.
  let wMax = new Float32Array(0), wMin = new Float32Array(0);
  function drawWave(c: CL, body: { x: number; y: number; w: number; h: number }, beatLen: number): void {   // selalu hitam seperti note mini
    const e = audioOf(c);
    if (!c.audio) return;
    if (!e || !e.buf || !e.pyr) { void ensureAudio(c.audio.id); return; }
    let buf = e.buf, pyr = e.pyr;
    if (c.audio.rev) {   // gelombang terbalik: buffer + piramid peak versi terbalik (dibangun sekali di belakang layar)
      const rb = reversedOf(e);
      if (!rb) return;
      if (!e.rpyr) { if (!e.rbuild) { e.rbuild = true; void buildPyramid(rb).then(p => { e.rpyr = p; invalidate(); }).catch(() => { e.rbuild = false; }); } return; }
      buf = rb; pyr = e.rpyr;
    }
    const sr = buf.sampleRate, off = c.audio.off ?? 0, bps = S.bpm / 60, rate = rateOf(c.audio);
    const x0 = Math.floor(Math.max(body.x, areaX)), x1 = Math.ceil(Math.min(body.x + body.w, areaX + areaW));
    const fpp = sr * (beatLen / bps) * rate / body.w;                // frame per pixel (terikat tempo, zoom, dan laju varispeed)
    if (!(fpp > 0) || x1 <= x0) return;
    const start = (off + ((x0 - body.x) / body.w * beatLen) / bps * rate) * sr;   // frame di kolom pertama yang terlihat
    const cols = Math.min(x1 - x0, Math.ceil((buf.length - start) / fpp));   // potong di ujung audio
    if (cols <= 0) return;
    const ch = pyr.ch;
    if (wMax.length < cols * ch) { wMax = new Float32Array(cols * ch); wMin = new Float32Array(cols * ch); }
    getPeaks(pyr, buf, start, fpp, cols, wMax, wMin);
    const lanes = ch === 2 ? 2 : 1, laneH = body.h / lanes, amp = laneH / 2 - 0.5;
    const ga = ctx.globalAlpha;
    const fd = fadeOf(c.audio, beatLen), fiPx = fd.fi / beatLen * body.w, foPx = fd.fo / beatLen * body.w;   // lebar fade dalam piksel
    ctx.fillStyle = NOTE_INK;
    for (let l = 0; l < lanes; l++) {
      const mid = body.y + laneH * (l + 0.5);
      ctx.globalAlpha = ga * 0.45; ctx.fillRect(x0, Math.round(mid), cols, 1);   // garis nol
      ctx.globalAlpha = ga;
      for (let i = 0; i < cols; i++) {
        const px = x0 + i + 0.5 - body.x, gn = Math.min(1, fiPx > 0 ? px / fiPx : 1, foPx > 0 ? (body.w - px) / foPx : 1);   // gelombang mengecil mengikuti fade
        const top = mid - wMax[i * ch + l] * amp * gn, bot = mid - wMin[i * ch + l] * amp * gn;
        ctx.fillRect(x0 + i, top, 1, Math.max(1, bot - top));
      }
    }
  }
  // garis fade di atas gelombang: fade in = tanjakan dari kiri-bawah ke atas, fade out = turunan ke kanan-bawah; area yang "terpotong" diberi bayangan tipis
  function drawFade(c: CL, body: { x: number; y: number; w: number; h: number }, beatLen: number): void {
    if (!c.audio) return;
    const { fi, fo } = fadeOf(c.audio, beatLen);
    if (fi <= 0 && fo <= 0) return;
    const top = body.y, bot = body.y + body.h, lw = Math.max(1, Math.round(U));
    ctx.save();
    ctx.beginPath(); ctx.rect(body.x, body.y, body.w, body.h); ctx.clip();
    ctx.fillStyle = 'rgba(14,16,20,0.28)'; ctx.strokeStyle = NOTE_INK; ctx.lineWidth = lw;
    if (fi > 0) {
      const fw = fi / beatLen * body.w;
      ctx.beginPath(); ctx.moveTo(body.x, bot); ctx.lineTo(body.x + fw, top); ctx.lineTo(body.x, top); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(body.x, bot); ctx.lineTo(body.x + fw, top); ctx.stroke();
    }
    if (fo > 0) {
      const fw = fo / beatLen * body.w, xe = body.x + body.w;
      ctx.beginPath(); ctx.moveTo(xe, bot); ctx.lineTo(xe - fw, top); ctx.lineTo(xe, top); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(xe - fw, top); ctx.lineTo(xe, bot); ctx.stroke();
    }
    ctx.restore();
  }
  function drawClip(c: CL): void {
    const r = clipRectPx(c);
    if (r.x + r.w < areaX || r.x > areaX + areaW || r.y + r.h < areaY || r.y > areaY + areaH) return;
    const tr = trackById(c.track); if (!tr) return;
    const s = shifted(c);
    const isCur = c.id === S.cur && c.track === S.selTrack;
    ctx.globalAlpha = c.muted ? 0.45 : 1;
    if (isCur) {   // halo gelap 5 px + bingkai terang 4 px di atas dan bawah clip aktif
      ctx.fillStyle = C.bg; ctx.fillRect(r.x, r.y - 5 * U, r.w, r.h + 10 * U);
      ctx.fillStyle = C.light; ctx.fillRect(r.x, r.y - 4 * U, r.w, r.h + 8 * U);
    }
    ctx.fillStyle = C.clipLine; ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.fillStyle = tr.color; ctx.fillRect(r.x, r.y, r.w, r.h);   // satu warna solid, dibatasi garis lurus (clipLine)
    const dk = C.abl ? ink(tr.color) : darken(tr.color, 0.65);   // warna nama + note mini
    ctx.save();
    ctx.beginPath(); ctx.rect(Math.max(r.x, areaX), r.y, Math.min(r.x + r.w, areaX + areaW) - Math.max(r.x, areaX), r.h); ctx.clip();
    ctx.fillStyle = dk; ctx.font = Math.round(cell * 0.42) + 'px system-ui,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tx = Math.max(r.x, areaX) + 4 * U;
    if (r.x + r.w - tx > 6 * U) ctx.fillText(c.name, tx, r.y + cell * 0.35 + U);
    if (c.audio && pitchOf(c.audio) !== 0 && r.w > cell * 3.5) {   // label pitch di kanan judul: "+3", "+3 S" (sync), "…" saat masih dirender
      const st = pitchOf(c.audio), lab = (st > 0 ? '+' : '') + st + (c.audio.sync ? ' S' : '') + (pitchBusy(c.audio) ? ' …' : '');
      ctx.textAlign = 'right';
      ctx.fillText(lab, Math.min(r.x + r.w, areaX + areaW) - 4 * U, r.y + cell * 0.35 + U);
      ctx.textAlign = 'left';
    }
    const headH = Math.round(cell * 0.7);
    ctx.fillStyle = darken(tr.color, 0.55);   // garis pembatas tipis di bawah judul clip
    ctx.fillRect(r.x, r.y + headH - U, r.w, Math.max(U, 1));
    const body = { x: r.x, y: r.y + headH, w: r.w, h: r.h - headH - 2 * U };
    const cursor = isCur && tapBeat >= c.beat && tapBeat < c.beat + c.len ? tapBeat - c.beat : -1;
    if (body.h > 4) {
      if (c.audio) { drawWave(c, body, s.len); drawFade(c, body, s.len); }
      else drawClipContent(c, body, s.len, NOTE_INK, cursor);   // note mini selalu hitam, di tema gelap maupun terang
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  function drawClips(): void {
    for (const pass of [false, true]) {   // yang terseleksi digambar belakangan supaya di atas
      for (const c of S.clips) if (c.sel === pass) drawClip(c);
    }
  }
  function drawRowMarker(): void {   // segitiga penunjuk di tepi kiri baris terpilih
    const t = trackById(S.selTrack); if (!t) return;
    const y = (ry(t.disp) + ry(t.disp + 1)) / 2, T = cell * 0.4;
    ctx.fillStyle = C.tick;
    ctx.beginPath(); ctx.moveTo(areaX, y - T); ctx.lineTo(areaX, y + T); ctx.lineTo(areaX + T, y); ctx.closePath(); ctx.fill();
  }
  // Ruler hanya berisi angka (tanpa garis tick, tanpa kotak): nomor bar di garis bar, "bar.ketukan" saat zoom cukup dekat.
  // Langkah label dipilih otomatis supaya teks tidak saling menimpa: 1 ketukan -> 1 bar -> 2 bar -> 4 bar -> ...
  function rulerLabelStep(fontPx: number): number {
    const minPx = fontPx * 3.4;   // ruang untuk teks selebar "128.4" + napas
    let s = S.bpb > 1 ? 1 : S.bpb;
    while (s * pxBeat() < minPx) s = s < S.bpb ? S.bpb : s * 2;
    return s;
  }
  function drawRuler(): void {
    const pb = pxBeat();
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, 0, areaW, rulerH); ctx.clip();
    ctx.fillStyle = C.rulerBg; ctx.fillRect(areaX, 0, areaW, rulerH);
    const fontPx = Math.round(cell * 0.46);
    const step = rulerLabelStep(fontPx);
    const k0 = Math.floor(S.posH / step) - 1, k1 = Math.ceil((S.posH + areaW / pb) / step);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const pad = Math.round(cell * 0.28), cy = Math.round(rulerH / 2) + V;
    const cp = cornerPos();
    // tombol play ikut playhead, jadi label di bawahnya yang dihindari (saat play tombol tersembunyi, label tidak perlu dihindari)
    const bl = playing ? Infinity : cp.x - cp.w / 2, br = playing ? -Infinity : cp.x + cp.w / 2;
    for (let k = Math.max(0, k0); k <= k1; k++) {
      const b = k * step, x = bx(b);
      if (x > areaX + areaW) break;
      const bar = Math.floor(b / S.bpb + 1e-9), isBar = near(b / S.bpb);
      ctx.font = (isBar ? '600 ' : '400 ') + fontPx + 'px system-ui,sans-serif';
      ctx.fillStyle = isBar ? C.light : C.tick;   // nomor bar terang, ketukan lebih redup
      const text = isBar ? String(bar + 1) : `${bar + 1}.${Math.round(b - bar * S.bpb) + 1}`;
      let tx = Math.round(x + pad);
      const tw = ctx.measureText(text).width;
      if (tx < br && tx + tw > bl) {   // label tertutup tombol play
        if (k !== 0) continue;         // label lain disembunyikan selama tertimpa tombol
        const next = bx(b + step) + pad;   // bar 1: geser ke kanan tombol kalau label berikutnya masih muat
        if (next - (br + pad) < fontPx * 1.8) continue;
        tx = Math.round(br + pad);
      }
      ctx.fillText(text, tx, cy);
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
  type HandleKind = 'move' | 'menu' | 'resize' | 'resizeL';
  function handlePos(): Record<HandleKind, Pt> {
    const sd = selDisp()!, r = cell * 0.45;
    const x0 = bx(sd.beat), x1 = bx(sd.beat + sd.len), y0 = ry(sd.row), y1 = ry(sd.row + sd.rows);
    const cl = (p: Pt): Pt => ({ x: clamp(p.x, areaX + r, areaX + areaW - r), y: clamp(p.y, areaY + r, areaY + areaH - r) });
    return {
      move: cl({ x: (x0 + x1) / 2, y: y1 + cell * 0.75 }),
      menu: cl({ x: (x0 + x1) / 2, y: y0 - cell * 0.8 }),
      resize: cl({ x: x1 + cell * 0.65, y: (y0 + y1) / 2 }),
      resizeL: cl({ x: x0 - cell * 0.65, y: (y0 + y1) / 2 })
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
    } else if (kindName === 'resize' || kindName === 'resizeL') {
      ctx.moveTo(p.x - a, p.y); ctx.lineTo(p.x + a, p.y);
      head(p.x + a, p.y, 1, 0); head(p.x - a, p.y, -1, 0);
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
        drawHandle('menu', hp.menu); drawHandle('move', hp.move); drawHandle('resize', hp.resize); drawHandle('resizeL', hp.resizeL);
      }
    }
    ctx.restore();
  }
  function drawPlayhead(): void {
    const ph = curBeat();
    const x = Math.round(bx(ph));
    if (x < areaX || x > areaX + areaW) return;
    const pw = Math.max(U, Math.round(C.playW * V)), h0 = Math.floor(pw / 2);
    // garis selalu mulai dari tepi bawah penggaris (= sisi atas area playlist); tombol play seukuran penggaris ada di atasnya
    const top = areaY;
    ctx.fillStyle = C.playShadow; ctx.fillRect(x - h0 - U, top, pw + 2 * U, areaY + areaH - top);
    ctx.fillStyle = C.playhead; ctx.fillRect(x - h0, top, pw, areaY + areaH - top);
  }
  // tombol play/stop di ruler (satu-satunya kontrol transport, toolbar disembunyikan): selalu berada di posisi playhead,
  // dijepit ke tepi area yang terlihat supaya tetap bisa diketuk saat playhead di luar layar
  function cornerPos(): { x: number; y: number; r: number; w: number } {
    const iw = Math.round(cell * CORNER_CELLS);
    const x = clamp(bx(curBeat()), areaX + iw / 2, areaX + areaW - iw / 2);
    return { x, y: rulerH / 2, r: Math.min(iw, rulerH) * 0.5, w: iw };
  }
  function drawCorner(): void {
    if (playing) return;   // saat play: tombol di atas playhead disembunyikan (stop lewat ketuk penggaris / tombol Play di bilah bawah)
    const cp = cornerPos(), cx = cp.x, cy = cp.y, r = cp.r;
    ctx.fillStyle = C.handleBg; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.handleFg;
    if (playing) { const a = r * 0.45; ctx.fillRect(cx - a, cy - a, a * 2, a * 2); }
    else {
      const a = r * 0.5;
      ctx.beginPath(); ctx.moveTo(cx - a * 0.6, cy - a); ctx.lineTo(cx + a, cy); ctx.lineTo(cx - a * 0.6, cy + a); ctx.closePath(); ctx.fill();
    }
  }
  function draw(): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(areaX, areaY, areaW, areaH); ctx.clip();
    drawRows();
    drawLattice();
    drawShadow();
    drawClips();
    drawRowMarker();
    ctx.restore();
    drawRuler();
    drawSelector();
    drawPlayhead();
    drawCorner();
  }

  /* ---------- Operasi ---------- */
  function addTrack(kind: PLTrackKind = 'instrument'): void {
    saveUndo();
    const id = nextTrackId++;
    // warna ACAK tiap track baru (termasuk track pertama setelah reload): utamakan warna yang belum dipakai track lain, kalau sudah habis acak dari semua warna
    const used = new Set(S.tracks.map(t => t.color.toUpperCase()));
    const free = TRACK_COLORS.filter(c => !used.has(c));
    const pool = free.length ? free : TRACK_COLORS;
    const color = pool[Math.floor(Math.random() * pool.length)];
    S.tracks.push(toTR({ id, name: (kind === 'audio' ? 'Audio ' : 'Instrumen ') + id, color, kind }, S.tracks.length));
    S.selTrack = id; hideAdd();
    S.posV = Math.max(S.posV, S.tracks.length + 1.5 - areaH / rowH());
    clampView(); touch();
  }
  function createClip(beat: number, row: number): void {
    const t = S.tracks[row]; if (!t) return;
    saveUndo();
    const b = Math.max(0, align(beat, 'floor'));
    const c: CL = { id: nextClipId++, track: t.id, beat: b, len: S.lastLen, name: 'Clip ' + (S.clips.filter(x => x.track === t.id).length + 1), notes: [], sel: false, muted: false };
    S.clips.push(c);
    selectOnly(c); touch();
  }
  function deleteSel(): void {
    if (!selClips().length) return;
    saveUndo();
    S.clips = S.clips.filter(c => !c.sel);
    S.cur = 0; resetSel(); touch();
  }
  function duplicateSel(): void {
    const a = selClips(); if (!a.length || !S.sel) return;
    saveUndo();
    const l = S.sel.len, added: CL[] = [];
    for (const c of a) {
      c.sel = false;
      added.push({ id: nextClipId++, track: c.track, beat: r6(c.beat + l), len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), sel: true, muted: c.muted, audio: c.audio ? { ...c.audio } : undefined });
    }
    S.clips.push(...added);
    S.sel = { ...S.sel, beat: r6(S.sel.beat + l) }; S.cur = added[0].id; S.handles = true; touch();
  }
  function splitClipAt(c: CL, p: number): CL | null {   // potong clip di beat p; c jadi bagian kiri, yang dikembalikan bagian kanan
    if (p <= c.beat + 1e-6 || p >= c.beat + c.len - 1e-6) return null;
    const k = p - c.beat;
    const right: CL = {
      id: nextClipId++, track: c.track, beat: r6(p), len: r6(c.len - k), name: c.name, muted: c.muted, sel: false,
      audio: c.audio ? { ...c.audio, off: (c.audio.off ?? 0) + k * 60 / S.bpm * rateOf(c.audio) } : undefined,   // varispeed: file terbaca lebih cepat / lambat dari timeline; fade in hanya di bagian kiri
      notes: c.notes.map(n => ({ ...n, beat: n.beat - k })).filter(n => n.beat + n.len > 0).map(n => n.beat < 0 ? { ...n, len: n.len + n.beat, beat: 0 } : n)
    };
    c.len = r6(k);
    c.notes = c.notes.filter(n => n.beat < k);
    if (c.audio) delete c.audio.fo;   // fade out hanya di bagian kanan
    if (right.audio) delete right.audio.fi;
    return right;
  }
  function splitAtPlayhead(): void {
    const p = curBeat(); const a = selClips().filter(c => p > c.beat + 1e-6 && p < c.beat + c.len - 1e-6);
    if (!a.length) return;
    saveUndo();
    for (const c of a) {
      const right = splitClipAt(c, p);
      if (right) { right.sel = true; S.clips.push(right); }
    }
    refreshSel(); touch();
  }
  function selectAll(): void {
    if (!S.clips.length) return;
    S.clips.forEach(c => c.sel = true); S.sel = bound(S.clips); S.handles = true; invalidate();
  }
  function toggleMute(): void {
    const a = selClips(); if (!a.length) return;
    saveUndo();
    const to = !a.every(c => c.muted);
    a.forEach(c => c.muted = to);
    touch();
  }

  /* region: bekerja pada rentang beat + baris seleksi (Insert space, Delete space, Trim selection) */
  function regionIds(): Set<number> {
    const s = S.sel, ids = new Set<number>();
    if (s) for (let r = s.row; r < s.row + s.rows; r++) if (S.tracks[r]) ids.add(S.tracks[r].id);
    return ids;
  }
  function insertSpace(): void {
    const s = S.sel; if (!s) return;
    saveUndo();
    const ids = regionIds(), b = s.beat, l = s.len, add: CL[] = [];
    for (const c of S.clips) if (ids.has(c.track)) { const r = splitClipAt(c, b); if (r) add.push(r); }
    S.clips.push(...add);
    for (const c of S.clips) if (ids.has(c.track) && c.beat >= b - 1e-9) c.beat = r6(c.beat + l);
    resetSel(); touch();
  }
  function deleteSpace(): void {
    const s = S.sel; if (!s) return;
    saveUndo();
    const ids = regionIds(), b = s.beat, e = s.beat + s.len, l = s.len, add: CL[] = [];
    for (const c of S.clips) {
      if (!ids.has(c.track)) continue;
      const r1 = splitClipAt(c, e); if (r1) add.push(r1);
      const mid = splitClipAt(c, b); if (mid) add.push(mid);
    }
    S.clips.push(...add);
    S.clips = S.clips.filter(c => !(ids.has(c.track) && c.beat >= b - 1e-9 && c.beat + c.len <= e + 1e-9));
    for (const c of S.clips) if (ids.has(c.track) && c.beat >= e - 1e-9) c.beat = r6(c.beat - l);
    S.cur = 0; resetSel(); touch();
  }
  function trimSel(): void {
    const s = S.sel; if (!s) return;
    saveUndo();
    const ids = regionIds(), b = s.beat, e = s.beat + s.len, add: CL[] = [], drop = new Set<CL>();
    for (const c of S.clips) {
      if (!ids.has(c.track)) continue;
      if (c.beat >= e - 1e-9 || c.beat + c.len <= b + 1e-9) { drop.add(c); continue; }
      const r1 = splitClipAt(c, e); if (r1) drop.add(r1);
      const mid = splitClipAt(c, b); if (mid) { add.push(mid); drop.add(c); }
    }
    S.clips.push(...add);
    S.clips = S.clips.filter(c => !drop.has(c));
    S.cur = 0; resetSel(); touch();
  }

  /* clipboard */
  function copySel(): void {
    const a = selClips(); if (!a.length) return;
    const b0 = Math.min(...a.map(c => c.beat)), r0 = Math.min(...a.map(c => trackIdx(c.track)));
    clipboard = {
      len: Math.max(...a.map(c => c.beat + c.len)) - b0,
      items: a.map(c => ({ row: trackIdx(c.track) - r0, beat: r6(c.beat - b0), len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), muted: c.muted, audio: c.audio ? { ...c.audio } : undefined }))
    };
    bPaste.disabled = false;
  }
  function cutSel(): void { copySel(); deleteSel(); }
  function pasteClip(): void {
    if (!clipboard || !S.tracks.length) return;
    saveUndo();
    const maxOff = Math.max(...clipboard.items.map(i => i.row));
    const at = tapBeat >= 0 ? tapBeat : (addAt ? addAt.beat : (S.sel ? S.sel.beat + S.sel.len : curBeat()));
    const b0 = Math.max(0, align(at, 'floor'));
    const baseRow = clamp(Math.max(0, trackIdx(S.selTrack)), 0, Math.max(0, S.tracks.length - 1 - maxOff));
    S.clips.forEach(c => c.sel = false);
    const added: CL[] = [];
    for (const i of clipboard.items) {
      const t = S.tracks[clamp(baseRow + i.row, 0, S.tracks.length - 1)];
      added.push({ id: nextClipId++, track: t.id, beat: r6(b0 + i.beat), len: i.len, name: i.name, notes: i.notes.map(n => ({ ...n })), sel: true, muted: i.muted, audio: i.audio ? { ...i.audio } : undefined });
    }
    S.clips.push(...added);
    S.cur = added[0].id; S.selTrack = added[0].track; S.sel = bound(added); S.handles = true; hideAdd(); touch();
  }

  /* ---------- Popup ---------- */
  function closePop(): void { pop.style.display = 'none'; }
  // Popup sering muncul tepat di bawah jari. Di layar sentuh, begitu jari diangkat browser mengirim event "click" ke elemen di bawah jari
  // = salah satu tombol popup, sehingga popup langsung menutup dan aksinya ikut jalan. Klik yang datang sesaat setelah popup dibuka itu
  // sisa gestur pembukanya, bukan pilihan pengguna, jadi diabaikan.
  const POP_GUARD_MS = 400;
  let popOpenedAt = 0;
  function showPop(x: number, y: number, items: Array<[string, () => void]>, title = 'Menu'): void {
    pop.innerHTML = '';
    popOpenedAt = performance.now();
    const head = document.createElement('div');
    head.className = 'plc-pop-head'; head.textContent = title;
    pop.appendChild(head);
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => {
        if (performance.now() - popOpenedAt < POP_GUARD_MS) return;
        closePop(); fn();
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
  // Pitch clip audio: diatur dari tab "Pitch" di bilah bawah (knob pitch + tombol Auto + Reverse), lewat getPitchTarget / setClipPitch / setClipAuto / setClipReverse.
  function setPitch(c: CL, st: number): void {
    if (!c.audio) return;
    const v = clampPitch(st);
    if (v === pitchOf(c.audio)) return;
    saveUndo();
    if (v === 0) delete c.audio.pitch; else c.audio.pitch = v;
    prewarm(c); touch();
  }
  // Reverse: off disimpan di buffer yang diputar, jadi saat dibalik jendela clip dipetakan ke sisi seberangnya (D - off - panjang jendela)
  function setReverse(c: CL, on: boolean): void {
    const a = c.audio, e = a && bufs.get(a.id);
    if (!a || !e?.buf || !!a.rev === on) return;
    saveUndo();
    const D = e.buf.duration, off = a.off ?? 0;
    const win = Math.min(c.len / (S.bpm / 60) * rateOf(a), Math.max(0, D - off));
    a.off = Math.max(0, D - off - win);
    if (on) a.rev = true; else delete a.rev;
    prewarm(c); touch();
  }
  // Fade in / out clip audio (tab "Sample"): panjang dalam ketukan, kelipatan 1/16 ketukan; fade in + fade out tidak boleh melebihi panjang clip.
  // live = true: dipanggil terus selama knob diseret (real-time); undo hanya disimpan sekali di awal seretan.
  let fadeLive = false;
  function setFade(c: CL, kind: 'in' | 'out', beats: number, live = false): void {
    const a = c.audio; if (!a) return;
    const key = kind === 'in' ? 'fi' : 'fo', other = kind === 'in' ? fadeOf(a, c.len).fo : fadeOf(a, c.len).fi;
    const v = Math.max(0, Math.min(Math.round(beats * 16) / 16, c.len - other));
    if (Math.abs(v - (a[key] ?? 0)) < 1e-9) return;
    if (!(live && fadeLive)) saveUndo();
    fadeLive = live;
    if (v <= 0) delete a[key]; else a[key] = v;
    touch();
  }
  // Volume clip audio (tab "Sample"): 0..1 (1 = level asli file), langkah 1%; live = dipanggil terus selama knob diseret (real-time),
  // undo hanya disimpan sekali di awal seretan. Nilai 1 tidak disimpan di file project.
  let volLive = false;
  function setVolume(c: CL, v01: number, live = false): void {
    const a = c.audio; if (!a) return;
    const v = Math.max(0, Math.min(1, Math.round(v01 * 100) / 100));
    if (Math.abs(v - volOf(a)) < 1e-9) return;
    if (!(live && volLive)) saveUndo();
    volLive = live;
    if (v >= 1) delete a.vol; else a.vol = v;
    touch();
  }
  function setSync(c: CL, on: boolean): void {
    if (!c.audio || !!c.audio.sync === on) return;
    saveUndo();
    if (on) { c.audio.sync = true; c.audio.bpm = S.bpm; } else { delete c.audio.sync; delete c.audio.bpm; }   // Auto menyala: tempo project saat ini jadi acuan
    prewarm(c); touch();
  }
  function openMenu(p: Pt): void {
    const items: Array<[string, () => void]> = [
      ['Deselect', resetSel], ['Copy', copySel], ['Cut', cutSel]
    ];
    const one = selClips();
    if (one.length === 1 && !one[0].audio) items.unshift(['Edit', () => editClip(one[0])]);
    if (clipboard) items.push(['Paste', pasteClip]);
    items.push(
      ['Duplicate', duplicateSel], ['Mute / Unmute', toggleMute], ['Split di playhead', splitAtPlayhead],
      ['Rename', () => showRenamePop(p)], ['Color', () => showColorPop(p)], ['Insert space', insertSpace], ['Delete space', deleteSpace], ['Trim selection', trimSel], ['Delete', deleteSel]
    );
    showPop(p.x, p.y, items, one.length === 1 ? one[0].name : `${selClips().length} clip`);
  }
  // Rename: popup kecil dengan kolom nama (bukan window.prompt, yang tidak ada di semua jenis jendela aplikasi).
  // Satu clip terseleksi = nama sekarang terisi; beberapa clip = kolom kosong, nama baru dipakai untuk semuanya. Kosong / tidak berubah = tidak ada perubahan.
  function showRenamePop(p: Pt): void {
    const sel = selClips();
    if (!sel.length) return;
    const ids = new Set(sel.map(c => c.id));
    pop.innerHTML = '';
    popOpenedAt = performance.now();
    const head = document.createElement('div');
    head.className = 'plc-pop-head'; head.textContent = sel.length === 1 ? 'Rename' : `Rename ${sel.length} clip`;
    const row = document.createElement('div');
    row.className = 'plc-pop-rn';
    const input = document.createElement('input');
    input.type = 'text'; input.maxLength = 40; input.spellcheck = false; input.autocomplete = 'off';
    input.value = sel.length === 1 ? sel[0].name : '';
    input.placeholder = 'Nama clip';
    input.setAttribute('aria-label', 'Nama clip');
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    const apply = (): void => {
      const name = input.value.trim();
      closePop();
      if (name) renameClips(ids, name);
    };
    ok.onclick = () => { if (performance.now() - popOpenedAt < POP_GUARD_MS) return; apply(); };
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } else if (e.key === 'Escape') { e.preventDefault(); closePop(); } };
    row.append(input, ok);
    pop.append(head, row);
    pop.style.gridTemplateColumns = '';
    pop.style.display = 'flex';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(p.x / dpr - pw / 2, 4, W / dpr - pw - 4) + 'px';
    pop.style.top = clamp(p.y / dpr - ph / 2, 4, H / dpr - ph - 4) + 'px';
    setTimeout(() => { input.focus(); input.select(); }, POP_GUARD_MS);   // tunggu sisa gestur pembuka selesai, supaya fokus tidak langsung hilang
  }
  function renameClips(ids: Set<number>, name: string): void {
    const cs = S.clips.filter(c => ids.has(c.id) && c.name !== name);
    if (!cs.length) return;
    saveUndo();
    for (const c of cs) c.name = name;
    touch();   // nama di panel efek ikut lewat onChange
  }
  // Color: pilih salah satu warna track (semua warna yang ada). Warna pattern = warna track-nya, jadi semua pattern di track itu ikut berubah
  function showColorPop(p: Pt): void {
    const ids = new Set(selClips().map(c => c.track));
    const cur = ids.size === 1 ? (S.tracks.find(t => t.id === [...ids][0])?.color ?? '').toUpperCase() : '';
    pop.innerHTML = '';
    popOpenedAt = performance.now();
    const head = document.createElement('div');
    head.className = 'plc-pop-head'; head.textContent = 'Color';
    const grid = document.createElement('div');
    grid.className = 'plc-pop-sw';
    for (const col of TRACK_COLORS) {
      const b = document.createElement('button');
      b.style.background = col; b.setAttribute('aria-label', col);
      if (col.toUpperCase() === cur) b.classList.add('cur');
      b.onclick = () => {
        if (performance.now() - popOpenedAt < POP_GUARD_MS) return;
        closePop(); setTrackColor(ids, col);
      };
      grid.appendChild(b);
    }
    pop.append(head, grid);
    pop.style.gridTemplateColumns = '';
    pop.style.display = 'flex';
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = clamp(p.x / dpr - pw / 2, 4, W / dpr - pw - 4) + 'px';
    pop.style.top = clamp(p.y / dpr - ph / 2, 4, H / dpr - ph - 4) + 'px';
  }
  function setAllTrackColors(colors: string[]): void {
    if (!S.tracks.length) return;
    saveUndo();
    S.tracks.forEach((t, i) => { t.color = colors[i]; });
    touch();   // pattern di panel efek + mixer ikut warna baru lewat onChange
  }
  function randomizeColors(): void {
    const colors: string[] = [];
    let pool: string[] = [];
    for (let i = 0; i < S.tracks.length; i++) {
      if (!pool.length) {   // kocok palet; habis dipakai semua baru dikocok lagi (warna kembar baru muncul kalau track > jumlah palet)
        pool = [...TRACK_COLORS];
        for (let j = pool.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [pool[j], pool[k]] = [pool[k], pool[j]]; }
      }
      colors.push(pool.pop() as string);
    }
    setAllTrackColors(colors);
  }
  function trackGradient(top: string, bottom: string): void {
    const rgb = (h: string): number[] => { const n = parseInt(h.replace('#', ''), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
    const a = rgb(top), b = rgb(bottom), n = S.tracks.length;
    const hex = (v: number): string => Math.round(v).toString(16).padStart(2, '0');
    setAllTrackColors(S.tracks.map((_, i) => {
      const t = n > 1 ? i / (n - 1) : 0;   // track pertama = warna atas, track terakhir = warna bawah
      return ('#' + hex(a[0] + (b[0] - a[0]) * t) + hex(a[1] + (b[1] - a[1]) * t) + hex(a[2] + (b[2] - a[2]) * t)).toUpperCase();
    }));
  }
  function setTrackColor(ids: Set<number>, color: string): void {
    const trs = S.tracks.filter(t => ids.has(t.id) && t.color.toUpperCase() !== color.toUpperCase());
    if (!trs.length) return;
    saveUndo();
    for (const t of trs) t.color = color;
    touch();   // pattern di panel efek + mixer ikut warna baru lewat onChange
  }
  function editClip(c: CL): void {   // buka editor (piano roll) untuk clip ini; clip audio tidak punya editor
    if (c.audio) return;
    opts.onOpenClip?.({ id: c.id, track: c.track, beat: c.beat, len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), muted: c.muted });
  }
  function showAdd(q: Pt, row: number): void {
    const t = S.tracks[row]; if (!t) return;
    addAt = { beat: xToBeat(q.x), row };
    const sz = cell * 1.5 / dpr, cy = (ry(row) + ry(row + 1)) / 2 / dpr;
    bAdd.style.cssText = `display:flex;width:${sz}px;height:${sz}px;left:${q.x / dpr - sz / 2}px;top:${cy - sz / 2}px;font-size:${Math.max(10, sz * 0.28)}px`;
  }
  bAdd.onclick = () => { if (addAt) { const a = addAt; hideAdd(); createClip(a.beat, a.row); } };

  /* ---------- Pointer / gesture ---------- */
  const ptrs = new Map<number, Gs>();
  let pinch: Pinch | null = null;
  const pt = (e: { clientX: number; clientY: number }): Pt => { const r = cv.getBoundingClientRect(); const k = cv.width / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
  const inArea = (x: number, y: number): boolean => x >= areaX && x < areaX + areaW && y >= areaY && y < areaY + areaH;

  function beginDrag(gs: Gs, type: DragType, q: Pt): void {
    saveUndo();
    const sc = selClips(), rows = sc.map(c => trackIdx(c.track));
    gs.mode = 'drag'; gs.type = type; gs.s0 = { ...S.sel! }; gs.start = q;
    gs.minBeat = Math.min(...sc.map(c => c.beat)); gs.maxBeat = Math.max(...sc.map(c => c.beat));
    gs.minRow = Math.min(...rows); gs.maxRow = Math.max(...rows);
    if (type === 'resizeL') {   // batas geser tepi kiri: clip tak boleh lebih pendek dari MINLEN, tak boleh mulai sebelum beat 0, dan clip audio tak boleh membuka lebih dari awal file
      let lo = -Infinity, hi = Infinity;
      for (const c of sc) {
        hi = Math.min(hi, c.len - MINLEN);
        lo = Math.max(lo, -c.beat);
        if (c.audio) lo = Math.max(lo, -(c.audio.off ?? 0) / (60 / S.bpm * rateOf(c.audio)));
      }
      gs.kMin = lo; gs.kMax = Math.max(lo, hi);
    }
    drag = { type, dBeat: 0, dRow: 0, dLen: 0 };
    invalidate();
  }
  function dragMove(gs: Gs, q: Pt): void {
    const d = drag!, pb = pxBeat(), rh = rowH(), s0 = gs.s0!;
    const dx = q.x - gs.start!.x, dy = q.y - gs.start!.y;
    if (gs.type === 'move') {
      let dB = r6(align(s0.beat + dx / pb) - s0.beat);
      dB = Math.max(dB, -gs.minBeat!);
      d.dBeat = dB;
      d.dRow = clamp(Math.round(dy / rh), -gs.minRow!, S.tracks.length - 1 - gs.maxRow!);
    } else if (gs.type === 'resizeL') {
      const k = clamp(r6(align(s0.beat + dx / pb) - s0.beat), gs.kMin!, gs.kMax!);   // k > 0 = dipendekkan dari kiri, k < 0 = dipanjangkan ke kiri
      d.dBeat = k; d.dLen = -k;
    } else {
      const end = align(s0.beat + s0.len + dx / pb);
      d.dLen = r6(Math.max(MINLEN, end - s0.beat) - s0.len);
    }
    invalidate();
  }
  function trimLeft(c: CL, k: number): void {   // geser tepi kiri clip sebanyak k ketukan, ujung kanan tetap
    c.beat = r6(c.beat + k); c.len = Math.max(MINLEN, r6(c.len - k));
    if (c.audio) c.audio.off = Math.max(0, (c.audio.off ?? 0) + k * 60 / S.bpm * rateOf(c.audio));   // awal file ikut maju / mundur supaya suara tidak bergeser
    else c.notes = c.notes.map(n => ({ ...n, beat: r6(n.beat - k) })).filter(n => n.beat + n.len > 1e-6).map(n => n.beat < 0 ? { ...n, len: r6(n.len + n.beat), beat: 0 } : n);   // note ikut bergeser; yang terpotong di kiri dibuang / dipendekkan seperti Split
  }
  function commitDrag(): void {
    const d = drag!; drag = null;
    if (!(d.dBeat || d.dRow || d.dLen)) { cancelUndo(); invalidate(); return; }
    for (const c of selClips()) {
      if (d.type === 'move') {
        c.beat = r6(Math.max(0, c.beat + d.dBeat));
        const t = S.tracks[clamp(trackIdx(c.track) + d.dRow, 0, S.tracks.length - 1)];
        c.track = t.id;
      } else if (d.type === 'resizeL') trimLeft(c, d.dBeat);
      else c.len = Math.max(MINLEN, r6(c.len + d.dLen));
    }
    if (d.type !== 'move') S.lastLen = selClips()[0].len;
    const cur = S.clips.find(c => c.id === S.cur);
    if (cur && cur.sel) S.selTrack = cur.track;
    S.sel = bound(selClips()); touch();
  }

  function beginSelect(gs: Gs): void {
    gs.mode = 'select';
    const b = clamp(align(xToBeat(gs.sx)), 0, songLen());
    const r = clamp(Math.floor(yToRow(gs.sy)), 0, Math.max(0, S.tracks.length - 1));
    selDrag = { b0: b, r0: r, b1: b, r1: r };
    S.clips.forEach(c => c.sel = false); S.sel = null; S.handles = false; hideAdd();
    invalidate();
  }
  function finishSelect(gs: Gs, q: Pt): void {
    const moved = Math.hypot(q.x - gs.sx, q.y - gs.sy) > 6 * dpr;
    const sd = selDrag; selDrag = null;
    if (!moved || !sd) { resetSel(); return; }
    const b0 = Math.min(sd.b0, sd.b1), b1 = Math.max(sd.b0, sd.b1);
    const r0 = Math.min(sd.r0, sd.r1), r1 = Math.max(sd.r0, sd.r1);
    let any: CL | null = null;
    for (const c of S.clips) {
      const row = trackIdx(c.track);
      const inT = (b1 - b0 < 1e-6) ? (c.beat <= b0 && c.beat + c.len > b0) : (c.beat < b1 && c.beat + c.len > b0);
      c.sel = inT && row >= r0 && row <= r1;
      if (c.sel && !any) any = c;
    }
    if (!any) { resetSel(); return; }
    S.cur = any.id; S.selTrack = any.track;
    S.sel = bound(selClips()); S.handles = true; invalidate();
  }

  function handleTap(q: Pt): void {
    const beat = xToBeat(q.x), row = Math.floor(yToRow(q.y));
    const hit = hitClip(q.x, q.y);
    const now = performance.now();
    if (hit) {
      if (!hit.audio && lastTap && lastTap.id === hit.id && now - lastTap.t < 350) {   // double-tap: buka editor (piano roll), kecuali clip audio
        lastTap = null; selectOnly(hit); tapBeat = beat;
        opts.onOpenClip?.({ id: hit.id, track: hit.track, beat: hit.beat, len: hit.len, name: hit.name, notes: hit.notes.map(n => ({ ...n })), muted: hit.muted });
        return;
      }
      lastTap = { id: hit.id, t: now }; selectOnly(hit); tapBeat = beat; return;   // tap pattern hanya memilih; menu muncul dari titik tiga
    }
    lastTap = null;
    if (row < 0 || row >= S.tracks.length || beat < 0) { resetSel(); hideAdd(); return; }
    const t = S.tracks[row];
    if (t.id !== S.selTrack) { resetSel(); S.selTrack = t.id; hideAdd(); invalidate(); return; }   // tap pertama hanya memilih baris
    if (addAt) { hideAdd(); return; }                                                               // tap lagi membatalkan tombol
    if (S.sel && S.handles) { resetSel(); return; }
    resetSel(); tapBeat = beat; showAdd(q, row);
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
    if (pinch!.dx0 >= 30 * dpr) S.zH = clamp(pinch!.zH0 * dx / pinch!.dx0, ZHMIN, ZHMAX);   // tiap sumbu dihitung sendiri
    if (pinch!.dy0 >= 30 * dpr) S.zV = clamp(pinch!.zV0 * dy / pinch!.dy0, ZVMIN, ZVMAX);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    S.posH = pinch!.mb - (mx - areaX) / pxBeat();
    S.posV = pinch!.mr - (my - areaY) / rowH();
    clampView(); syncZoomUI(); invalidate();
  }

  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
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

    const cp = cornerPos();
    // tombol play: bisa digeser kiri-kanan (memindahkan playhead); play/stop hanya saat diketuk, bukan saat digeser (lihat endPointer)
    if (!playing && Math.abs(q.x - cp.x) <= cp.w / 2 && q.y < rulerH) { gs.mode = 'corner'; gs.moved = false; gs.off = q.x - cp.x; return; }
    if (q.y < rulerH) {
      if (playing) { gs.mode = 'ruler-stop'; stopAndReturn(); return; }   // saat play: ketuk penggaris = stop + kembali ke titik awal
      gs.mode = 'ruler'; if (q.x >= areaX) seekTo(q.x); return;
    }
    if (!inArea(q.x, q.y)) { gs.mode = 'dead'; return; }
    if (S.sel && S.handles) {
      const hp = handlePos();
      for (const k of ['menu', 'move', 'resize', 'resizeL'] as HandleKind[]) {
        const p = hp[k];
        if (Math.hypot(q.x - p.x, q.y - p.y) <= cell * 0.6) {
          if (k === 'menu') { gs.mode = 'dead'; openMenu(p); } else beginDrag(gs, k, q);
          return;
        }
      }
    }
    const hit = hitClip(q.x, q.y);
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
      case 'ruler': if (q.x >= areaX) seekTo(q.x); break;
      case 'corner':
        if (!gs.moved && Math.hypot(q.x - gs.sx, q.y - gs.sy) > 6 * dpr) gs.moved = true;
        if (gs.moved) {
          const b = seekTo(clamp(q.x - (gs.off ?? 0), areaX, areaX + areaW));
          if (playing) returnTo = b;   // digeser saat play: titik awal ikut pindah ke posisi baru
        }
        break;
      case 'drag': dragMove(gs, q); break;
      case 'select':
        selDrag!.b1 = clamp(align(xToBeat(q.x)), 0, songLen());
        selDrag!.r1 = clamp(Math.floor(yToRow(q.y)), 0, Math.max(0, S.tracks.length - 1));
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
        hideAdd(); clampView(); syncZoomUI(); invalidate(); break;
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
      case 'corner': if (!gs.moved && e.type !== 'pointercancel') togglePlay(); break;
      case 'select': finishSelect(gs, q); break;
      case 'pan':
        if (performance.now() - (gs.lastT || 0) < 60 && Math.hypot(gs.vx, gs.vy) > 0.05) inertia = { vx: gs.vx, vy: gs.vy };
        break;
      case 'drag': commitDrag(); break;
      case 'pinch':
        pinch = null;
        for (const o of ptrs.values()) if (o.mode === 'pinch') o.mode = 'dead';
        break;
    }
    invalidate();
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
    hideAdd(); clampView(); syncZoomUI(); invalidate();
  }
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const q = pt(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * 0.0015);
      zoomAt(e.altKey ? 'v' : 'h', f, q.x, q.y);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      S.posH += (e.deltaX || e.deltaY) * dpr / pxBeat(); hideAdd(); clampView(); invalidate();
    } else {
      S.posV += e.deltaY * dpr / rowH(); hideAdd(); clampView(); invalidate();
    }
  }, { passive: false });
  zhEl.addEventListener('input', () => {
    const b = xToBeat(areaX + areaW / 2);
    S.zH = fromPos(+zhEl.value, ZHMIN, ZHMAX);
    S.posH = b - (areaW / 2) / pxBeat(); hideAdd(); clampView(); invalidate();
  });
  zvEl.addEventListener('input', () => {
    const r = yToRow(areaY + areaH / 2);
    S.zV = fromPos(+zvEl.value, ZVMIN, ZVMAX);
    S.posV = r - (areaH / 2) / rowH(); hideAdd(); clampView(); invalidate();
  });

  /* ---------- Toolbar & keyboard ---------- */
  function setTheme(name: 'light' | 'dark'): void {
    C = THEMES[name];
    for (const k in C.css) root.style.setProperty(k, C.css[k]);
    themeEl.value = name;
    invalidate();
  }
  themeEl.addEventListener('change', () => setTheme(themeEl.value as 'light' | 'dark'));
  bPlay.onclick = togglePlay;
  // tombol + track: pilih jenis track lewat popup (Instrumen / Audioclip), muncul tepat di atas tombol yang diketuk
  function showTrackMenu(btn: HTMLElement): void {
    hideAdd();
    showPop(0, 0, [['Instrumen', () => addTrack('instrument')], ['Audioclip', () => addTrack('audio')]], 'Tambah track');
    const rr = (pop.offsetParent ?? root).getBoundingClientRect(), br = btn.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const left = br.left - rr.left + br.width / 2 - pw / 2, below = br.bottom - rr.top + 6, above = br.top - rr.top - ph - 6;
    pop.style.left = clamp(left, 4, W / dpr - pw - 4) + 'px';
    pop.style.top = clamp(above >= 4 ? above : below, 4, Math.max(4, H / dpr - ph - 4)) + 'px';
  }
  bAddTrack.onclick = () => showTrackMenu(bAddTrack);
  const bAddTrack2 = $<HTMLButtonElement>('addtrack2');   // tombol + mengambang di tengah bawah playlist
  bAddTrack2.addEventListener('pointerdown', e => e.stopPropagation());
  bAddTrack2.onclick = () => showTrackMenu(bAddTrack2);
  bPaste.onclick = pasteClip;
  bPaste.disabled = true;
  bpmEl.addEventListener('input', () => applyBpm(+bpmEl.value));
  uiEl.addEventListener('change', () => { uiScale = +uiEl.value; hideAdd(); layout(); });
  snapSel.addEventListener('change', invalidate);
  bUndo.onclick = undo;
  bRedo.onclick = redo;

  const onKey = (e: KeyboardEvent): void => {
    const t = (e.target as HTMLElement | null)?.tagName;
    if (t === 'INPUT' || t === 'SELECT') return;
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
    else if (k === 'escape') { resetSel(); closePop(); hideAdd(); }
    else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
    else if (mod && k === 'd') { e.preventDefault(); duplicateSel(); }
    else if (mod && k === 'c') { e.preventDefault(); copySel(); }
    else if (mod && k === 'x') { e.preventDefault(); cutSel(); }
    else if (mod && k === 'v') { e.preventDefault(); pasteClip(); }
    else if (k === 'm' && !mod) { toggleMute(); }
  };
  window.addEventListener('keydown', onKey);

  /* ---------- Loop render ---------- */
  let lastT = 0, raf = 0, dead = false;
  let lastDraw = 0;
  function frame(t: number): void {
    if (dead) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(50, t - lastT); lastT = t;
    const k = 1 - Math.pow(0.6, dt / 16.7);   // ease-out 0,4 per tick, dipaku bila selisih < 0,05
    for (const tr of S.tracks) {
      if (tr.disp === tr.tgt) continue;
      tr.disp += (tr.tgt - tr.disp) * k;
      if (Math.abs(tr.tgt - tr.disp) < 0.05) tr.disp = tr.tgt;
      dirty = true;
    }
    if (inertia) {
      S.posH -= inertia.vx * dt / pxBeat();
      S.posV -= inertia.vy * dt / rowH();
      const f = Math.pow(0.95, dt / 16.7);
      inertia.vx *= f; inertia.vy *= f;
      if (Math.hypot(inertia.vx, inertia.vy) < 0.02) inertia = null;
      clampView(); syncZoomUI(); dirty = true;
    }
    if (playing && !ptrs.size) {   // ikuti playhead: gulung layar bila playhead keluar dari tampilan
      const ph = curBeat(), vb = areaW / pxBeat();
      if (ph < S.posH || ph > S.posH + vb * 0.95) { S.posH = ph; clampView(); syncZoomUI(); }
    }
    // saat play, gambar ulang maksimal ±30 fps (beban main thread turun); gesture / perubahan tetap langsung digambar
    if (dirty || (playing && t - lastDraw >= 33)) { dirty = false; lastDraw = t; draw(); }
  }

  /* ---------- Init ---------- */
  const init = opts.tracks ? { tracks: opts.tracks, clips: opts.clips ?? [] } : { tracks: [], clips: [] };   // default: playlist kosong
  loadState(init);
  bpmEl.value = String(S.bpm);
  setTheme(opts.theme ?? 'dark');
  syncZoomUI(); updUndo();
  resize();
  raf = requestAnimationFrame(frame);

  /* ---------- Handle ---------- */
  const exportState = (): PlaylistState => ({
    tracks: S.tracks.map(t => ({ id: t.id, name: t.name, color: t.color, kind: t.kind })),
    clips: S.clips.map(c => ({ id: c.id, track: c.track, beat: c.beat, len: c.len, name: c.name, notes: c.notes.map(n => ({ ...n })), muted: c.muted, audio: c.audio ? { ...c.audio } : undefined })),
    view: { posH: S.posH, posV: S.posV, zH: S.zH, zV: S.zV },
    bpm: S.bpm
  });
  return {
    destroy(): void {
      dead = true;
      cancelAnimationFrame(raf);
      stopPlay();
      for (const g of ptrs.values()) clearTimeout(g.timer);
      ptrs.clear();
      window.removeEventListener('keydown', onKey);
      ro.disconnect();
      ac = null;   // AudioContext milik engine bersama: jangan ditutup di sini
      root.remove();
    },
    getState: exportState,
    getSelTrack: () => S.selTrack,
    getTracks: () => S.tracks.map(t => ({ id: t.id, name: t.name, color: t.color, kind: t.kind })),
    setTrackColor: (trackId, color) => setTrackColor(new Set([trackId]), color),
    getBpm: () => S.bpm,
    getClipsInfo: () => S.clips.map(c => ({ id: c.id, name: c.name, track: c.track, audio: !!c.audio })),
    getPitchTarget(): PitchTarget | null {
      const c = pitchClip();
      return c && c.audio ? { id: c.id, name: c.name, pitch: pitchOf(c.audio), auto: !!c.audio.sync, busy: pitchBusy(c.audio), rev: !!c.audio.rev, progress: pitchProgress(c.audio), len: c.len, fadeIn: fadeOf(c.audio, c.len).fi, fadeOut: fadeOf(c.audio, c.len).fo, vol: volOf(c.audio) } : null;
    },
    setClipPitch(st: number): void { const c = pitchClip(); if (c) setPitch(c, st); },
    setClipAuto(on: boolean): void { const c = pitchClip(); if (c) setSync(c, on); },
    setClipReverse(on: boolean): void { const c = pitchClip(); if (c) setReverse(c, on); },
    setClipFade(kind: 'in' | 'out', beats: number, live = false): void { const c = pitchClip(); if (c) setFade(c, kind, beats, live); },
    endClipFade(): void { fadeLive = false; },
    setClipVolume(v: number, live = false): void { const c = pitchClip(); if (c) setVolume(c, v, live); },
    endClipVolume(): void { volLive = false; },
    setState(s: PlaylistState): void {
      loadState(s); undoS.length = 0; redoS.length = 0; updUndo();
      hideAdd(); clampView(); syncZoomUI(); touch();
    },
    async addAudioClip(fileId: string, name: string, clientX: number, clientY: number): Promise<boolean> {
      const r = cv.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
      const q = pt({ clientX, clientY });
      if (q.x < areaX || q.y < areaY) return false;   // jatuh di header track / penggaris, bukan di area clip
      await ensureAudio(fileId);
      const buf = bufs.get(fileId)?.buf;
      if (!buf) return false;                          // file tidak bisa dibaca / di-decode
      if (!S.tracks.length) addTrack('audio');
      const row = clamp(Math.floor(yToRow(q.y)), 0, S.tracks.length - 1);
      const t = S.tracks[row];
      saveUndo();
      const len = Math.max(0.25, r6(buf.duration * S.bpm / 60));
      const c: CL = { id: nextClipId++, track: t.id, beat: Math.max(0, align(xToBeat(q.x), 'floor')), len, name: name.replace(/\.[^.]+$/, ''), notes: [], sel: false, muted: false, audio: { id: fileId, dur: buf.duration } };
      S.clips.push(c);
      selectOnly(c); touch();
      return true;
    },
    setClipNotes(clipId: number, notes: PLNote[]): void {   // dipakai setelah piano roll selesai mengedit clip
      const c = S.clips.find(x => x.id === clipId); if (!c) return;
      c.notes = notes.map(n => ({ ...n })); touch();
    },
    resize,
    stop(): void { stopPlay(); },
    setBpm: applyBpm,
    setMetronome(on: boolean): void {
      metroOn = on;
      if (!on) cancelClicks(); else if (playing) metroNext = Math.ceil(absNow() - 1e-9);
    },
    randomizeTrackColors: randomizeColors,
    applyTrackGradient: trackGradient,
    togglePlay,
    rewind: stopAndReturn,
    seekBars,
    isPlaying: () => playing,
    undo, redo, canUndo: () => undoS.length > 0, canRedo: () => redoS.length > 0
  };
}
