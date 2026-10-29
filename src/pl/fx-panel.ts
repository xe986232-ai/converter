// Panel efek di bawah layar: deretan plugin ke samping (kanan), panel bisa dibuka/ditutup.
// Bilah bawah: [tombol kiri tetap | Efek, Mixer, Sample, Module | REWIND + PLAY | (kosong)]. Punya empat tombol panel: "Efek" (deretan plugin), "Mixer" (strip channel, lihat mixer-panel.ts), "Sample" (dulu "Pitch": knob pitch, Fade In / Out, Auto, Rev; lihat pitch-panel.ts; id internal tetap 'pitch'), dan "Module" (plugin VST, lihat module-panel.ts). Hanya satu panel terbuka sekaligus.
// UI + penyimpanan parameter; perubahan dikirim lewat onFxChange() ke audio-engine.ts (chain efek per clip = module track + efek track).
// Undo / Redo: seluruh perubahan di panel ini (knob, slider, tombol, tambah / hapus plugin, sample, Master) punya riwayat sendiri (lihat blok "riwayat Undo / Redo" dan FxHistoryHandle); host memilihnya lewat tombol Undo / Redo di bilah bawah.
// Tab Efek punya dua tombol vertikal di tepi kanan: "Track" (efek milik track dari pattern terpilih: satu deretan untuk semua clip di track itu) dan "Master" (efek di output master, berlaku untuk semua channel; lewat onMasterFxChange()).
import './fx-panel.css';
import { el, SVGNS, polar, arc, inkOn } from './ui-util';
import { mountMixer, type MixerHandle } from './mixer-panel';
import { MODULES, moduleDef, type ParamDef, type DeviceDef } from './modules';
import { computeSpectrogram, drawSpectrogram, type Spectro } from './spectrogram';
import { createVsynth, type VSource, type VVoice, type VsynthHandle } from './vsynth';
import { createSampler, type SmpSource, type SamplerHandle } from './sampler';
import { createDrumSeq, cleanSamples, cleanEq, cleanMix, type SlotMix, type SampleRef, type DrumInstrument } from './drumseq';
import { mountPitchPanel, type PitchPanelHandle, type PitchPanelOptions } from './pitch-panel';
import { mountToolsPanel, type ToolsPanelOptions } from './tools-panel';


const DEVICES: DeviceDef[] = [
  { type: 'lfo', name: 'LFO', params: [
    { key: 'rate', label: 'Rate', min: 0.01, max: 20, def: 1, unit: 'Hz', dec: 2, log: true },
    { key: 'depth', label: 'Depth', min: 0, max: 100, def: 50, unit: '%', dec: 0 },
    { key: 'offset', label: 'Offset', min: -100, max: 100, def: 0, unit: '%', dec: 0 },
    { key: 'phase', label: 'Phase', min: 0, max: 360, def: 0, unit: '°', dec: 0 }
  ] },
  { type: 'filter', name: 'Filter', params: [
    { key: 'freq', label: 'Freq', min: 20, max: 20000, def: 1000, unit: 'Hz', dec: 0, log: true },
    { key: 'reso', label: 'Reso', min: 0, max: 100, def: 20, unit: '%', dec: 0 },
    { key: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%', dec: 0 }
  ] },
  { type: 'delay', name: 'Delay', params: [
    { key: 'time', label: 'Time', min: 1, max: 1000, def: 250, unit: 'ms', dec: 0, log: true },
    { key: 'fb', label: 'Feedback', min: 0, max: 95, def: 35, unit: '%', dec: 0 },
    { key: 'mix', label: 'Mix', min: 0, max: 100, def: 30, unit: '%', dec: 0 }
  ] },
  { type: 'reverb', name: 'Reverb', params: [
    { key: 'size', label: 'Size', min: 0, max: 100, def: 50, unit: '%', dec: 0 },
    { key: 'decay', label: 'Decay', min: 0.1, max: 10, def: 2, unit: 's', dec: 1, log: true },
    { key: 'mix', label: 'Mix', min: 0, max: 100, def: 25, unit: '%', dec: 0 }
  ] },
  { type: 'eq1', name: 'EQ1', params: [
    { key: 'low', label: 'Low', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true },
    { key: 'mid', label: 'Mid', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true },
    { key: 'high', label: 'High', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true }
  ] },
  { type: 'compressor', name: 'Compressor', params: [   // kompresor dinamika lengkap (lihat mkCompressor di audio-engine.ts)
    { key: 'thresh', label: 'Thresh', min: -60, max: 0, def: -24, unit: 'dB', dec: 1 },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, def: 4, unit: ':1', dec: 1, log: true },
    { key: 'attack', label: 'Attack', min: 0.1, max: 200, def: 10, unit: 'ms', dec: 1, log: true },
    { key: 'release', label: 'Release', min: 10, max: 1000, def: 120, unit: 'ms', dec: 0, log: true },
    { key: 'knee', label: 'Knee', min: 0, max: 40, def: 6, unit: 'dB', dec: 1 },
    { key: 'makeup', label: 'Makeup', min: 0, max: 24, def: 0, unit: 'dB', dec: 1 },
    { key: 'mix', label: 'Mix', min: 0, max: 100, def: 100, unit: '%', dec: 0 }
  ] },
  { type: 'eq2', name: 'EQ2', layout: 'sliders', params: [   // lima slider vertikal, frekuensi tetap (lihat EQ2_BANDS di audio-engine.ts)
    { key: 'b1', label: '60 Hz', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true },
    { key: 'b2', label: '250 Hz', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true },
    { key: 'b3', label: '1 kHz', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true },
    { key: 'b4', label: '4 kHz', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true },
    { key: 'b5', label: '12 kHz', min: -18, max: 18, def: 0, unit: 'dB', dec: 1, bipolar: true }
  ] }
];
const defOf = (type: string): DeviceDef | undefined => DEVICES.find(d => d.type === type) ?? moduleDef(type);   // efek bawaan + module (modules.ts)
const isModule = (type: string): boolean => !!moduleDef(type);

interface FxDevice { id: number; type: string; on: boolean; params: Record<string, number>; file?: { id: string; name: string }; start?: number; samples?: (SampleRef | null)[]; eq?: number[][]; mix?: SlotMix[] }   // mix = Volume + Attack per slot Drum Sequence; eq = EQ2 per slot Drum Sequence (8 slot x 5 band, dB); samples = sample per slot Drum Sequence; file + start = sampel vsynth (id file di panel browser) dan titik start 0..1
type DockTab = 'fx' | 'mixer' | 'pitch' | 'module' | 'tools';
// patterns[idPattern] = module instrumen milik pattern; patterns[-idTrack] = efek milik track (satu deretan untuk semua clip di track)
type FxView = 'track' | 'master' | 'fxch';   // isi tab Efek: efek pattern (Track), efek output master (Master), atau efek satu channel FX (fxch, dipilih lewat Mixer > titik tiga FX > Effect)
interface FxState { open: boolean; tab: DockTab; view: FxView; nextId: number; patterns: Record<number, FxDevice[]>; master: FxDevice[]; fxch: Record<number, FxDevice[]>; fxSel: number | null }   // fxch = efek per channel FX (kunci = id channel FX di Mixer); fxSel = channel FX yang sedang ditampilkan
export interface PatternInfo { id: number; name: string; color: string; track: number; trackName?: string; audio?: boolean }   // track = track pemilik clip; audio = clip audio (tidak ikut instrumen track)
export type FxEntry = { type: string; on: boolean; params: Record<string, number>; file?: { id: string; name: string }; start?: number; samples?: (SampleRef | null)[]; eq?: number[][]; mix?: SlotMix[] };
export type FxExport = Record<number, FxEntry[]> & { master?: FxEntry[]; tracks?: Record<string, FxEntry[]>; fxch?: Record<string, FxEntry[]> };   // kunci angka = id pattern (hanya module); "tracks" = efek per track (id track -> efek); "master" = efek Master
// Riwayat Undo / Redo panel efek (knob, slider, tombol, tambah / hapus plugin, sample, Master): satu langkah = satu gestur. Host (main.ts) memilih antara ini dan riwayat editor.
export interface FxHistoryHandle {
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean;
  onChange(cb: () => void): () => void;   // isi riwayat berubah (tombol Undo / Redo ikut aktif / mati)
  onEdit(cb: () => void): () => void;     // perubahan baru dibuat pengguna di panel efek (bukan Undo / Redo)
}
export interface FxPanelHandle {
  getState(): FxState;
  history: FxHistoryHandle;
  setOpen(open: boolean): void;
  setTab(tab: DockTab): void;   // buka panel tersebut (kalau sedang tertutup, ikut dibuka)
  setSelTrackProvider(fn: () => number | null): void;   // track yang sedang dipilih di playlist: keyboard komputer membunyikan instrumen track ini tanpa perlu membuka panel keyboard
  setPatterns(list: PatternInfo[]): void;   // daftar pattern terkini (nama + warna + track); dipanggil setiap playlist berubah
  chainFor(clipId: number): FxDevice[];     // daftar device untuk chain audio clip ini: module instrumen track (bersama) + efek track (bersama)
  clipIds(): number[];                      // id semua pattern (clip) yang dikenal panel
  showPattern(id: number | null): void;     // tampilkan efek milik track pattern ini
  dropFile(file: { id: string; name: string }, blob: Blob, clientX: number, clientY: number): boolean;   // file audio dilepas tepat di canvas audio module = tampil sebagai spectrogram
  exportFx(): FxExport;                     // efek semua track (+ module pattern) yang masih ada, untuk disimpan di file project
  importFx(data: unknown): void;            // muat efek dari file project (null/kosong = hapus semua)
  onFxChange(cb: (clipId: number | null) => void): () => void;   // efek pattern berubah (null = semua pattern diganti, mis. impor project)
  onMasterFxChange(cb: () => void): () => void;          // efek Master berubah (juga saat impor project); isinya di getState().master
  onFxChannelFxChange(cb: (id: number | null) => void): () => void;   // efek satu channel FX berubah (null = semua diganti, mis. impor project); isinya di getState().fxch[id]
  mixer: MixerHandle;
  pitch: PitchPanelHandle;
  instrument: VsynthHandle;                              // instrumen vsynth bersama (keyboard, piano roll, playlist)
  sampler: SamplerHandle;                                // mesin Sampler (tanpa Signalsmith, realtime)
  vsynthSource(clipId: number): { src: VSource | null; smp?: SmpSource | null } | null;   // null = pattern tanpa vsynth / Sampler aktif; vsynth: src; Sampler: smp; keduanya null = sampel masih dimuat
  setBlobProvider(fn: (fileId: string) => Blob | null): void;    // ambil file dari panel browser (untuk memuat sampel dari file project)
  onVsynthChange(cb: () => void): () => void;            // sampel dimuat / diganti / titik start berubah
  drumFor(clipId: number): DrumInstrument | null;        // Drum Sequence aktif di pattern ini = instrumennya (nama sample di tuts + pemutar sample asli); null = tidak ada
  onOpenPianoRoll(cb: (clipId: number) => void): () => void;   // tombol Roll di plugin Drum Sequence diketuk
  setPlaying(on: boolean): void;                         // tombol Play di tengah bilah bawah: tampil sebagai Stop saat playlist berjalan
  onPlay(cb: () => void): () => void;                    // tombol Play di bilah bawah diketuk (play / stop playhead playlist)
  onUndo(cb: () => void): () => void;                    // tombol Undo (kanan Play) diketuk: umum, host memilih playlist / piano roll
  onRedo(cb: () => void): () => void;                    // tombol Redo (kanan Play) diketuk
  setHistory(canUndo: boolean, canRedo: boolean): void;  // aktif / matikan tombol Undo / Redo sesuai riwayat editor yang sedang dipakai
  onRewind(cb: () => void): () => void;                  // tombol atur playhead (di kiri Play) diketuk: kembali ke titik tempat Play terakhir
}

const STORE_KEY = 'daw-starter-fx-v2';   // hanya menyimpan buka/tutup panel; efek ikut file project (Ekspor/Impor)

function cleanDevices(raw: unknown, startId: number): { devices: FxDevice[]; nextId: number } {
  const out: FxDevice[] = [];
  let nextId = startId;
  if (Array.isArray(raw)) {
    for (const d of raw as Partial<FxDevice>[]) {
      const def = d && typeof d.type === 'string' ? defOf(d.type) : undefined;
      if (!def) continue;
      const params: Record<string, number> = {};
      for (const p of def.params) {
        const v = d.params?.[p.key];
        params[p.key] = typeof v === 'number' && isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.def;
      }
      const f = d.file, file = f && typeof f.id === 'string' && f.id ? { id: f.id, name: typeof f.name === 'string' ? f.name : f.id } : undefined;
      const samples = def.drum ? cleanSamples(d.samples) : undefined, eq = def.drum ? cleanEq(d.eq) : undefined, mix = def.drum ? cleanMix(d.mix) : undefined;
      out.push({ id: nextId++, type: def.type, on: d.on !== false, params, ...(samples ? { samples } : {}), ...(eq ? { eq } : {}), ...(mix ? { mix } : {}), ...(file ? { file, start: typeof d.start === 'number' && isFinite(d.start) ? Math.min(1, Math.max(0, d.start)) : 0 } : {}) });
    }
  }
  return { devices: out, nextId };
}

function loadState(): FxState {
  const s: FxState = { open: false, tab: 'fx', view: 'track', nextId: 1, patterns: {}, master: [], fxch: {}, fxSel: null };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const v = JSON.parse(raw) as { open?: boolean; tab?: string; view?: string }; s.open = !!v.open; s.view = v.view === 'master' ? 'master' : 'track'; s.tab = v.tab === 'mixer' ? 'mixer' : v.tab === 'pitch' ? 'pitch' : v.tab === 'module' ? 'module' : v.tab === 'tools' ? 'tools' : 'fx'; }
    localStorage.removeItem('daw-starter-fx-v1');   // sisa versi lama (satu deretan efek untuk semua)
  } catch { /* abaikan */ }
  return s;
}

/* ---------- util knob ---------- */
const toNorm = (p: ParamDef, v: number): number =>
  p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
const fromNorm = (p: ParamDef, n: number): number =>
  p.log ? p.min * Math.pow(p.max / p.min, n) : p.min + n * (p.max - p.min);
function fmt(p: ParamDef, v: number): string {
  if (p.unit === 'Hz' && v >= 1000) return (v / 1000).toFixed(2) + ' kHz';
  return (p.bipolar && v > 0 ? '+' : '') + v.toFixed(p.dec) + ' ' + p.unit;
}

export function mountFxPanel(host: HTMLElement, pitchOpts: PitchPanelOptions, toolsOpts?: ToolsPanelOptions): FxPanelHandle {
  const S = loadState();
  let saveTimer = 0;
  const save = (): void => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify({ open: S.open, tab: S.tab, view: S.view })); } catch { /* abaikan */ } }, 300);
  };

  host.innerHTML = '';
  const root = el('section', 'fx');
  const body = el('div', 'fx-body');
  body.id = 'fx-body';
  const chain = el('div', 'fx-chain');
  chain.setAttribute('role', 'list');
  const mixPane = el('div', 'fx-mixer');
  mixPane.id = 'mx-pane';
  const pitchPane = el('div', 'fx-pitch');
  pitchPane.id = 'pt-pane';
  const modPane = el('div', 'fx-module');   // deretan module (plugin buatan sendiri), gaya sama seperti deretan efek
  modPane.id = 'md-pane';
  modPane.setAttribute('role', 'list');
  const mfx = el('div', 'fx-mfx');   // deretan efek Master (tab Efek > Master), gaya sama seperti deretan efek pattern
  mfx.setAttribute('role', 'list');
  // dua tombol vertikal di tepi kanan tab Efek: Master (atas) dan Track (bawah)
  const side = el('div', 'fx-side');
  side.setAttribute('role', 'group'); side.setAttribute('aria-label', 'Sasaran efek');
  const viewBtns = {} as Record<FxView, HTMLButtonElement>;
  for (const [v, label, tip] of [['master', 'Master', 'Efek di output master (semua channel)'], ['fxch', 'FX', 'Efek channel FX yang dipilih dari menu titik tiga di Mixer'], ['track', 'Track', 'Efek milik track terpilih (satu panel untuk semua clip di track itu)']] as [FxView, string, string][]) {
    const b = el('button', 'fx-side-btn', label);
    b.type = 'button'; b.dataset.v = v; b.title = tip;
    b.onclick = () => { S.view = v; if (v !== 'track' && mfxKey !== shownBus()) renderChain(); applyOpen(); save(); };   // Master dan FX berbagi satu deretan: isi ulang kalau yang tampil berbeda
    viewBtns[v] = b; side.appendChild(b);
  }
  const toolsPane = el('div', 'fx-tools');   // panel Tools: deretan kartu tool (registry di src/tools.ts, mis. bpmfind)
  toolsPane.id = 'tl-pane';
  body.append(chain, mfx, side, mixPane, pitchPane, modPane, toolsPane);
  const mixer = mountMixer(mixPane);
  if (toolsOpts) mountToolsPanel(toolsPane, toolsOpts);
  const pitch = mountPitchPanel(pitchPane, pitchOpts);
  const bar = el('div', 'fx-bar');
  const toggle = el('button', 'fx-toggle');
  toggle.setAttribute('aria-controls', 'fx-body');
  const chev = el('span', 'fx-chev');
  const toggleLabel = el('span', 'fx-toggle-label', 'Efek');
  const count = el('span', 'fx-count');
  toggle.append(chev, toggleLabel, count);
  const mixToggle = el('button', 'fx-toggle');
  mixToggle.setAttribute('aria-controls', 'mx-pane');
  const mixSolo = el('span', 'fx-solo', 'S');
  mixSolo.title = 'Ada channel yang di-solo';
  mixSolo.hidden = true;
  mixToggle.append(el('span', 'fx-chev'), el('span', 'fx-toggle-label', 'Mixer'), mixSolo);
  const pitchToggle = el('button', 'fx-toggle');
  pitchToggle.setAttribute('aria-controls', 'pt-pane');
  pitchToggle.append(el('span', 'fx-chev'), el('span', 'fx-toggle-label', 'Sample'));
  const modToggle = el('button', 'fx-toggle');
  modToggle.setAttribute('aria-controls', 'md-pane');
  modToggle.append(el('span', 'fx-chev'), el('span', 'fx-toggle-label', 'Module'));
  const toolsToggle = el('button', 'fx-toggle');
  toolsToggle.setAttribute('aria-controls', 'tl-pane');
  toolsToggle.append(el('span', 'fx-chev'), el('span', 'fx-toggle-label', 'Tools'));
  // tombol Undo / Redo (teks) di kanan Play: umum untuk playlist dan piano roll, host (main.ts) yang memilih editor yang sedang dipakai
  const undoBtn = el('button', 'fx-hist', 'Undo'), redoBtn = el('button', 'fx-hist', 'Redo');
  undoBtn.type = 'button'; redoBtn.type = 'button';
  undoBtn.title = 'Undo (Ctrl+Z)'; redoBtn.title = 'Redo (Ctrl+Shift+Z)';
  const undoListeners = new Set<() => void>(), redoListeners = new Set<() => void>();
  undoBtn.onclick = () => { for (const cb of undoListeners) cb(); };
  redoBtn.onclick = () => { for (const cb of redoListeners) cb(); };
  undoBtn.disabled = true; redoBtn.disabled = true;
  const setHistory = (u: boolean, r: boolean): void => { undoBtn.disabled = !u; redoBtn.disabled = !r; };
  // tombol Play di tengah bilah: play / stop playhead playlist (sama dengan tombol play di penggaris playlist)
  const playBtn = el('button', 'fx-play');
  playBtn.type = 'button';
  const playIcon = el('i');
  playBtn.append(playIcon);
  const playListeners = new Set<() => void>();
  playBtn.onclick = () => { for (const cb of playListeners) cb(); };
  const setPlaying = (on: boolean): void => {
    playBtn.classList.toggle('on', on);
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.setAttribute('aria-label', on ? 'Stop' : 'Play');
    playBtn.title = on ? 'Stop (Spasi)' : 'Play (Spasi)';
  };
  setPlaying(false);
  // tombol atur playhead di kiri Play: kembalikan playhead ke titik tempat Play terakhir dimulai (stop dulu kalau sedang play)
  const rewBtn = el('button', 'fx-rew');
  rewBtn.type = 'button';
  rewBtn.setAttribute('aria-label', 'Kembalikan playhead ke titik Play terakhir');
  rewBtn.title = 'Playhead ke titik Play terakhir';
  rewBtn.append(el('i'));
  const rewListeners = new Set<() => void>();
  rewBtn.onclick = () => { for (const cb of rewListeners) cb(); };
  const mid = el('div', 'fx-mid');   // [Rewind | Play | (kosong)]: sel kanan kosong menjaga Play tetap di tengah
  const midPad = el('span', 'fx-mid-pad');
  midPad.setAttribute('aria-hidden', 'true');
  mid.append(rewBtn, playBtn, midPad);
  const grpL = el('div', 'fx-grp'), grpR = el('div', 'fx-grp');
  grpL.append(toggle, mixToggle, pitchToggle, modToggle);   // semua tombol panel dalam satu deret di kiri Play
  grpR.classList.add('fx-grp-r');
  grpR.append(toolsToggle);   // Play / Rewind / Undo / Redo sekarang ada di bar bawah lama (dock.ts); tombol-tombolnya tidak dipasang di sini
  bar.append(grpL, grpR);   // Efek, Mixer, Sample, Module | Tools
  root.append(pitch.bar, body, bar);   // garis progres pitch di sisi paling atas panel
  host.appendChild(root);

  function applyOpen(): void {
    const fxSelName = S.fxSel == null ? undefined : mixer.getState().fx.find(f => f.id === S.fxSel)?.name;   // channel FX yang dipilih masih ada di Mixer?
    if (fxSelName == null) { S.fxSel = null; if (S.view === 'fxch') S.view = 'track'; }
    root.dataset.open = String(S.open);
    root.dataset.tab = S.tab;
    root.dataset.view = S.view;
    viewBtns.fxch.hidden = fxSelName == null;   // tombol FX hanya muncul setelah channel FX dipilih dari Mixer
    if (fxSelName != null) viewBtns.fxch.textContent = fxSelName;
    for (const v of ['master', 'fxch', 'track'] as FxView[]) { viewBtns[v].classList.toggle('on', S.view === v); viewBtns[v].setAttribute('aria-pressed', String(S.view === v)); }
    const tabs: [HTMLButtonElement, DockTab, string][] = [[toggle, 'fx', 'panel efek'], [mixToggle, 'mixer', 'panel mixer'], [pitchToggle, 'pitch', 'panel sample'], [modToggle, 'module', 'panel module'], [toolsToggle, 'tools', 'panel tools']];
    for (const [btn, tab, name] of tabs) {
      const on = S.open && S.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-expanded', String(on));
      btn.setAttribute('aria-label', (on ? 'Tutup ' : 'Buka ') + name);
    }
    body.toggleAttribute('inert', !S.open);
    if (!(S.open && S.tab === 'module')) closeKbd();
    if (S.open && S.tab === 'pitch') pitch.refresh();
  }
  function setOpen(open: boolean): void { S.open = open; applyOpen(); save(); }
  function setTab(tab: DockTab): void { S.tab = tab; S.open = true; applyOpen(); save(); }
  // ketuk tombol panel yang sedang terbuka = tutup; ketuk tombol panel lain = pindah panel
  const press = (tab: DockTab): void => { if (S.open && S.tab === tab) setOpen(false); else setTab(tab); };
  toggle.onclick = () => press('fx');
  mixToggle.onclick = () => press('mixer');
  pitchToggle.onclick = () => press('pitch');
  modToggle.onclick = () => press('module');
  toolsToggle.onclick = () => press('tools');
  const syncSolo = (): void => { mixSolo.hidden = !mixer.anySolo(); };
  mixer.onChange(syncSolo);
  syncSolo();
  // Mixer > titik tiga channel FX > Effect: buka panel Efek dengan deretan efek khusus channel FX itu (plugin efek yang sama seperti Master / Track)
  mixer.onFxEffect(id => { S.fxSel = id; S.view = 'fxch'; S.tab = 'fx'; S.open = true; renderChain(); applyOpen(); save(); });
  mixer.onFxRemoved(id => {   // channel FX dihapus di Mixer: efeknya ikut dibuang
    const had = (S.fxch[id]?.length ?? 0) > 0;
    delete S.fxch[id];
    if (S.fxSel === id) { S.fxSel = null; if (S.view === 'fxch') S.view = 'track'; }
    if (mfxKey === id) renderChain();
    applyOpen(); save();
    if (had) emitFxCh(id);
  });

  /* ---------- pattern aktif ---------- */
  const info = new Map<number, PatternInfo>();
  let cur: number | null = null;
  const devsOf = (id: number): FxDevice[] => (S.patterns[id] ??= []);
  // Efek (bukan module) dimiliki TRACK: satu track = satu deretan efek / satu panel, dipakai semua clip di track itu
  // (mis. track Audioclip dengan banyak potongan sample: semuanya lewat panel efek yang sama). Disimpan di S.patterns dengan kunci
  // NEGATIF -idTrack (id track selalu > 0, jadi tidak bentrok dengan id pattern); kunci positif hanya berisi module.
  const fxKeyOf = (id: number | null): number | null => { const p = id == null ? undefined : info.get(id); return p ? -p.track : null; };
  const fxUsers = (key: number): number[] => [...info.values()].filter(p => -p.track === key).map(p => p.id);   // semua clip di track pemilik efek
  const trackFxOf = (id: number): FxDevice[] => { const k = fxKeyOf(id); return k == null ? [] : (S.patterns[k] ?? []).filter(d => !isModule(d.type)); };
  const fxDevs = (): FxDevice[] => (cur == null ? [] : trackFxOf(cur));   // isi tab Efek: efek milik track pattern ini
  // Instrumen (module: vsynth / Drum Sequence / ...) dimiliki TRACK: semua pattern di track yang sama memakai instrumen yang sama.
  // Pemilik = pattern itu sendiri kalau dia punya module sendiri (project lama), kalau tidak pattern pertama di track yang sama yang punya module.
  // Pattern baru di kiri / kanan otomatis ikut: sample + nama tuts sama. Clip audio tidak ikut instrumen track.
  const hasMod = (id: number): boolean => (S.patterns[id] ?? []).some(d => isModule(d.type));
  function ownerOf(id: number): number | null {
    if (hasMod(id)) return id;
    const me = info.get(id);
    if (!me || me.audio) return null;
    for (const p of info.values()) if (p.id !== id && p.track === me.track && !p.audio && hasMod(p.id)) return p.id;
    return null;
  }
  const moduleHome = (id: number): number => ownerOf(id) ?? id;   // tempat module disimpan (pemilik, atau pattern ini kalau track belum punya instrumen)
  const usersOf = (home: number): number[] => [...info.keys()].filter(id => id === home || ownerOf(id) === home);   // pattern yang memakai module milik `home`
  const homeOf = (dev: FxDevice): number | null => { for (const [k, list] of Object.entries(S.patterns)) if (list.includes(dev)) return Number(k); return null; };
  const modDevs = (): FxDevice[] => { const h = cur == null ? null : ownerOf(cur); return h == null ? [] : devsOf(h).filter(d => isModule(d.type)); };   // isi tab Module (milik track)
  function chainFor(id: number): FxDevice[] {   // module instrumen (milik track) + efek milik track: sama untuk semua clip di track
    const own = (S.patterns[id] ?? []).filter(d => isModule(d.type));
    const h = own.length ? id : ownerOf(id);
    const mods = own.length ? own : h == null ? [] : devsOf(h).filter(d => isModule(d.type));
    return [...mods, ...trackFxOf(id)];
  }
  const fxListeners = new Set<(id: number | null) => void>();
  const emitFx = (id: number | null): void => { for (const cb of fxListeners) cb(id); };
  const emitTrackFx = (id: number | null): void => {   // efek track berubah: chain semua clip di track itu disamakan
    const k = fxKeyOf(id);
    const ids = k == null ? [] : fxUsers(k);
    if (!ids.length) emitFx(id); else for (const i of ids) emitFx(i);
  };
  const masterListeners = new Set<() => void>();
  const emitMaster = (): void => { for (const cb of masterListeners) cb(); };
  const fxchListeners = new Set<(id: number | null) => void>();
  const emitFxCh = (id: number | null): void => { for (const cb of fxchListeners) cb(id); };
  // "bus" = deretan efek di luar pattern: Master, atau satu channel FX di Mixer. Keduanya memakai kotak yang sama (mfx).
  type BusKey = 'master' | number;
  const fxchList = (id: number): FxDevice[] => (S.fxch[id] ??= []);
  const busKeyOf = (dev: FxDevice): BusKey | null => { if (S.master.includes(dev)) return 'master'; for (const [k, list] of Object.entries(S.fxch)) if (list.includes(dev)) return Number(k); return null; };
  const busListOf = (k: BusKey): FxDevice[] => (k === 'master' ? S.master : fxchList(k));
  const emitBus = (k: BusKey): void => { if (k === 'master') emitMaster(); else emitFxCh(k); };
  const shownBus = (): BusKey => (S.view === 'fxch' && S.fxSel != null ? S.fxSel : 'master');   // deretan yang sedang tampil di kotak mfx
  const fxName = (id: number): string => mixer.getState().fx.find(f => f.id === id)?.name ?? 'FX';
  const emitDev = (dev: FxDevice): void => {   // Sampler: Pitch / Volume langsung ke suara yang berbunyi (realtime); efek Master ke engine Master; module ke semua pattern di track-nya; efek lain ke chain pattern aktif
    if (dev.type === 'sampler') smp.refresh(dev.id);
    const bk = busKeyOf(dev);
    if (bk != null) { emitBus(bk); return; }   // efek Master / channel FX: langsung ke engine
    const h = isModule(dev.type) ? homeOf(dev) : null;
    if (h == null) { emitTrackFx(cur); return; }   // efek biasa: semua clip di track ikut
    const ids = usersOf(h);
    if (!ids.length) emitFx(cur); else for (const id of ids) emitFx(id);
  };
  function updateCount(): void { const n = fxDevs().length; count.textContent = n ? String(n) : ''; }
  let tagEl: HTMLElement | null = null, modTagEl: HTMLElement | null = null;
  // warna pattern dipakai semua plugin lewat --fx-accent; kartu nama dan kepala plugin ikut berwarna
  function paintPattern(): void {
    const p = cur != null ? info.get(cur) : undefined;
    const color = p?.color ?? '#F5A12A';
    root.style.setProperty('--fx-accent', color);
    root.style.setProperty('--fx-ink', inkOn(color));
    pitch.refresh();
    if (tagEl && p) { const n = p.trackName ?? p.name; tagEl.textContent = n; tagEl.title = n; }   // deretan efek = milik track: kartu nama memakai nama track
    if (modTagEl && p) { modTagEl.textContent = p.name; modTagEl.title = p.name; }
  }

  /* ---------- riwayat Undo / Redo panel efek ----------
     Satu langkah = satu gestur: geser knob / slider sampai dilepas, satu ketukan tombol, tambah / hapus plugin, jatuhkan sample, geser titik start, dst.
     Disimpan: snapshot JSON seluruh efek (semua pattern + Master) SEBELUM gestur. Undo / Redo mengubah objek device yang sudah ada di tempat (bukan menggantinya
     dengan objek baru) supaya instrumen drum, Sampler, dan keyboard preview yang memegang objek itu tetap valid. Kartu tidak dibangun ulang kalau susunan plugin
     tidak berubah, jadi halaman Mix drum, scroll, dan keyboard preview tetap di tempatnya. */
  interface HistEntry { state: string; cur: number | null; view: FxView; tab: DockTab }   // cur / view / tab = tampilan saat perubahan dibuat, supaya Undo menampilkan apa yang berubah
  const HIST_MAX = 100;
  const histUndo: HistEntry[] = [], histRedo: HistEntry[] = [];
  const histListeners = new Set<() => void>(), editListeners = new Set<() => void>();
  const known = new Map<number, FxDevice>();   // semua device yang pernah ada (id -> objek): device yang dihapus bisa dihidupkan lagi oleh Undo
  const repaints = new Map<number, Set<() => void>>();   // penggambar ulang kontrol tiap device (knob / slider / tombol) untuk Undo / Redo tanpa membangun ulang kartu
  let restoring = false, hKey = '', hT = 0;
  const regPaint = (dev: FxDevice, fn: () => void): void => { repaints.get(dev.id)?.add(fn); };
  const notifyHist = (): void => { for (const cb of histListeners) cb(); };
  const allDevs = (): FxDevice[] => [...Object.values(S.patterns).flat(), ...S.master, ...Object.values(S.fxch).flat()];
  const devById = (id: number): FxDevice | undefined => allDevs().find(d => d.id === id);
  function snap(): string {
    const p: Record<string, FxDevice[]> = {};
    for (const [k, list] of Object.entries(S.patterns)) { if (list.length) p[k] = list; for (const d of list) known.set(d.id, d); }
    for (const d of S.master) known.set(d.id, d);
    const x: Record<string, FxDevice[]> = {};
    for (const [k, list] of Object.entries(S.fxch)) { if (list.length) x[k] = list; for (const d of list) known.set(d.id, d); }
    return JSON.stringify({ p, m: S.master, x });
  }
  // Mulai satu langkah: panggil SEBELUM mengubah apa pun, lalu panggil fungsi yang dikembalikan setelah gestur selesai (tidak ada perubahan = tidak ada langkah).
  // key: tekanan beruntun pada kontrol yang sama dalam 600 ms (mis. tombol panah) dihitung satu langkah.
  function begin(key?: string): () => void {
    const pre = snap(), ctx = { cur, view: S.view, tab: S.tab };
    return () => {
      if (restoring || snap() === pre) return;
      const now = performance.now();
      if (key && key === hKey && now - hT < 600) { hT = now; return; }
      hKey = key ?? ''; hT = now;
      histUndo.push({ state: pre, ...ctx });
      if (histUndo.length > HIST_MAX) histUndo.shift();
      histRedo.length = 0;
      notifyHist();
      for (const cb of editListeners) cb();
    };
  }
  function histClear(): void { histUndo.length = 0; histRedo.length = 0; hKey = ''; notifyHist(); }
  const sigChain = (id: number): string => JSON.stringify(chainFor(id));
  const structure = (): string => JSON.stringify([Object.entries(S.patterns).filter(([, l]) => l.length).map(([k, l]) => [k, l.map(d => d.id)]), S.master.map(d => d.id), Object.entries(S.fxch).filter(([, l]) => l.length).map(([k, l]) => [k, l.map(d => d.id)])]);
  function applySnap(json: string): void {
    const d = JSON.parse(json) as { p: Record<string, FxDevice[]>; m: FxDevice[]; x?: Record<string, FxDevice[]> };
    const revive = (x: FxDevice): FxDevice => {
      const live = known.get(x.id);
      if (!live) { known.set(x.id, x); return x; }
      live.type = x.type; live.on = x.on;
      Object.assign(live.params, x.params);
      live.file = x.file; live.start = x.start; live.samples = x.samples; live.eq = x.eq; live.mix = x.mix;
      return live;
    };
    const pats: Record<number, FxDevice[]> = {};
    for (const [k, list] of Object.entries(d.p)) pats[Number(k)] = list.map(revive);
    S.patterns = pats;
    S.master = d.m.map(revive);
    const fxIds = new Set(mixer.getState().fx.map(f => f.id)), fxch: Record<number, FxDevice[]> = {};
    for (const [k, list] of Object.entries(d.x ?? {})) if (fxIds.has(Number(k))) fxch[Number(k)] = list.map(revive);   // channel FX yang sudah dihapus di Mixer tidak dihidupkan lagi
    S.fxch = fxch;
  }
  // data runtime yang tidak ikut snapshot (spectrogram / buffer sample, canvas, drum) disamakan dengan device; true = ada kartu yang harus dibangun ulang
  function syncRuntime(): boolean {
    let reload = false;
    for (const dev of allDevs()) {
      const def = defOf(dev.type), fid = dev.file?.id ?? null;
      if (def?.canvas) {
        const v = viewByDev.get(dev.id);
        if (v && v.fid !== fid) { viewByDev.delete(dev.id); viewLoading.delete(dev.id); reload = true; }
        else if (v) { const st = Math.min(1, Math.max(0, dev.start ?? 0)); if (v.start !== st) { v.start = st; paneShow.get(dev.id)?.(v); } }
      }
      if (def?.sampler) {
        const sm = sampByDev.get(dev.id);
        if (sm && sm.fid !== fid) { sampByDev.delete(dev.id); sampLoading.delete(dev.id); reload = true; }
      }
      if (def?.drum) drum.sync(dev);
    }
    return reload;
  }
  function histStep(from: HistEntry[], to: HistEntry[]): void {
    const e = from.pop();
    if (!e) return;
    to.push({ state: snap(), cur: e.cur, view: e.view, tab: e.tab });
    hKey = '';
    const chainsBefore = new Map<number, string>();
    for (const id of info.keys()) chainsBefore.set(id, sigChain(id));
    const fxchBefore = new Map(Object.entries(S.fxch).map(([k, l]) => [k, JSON.stringify(l)] as [string, string])), masterBefore = JSON.stringify(S.master), structBefore = structure(), curBefore = cur, kd = kbdDev?.id ?? null;
    const scroll = [chain.scrollLeft, modPane.scrollLeft, mfx.scrollLeft];
    const revBefore = new Map<number, boolean>();
    for (const d of allDevs()) if (d.type === 'vsynth') revBefore.set(d.id, (d.params.reverse ?? 0) >= 0.5);
    restoring = true;
    try {
      applySnap(e.state);
      if (e.cur != null && info.has(e.cur)) cur = e.cur;
      S.view = e.view;
      if (S.open && (S.tab === 'fx' || S.tab === 'module') && (e.tab === 'fx' || e.tab === 'module')) S.tab = e.tab;
      const reload = syncRuntime();
      if (reload || cur !== curBefore || structure() !== structBefore || mfxKey !== shownBus()) {
        renderChain();
        chain.scrollLeft = scroll[0]; modPane.scrollLeft = scroll[1]; mfx.scrollLeft = scroll[2];
        const nd = kd == null ? undefined : devById(kd), btn = kd == null ? null : root.querySelector<HTMLButtonElement>(`.fx-dev[data-id="${kd}"] .fx-midi`);
        if (nd && btn) toggleKbd(nd, btn);   // keyboard preview yang tadinya terbuka tetap terbuka
      } else for (const set of repaints.values()) for (const fn of set) fn();
      applyOpen(); save();
      for (const d of allDevs()) {   // Reverse vsynth berubah: canvas ikut dibalik
        if (d.type === 'vsynth' && revBefore.has(d.id) && revBefore.get(d.id) !== ((d.params.reverse ?? 0) >= 0.5)) { paneFlip.get(d.id)?.(); watchRender(d.id); }
        if (d.type === 'sampler') smp.refresh(d.id);   // Pitch / Volume Sampler langsung ke suara yang sedang berbunyi
      }
      for (const id of info.keys()) if (sigChain(id) !== chainsBefore.get(id)) emitFx(id);   // hanya chain yang isinya berubah dikirim ke engine (node yang sama dipakai ulang)
      if (JSON.stringify(S.master) !== masterBefore) emitMaster();
      for (const k of new Set([...fxchBefore.keys(), ...Object.keys(S.fxch)])) if (JSON.stringify(S.fxch[Number(k)] ?? []) !== (fxchBefore.get(k) ?? '[]')) emitFxCh(Number(k));   // hanya channel FX yang isinya berubah
      notifyVs(); kbSync();
    } finally { restoring = false; }
    notifyHist();
  }
  const history: FxHistoryHandle = {
    undo: () => histStep(histUndo, histRedo),
    redo: () => histStep(histRedo, histUndo),
    canUndo: () => histUndo.length > 0,
    canRedo: () => histRedo.length > 0,
    onChange(cb) { histListeners.add(cb); return () => { histListeners.delete(cb); }; },
    onEdit(cb) { editListeners.add(cb); return () => { editListeners.delete(cb); }; }
  };

  /* ---------- knob ---------- */
  function makeKnob(dev: FxDevice, p: ParamDef, onValue?: () => void): HTMLElement {
    const wrap = el('div', 'fx-knob');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-label', p.label);
    wrap.setAttribute('aria-valuemin', String(p.min));
    wrap.setAttribute('aria-valuemax', String(p.max));
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    const track = document.createElementNS(SVGNS, 'path');
    track.setAttribute('class', 'k-track'); track.setAttribute('d', arc(15, -135, 135));
    const val = document.createElementNS(SVGNS, 'path');
    val.setAttribute('class', 'k-val');
    const tick = document.createElementNS(SVGNS, 'line');
    tick.setAttribute('class', 'k-tick');
    svg.append(track, val, tick);
    const lab = el('span', 'k-label', p.label);
    const read = el('span', 'k-read');
    wrap.append(svg, lab, read);

    function paint(): void {
      const v = dev.params[p.key];
      const n = Math.min(1, Math.max(0, toNorm(p, v)));
      const a = -135 + n * 270;
      const a0 = p.bipolar ? -135 + Math.min(1, Math.max(0, toNorm(p, 0))) * 270 : -135;   // bipolar: busur mulai dari titik 0
      val.setAttribute('d', Math.abs(a - a0) > 0.6 ? arc(15, a0, a) : '');
      const [x0, y0] = polar(6, a), [x1, y1] = polar(13, a);
      tick.setAttribute('x1', x0.toFixed(2)); tick.setAttribute('y1', y0.toFixed(2));
      tick.setAttribute('x2', x1.toFixed(2)); tick.setAttribute('y2', y1.toFixed(2));
      read.textContent = fmt(p, v);
      wrap.setAttribute('aria-valuenow', v.toFixed(p.dec));
      wrap.setAttribute('aria-valuetext', fmt(p, v));
    }
    function setNorm(n: number): void {
      dev.params[p.key] = fromNorm(p, Math.min(1, Math.max(0, n)));
      paint(); onValue?.(); emitDev(dev); save();
    }
    paint();
    regPaint(dev, () => { paint(); onValue?.(); });   // Undo / Redo: gambar ulang tanpa membangun ulang kartu

    let startY = 0, startN = 0, lastTap = 0, commit: (() => void) | null = null;   // commit = langkah Undo untuk satu gestur
    wrap.addEventListener('pointerdown', e => {
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      wrap.classList.add('drag');
      commit = begin();
      startY = e.clientY; startN = toNorm(p, dev.params[p.key]);
      const now = performance.now();
      if (now - lastTap < 300) { dev.params[p.key] = p.def; paint(); onValue?.(); emitDev(dev); save(); startN = toNorm(p, p.def); }   // ketuk dua kali: kembali ke default
      lastTap = now;
    });
    wrap.addEventListener('pointermove', e => {
      if (!wrap.hasPointerCapture(e.pointerId)) return;
      setNorm(startN + (startY - e.clientY) / 140);
    });
    const end = (e: PointerEvent): void => { wrap.classList.remove('drag'); if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId); commit?.(); commit = null; };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    wrap.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const n = toNorm(p, dev.params[p.key]);
      let to: number | null = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') to = n + step;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') to = n - step;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = 1;
      if (to == null) return;
      e.preventDefault();
      const c = begin(`k${dev.id}.${p.key}`); setNorm(to); c();
    });
    return wrap;
  }

  /* ---------- slider vertikal (layout 'sliders', mis. EQ2): seret naik/turun, ketuk dua kali = kembali ke default ---------- */
  function makeVSlider(dev: FxDevice, p: ParamDef): HTMLElement {
    const wrap = el('div', 'fx-vs');
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'slider');
    wrap.setAttribute('aria-orientation', 'vertical');
    wrap.setAttribute('aria-label', p.label);
    wrap.setAttribute('aria-valuemin', String(p.min));
    wrap.setAttribute('aria-valuemax', String(p.max));
    const read = el('span', 'k-read');
    const track = el('div', 'vs-track');
    const zero = el('i', 'vs-zero');
    const fill = el('i', 'vs-fill');
    const thumb = el('i', 'vs-thumb');
    track.append(zero, fill, thumb);
    const lab = el('span', 'k-label', p.label);
    if (p.kind === 'slider') { wrap.classList.add('mix'); wrap.append(track, lab, read); }   // dicampur dengan knob: urutan track, label, nilai = sama seperti knob, jadi label dan nilai sejajar
    else wrap.append(read, track, lab);
    const z = Math.min(1, Math.max(0, toNorm(p, 0)));   // titik 0 dB di track
    zero.style.bottom = (z * 100) + '%';
    zero.hidden = !p.bipolar;   // garis 0 hanya untuk parameter +/-

    function paint(): void {
      const v = dev.params[p.key];
      const n = Math.min(1, Math.max(0, toNorm(p, v)));
      thumb.style.bottom = (n * 100) + '%';
      fill.style.bottom = (Math.min(n, z) * 100) + '%';
      fill.style.height = (Math.abs(n - z) * 100) + '%';
      read.textContent = p.bipolar ? (v > 0.049 ? '+' : '') + v.toFixed(p.dec) : fmt(p, v);
      wrap.setAttribute('aria-valuenow', v.toFixed(p.dec));
      wrap.setAttribute('aria-valuetext', fmt(p, v));
    }
    function setNorm(n: number): void {
      dev.params[p.key] = fromNorm(p, Math.min(1, Math.max(0, n)));
      paint(); emitDev(dev); save();
    }
    paint();
    regPaint(dev, paint);   // Undo / Redo: gambar ulang tanpa membangun ulang kartu

    const fromY = (y: number): number => { const r = track.getBoundingClientRect(); return r.height > 0 ? 1 - (y - r.top) / r.height : 0; };
    let lastTap = 0, commit: (() => void) | null = null;   // commit = langkah Undo untuk satu gestur
    wrap.addEventListener('pointerdown', e => {
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      wrap.classList.add('drag');
      commit = begin();
      const now = performance.now();
      if (now - lastTap < 300) { dev.params[p.key] = p.def; paint(); emitDev(dev); save(); lastTap = 0; return; }   // ketuk dua kali: kembali ke default
      lastTap = now;
      setNorm(fromY(e.clientY));
    });
    wrap.addEventListener('pointermove', e => { if (wrap.hasPointerCapture(e.pointerId) && wrap.classList.contains('drag') && lastTap) setNorm(fromY(e.clientY)); });
    const end = (e: PointerEvent): void => { wrap.classList.remove('drag'); if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId); commit?.(); commit = null; };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    wrap.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const n = toNorm(p, dev.params[p.key]);
      let to: number | null = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') to = n + step;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') to = n - step;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = 1;
      if (to == null) return;
      e.preventDefault();
      const c = begin(`k${dev.id}.${p.key}`); setNorm(to); c();
    });
    return wrap;
  }

  /* ---------- pratinjau gelombang LFO ---------- */
  function makeLfoView(dev: FxDevice): { node: SVGSVGElement; update: () => void } {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 56');
    svg.setAttribute('class', 'fx-wave');
    svg.setAttribute('aria-hidden', 'true');
    const mid = document.createElementNS(SVGNS, 'line');
    mid.setAttribute('x1', '0'); mid.setAttribute('x2', '120'); mid.setAttribute('y1', '28'); mid.setAttribute('y2', '28');
    mid.setAttribute('class', 'w-mid');
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'w-line');
    svg.append(mid, path);
    const rateDef = defOf('lfo')!.params[0];
    function update(): void {
      const { rate, depth, offset, phase } = dev.params;
      const cycles = 0.5 + Math.min(1, Math.max(0, toNorm(rateDef, rate))) * 9.5;
      const amp = depth / 100 * 24, off = offset / 100 * 24;
      let d = '';
      for (let x = 0; x <= 120; x += 2) {
        const y = 28 - Math.max(-25, Math.min(25, off + amp * Math.sin(2 * Math.PI * (cycles * x / 120 + phase / 360))));
        d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
      }
      path.setAttribute('d', d);
    }
    update();
    return { node: svg, update };
  }

  /* ---------- tombol nyala/mati (param kind 'toggle') ---------- */
  function makeToggle(dev: FxDevice, p: ParamDef): HTMLElement {
    const wrap = el('div', 'fx-tgl');
    const btn = el('button', 'fx-tgl-btn', p.label.slice(0, 3));
    btn.setAttribute('aria-label', p.label);
    const cap = el('span', 'k-label', p.label);
    const paint = (): void => { const on = dev.params[p.key] >= 0.5; btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); };
    btn.onclick = () => {
      const commit = begin();
      dev.params[p.key] = dev.params[p.key] >= 0.5 ? 0 : 1; paint();
      if (dev.type === 'vsynth' && p.key === 'reverse') { paneFlip.get(dev.id)?.(); watchRender(dev.id); }   // canvas audio langsung tampil terbalik + progres di sisi atas panel
      emitDev(dev); save();
      commit();
    };
    paint();
    regPaint(dev, paint);   // Undo / Redo: gambar ulang tanpa membangun ulang kartu
    wrap.append(btn, cap);
    return wrap;
  }

  /* ---------- area canvas audio: file audio dari panel browser dijatuhkan di sini dan ditampilkan sebagai spectrogram ---------- */
  interface CanvasView { serial: number; name: string; fid: string; sp: Spectro; buf: AudioBuffer; v0: number; v1: number; start: number }   // v0..v1 = bagian file yang terlihat (0..1); start = titik start sample (0..1)
  const canvasLoaders = new WeakMap<HTMLElement, (file: { id: string; name: string }, blob: Blob) => Promise<void>>();
  const viewByDev = new Map<number, CanvasView>();   // sementara (sesi ini), per device
  let decodeCtx: AudioContext | null = null;
  let viewSerial = 0;
  const getCtx = (): AudioContext => (decodeCtx ??= new AudioContext());
  const inst = createVsynth(getCtx);   // instrumen vsynth bersama
  const smp = createSampler();         // mesin Sampler (terpisah dari vsynth, tanpa Signalsmith)
  const vsListeners = new Set<() => void>();
  const notifyVs = (): void => { for (const cb of vsListeners) cb(); };
  let blobOf: (id: string) => Blob | null = () => null;
  const paneShow = new Map<number, (v: CanvasView) => void>();
  const paneFlip = new Map<number, () => void>();   // Reverse berubah: tampilan canvas dibalik
  // progres render ulang nada vsynth (setelah Reverse): garis tipis yang sama dengan progres pitch, di sisi atas panel bawah.
  // Nada dirender ditunda sebentar (kbSync / prepareVsynth), jadi garis berjalan tanpa angka dulu; kalau tidak ada nada yang perlu dirender garis hilang sendiri.
  let watch: { id: number; t0: number; seen: boolean } | null = null, watchRaf = 0;
  function watchTick(): void {
    watchRaf = 0;
    const w = watch;
    if (!w) return;
    const p = inst.progress(w.id);
    if (p != null) { w.seen = true; pitch.setExtra(p); }
    else if (!w.seen && performance.now() - w.t0 < 600) pitch.setExtra(0);
    else { watch = null; pitch.setExtra(null); return; }
    watchRaf = requestAnimationFrame(watchTick);
  }
  function watchRender(devId: number): void {
    watch = { id: devId, t0: performance.now(), seen: false };
    pitch.setExtra(0);
    if (!watchRaf) watchRaf = requestAnimationFrame(watchTick);
  }
  const viewLoading = new Map<number, Promise<CanvasView | null>>();
  // muat sampel device dari file panel browser (project yang diimpor / dibuka ulang); panel browser memuat IndexedDB-nya async, jadi dicoba beberapa kali
  function ensureView(dev: FxDevice): Promise<CanvasView | null> {
    const have = viewByDev.get(dev.id);
    if (have) return Promise.resolve(have);
    if (!dev.file) return Promise.resolve(null);
    let p = viewLoading.get(dev.id);
    if (p) return p;
    const fid = dev.file.id, fname = dev.file.name;
    p = (async (): Promise<CanvasView | null> => {
      try {
        let blob = blobOf(fid);
        for (let i = 0; !blob && i < 20; i++) { await new Promise(r => setTimeout(r, 500)); blob = blobOf(fid); }
        if (!blob) return null;
        const buf = await getCtx().decodeAudioData(await blob.arrayBuffer());
        const sp = await computeSpectrogram(buf);
        if (devById(dev.id)?.file?.id !== fid) return null;   // file device sudah berubah (Undo / Redo / file lain) selama dimuat
        const v: CanvasView = { serial: ++viewSerial, name: fname, fid, sp, buf, v0: 0, v1: 1, start: Math.min(1, Math.max(0, dev.start ?? 0)) };
        viewByDev.set(dev.id, v);
        paneShow.get(dev.id)?.(v);
        notifyVs();
        return v;
      } catch { return null; } finally { viewLoading.delete(dev.id); }
    })();
    viewLoading.set(dev.id, p);
    return p;
  }
  // Sampler: sample tunggal tanpa canvas / spectrogram (hanya buffer + nama); dimainkan lewat mesin vsynth yang sama
  const sampByDev = new Map<number, { serial: number; name: string; fid: string; buf: AudioBuffer }>();
  const sampShow = new Map<number, (name: string | null, msg?: string) => void>();
  const sampLoading = new Map<number, Promise<boolean>>();
  const isSampler = (dev: FxDevice): boolean => !!defOf(dev.type)?.sampler;
  async function loadSamp(dev: FxDevice, file: { id: string; name: string }, blob: Blob): Promise<void> {
    const buf = await getCtx().decodeAudioData(await blob.arrayBuffer());
    sampByDev.set(dev.id, { serial: ++viewSerial, name: file.name, fid: file.id, buf });
  }
  function ensureSamp(dev: FxDevice): Promise<boolean> {   // muat sample dari file panel browser (project dibuka ulang / diimpor); browser memuat IndexedDB-nya async, jadi dicoba beberapa kali
    if (sampByDev.has(dev.id)) return Promise.resolve(true);
    if (!dev.file) return Promise.resolve(false);
    let p = sampLoading.get(dev.id);
    if (p) return p;
    const fid = dev.file.id, fname = dev.file.name;
    p = (async (): Promise<boolean> => {
      try {
        let blob = blobOf(fid);
        for (let i = 0; !blob && i < 20; i++) { await new Promise(r => setTimeout(r, 500)); blob = blobOf(fid); }
        if (!blob) { sampShow.get(dev.id)?.(fname, 'File tidak ditemukan'); return false; }
        const buf = await getCtx().decodeAudioData(await blob.arrayBuffer());
        if (devById(dev.id)?.file?.id !== fid) return false;   // file device sudah berubah (Undo / Redo / file lain) selama dimuat
        sampByDev.set(dev.id, { serial: ++viewSerial, name: fname, fid, buf });
        sampShow.get(dev.id)?.(fname);
        notifyVs();
        return true;
      } catch { return false; } finally { sampLoading.delete(dev.id); }
    })();
    sampLoading.set(dev.id, p);
    return p;
  }
  function smpOfDev(dev: FxDevice): SmpSource | null {   // params = objek hidup device: knob / slider yang digeser langsung terbaca suara
    const sm = sampByDev.get(dev.id);
    return sm ? { devId: dev.id, buf: sm.buf, params: dev.params } : null;
  }
  function srcOfDev(dev: FxDevice): VSource | null {   // khusus vsynth (Sampler tidak dirender)
    if (isSampler(dev)) return null;
    const v = viewByDev.get(dev.id);
    if (!v) return null;
    return { devId: dev.id, buf: v.buf, start: v.start, serial: v.serial, pitch: Math.round(dev.params.pitch ?? 0), volume: dev.params.volume ?? 100, speed: dev.params.speed ?? 1, reverse: (dev.params.reverse ?? 0) >= 0.5 };
  }
  function vsynthFor(clipId: number): { src: VSource | null; smp?: SmpSource | null } | null {   // vsynth / Sampler aktif di pattern ini = instrumennya
    const dev = (S.patterns[ownerOf(clipId) ?? clipId] ?? []).find(d => (d.type === 'vsynth' || d.type === 'sampler') && d.on);   // instrumen milik track
    if (!dev) return null;
    if (isSampler(dev)) {
      const sm = smpOfDev(dev);
      if (sm) return { src: null, smp: sm };
      if (dev.file) void ensureSamp(dev);
      return dev.file ? { src: null, smp: null } : null;
    }
    const src = srcOfDev(dev);
    if (src) return { src };
    if (dev.file) { void ensureView(dev); return { src: null }; }
    return null;
  }
  function drumFor(clipId: number): DrumInstrument | null {   // Drum Sequence aktif di pattern ini = instrumennya
    const dev = (S.patterns[ownerOf(clipId) ?? clipId] ?? []).find(d => d.type === 'drumseq' && d.on);   // instrumen milik track
    return dev ? drum.instrument(dev) : null;
  }
  function makeCanvasPane(dev: FxDevice): HTMLElement {
    const box = el('div', 'fx-canvas');
    box.setAttribute('aria-label', 'Canvas audio');
    const cv = document.createElement('canvas');
    cv.className = 'fx-canvas-cv'; cv.width = 400; cv.height = 200; cv.hidden = true;
    const title = el('span', 'fx-canvas-title', 'Canvas audio');
    const hint = el('span', 'fx-canvas-hint', 'Seret file dari browser ke sini');
    const label = el('span', 'fx-canvas-name'); label.hidden = true;
    const zoomBar = el('div', 'fx-canvas-zoom'); zoomBar.hidden = true;
    box.append(cv, title, hint, label, zoomBar);
    let view: CanvasView | null = viewByDev.get(dev.id) ?? null;

    const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
    const minSpan = (): number => (view ? Math.min(1, Math.max(0.002, 0.05 / Math.max(0.05, view.sp.dur))) : 1);   // paling dekat ~50 ms
    function paint(): void {
      if (!view) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(box.clientWidth * dpr), h = Math.round(box.clientHeight * dpr);
      if (w && h && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
      const rev = (dev.params.reverse ?? 0) >= 0.5;
      drawSpectrogram(cv, view.sp, view.v0, view.v1, rev);   // Reverse: spectrogram tampil terbalik (waktu dari ujung file)
      const ctx = cv.getContext('2d');
      const span = view.v1 - view.v0, x = (view.start - view.v0) / span * cv.width;
      if (ctx && x >= -6 && x <= cv.width + 6) {   // garis start sample: tipis, dengan pegangan segitiga kecil di atas
        ctx.fillStyle = ctx.strokeStyle = '#7FE9FF';
        ctx.lineWidth = Math.max(1, Math.round(dpr));
        const px = Math.round(x) + 0.5;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, cv.height); ctx.stroke();
        const t = 4 * dpr;
        ctx.beginPath(); ctx.moveTo(px - t, 0); ctx.lineTo(px + t, 0); ctx.lineTo(px, t * 1.6); ctx.closePath(); ctx.fill();
      }
      label.textContent = `${view.name}${rev ? ' (rev)' : ''} · start ${(view.start * view.sp.dur).toFixed(2)} s · ${(1 / span).toFixed(1)}x`;
    }
    function zoomAt(frac: number, factor: number): void {   // frac = posisi kursor di canvas (0..1), titik itu tetap diam
      if (!view) return;
      const span = view.v1 - view.v0, ns = clamp(span / factor, minSpan(), 1), anchor = view.v0 + frac * span;
      view.v0 = clamp(anchor - frac * ns, 0, 1 - ns); view.v1 = view.v0 + ns;
    }
    function panBy(dfrac: number): void {   // dfrac = pecahan lebar tampilan
      if (!view) return;
      const span = view.v1 - view.v0;
      view.v0 = clamp(view.v0 + dfrac * span, 0, 1 - span); view.v1 = view.v0 + span;
    }
    const resetZoom = (): void => { if (view) { view.v0 = 0; view.v1 = 1; paint(); } };

    for (const [txt, aria, f] of [['−', 'Zoom out', 1 / 1.6], ['+', 'Zoom in', 1.6]] as [string, string, number][]) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = txt; b.setAttribute('aria-label', aria);
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.onclick = () => { zoomAt(0.5, f); paint(); };
      zoomBar.appendChild(b);
    }

    const show = (v: CanvasView): void => {
      view = v;
      cv.hidden = false; title.hidden = true; hint.hidden = true; label.hidden = false; zoomBar.hidden = false;
      box.classList.add('has');
      paint();
    };
    if (view) show(view);
    new ResizeObserver(() => paint()).observe(box);

    // gestur: seret garis start = geser titik start; seret area lain = geser tampilan; scroll / cubit = zoom; klik dua kali = reset zoom
    const ptrs = new Map<number, number>();   // pointerId -> clientX
    let mode: 'none' | 'line' | 'pan' | 'pinch' = 'none', lastX = 0, moved = false, lastTap = 0, pinchD = 0, pinchC = 0, lineCommit: (() => void) | null = null;   // lineCommit = langkah Undo untuk geser titik start
    const lineX = (): number => { const r = box.getBoundingClientRect(); return view ? r.left + (view.start - view.v0) / (view.v1 - view.v0) * r.width : -1e9; };
    const pinchInfo = (): { d: number; c: number } => { const xs = [...ptrs.values()]; return { d: Math.abs(xs[0] - xs[1]), c: (xs[0] + xs[1]) / 2 }; };
    box.addEventListener('pointerdown', e => {
      if (!view || (e.pointerType === 'mouse' && e.button !== 0)) return;
      box.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, e.clientX);
      if (ptrs.size === 1) { mode = Math.abs(e.clientX - lineX()) <= 12 ? 'line' : 'pan'; lastX = e.clientX; moved = false; if (mode === 'line') lineCommit = begin(); }
      else if (ptrs.size === 2) { mode = 'pinch'; const p = pinchInfo(); pinchD = p.d; pinchC = p.c; moved = true; }
      e.preventDefault();
    });
    box.addEventListener('pointermove', e => {
      if (!view) return;
      const r = box.getBoundingClientRect();
      if (!ptrs.has(e.pointerId)) { cv.style.cursor = Math.abs(e.clientX - lineX()) <= 12 ? 'ew-resize' : 'grab'; return; }
      ptrs.set(e.pointerId, e.clientX);
      if (mode === 'line') {
        view.start = clamp(view.v0 + (e.clientX - r.left) / r.width * (view.v1 - view.v0), 0, 1);
        moved = true; paint();
      } else if (mode === 'pan') {
        if (Math.abs(e.clientX - lastX) > 0) moved = true;
        panBy(-(e.clientX - lastX) / r.width); lastX = e.clientX; paint();
      } else if (mode === 'pinch' && ptrs.size >= 2) {
        const p = pinchInfo();
        if (pinchD > 4 && p.d > 4) zoomAt(clamp((p.c - r.left) / r.width, 0, 1), p.d / pinchD);
        panBy(-(p.c - pinchC) / r.width);
        pinchD = p.d; pinchC = p.c; paint();
      }
    });
    const release = (e: PointerEvent): void => {
      if (!ptrs.delete(e.pointerId)) return;
      if (ptrs.size === 1) { mode = 'pan'; lastX = [...ptrs.values()][0]; }
      else if (ptrs.size === 0) {
        if (mode === 'pan' && !moved && e.type === 'pointerup') {   // ketukan ganda = reset zoom
          const now = performance.now();
          if (now - lastTap < 320) { resetZoom(); lastTap = 0; } else lastTap = now;
        }
        if (mode === 'line' && view) { dev.start = view.start; emitFx(cur); notifyVs(); kbSync(); }   // titik start berubah: ikut project, nada dirender ulang
        if (mode === 'line') { lineCommit?.(); lineCommit = null; }
        mode = 'none';
      }
    };
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', release);
    box.addEventListener('wheel', e => {
      if (!view) return;
      e.preventDefault(); e.stopPropagation();
      const r = box.getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) panBy((e.deltaX || e.deltaY) / r.width);
      else zoomAt(clamp((e.clientX - r.left) / r.width, 0, 1), Math.exp(-e.deltaY * 0.002));
      paint();
    }, { passive: false });

    paneShow.set(dev.id, v => show(v));
    // Reverse diketuk: jendela zoom dicerminkan supaya bagian audio yang sama tetap terlihat; titik start tetap pada waktu tampilan (0 = awal tampilan)
    paneFlip.set(dev.id, () => { if (view) { const a = 1 - view.v1, b = 1 - view.v0; view.v0 = a; view.v1 = b; } paint(); });
    if (!view && dev.file) void ensureView(dev);
    canvasLoaders.set(box, async (file, blob) => {
      const name = file.name;
      box.classList.add('busy');
      if (!view) { hint.hidden = false; hint.textContent = 'Membuat spectrogram…'; }
      try {
        decodeCtx ??= new AudioContext();
        const buf = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
        const sp = await computeSpectrogram(buf);
        const v: CanvasView = { serial: ++viewSerial, name, fid: file.id, sp, buf, v0: 0, v1: 1, start: 0 };
        const commit = begin();   // langkah Undo: file canvas diganti
        viewByDev.set(dev.id, v);
        show(v);
        dev.file = { id: file.id, name }; dev.start = 0;   // ikut file project
        emitFx(cur); notifyVs(); kbSync();
        commit();
      } catch {
        if (view) label.textContent = 'Gagal membaca file audio'; else { hint.hidden = false; hint.textContent = 'Gagal membaca file audio'; }
      } finally { box.classList.remove('busy'); }
    });
    return box;
  }
  // Sampler: nama sample hanya teks kecil di kiri atas kartu (kepala kartu), tanpa kotak / canvas; seluruh kartu jadi tempat file dari panel browser dijatuhkan
  function attachSampler(dev: FxDevice, card: HTMLElement, title: HTMLElement): void {
    card.classList.add('fx-drop');
    const show = (n: string | null, msg?: string): void => {
      const t = msg ?? n ?? 'Seret sample ke sini';
      title.textContent = t; title.title = n ?? '';
      title.classList.toggle('empty', !n || !!msg);
    };
    sampShow.set(dev.id, show);
    const have = sampByDev.get(dev.id);
    if (have) show(have.name);
    else if (dev.file) { show(dev.file.name, 'Memuat…'); void ensureSamp(dev); }
    else show(null);
    canvasLoaders.set(card, async (file, blob) => {
      card.classList.add('busy');
      const prev = sampByDev.get(dev.id)?.name ?? null;
      show(prev, 'Memuat…');
      try {
        await loadSamp(dev, file, blob);
        const commit = begin();   // langkah Undo: sample diganti
        dev.file = { id: file.id, name: file.name }; dev.start = 0;   // ikut file project
        show(file.name);
        emitDev(dev); notifyVs(); kbSync(); save();
        commit();
      } catch { show(prev, 'Gagal membaca file audio'); }
      finally { card.classList.remove('busy'); }
    });
  }
  // dipanggil main.ts saat file dilepas di layar: true kalau jatuh tepat di canvas audio sebuah module
  function dropFile(file: { id: string; name: string }, blob: Blob, x: number, y: number): boolean {
    for (const n of document.elementsFromPoint(x, y)) {
      const load = n instanceof HTMLElement && (n.classList.contains('fx-canvas') || n.classList.contains('fx-drop')) ? canvasLoaders.get(n) : undefined;
      if (load) { void load(file, blob); return true; }
    }
    return false;
  }

  const rollListeners = new Set<(id: number) => void>();
  const drum = createDrumSeq({
    getCtx, getBlob: id => blobOf(id), registerDrop: (box, load) => { canvasLoaders.set(box, load); },
    onChange: () => { emitFx(cur); save(); },
    openPianoRoll: () => { if (cur != null) for (const cb of rollListeners) cb(cur); },
    begin: key => begin(key)
  });   // plugin Drum Sequence (drumseq.ts)

  /* ---------- keyboard preview (vsynth): tombol MIDI di kepala plugin membuka papan tuts flat untuk mencoba audio dari canvas ---------- */
  const KB_ROOT = 60;                 // C4 = nada asli file
  const KB_WHITE = 15;                // 2 oktaf + C penutup
  const KB_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const KB_KEYMAP: Record<string, number> = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15 };   // keyboard komputer
  const kbdEl = el('div', 'fx-kbd'); kbdEl.hidden = true;
  const kbTitle = el('span', 'kb-title');
  const kbMinus = el('button', 'kb-btn', '−'), kbPlus = el('button', 'kb-btn', '+');
  kbMinus.setAttribute('aria-label', 'Oktaf turun'); kbPlus.setAttribute('aria-label', 'Oktaf naik');
  const kbRange = el('span', 'kb-range');
  const kbStatus = el('span', 'kb-status');
  const kbClose = el('button', 'fx-del', '×'); kbClose.setAttribute('aria-label', 'Tutup keyboard');
  const kbHead = el('div', 'kb-head');
  kbHead.append(kbTitle, el('span', 'kb-sep'), kbMinus, kbRange, kbPlus, kbStatus, kbClose);
  const kbKeys = el('div', 'kb-keys');
  kbKeys.setAttribute('role', 'group'); kbKeys.setAttribute('aria-label', 'Keyboard preview');
  const kbProg = el('div', 'kb-prog'), kbProgFill = el('i');
  kbProg.appendChild(kbProgFill);
  kbdEl.append(kbHead, kbProg, kbKeys);
  root.insertBefore(kbdEl, bar);

  let kbdDev: FxDevice | null = null, kbdBtn: HTMLButtonElement | null = null, kbBase = 48, kbTimer = 0;   // kbBase = nada paling kiri (C3)
  const keyEls = new Map<number, HTMLElement>();
  const voices = new Map<string, VVoice>();
  const heldKeys = new Map<string, HTMLElement>();
  const noteName = (m: number): string => KB_NAMES[m % 12] + (Math.floor(m / 12) - 1);
  const kbSrc = (): VSource | null => (kbdDev ? srcOfDev(kbdDev) : null);   // vsynth saja; Sampler tidak punya render
  const kbWanted = (): number[] => Array.from({ length: 25 }, (_, i) => kbBase + i);

  function buildKeys(): void {
    kbKeys.textContent = ''; keyEls.clear();
    const whites = el('div', 'kb-white');
    kbKeys.appendChild(whites);
    let wi = 0;
    for (let n = 0; wi < KB_WHITE; n++) {   // berhenti tepat setelah C penutup (tanpa tuts hitam di luar jangkauan)
      const midi = kbBase + n, pc = n % 12, black = [1, 3, 6, 8, 10].includes(pc);
      const k = el('div', 'kb-key ' + (black ? 'b' : 'w'));
      k.dataset.midi = String(midi);
      if (black) {
        const wpct = 100 / KB_WHITE, bw = wpct * 0.6;
        k.style.left = `calc(${wi * wpct}% - ${bw / 2}%)`; k.style.width = bw + '%';
        kbKeys.appendChild(k);
      } else {
        if (pc === 0) k.textContent = noteName(midi);
        if (midi === KB_ROOT) k.classList.add('root');
        whites.appendChild(k); wi++;
      }
      keyEls.set(midi, k);
    }
    kbRange.textContent = `${noteName(kbBase)}–${noteName(kbBase + 24)}`;
    kbMinus.disabled = kbBase <= 24; kbPlus.disabled = kbBase >= 84;
    markKeys();
  }
  function markKeys(): void {   // tuts yang belum selesai dirender diredupkan
    const src = kbSrc();   // Sampler: semua tuts langsung siap (tanpa render)
    for (const [m, k] of keyEls) k.classList.toggle('wait', !!src && !inst.get(src, m));
  }
  function refreshKbd(): void {   // judul + status (nama file, start, progres render) untuk device yang sedang membuka keyboard
    if (!kbdDev) return;
    const isSmp = isSampler(kbdDev), v = isSmp ? sampByDev.get(kbdDev.id) : viewByDev.get(kbdDev.id), src = kbSrc();
    const total = 25, done = isSmp ? total : src ? inst.ready(src, kbWanted()) : 0;
    kbTitle.textContent = `${defOf(kbdDev.type)?.name ?? 'Module'} · Keyboard`;
    kbStatus.textContent = !v || (!isSmp && !src) ? (isSmp ? 'Belum ada sample: jatuhkan file di slot Sample' : 'Belum ada audio: jatuhkan file di Canvas audio')
      : done < total ? `Menyiapkan nada ${done}/${total}…`
      : `${v.name}${isSmp ? '' : ` · start ${((v as CanvasView).start * v.buf.duration).toFixed(2)} s`} · ${noteName(KB_ROOT)} = asli`;
    kbStatus.title = kbStatus.textContent;
    kbProg.hidden = !v || done >= total;
    kbProgFill.style.width = (done / total * 100) + '%';
  }
  // dipanggil tiap pengaturan berubah (file, start, Pitch / Speed / Reverse, oktaf): nada yang terlihat dirender (ditunda sebentar); render lama dibuang oleh instrumen
  function kbSync(): void {
    if (!kbdDev) return;
    markKeys(); refreshKbd();
    clearTimeout(kbTimer);
    kbTimer = window.setTimeout(() => {
      const src = kbSrc();
      if (!src) return;
      for (const m of kbWanted().sort((a, b) => Math.abs(a - KB_ROOT) - Math.abs(b - KB_ROOT))) inst.request(src, m, 6, false);
      markKeys(); refreshKbd();
    }, 220);
  }
  inst.onChange(() => { if (kbdDev) { markKeys(); refreshKbd(); } });

  // Instrumen untuk keyboard komputer saat panel keyboard preview TERTUTUP: module instrumen (vsynth / Sampler, yang menyala) milik track pattern yang sedang dipilih
  let selTrackOf: () => number | null = () => null;
  function quickDev(): FxDevice | null {
    // track yang dipilih di playlist; kalau belum ada penyedianya / tidak ada track terpilih, pakai pattern yang sedang tampil di panel
    const tid = selTrackOf();
    let from: number | null = cur;
    if (tid != null) {
      from = null;
      for (const p of info.values()) if (p.track === tid && !p.audio && ownerOf(p.id) != null) { from = p.id; break; }
    }
    const h = from == null ? null : ownerOf(from);
    if (h == null) return null;
    return devsOf(h).find(d => { const df = defOf(d.type); return d.on && !!df && isModule(d.type) && (df.canvas || df.sampler); }) ?? null;
  }
  function noteOn(id: string, midi: number, keyEl: HTMLElement | undefined, quick?: FxDevice): void {
    const dev = quick ?? kbdDev;
    if (!dev) return;
    const preview = !quick;   // tanpa panel: tidak ada tuts / status yang perlu diperbarui
    if (keyEl) { keyEl.classList.add('on'); heldKeys.set(id, keyEl); }
    voices.get(id)?.stop();
    const ctx = getCtx(); void ctx.resume();
    if (isSampler(dev)) {   // Sampler: langsung bunyi (tanpa render / Signalsmith)
      const sm = smpOfDev(dev);
      if (!sm) { if (preview) refreshKbd(); else if (dev.file) void ensureSamp(dev); return; }
      voices.set(id, smp.play(sm, midi, 1, null, undefined, ctx.destination));
      return;
    }
    const src = srcOfDev(dev);
    if (!src) { if (preview) refreshKbd(); return; }
    voices.set(id, inst.play(src, midi, 1, null, undefined, ctx.destination));   // belum dirender: bunyi begitu selesai
  }
  function noteOff(id: string, visual = true): void {
    if (visual) {
      const k = heldKeys.get(id);
      heldKeys.delete(id);
      if (k && ![...heldKeys.values()].includes(k)) k.classList.remove('on');
    }
    voices.get(id)?.stop();
    voices.delete(id);
  }
  const releaseAll = (): void => { for (const id of [...voices.keys(), ...heldKeys.keys()]) noteOff(id); };

  // sentuh / mouse: tekan = bunyi, geser ke tuts lain = ganti nada (glissando), lepas = berhenti
  const keyAt = (x: number, y: number): HTMLElement | null => document.elementFromPoint(x, y)?.closest<HTMLElement>('.kb-key') ?? null;
  const downKey = new Map<number, HTMLElement>();
  kbKeys.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const k = keyAt(e.clientX, e.clientY);
    if (!k) return;
    kbKeys.setPointerCapture(e.pointerId);
    downKey.set(e.pointerId, k);
    noteOn('p' + e.pointerId, +k.dataset.midi!, k);
    e.preventDefault();
  });
  kbKeys.addEventListener('pointermove', e => {
    const cur = downKey.get(e.pointerId);
    if (!cur) return;
    const k = keyAt(e.clientX, e.clientY);
    if (k && k !== cur) { noteOff('p' + e.pointerId); downKey.set(e.pointerId, k); noteOn('p' + e.pointerId, +k.dataset.midi!, k); }
  });
  const kbUp = (e: PointerEvent): void => { if (downKey.delete(e.pointerId)) noteOff('p' + e.pointerId); };
  kbKeys.addEventListener('pointerup', kbUp);
  kbKeys.addEventListener('pointercancel', kbUp);
  kbKeys.addEventListener('contextmenu', e => e.preventDefault());

  // keyboard komputer: A W S E D F T G Y H U J K O L P = C sampai D# oktaf berikutnya
  const onKbdKey = (e: KeyboardEvent): void => {
    if (!kbdDev) return;
    const t = (e.target as HTMLElement | null)?.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (e.type === 'keydown' && k === 'escape') { closeKbd(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || !(k in KB_KEYMAP)) return;
    e.preventDefault();
    if (e.type === 'keyup') { noteOff('k' + k); return; }
    if (e.repeat) return;
    const midi = kbBase + KB_KEYMAP[k];
    noteOn('k' + k, midi, keyEls.get(midi));
  };
  // keyboard komputer tanpa membuka panel: asal ada track (pattern) yang dipilih, tombol yang sama (A W S E D F T G Y H U J K O L P) langsung membunyikan instrumen track itu.
  // Saat panel keyboard preview terbuka, onKbdKey yang menangani (instrumen plugin yang dibuka panelnya).
  const quickHeld = new Set<string>();
  const onQuickKey = (e: KeyboardEvent): void => {
    if (kbdDev) return;
    const el0 = e.target as HTMLElement | null, t = el0?.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || el0?.isContentEditable) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey || !(k in KB_KEYMAP)) return;
    if (e.type === 'keyup') { if (quickHeld.delete(k)) noteOff('k' + k, false); return; }
    const dev = quickDev();
    if (!dev) return;
    e.preventDefault();
    if (e.repeat) return;
    quickHeld.add(k);
    noteOn('k' + k, kbBase + KB_KEYMAP[k], undefined, dev);
  };
  window.addEventListener('keydown', onQuickKey); window.addEventListener('keyup', onQuickKey);
  window.addEventListener('blur', () => { if (!kbdDev) { for (const k of [...quickHeld]) noteOff('k' + k, false); quickHeld.clear(); } });
  function closeKbd(): void {
    releaseAll(); downKey.clear();
    clearTimeout(kbTimer);
    window.removeEventListener('keydown', onKbdKey); window.removeEventListener('keyup', onKbdKey); window.removeEventListener('blur', releaseAll);
    kbdEl.hidden = true; kbdDev = null;
    if (kbdBtn) { kbdBtn.setAttribute('aria-pressed', 'false'); kbdBtn = null; }
  }
  function toggleKbd(dev: FxDevice, btn: HTMLButtonElement): void {
    if (kbdDev?.id === dev.id) { closeKbd(); return; }
    closeKbd();
    kbdDev = dev; kbdBtn = btn; btn.setAttribute('aria-pressed', 'true');
    buildKeys(); refreshKbd();
    kbdEl.hidden = false;
    kbSync();
    window.addEventListener('keydown', onKbdKey); window.addEventListener('keyup', onKbdKey); window.addEventListener('blur', releaseAll);
  }
  kbClose.onclick = closeKbd;
  fxListeners.add(() => kbSync());   // knob Pitch / Speed / Reverse berubah
  kbMinus.onclick = () => { releaseAll(); kbBase = Math.max(24, kbBase - 12); buildKeys(); kbSync(); };
  kbPlus.onclick = () => { releaseAll(); kbBase = Math.min(84, kbBase + 12); buildKeys(); kbSync(); };

  /* ---------- device ---------- */
  function renderDevice(dev: FxDevice): HTMLElement {
    const def = defOf(dev.type)!;
    const card = el('div', 'fx-dev');
    card.setAttribute('role', 'listitem');
    card.dataset.type = dev.type;
    card.dataset.id = String(dev.id);
    card.classList.toggle('off', !dev.on);
    repaints.set(dev.id, new Set());   // kontrol kartu ini mendaftarkan penggambar ulangnya (lihat regPaint)

    const head = el('div', 'fx-dev-head');
    const power = el('button', 'fx-power');
    power.setAttribute('aria-label', `Aktifkan ${def.name}`);
    power.setAttribute('aria-pressed', String(dev.on));
    power.onclick = () => {
      const commit = begin();
      dev.on = !dev.on;
      power.setAttribute('aria-pressed', String(dev.on));
      card.classList.toggle('off', !dev.on);
      emitDev(dev); save();
      commit();
    };
    regPaint(dev, () => { power.setAttribute('aria-pressed', String(dev.on)); card.classList.toggle('off', !dev.on); });   // Undo / Redo
    const name = el('span', 'fx-dev-name', def.name);
    const del = el('button', 'fx-del', '×');
    del.setAttribute('aria-label', `Hapus ${def.name}`);
    let delTimer = 0;
    del.onclick = () => {
      if (del.classList.contains('arm')) {
        const commit = begin();   // langkah Undo: plugin ini dihapus (Undo menghidupkannya lagi dengan semua pengaturannya)
        repaints.delete(dev.id);
        const bk = busKeyOf(dev);
        if (bk != null) { const rest = busListOf(bk).filter(d => d.id !== dev.id); if (bk === 'master') S.master = rest; else S.fxch[bk] = rest; card.remove(); emitBus(bk); save(); commit(); return; }   // efek Master / channel FX
        if (isModule(dev.type)) {   // module dihapus dari pemiliknya: berlaku untuk semua pattern di track
          const h = homeOf(dev), ids = h == null ? [] : usersOf(h);
          if (h != null) S.patterns[h] = devsOf(h).filter(d => d.id !== dev.id);
          card.remove(); if (!ids.length) emitFx(cur); else for (const id of ids) emitFx(id);
          renderChain(); save(); commit();
          return;
        }
        const fk = fxKeyOf(cur);
        if (fk != null) S.patterns[fk] = devsOf(fk).filter(d => d.id !== dev.id);   // efek milik track: hilang dari semua clip di track
        card.remove(); updateCount(); emitTrackFx(cur); save(); commit();
        return;
      }
      del.classList.add('arm'); del.textContent = 'Hapus?';
      clearTimeout(delTimer);
      delTimer = window.setTimeout(() => { del.classList.remove('arm'); del.textContent = '×'; }, 2500);
    };
    if (def.canvas || def.sampler) {   // tombol MIDI kecil di sebelah tombol ×: buka / tutup keyboard preview
      const midi = el('button', 'fx-midi');
      midi.setAttribute('aria-label', `Keyboard preview ${def.name}`);
      midi.title = 'Keyboard preview';
      midi.setAttribute('aria-pressed', String(kbdDev?.id === dev.id));
      midi.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="3.9" cy="8.2" r="1" fill="currentColor"/><circle cx="5.1" cy="5.3" r="1" fill="currentColor"/><circle cx="8" cy="4.1" r="1" fill="currentColor"/><circle cx="10.9" cy="5.3" r="1" fill="currentColor"/><circle cx="12.1" cy="8.2" r="1" fill="currentColor"/><path d="M6.2 11.6h3.6" stroke="currentColor" stroke-width="1.3"/></svg>';
      midi.addEventListener('pointerdown', e => e.stopPropagation());
      midi.onclick = () => toggleKbd(dev, midi);
      head.append(power, name, midi, del);
    } else head.append(power, name, del);

    if (def.sampler) { const t = el('span', 'fx-smp-title'); name.after(t); name.style.flex = 'none'; attachSampler(dev, card, t); }   // nama sample: teks kecil di kiri atas kartu
    const knobs = el('div', 'fx-knobs');
    let lfo: { node: SVGSVGElement; update: () => void } | null = null;
    if (dev.type === 'lfo') { lfo = makeLfoView(dev); knobs.appendChild(lfo.node); }
    if (def.canvas) knobs.appendChild(makeCanvasPane(dev));
    const drumView = def.drum ? drum.build(dev) : null;
    if (drumView) knobs.appendChild(drumView.main);
    if (def.layout === 'sliders') { knobs.classList.add('fx-sliders'); for (const p of def.params) knobs.appendChild(makeVSlider(dev, p)); }
    else for (const p of def.params) knobs.appendChild(p.kind === 'toggle' ? makeToggle(dev, p) : p.kind === 'slider' ? makeVSlider(dev, p) : makeKnob(dev, p, lfo ? lfo.update : undefined));   // knob + slider boleh campur
    if (drumView) { knobs.appendChild(drumView.mixBtn); knobs.appendChild(drumView.rollBtn); }   // tombol menuju bagian mixing plugin + tombol piano roll
    card.append(head, knobs);
    return card;
  }

  /* ---------- slot tambah (+): satu untuk deretan efek, satu untuk deretan module ---------- */
  function makeAddSlot(defs: DeviceDef[], title: string | (() => string), container: HTMLElement, master = false): { slot: HTMLElement; render: (choosing: boolean) => void } {
    const slot = el('div', 'fx-add');
    const render = (choosing: boolean): void => {
      const ttl = typeof title === 'function' ? title() : title;
      slot.innerHTML = '';
      slot.classList.toggle('choosing', choosing);
      if (!choosing) {
        const b = el('button', 'fx-add-btn', '+');
        b.setAttribute('aria-label', ttl);
        b.onclick = () => render(true);
        slot.appendChild(b);
        return;
      }
      slot.appendChild(el('div', 'fx-add-title', ttl));
      const grid = el('div', 'fx-add-grid');   // daftar jenis efek: 5 tombol per baris
      for (const d of defs) {
        const b = el('button', 'fx-add-type', d.name);
        b.onclick = () => addDevice(d.type, container, slot, render, master);
        grid.appendChild(b);
      }
      slot.appendChild(grid);
      const cancel = el('button', 'fx-add-cancel', 'Batal');
      cancel.onclick = () => render(false);
      slot.appendChild(cancel);
    };
    return { slot, render };
  }
  function addDevice(type: string, container: HTMLElement, slot: HTMLElement, render: (choosing: boolean) => void, master = false): void {
    const def = defOf(type)!;
    const params: Record<string, number> = {};
    for (const p of def.params) params[p.key] = p.def;
    if (!master && cur == null) return;   // efek Master tidak butuh pattern terpilih
    const commit = begin();   // langkah Undo: plugin ditambah
    const dev: FxDevice = { id: S.nextId++, type, on: true, params };
    const isMod = !master && container === modPane;
    const home = isMod ? moduleHome(cur!) : fxKeyOf(cur);   // module: pattern pemilik instrumen; efek: kunci track (negatif)
    if (master) busListOf(shownBus()).push(dev); else devsOf(home!).push(dev);
    const node = renderDevice(dev);
    container.insertBefore(node, slot);
    render(false);
    if (master) emitBus(shownBus());
    else if (isMod) { for (const id of usersOf(home!)) emitFx(id); if (home !== cur) renderChain(); }   // module baru = instrumen track: semua pattern di track ikut
    else { updateCount(); emitTrackFx(cur); }   // efek baru berlaku untuk semua clip di track
    save();
    commit();
    requestAnimationFrame(() => { container.scrollTo({ left: container.scrollWidth, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); });
  }
  const fxAdd = makeAddSlot(DEVICES, 'Tambah efek', chain);
  const modAdd = makeAddSlot(MODULES, 'Tambah module', modPane);
  const mfxAdd = makeAddSlot(DEVICES, () => { const k = shownBus(); return k === 'master' ? 'Tambah efek Master' : 'Tambah efek ' + fxName(k); }, mfx, true);   // hanya efek (bukan module): module = instrumen per pattern

  /* ---------- isi deretan: kartu nama (track untuk efek, pattern untuk module) di kiri, lalu isinya ---------- */
  function renderList(box: HTMLElement, devs: FxDevice[], add: { slot: HTMLElement; render: (c: boolean) => void }): HTMLElement | null {
    box.innerHTML = '';
    if (cur == null) { box.appendChild(el('div', 'fx-empty', 'Pilih pattern di playlist untuk melihat isinya')); return null; }
    const tag = el('div', 'fx-tag');
    box.appendChild(tag);
    for (const dev of devs) box.appendChild(renderDevice(dev));
    box.appendChild(add.slot);
    add.render(false);
    box.scrollLeft = 0;
    return tag;
  }
  let mfxKey: BusKey = 'master';   // deretan yang sedang dibangun di kotak mfx: Master atau id channel FX
  function renderMaster(): void {   // deretan efek Master / channel FX: tidak tergantung pattern terpilih
    mfx.innerHTML = '';
    mfxKey = shownBus();
    const tag = el('div', 'fx-tag', mfxKey === 'master' ? 'Master' : fxName(mfxKey));
    mfx.appendChild(tag);
    for (const dev of busListOf(mfxKey)) mfx.appendChild(renderDevice(dev));
    mfx.appendChild(mfxAdd.slot);
    mfxAdd.render(false);
    mfx.scrollLeft = 0;
  }
  function renderChain(): void {   // isi ulang tab Efek dan tab Module untuk pattern aktif (+ deretan Master)
    closeKbd();
    repaints.clear();   // kartu lama dibuang; renderDevice mendaftarkan ulang kontrol kartu yang baru
    renderMaster();
    tagEl = renderList(chain, fxDevs(), fxAdd);
    modTagEl = renderList(modPane, modDevs(), modAdd);
    updateCount(); paintPattern();
  }
  renderChain();
  applyOpen();

  function showPattern(id: number | null): void {
    if (id != null && !info.has(id)) id = null;
    if (id === cur) return;
    cur = id;
    renderChain();
  }
  const lastOwner = new Map<number, number | null>(), lastTrack = new Map<number, number>();
  function setPatterns(list: PatternInfo[]): void {
    const old = new Map(info);
    info.clear();
    for (const p of list) info.set(p.id, p);
    // pemilik instrumen track dihapus: module-nya pindah ke pattern lain di track yang sama supaya instrumen track tidak hilang
    for (const [id, o] of old) {
      if (info.has(id) || o.audio || !hasMod(id)) continue;
      const mates = [...info.values()].filter(p => p.track === o.track && !p.audio);
      if (!mates.length || mates.some(p => hasMod(p.id))) continue;
      const heir = mates[0].id, mods = S.patterns[id].filter(d => isModule(d.type));
      S.patterns[id] = S.patterns[id].filter(d => !isModule(d.type));
      S.patterns[heir] = [...mods, ...devsOf(heir)];
      histClear();   // pemilik module pindah di luar panel efek: snapshot lama menyimpan pemilik yang sudah tidak ada, jadi riwayat dimulai dari sini
    }
    // pattern yang pemilik instrumennya berubah (pattern baru di track, pemilik pindah): chain audio disamakan, tab Module ikut
    // clip pindah track / clip baru di track yang sudah punya efek: chain-nya ikut efek track yang baru
    const changed: number[] = [];
    for (const [id, p] of info) {
      const o = ownerOf(id), ownerChanged = lastOwner.get(id) !== o, trackChanged = lastTrack.get(id) !== p.track, seen = lastTrack.has(id);
      lastOwner.set(id, o); lastTrack.set(id, p.track);
      if ((ownerChanged && o != null) || (trackChanged && (seen || (S.patterns[-p.track]?.length ?? 0) > 0))) changed.push(id);
    }
    for (const id of [...lastOwner.keys()]) if (!info.has(id)) { lastOwner.delete(id); lastTrack.delete(id); }
    if (cur != null && !info.has(cur)) { cur = null; renderChain(); }
    else if (cur != null && changed.includes(cur)) renderChain();
    else paintPattern();
    for (const id of changed) emitFx(id);
  }
  const serFx = (devs: FxDevice[]): FxEntry[] => devs.map(d => ({ type: d.type, on: d.on, params: { ...d.params }, ...(d.samples?.some(Boolean) ? { samples: d.samples.map(x => (x ? { ...x } : null)) } : {}), ...(cleanEq(d.eq) ? { eq: d.eq!.map(r => [...r]) } : {}), ...(cleanMix(d.mix) ? { mix: d.mix!.map(m => ({ ...m })) } : {}), ...(d.file ? { file: { ...d.file }, start: d.start ?? 0 } : {}) }));
  function exportFx(): FxExport {
    const out: FxExport = {};
    const live = new Set<number>([...info.values()].map(p => p.track));   // track yang masih ada: punya clip, atau masih punya channel di Mixer
    for (const t of Object.keys(mixer.getState().chans)) live.add(Number(t));
    const tracks: Record<string, FxEntry[]> = {};
    for (const k of Object.keys(S.patterns)) {
      const id = Number(k);
      if (!S.patterns[id].length) continue;
      if (id < 0) { if (live.has(-id)) tracks[String(-id)] = serFx(S.patterns[id]); continue; }   // efek milik track (kunci "tracks": id track -> efek)
      if (!info.has(id)) continue;
      out[id] = serFx(S.patterns[id]);   // module instrumen milik pattern
    }
    if (Object.keys(tracks).length) out.tracks = tracks;
    if (S.master.length) out.master = serFx(S.master);   // efek Master ikut file project (kunci "master")
    const fxIds = new Set(mixer.getState().fx.map(f => f.id)), fxch: Record<string, FxEntry[]> = {};
    for (const [k, list] of Object.entries(S.fxch)) if (list.length && fxIds.has(Number(k))) fxch[k] = serFx(list);
    if (Object.keys(fxch).length) out.fxch = fxch;   // efek channel FX ikut file project (kunci "fxch": id channel FX -> efek)
    return out;
  }
  // project lama menyimpan efek per clip: pindahkan ke track-nya. Clip pertama (id terkecil) di track yang punya efek menang, efek clip lain di track yang sama
  // dibuang supaya tidak jadi dobel (kalau file sudah punya "tracks" untuk track itu, efek lama tidak menimpanya). Module tetap di clip pemiliknya.
  function migrateLegacyFx(): void {
    for (const id of Object.keys(S.patterns).map(Number).filter(k => k > 0).sort((a, b) => a - b)) {
      const p = info.get(id), list = S.patterns[id];
      if (!p || !list.some(d => !isModule(d.type))) continue;
      S.patterns[id] = list.filter(d => isModule(d.type));
      if (!S.patterns[-p.track]?.length) S.patterns[-p.track] = list.filter(d => !isModule(d.type));
    }
  }
  function importFx(data: unknown): void {
    histClear(); known.clear();   // project baru / dibuka: riwayat efek project lama dibuang
    S.patterns = {};
    S.master = [];
    S.fxch = {}; S.fxSel = null; if (S.view === 'fxch') S.view = 'track';
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        if (k === 'master') { const r = cleanDevices(v, S.nextId); S.nextId = r.nextId; S.master = r.devices.filter(d => !isModule(d.type)); continue; }
        if (k === 'tracks') {   // efek per track: id track -> daftar efek (hanya efek, bukan module)
          if (v && typeof v === 'object') for (const [tk, tv] of Object.entries(v as Record<string, unknown>)) {
            const tid = Number(tk);
            if (!Number.isInteger(tid) || tid <= 0) continue;
            const tr = cleanDevices(tv, S.nextId);
            S.nextId = tr.nextId;
            const dv = tr.devices.filter(d => !isModule(d.type));
            if (dv.length) S.patterns[-tid] = dv;
          }
          continue;
        }
        if (k === 'fxch') {   // efek per channel FX: id channel FX -> daftar efek (hanya efek, bukan module)
          if (v && typeof v === 'object') for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) {
            const fid = Number(fk);
            if (!Number.isInteger(fid) || fid <= 0) continue;
            const fr = cleanDevices(fv, S.nextId);
            S.nextId = fr.nextId;
            const dv = fr.devices.filter(d => !isModule(d.type));
            if (dv.length) S.fxch[fid] = dv;
          }
          continue;
        }
        const id = Number(k);
        if (!Number.isFinite(id) || id <= 0) continue;
        const r = cleanDevices(v, S.nextId);
        S.nextId = r.nextId;
        if (r.devices.length) S.patterns[id] = r.devices;
      }
      migrateLegacyFx();
    }
    cur = null;
    renderChain();
    applyOpen();
    emitFx(null);
    emitMaster();
    emitFxCh(null);
  }

  // geser horizontal dengan roda mouse di desktop
  for (const box of [chain, modPane, mfx]) box.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { box.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  return { getState: () => S, history, onUndo(cb) { undoListeners.add(cb); return () => { undoListeners.delete(cb); }; }, onRedo(cb) { redoListeners.add(cb); return () => { redoListeners.delete(cb); }; }, setHistory, dropFile, instrument: inst, sampler: smp, vsynthSource: vsynthFor, drumFor, onOpenPianoRoll(cb) { rollListeners.add(cb); return () => { rollListeners.delete(cb); }; }, setBlobProvider: fn => { blobOf = fn; }, onVsynthChange: cb => { vsListeners.add(cb); return () => { vsListeners.delete(cb); }; }, setSelTrackProvider: fn => { selTrackOf = fn; }, setPlaying, onPlay(cb) { playListeners.add(cb); return () => { playListeners.delete(cb); }; }, onRewind(cb) { rewListeners.add(cb); return () => { rewListeners.delete(cb); }; }, setOpen, setTab, setPatterns, chainFor, clipIds: () => [...info.keys()], showPattern, exportFx, importFx, mixer, pitch, onFxChange(cb) { fxListeners.add(cb); return () => { fxListeners.delete(cb); }; }, onMasterFxChange(cb) { masterListeners.add(cb); return () => { masterListeners.delete(cb); }; }, onFxChannelFxChange(cb) { fxchListeners.add(cb); return () => { fxchListeners.delete(cb); }; } };
}
