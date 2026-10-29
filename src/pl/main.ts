import { initLandscape } from './landscape';
import './style.css';
import { mountPlaylist, demoState, type PLClip, type PLNote, type PlaylistState, type PlaylistCanvasHandle } from './playlist-canvas';
import { mountPianoRoll, type PianoRollCanvasHandle } from './piano-roll-canvas';
import { mountFxPanel, type FxPanelHandle } from './fx-panel';
import { mountDock, type Dock } from './dock';   // bar bawah LAMA (transport + metronome + undo / redo)
import { mountBrowser } from './browser-panel';
import { mountProjectPanel, type ProjectPanelHandle } from './project-panel';
import { projectStore, newProjectId, type ProjectRec } from './project-store';
import { backupSupported, backupFolder, syncProject, makeProjectZip, readBackupFolder, readProjectZip, listBackupFolder, entriesOf, usedSampleIds, type RestoredProject, type BackupEntry } from './backup';
import { engine } from './audio-engine';
import type { DrumInstrument } from './drumseq';

const STORE_KEY = 'daw-starter-project-v1';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const plHost = $('pl-host'), prPanel = $('pr-panel'), prHost = $('pr-host');
const prTitle = $('pr-title'), prDot = $('pr-dot');

/* ---------- Tema (terang / gelap) ---------- */
type Theme = 'dark' | 'light';
const THEME_KEY = 'daw-starter-theme';
const APP_VARS: Record<Theme, Record<string, string>> = {
  dark: { '--bg-dark': '#2A2D34', '--row-black': '#34373E', '--row-white': '#3A3E46', '--rule': '#1D2226', '--light': '#C5C8D1' },
  light: { '--bg-dark': '#D2D2D2', '--row-black': '#C2C2C2', '--row-white': '#B4B4B4', '--rule': '#9A9A9A', '--light': '#222222' }
};
let theme: Theme = (() => { try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } })();

/* ---------- Penyimpanan ---------- */
// Project (playlist + efek/module + mixer) disimpan sebagai satu JSON lewat panel Project (Save) atau Ekspor/Impor; app selalu dibuka dengan project kosong.
// Hapus sisa data lama dari versi sebelumnya yang masih menyimpan project di localStorage.
try { localStorage.removeItem(STORE_KEY); localStorage.removeItem('daw-starter-mixer-v1'); } catch { /* abaikan */ }

/* ---------- Playlist <-> Piano roll ---------- */
let pianoRoll: PianoRollCanvasHandle | null = null;
let editingId: number | null = null;
// riwayat Undo / Redo umum (lihat bagian bawah): dideklarasikan di sini karena onHistory playlist sudah terpanggil saat playlist dipasang
let lastEdit: 'fx' | 'editor' = 'editor', lastUndone: 'fx' | 'editor' = 'editor', histBusy = false;
let fxPanel: FxPanelHandle | null = null;
let dock: Dock | null = null;   // bar bawah lama; dipasang setelah playlist dan panel efek ada
let projectPanel: ProjectPanelHandle | null = null;   // diisi di bagian "Panel project" di bawah

// tombol Play di bilah bawah: memainkan piano roll kalau editor terbuka, selain itu playlist; tampil sebagai Stop kalau salah satunya berjalan
function syncPlayBtn(): void { dock?.setPlaying(playlist.isPlaying() || (pianoRoll?.isPlaying() ?? false)); }
function togglePlayActive(): void { if (editingId != null && pianoRoll) pianoRoll.togglePlay(); else playlist.togglePlay(); }

// strip mixer mengikuti daftar track playlist (tambah / hapus / ganti nama / warna); ditunda sedikit karena onChange sering terpanggil
let mixTimer = 0;
function syncMixer(): void {
  clearTimeout(mixTimer);
  mixTimer = window.setTimeout(() => fxPanel?.mixer.setTracks(playlist.getTracks()), 120);
}

// panel efek: efek milik track (satu deretan untuk semua clip di track); nama + warna mengikuti clip / track-nya
function syncPatterns(): void {
  if (!fxPanel) return;
  engine.setClips(playlist.getClipsInfo());   // clip -> track: menentukan clip lewat strip channel mana
  const tracks = new Map(playlist.getTracks().map(t => [t.id, t]));
  fxPanel.setPatterns(playlist.getClipsInfo().map(c => ({ id: c.id, name: c.name, color: tracks.get(c.track)?.color ?? '#F5A12A', track: c.track, trackName: tracks.get(c.track)?.name, audio: c.audio })));
}

// Drum Sequence sebagai instrumen: pattern yang punya plugin Drum Sequence (aktif) memainkan sample slot-nya, ASLI dan utuh (seperti pratinjau panel browser).
// Tuts C4..G4 = slot 1..8 dan diberi nama sample-nya di keyboard piano roll. drumInst = instrumen milik pattern yang sedang dibuka di piano roll.
let drumInst: DrumInstrument | null = null;
function syncDrum(): void {
  drumInst = editingId != null ? fxPanel?.drumFor(editingId) ?? null : null;
  pianoRoll?.refresh();   // nama tuts mengikuti sample slot (diganti / dikosongkan / plugin dihapus)
}

// vsynth sebagai instrumen: clip instrumen yang pattern-nya punya vsynth (aktif, ada sampel) dimainkan dengan sampel itu, bukan oscillator bawaan
function playSampleFor(clipId: number, key: number, vel: number, when: number | null | undefined, dur: number | undefined, segs?: { off: number; key: number; dur: number }[]): { stop(at?: number): void; start?: number } | null {
  const dv = fxPanel?.drumFor(clipId);
  if (dv) return dv.play(key, vel, when ?? null, engine.pattern(clipId));   // drum: sample asli lewat chain efek + channel pattern (tanpa pitch / stretch)
  const r = fxPanel?.vsynthSource(clipId);
  if (!r) return null;                                                   // tidak ada vsynth / Sampler: pakai oscillator
  if (r.smp) return fxPanel!.sampler.play(r.smp, key, vel, when ?? null, dur, engine.pattern(clipId), segs?.map(g => ({ off: g.off, midi: g.key, dur: g.dur })));   // Sampler: langsung diputar (tanpa Signalsmith), knob realtime
  if (!r.src) return { stop(): void { /* sampel masih dimuat: diam */ }, start: engine.context().currentTime };
  return fxPanel!.instrument.play(r.src, key, vel, when ?? null, dur, engine.pattern(clipId), segs?.map(g => ({ off: g.off, midi: g.key, dur: g.dur })));
}
// nada yang dipakai note dirender di latar belakang begitu note / pengaturan / sampel berubah, jadi saat Play semuanya sudah siap
let vsTimer = 0;
function prepareVsynth(): void {
  clearTimeout(vsTimer);
  vsTimer = window.setTimeout(() => {
    if (!fxPanel) return;
    const bpm = playlist.getBpm();
    for (const c of playlist.getState().clips) {
      if (c.id == null || !c.notes?.length) continue;
      const r = fxPanel.vsynthSource(c.id);
      if (r?.src) fxPanel.instrument.prepare(r.src, c.notes, bpm);
    }
  }, 250);
}

const playlist: PlaylistCanvasHandle = mountPlaylist(plHost, {
  title: 'DAW Starter',
  theme,
  onChange: () => {
    fxPanel?.pitch.refresh();
    syncSettings();
    syncMixer();
    syncPatterns();
    prepareVsynth();
    if (editingId != null && !playlist.getState().clips.some(c => c.id === editingId)) closeEditor();   // clip yang sedang diedit terhapus
  },
  onTransport: playing => { syncPlayBtn(); if (playing) pianoRoll?.stop(); },
  onHistory: () => { if (!histBusy && editingId == null) lastEdit = 'editor'; if (fxPanel) syncHistory(); },   // riwayat playlist berubah (perubahan baru = Undo berikutnya ke editor)
  onOpenClip: clip => openEditor(clip),
  getAudioBlob: async id => browser.getBlob(id),
  playSample: playSampleFor,
  // memilih pattern (clip) di playlist menampilkan panel efek miliknya; tap area kosong tidak mengosongkan panel
  onSelectClip: id => { if (id != null) { syncPatterns(); fxPanel?.showPattern(id); } fxPanel?.pitch.refresh(); },
  onPitchUpdate: () => fxPanel?.pitch.refresh()   // render pitch (Auto) maju / selesai
});

// panel efek + mixer + pitch di bawah playlist (buka/tutup lewat bilah "Efek" / "Mixer" / "Sample"); playlist menyesuaikan ukuran lewat ResizeObserver-nya sendiri
fxPanel = mountFxPanel($('fx-host'), {
  getTarget: () => playlist.getPitchTarget(),   // clip audio terpilih
  setPitch: st => playlist.setClipPitch(st),
  setAuto: on => playlist.setClipAuto(on),
  setReverse: on => playlist.setClipReverse(on),
  setFade: (kind, beats, live) => playlist.setClipFade(kind, beats, live),
  endFade: () => playlist.endClipFade(),
  setVolume: (v, live) => playlist.setClipVolume(v, live),
  endVolume: () => playlist.endClipVolume()
}, {
  getBpm: () => playlist.getBpm(),   // Tools -> BPM Finder
  setBpm: v => applyBpmInput(v)
});
fxPanel.setSelTrackProvider(() => playlist.getSelTrack() || null);   // keyboard komputer (A W S E ...) membunyikan instrumen track yang dipilih, tanpa membuka panel keyboard
fxPanel.mixer.setTracks(playlist.getTracks());
fxPanel.mixer.onTrackColor((id, color) => playlist.setTrackColor(id, color));   // titik tiga track di Mixer > Color: warna seluruh track (semua clip di baris itu ikut)
// Undo / Redo umum di bilah bawah (tombol dan Ctrl+Z): ke panel efek (knob, slider, plugin, sample, Master) atau ke editor (piano roll kalau terbuka, selain itu playlist).
// Yang dipilih = yang terakhir diubah pengguna; kalau riwayat itu kosong, pakai yang lain. Redo = ke yang terakhir di-Undo (atau yang masih punya Redo).
interface Hist { undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean }
const editorHist = (): Hist => (editingId != null && pianoRoll ? pianoRoll : playlist);
function syncHistory(): void {
  const e = editorHist(), f = fxPanel?.history;
  dock?.setHistory(e.canUndo() || !!f?.canUndo(), e.canRedo() || !!f?.canRedo());
}
function doUndo(): void {
  const f = fxPanel!.history, e = editorHist(), toFx = f.canUndo() && (lastEdit === 'fx' || !e.canUndo());
  lastUndone = toFx ? 'fx' : 'editor';
  histBusy = true;
  try { (toFx ? f : e).undo(); } finally { histBusy = false; }
  syncHistory();
}
function doRedo(): void {
  const f = fxPanel!.history, e = editorHist(), toFx = f.canRedo() && (lastUndone === 'fx' || !e.canRedo());
  histBusy = true;
  try { (toFx ? f : e).redo(); } finally { histBusy = false; }
  syncHistory();
}
fxPanel.history.onChange(syncHistory);
fxPanel.history.onEdit(() => { lastEdit = 'fx'; });
// Ctrl/Cmd+Z dan Ctrl+Shift+Z / Ctrl+Y: kalau yang dituju panel efek, ditangani di sini; kalau editor, editor menanganinya sendiri seperti sebelumnya
window.addEventListener('keydown', e => {
  const t = (e.target as HTMLElement | null)?.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase(), redo = (k === 'z' && e.shiftKey) || k === 'y';
  if (k !== 'z' && k !== 'y') return;
  const f = fxPanel!.history, ed = editorHist();
  const toFx = redo ? f.canRedo() && (lastUndone === 'fx' || !ed.canRedo()) : f.canUndo() && (lastEdit === 'fx' || !ed.canUndo());
  if (!toFx) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (redo) doRedo(); else doUndo();
}, true);
syncHistory();

// wiring audio: mixer (fader/pan/send/mute/solo + meter) dan efek track (dan module pattern) disambung ke audio-engine
fxPanel.onVsynthChange(prepareVsynth);   // sampel dimuat / diganti
engine.attachMixer(fxPanel.mixer, () => { const st = fxPanel!.getState(); return st.open && st.tab === 'mixer'; });
fxPanel.onFxChange(id => {
  // chainFor: instrumen (module) milik track ikut ke semua pattern di track itu, jadi chain tiap pattern = module bersama + efeknya sendiri
  if (id == null) { engine.clearPatternFx(); for (const k of fxPanel!.clipIds()) engine.setPatternFx(k, fxPanel!.chainFor(k)); }   // project diganti / diimpor
  else engine.setPatternFx(id, fxPanel!.chainFor(id));
  prepareVsynth();   // knob Pitch / Speed / Reverse, vsynth ditambah / dihapus / titik start berubah
  syncDrum();        // sample slot drum diganti / plugin Drum Sequence ditambah atau dihapus: nama tuts ikut
});
fxPanel.onFxChannelFxChange(id => {   // efek channel FX (Mixer > titik tiga FX > Effect): strip FX -> efek -> fader FX
  const st = fxPanel!.getState().fxch;
  if (id == null) { engine.clearFxChannelFx(); for (const k of Object.keys(st)) engine.setFxChannelFx(+k, st[+k]); }   // project diganti / diimpor
  else engine.setFxChannelFx(id, st[id] ?? []);
});
fxPanel.onMasterFxChange(() => engine.setMasterFx(fxPanel!.getState().master));   // efek Master (tab Efek > Master): masterIn -> efek -> fader master
// tombol Roll di plugin Drum Sequence: buka piano roll pattern itu
fxPanel.onOpenPianoRoll(id => {
  const c = playlist.getState().clips.find(x => x.id === id);
  if (c && c.id != null && !c.audio) openEditor(c as PLClip & { id: number });
});
syncPatterns();

// ganti tema: komponen punya dropdown tema sendiri (tersembunyi), jadi cukup set nilainya lalu picu event change
function setComponentTheme(host: HTMLElement, t: Theme): void {
  const sel = host.querySelector<HTMLSelectElement>('[data-r="theme"]');
  if (sel) { sel.value = t; sel.dispatchEvent(new Event('change')); }
}
const themeBtns = document.querySelectorAll<HTMLButtonElement>('#settings [data-theme]');
function applyTheme(t: Theme): void {
  theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* abaikan */ }
  for (const k in APP_VARS[t]) document.documentElement.style.setProperty(k, APP_VARS[t][k]);
  setComponentTheme(plHost, t);
  setComponentTheme(prHost, t);
  themeBtns.forEach(b => b.classList.toggle('on', b.dataset.theme === t));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', APP_VARS[t]['--bg-dark']);
}
themeBtns.forEach(b => { b.onclick = () => applyTheme(b.dataset.theme as Theme); });
const settingsEl = $('settings'), settingsBtn = $('btn-settings');
function setSettingsOpen(open: boolean): void {
  settingsEl.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
  if (open) settingsEl.querySelector<HTMLElement>('.set-card')?.focus({ preventScroll: true }); else settingsBtn.focus({ preventScroll: true });
}
settingsBtn.onclick = () => setSettingsOpen(!!settingsEl.hidden);
settingsEl.addEventListener('pointerdown', e => { if (e.target === settingsEl) setSettingsOpen(false); });   // ketuk di luar popup = tutup
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !settingsEl.hidden) setSettingsOpen(false); });
applyTheme(theme);

/* ---------- Pengaturan project: BPM + metronom ---------- */
const METRO_KEY = 'daw-starter-metro';
let metroOn = false;
try { metroOn = localStorage.getItem(METRO_KEY) === '1'; } catch { /* abaikan */ }
const bpmInput = $<HTMLInputElement>('set-bpm');
const metroBtns = document.querySelectorAll<HTMLButtonElement>('#metro-seg [data-metro]');
function syncSettings(): void {   // tampilan BPM mengikuti project (impor / proyek baru / demo); tidak mengganggu saat sedang diketik
  const el = document.getElementById('set-bpm') as HTMLInputElement | null;
  if (el && document.activeElement !== el) el.value = String(playlist.getBpm());
  dock?.metro.sync();
}
function applyBpmInput(v: number): void { playlist.setBpm(v); pianoRoll?.setBpm(playlist.getBpm()); bpmInput.value = String(playlist.getBpm()); dock?.metro.sync(); }
bpmInput.addEventListener('change', () => applyBpmInput(+bpmInput.value));
bpmInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); bpmInput.blur(); } });
$('bpm-dec').onclick = () => applyBpmInput(playlist.getBpm() - 1);
$('bpm-inc').onclick = () => applyBpmInput(playlist.getBpm() + 1);
function applyMetro(on: boolean): void {
  metroOn = on;
  try { localStorage.setItem(METRO_KEY, on ? '1' : '0'); } catch { /* abaikan */ }
  playlist.setMetronome(on);
  pianoRoll?.setMetronome(on);
  metroBtns.forEach(b => b.classList.toggle('on', (b.dataset.metro === '1') === on));
  dock?.metro.sync();
}
metroBtns.forEach(b => { b.onclick = () => applyMetro(b.dataset.metro === '1'); });
applyMetro(metroOn);

// bar bawah LAMA: Mundur / Putar-Jeda / Maju, Undo / Redo, dan M (metronome + BPM). Menjalankan piano roll kalau editor terbuka, selain itu playlist.
dock = mountDock($('dock-host'), {
  onPlay: togglePlayActive,
  onRewind: () => { if (editingId != null && pianoRoll) pianoRoll.rewind(); else playlist.rewind(); },   // playhead kembali ke titik Play terakhir
  onSeek: bars => { if (editingId != null && pianoRoll) pianoRoll.seekBars(bars); else playlist.seekBars(bars); },
  onUndo: doUndo,
  onRedo: doRedo,
  metro: {
    getBpm: () => playlist.getBpm(),
    setBpm: v => applyBpmInput(v),
    isOn: () => metroOn,
    setOn: on => applyMetro(on)
  }
});
syncPlayBtn();
syncHistory();

/* ---------- Playlist Setting: Random Color Track (acak semua) + Gradient Color (warna atas -> bawah) ---------- */
const GRAD_KEY = 'daw-starter-gradient-colors';
const gradTop = $<HTMLInputElement>('grad-top'), gradBot = $<HTMLInputElement>('grad-bot');
try {
  const g = JSON.parse(localStorage.getItem(GRAD_KEY) ?? 'null') as { top?: string; bot?: string } | null;
  if (g?.top && /^#[0-9a-f]{6}$/i.test(g.top)) gradTop.value = g.top;
  if (g?.bot && /^#[0-9a-f]{6}$/i.test(g.bot)) gradBot.value = g.bot;
} catch { /* abaikan */ }
const saveGrad = (): void => { try { localStorage.setItem(GRAD_KEY, JSON.stringify({ top: gradTop.value, bot: gradBot.value })); } catch { /* abaikan */ } };
gradTop.addEventListener('input', saveGrad);
gradBot.addEventListener('input', saveGrad);
$('btn-randcolor').onclick = () => playlist.randomizeTrackColors();
$('btn-gradient').onclick = () => { saveGrad(); playlist.applyTrackGradient(gradTop.value, gradBot.value); };
syncSettings();
settingsEl.addEventListener('keydown', e => { if (e.code === 'Space') e.stopPropagation(); });   // Spasi di popup tidak ikut menjalankan play

function openEditor(clip: PLClip & { id: number }): void {
  const st = playlist.getState();
  const track = st.tracks.find(t => t.id === clip.track);
  const color = track?.color ?? '#F5A12A';
  const notes: PLNote[] = (clip.notes ?? []).map(n => ({ ...n, vel: n.vel ?? 180 }));
  editingId = null;   // jangan kirim balik perubahan selama editor diisi ulang
  prPanel.hidden = false;
  prTitle.textContent = `${clip.name}${track ? ' · ' + track.name : ''}`;
  prDot.style.background = color;
  if (!pianoRoll) {
    pianoRoll = mountPianoRoll(prHost, {
      notes: notes as Required<PLNote>[], theme, color, clipOffset: clip.beat, bpm: playlist.getBpm(),
      onChange: () => {
        if (editingId == null || !pianoRoll) return;
        playlist.setClipNotes(editingId, pianoRoll.getNotes());
      },
      onTransport: playing => { syncPlayBtn(); if (playing) playlist.stop(); },
      onHistory: () => { if (!histBusy && editingId != null) lastEdit = 'editor'; if (fxPanel) syncHistory(); },
      playSample: (k, v, w, d, sg) => (editingId != null ? playSampleFor(editingId, k, v, w, d, sg) : null),
      getKeyLabel: k => drumInst?.label(k) ?? null,   // nama sample di tuts (hanya pattern Drum Sequence)
      getOutput: () => (editingId != null ? engine.pattern(editingId) : null)   // pratinjau lewat efek + channel clip yang diedit
    });
  } else {
    pianoRoll.stop();
    pianoRoll.setColor(color);
    pianoRoll.setClipOffset(clip.beat);
    pianoRoll.setBpm(playlist.getBpm());
    pianoRoll.setNotes(notes as Required<PLNote>[]);
  }
  pianoRoll.setMetronome(metroOn);
  editingId = clip.id;
  syncHistory();
  syncDrum();
  if (drumInst && !notes.length) pianoRoll.focusKey(drumInst.topKey);   // pattern drum masih kosong: tuts slot langsung kelihatan
  syncPlayBtn();
  requestAnimationFrame(() => { playlist.resize(); pianoRoll?.resize(); });
}

function closeEditor(): void {
  editingId = null;
  drumInst = null;
  pianoRoll?.stop();
  syncHistory();
  prPanel.hidden = true;
  requestAnimationFrame(() => playlist.resize());
}
$('pr-close').onclick = closeEditor;

/* ---------- Toolbar atas ---------- */
function freshState(): PlaylistState {
  return { tracks: [], clips: [] };   // proyek baru: kosong, track ditambah lewat tombol +
}
function confirmReplace(): boolean { return confirm('Ganti project yang sekarang? Perubahan yang belum diekspor akan hilang.'); }
/* Isi file project (JSON): playlist (track, clip, note, BPM, setelan Sample per clip), fx (efek + module per pattern + efek Master), mixer (volume, pan, send, routing FX, Return, Master). */
type ProjectData = PlaylistState & { fx?: unknown; mixer?: unknown };
const collectProject = (): ProjectData => JSON.parse(JSON.stringify({ format: 2, ...playlist.getState(), fx: fxPanel?.exportFx() ?? {}, mixer: fxPanel?.mixer.exportState() }));
function replaceProject(s: PlaylistState, fx?: unknown, mixer?: unknown): void {
  closeEditor();
  playlist.stop();
  playlist.setState(s);
  syncPatterns();
  fxPanel?.importFx(fx);   // efek + module per pattern ikut file project; proyek baru / demo = tanpa efek
  fxPanel?.mixer.setTracks(playlist.getTracks());   // strip track langsung ada (tanpa menunggu jeda), baru setelan mixer dimuat
  fxPanel?.mixer.importState(mixer);   // mixer ikut file project; proyek baru / demo / file lama = bawaan
}
$('btn-new').onclick = () => { if (confirmReplace()) { replaceProject(freshState()); activeProjectId = null; refreshProjectList(); } };
$('btn-demo').onclick = () => { if (confirmReplace()) { replaceProject(demoState()); activeProjectId = null; refreshProjectList(); } };
$('btn-export').onclick = () => {
  const blob = new Blob([JSON.stringify(collectProject(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
const fileIn = $<HTMLInputElement>('file-import');
$('btn-import').onclick = () => fileIn.click();
fileIn.onchange = async () => {
  const f = fileIn.files?.[0]; fileIn.value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text()) as ProjectData;
    if (!Array.isArray(s.tracks) || !Array.isArray(s.clips)) throw new Error('format');
    if (confirmReplace()) { replaceProject(s, s.fx, s.mixer); activeProjectId = null; refreshProjectList(); }
  } catch { alert('File project tidak valid.'); }
};

/* ---------- Toast + layar penuh ---------- */
const isStandalone = (): boolean =>
  matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const toastEl = $('toast');
let toastTimer = 0;
function toast(msg: string, ms = 3500): void {
  toastEl.textContent = msg; toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastEl.hidden = true; }, ms);
}
// Layar penuh (status bar + tombol navigasi HP hilang): dipilih lewat Pengaturan -> Layar penuh (Mati / Nyala).
// Layar penuh wajib dipicu sentuhan pengguna, makanya hanya dari tombol itu. iPhone tidak mendukung layar penuh di browser; di sana ditampilkan petunjuk.
const fsBtns = document.querySelectorAll<HTMLButtonElement>('#fs-seg [data-fs]');
function refreshFsBtns(): void {
  const on = !!document.fullscreenElement;
  fsBtns.forEach(b => b.classList.toggle('on', (b.dataset.fs === '1') === on));
}
async function setFullscreen(on: boolean): Promise<void> {
  try {
    if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    else if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch { if (on) toast('Browser ini tidak mendukung layar penuh. Pasang aplikasi ke layar utama (Pasang) untuk menyembunyikan bar HP.', 5000); }
  refreshFsBtns();
  requestAnimationFrame(() => { playlist.resize(); pianoRoll?.resize(); });
}
fsBtns.forEach(b => { b.onclick = () => { void setFullscreen(b.dataset.fs === '1'); }; });
document.addEventListener('fullscreenchange', () => {
  refreshFsBtns();   // keluar layar penuh lewat gestur sistem: pilihan ikut kembali ke Mati
  requestAnimationFrame(() => { playlist.resize(); pianoRoll?.resize(); });
});
refreshFsBtns();

// Landscape: tombol mengambang sendiri (src/landscape.ts) = layar penuh + kunci landscape dalam satu ketukan.
initLandscape(() => { playlist.resize(); pianoRoll?.resize(); });

/* ---------- Panel browser file (kiri) ---------- */
const browserBtn = $<HTMLButtonElement>('btn-browser');
const browser = mountBrowser($('bw'), {
  onMessage: m => toast(m),
  onToggle: o => browserBtn.classList.toggle('on', o),
  // file audio diseret dari panel lalu dilepas di playlist = clip audio di posisi itu
  onDropFile: (f, x, y) => {
    // dilepas tepat di canvas audio module vsynth = spectrogram (tidak jadi clip playlist)
    const blob = browser.getBlob(f.id);
    if (blob && fxPanel?.dropFile(f, blob, x, y)) return;
    if (!prPanel.hidden) return;   // piano roll menutupi playlist (tapi bilah bawah tetap tampak)
    void playlist.addAudioClip(f.id, f.name, x, y).then(ok => { if (!ok) toast('Lepas file di area clip playlist, ya.'); });
  }
});
fxPanel?.setBlobProvider(id => browser.getBlob(id));   // sampel vsynth dimuat dari file panel browser
browserBtn.classList.toggle('on', browser.isOpen());
browserBtn.onclick = () => browser.toggle();
browserBtn.addEventListener('pointerdown', e => e.stopPropagation());

/* ---------- Panel project (kanan): Save + New, daftar project ---------- */
// Buka app = project kosong tanpa nama. New -> popup nama -> project baru masuk daftar. Save menimpa project aktif; ketuk nama di daftar = buka.
const projectBtn = $<HTMLButtonElement>('btn-project');
let activeProjectId: string | null = null;
const hasContent = (): boolean => { const st = playlist.getState(); return st.tracks.length > 0 || st.clips.length > 0; };
const snapshot = (): unknown => collectProject();
function refreshProjectList(): void { projectPanel?.setProjects(projectStore.list().map(r => ({ id: r.id, name: r.name })), activeProjectId); }
function canLeave(): boolean { return !hasContent() || confirmReplace(); }   // ada isi yang belum disimpan = tanya dulu
async function newProject(): Promise<void> {
  if (!projectPanel) return;
  const name = await projectPanel.askName(n => (projectStore.nameTaken(n) ? 'Nama project sudah dipakai.' : ''));
  if (name == null || !canLeave()) return;
  replaceProject(freshState());
  const rec = { id: newProjectId(), name, data: snapshot(), updated: Date.now() };
  if (!projectStore.put(rec)) { toast('Gagal menyimpan: penyimpanan browser penuh atau tidak tersedia.'); return; }
  activeProjectId = rec.id;
  refreshProjectList();
}
function saveProject(): void {
  askPersist();
  const rec = activeProjectId ? projectStore.get(activeProjectId) : null;
  if (!rec) { toast('Belum ada project. Klik New dulu untuk membuat project.'); return; }
  rec.data = snapshot(); rec.updated = Date.now();
  if (!projectStore.put(rec)) { toast('Gagal menyimpan: penyimpanan browser penuh.'); return; }
  toast(`Project "${rec.name}" disimpan.`);
  void backupAfterSave(rec);   // folder backup sudah dipilih = diperbarui otomatis (folder project yang sama, bukan backup baru)
}
function openProject(id: string): void {
  if (id === activeProjectId) return;
  const rec = projectStore.get(id);
  if (!rec || !canLeave()) return;
  const d = rec.data as ProjectData;
  replaceProject(d, d.fx, d.mixer);
  activeProjectId = id;
  refreshProjectList();
}
// minta penyimpanan permanen: browser tidak menghapus sample / project sendiri saat HP penuh (hapus data manual tetap menghapus)
let persistAsked = false;
function askPersist(): void {
  if (persistAsked) return;
  navigator.storage?.persist?.().then(ok => { persistAsked = ok; }).catch(() => { /* abaikan */ });   // belum disetujui: coba lagi di Save / Backup berikutnya
}
const NO_FS = 'Browser ini belum bisa menyimpan ke folder (Chrome Android belum mendukung). Pakai Chrome / Edge di desktop.';
/* Backup = folder biasa (tanpa ZIP), isinya hanya project + sample yang dipakai project itu (bukan semua file browser).
   Per project, lewat menu titik tiga di daftar: Backup (tentukan + perbarui folder-nya; Save berikutnya memperbaruinya otomatis) dan Download. */
async function backupAfterSave(rec: ProjectRec): Promise<void> {
  if (!rec.backup || !backupSupported()) return;   // hanya project yang ditentukan (menu titik tiga > Backup)
  try {
    const root = await backupFolder.ready(true, false);   // belum ada folder backup = Save tidak mengganggu
    if (!root) return;
    const n = await syncProject(root, rec, browser.exportAll());
    toast(`Project "${rec.name}" disimpan, backup diperbarui (${n} sample).`, 3000);
  } catch { toast('Project tersimpan, tapi backup ke folder gagal. Coba tombol Backup.', 5000); }
}
/* project untuk backup / download: project aktif pakai isi terkini (belum perlu di-Save dulu) */
const projectNow = (id: string): ProjectRec | null => { const r = projectStore.get(id); return r && id === activeProjectId ? { ...r, data: snapshot() } : r; };
async function backupProject(id: string): Promise<void> {
  askPersist();
  if (!backupSupported()) { toast(NO_FS, 7000); return; }
  const rec = projectNow(id);
  if (!rec) return;
  try {
    const root = await backupFolder.ready(true, true);   // pertama kali: pilih folder; berikutnya dipakai terus
    if (!root) return;
    toast('Menyiapkan backup...', 2000);
    rec.backup = true; rec.updated = Date.now();
    if (!projectStore.put(rec)) { toast('Gagal menyimpan: penyimpanan browser penuh.'); return; }
    const n = await syncProject(root, rec, browser.exportAll());
    toast(`Backup "${rec.name}" diperbarui di "${root.name}" (${n} sample). Save berikutnya memperbarui otomatis.`, 5000);
  } catch { toast('Backup gagal.', 5000); }
}
async function downloadProject(id: string): Promise<void> {
  const rec = projectNow(id);
  if (!rec) return;
  try {
    toast('Menyiapkan download...', 2000);
    const z = await makeProjectZip(rec, browser.exportAll());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(z.blob); a.download = z.name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast(`Download: ${z.name} (${z.count} sample)`, 4000);
  } catch { toast('Download gagal (memori tidak cukup?).', 5000); }
}
async function changeBackupFolder(): Promise<void> {
  if (!backupSupported()) { toast(NO_FS, 7000); return; }
  try {
    const h = await backupFolder.choose();
    if (h) toast(`Folder backup: "${h.name}". Klik Save / Backup untuk mengisinya.`, 4000);
  } catch { toast('Gagal memilih folder.', 5000); }
}
async function applyRestore(found: RestoredProject[]): Promise<void> {
  if (!found.length) { toast('Tidak ada project backup di sana.', 5000); return; }
  if (!confirm(`Pulihkan ${found.length} project? Data yang sudah ada tidak ditimpa; yang belum ada ditambahkan.`)) return;
  let np = 0, nf = 0;
  for (const { rec, nodes } of found) {
    nf += await browser.importAll(nodes);
    if (projectStore.get(rec.id)) continue;
    let name = rec.name;
    for (let i = 2; projectStore.nameTaken(name); i++) name = `${rec.name} (${i})`;
    if (projectStore.put({ ...rec, name } as ProjectRec)) np++;
  }
  refreshProjectList();
  toast(`Restore selesai: ${np} project, ${nf} sample.`, 5000);
}
const restoreIn = $<HTMLInputElement>('file-restore');
restoreIn.onchange = async () => {
  const f = restoreIn.files?.[0]; restoreIn.value = '';
  if (!f) return;
  const viaLoad = loadViaZip; loadViaZip = false;
  try { const found = await readProjectZip(f); if (viaLoad) await loadEntry(entriesOf(found)); else await applyRestore(found); } catch { toast('File backup tidak valid.', 5000); }
};
async function restoreAll(): Promise<void> {
  if (!backupSupported()) { restoreIn.click(); return; }   // tanpa pilih folder (mis. Chrome Android): pulihkan dari .zip hasil Download
  try { const found = await readBackupFolder(); if (found) await applyRestore(found); }
  catch { toast('Folder backup tidak valid.', 5000); }
}
/* Load project from folder: pilih folder backup, pilih satu project, lalu dimuat dan langsung dibuka.
   Beda dengan Restore (semua project, tidak menimpa): Load hanya satu project, dan kalau project itu sudah ada di daftar, boleh ditimpa dengan versi backup. */
let loadViaZip = false;
async function loadEntry(entries: BackupEntry[]): Promise<void> {
  if (!projectPanel) return;
  if (!entries.length) { toast('Tidak ada project backup di sana.', 5000); return; }
  let entry: BackupEntry | undefined = entries[0];
  if (entries.length > 1) {
    const id = await projectPanel.askChoice('Load project dari folder', entries.map(e => ({ id: e.id, label: e.name, sub: e.updated ? new Date(e.updated).toLocaleDateString() : '' })));
    if (id == null) return;
    entry = entries.find(e => e.id === id);
  }
  if (!entry) return;
  const existing = projectStore.get(entry.id);
  if (existing && !confirm(`Project "${existing.name}" sudah ada. Timpa dengan versi dari backup?`)) return;
  if (!canLeave()) return;
  toast('Memuat project...', 120000);
  let r: Awaited<ReturnType<BackupEntry['load']>>, nf: number;
  try {
    r = await entry.load((d, t) => { if (t) toast(`Memuat sample ${d}/${t}...`, 120000); });
    if (!r) { toast('Project backup tidak valid.', 5000); return; }
    toast('Menyimpan sample ke browser...', 120000);
    nf = await browser.importAll(r.nodes);
  } catch (err) { toast(`Gagal memuat project: ${(err as Error)?.message || err}`, 8000); return; }
  let name = existing ? existing.name : r.rec.name;
  if (!existing) for (let i = 2; projectStore.nameTaken(name); i++) name = `${r.rec.name} (${i})`;
  const rec = { ...r.rec, name, updated: Date.now() } as ProjectRec;
  if (existing?.backup) rec.backup = true;
  if (!projectStore.put(rec)) { toast('Gagal menyimpan: penyimpanan browser penuh.'); return; }
  const d = rec.data as ProjectData;
  replaceProject(d, d.fx, d.mixer);
  activeProjectId = rec.id;
  refreshProjectList();
  // sample yang dipakai project tapi tidak ada (tidak ikut di folder backup / tidak terbaca): clip itu akan bisu, jadi beri tahu, jangan diam
  const used = [...usedSampleIds(d)], missing = used.filter(id => !browser.getBlob(id));
  if (missing.length) toast(`Project "${rec.name}" dimuat, tapi ${missing.length} dari ${used.length} sample TIDAK ADA di backup (clip / instrumen yang memakainya akan bisu). ID: ${missing.slice(0, 3).map(m => m.slice(0, 8)).join(', ')}${missing.length > 3 ? '…' : ''}`, 15000);
  else toast(`Project "${rec.name}" dimuat (${nf} sample baru, ${used.length} sample dipakai, semua ada).`, 5000);
}
async function loadFromFolder(): Promise<void> {
  if (!backupSupported()) { loadViaZip = true; restoreIn.click(); return; }   // tanpa pilih folder (mis. Chrome Android): pilih .zip hasil Download
  try { const found = await listBackupFolder(); if (found) await loadEntry(found); }
  catch { toast('Folder backup tidak valid.', 5000); }
}
projectPanel = mountProjectPanel($('pw'), {
  onToggle: o => { projectBtn.classList.toggle('on', o); requestAnimationFrame(() => { playlist.resize(); pianoRoll?.resize(); }); },
  onSave: saveProject,
  onNew: () => { void newProject(); },
  onOpen: openProject,
  onBackupProject: id => { void backupProject(id); },
  onDownloadProject: id => { void downloadProject(id); },
  onBackupFolder: () => { void changeBackupFolder(); },
  onRestore: () => { void restoreAll(); },
  onLoad: () => { void loadFromFolder(); }
});
refreshProjectList();
projectBtn.classList.toggle('on', projectPanel.isOpen());
projectBtn.onclick = () => projectPanel?.toggle();
projectBtn.addEventListener('pointerdown', e => e.stopPropagation());

/* ---------- PWA: service worker + tombol Pasang ---------- */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
let installEvt: BeforeInstallPromptEvent | null = null;
const installRow = $('install-row');
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function updateInstallUI(): void { installRow.hidden = isStandalone() || !(installEvt || isIOS); }

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvt = e as BeforeInstallPromptEvent;
  updateInstallUI();
});
window.addEventListener('appinstalled', () => { installEvt = null; updateInstallUI(); toast('Aplikasi terpasang.'); });
$('btn-install').onclick = async () => {
  if (installEvt) {
    const ev = installEvt;
    installEvt = null;               // prompt() hanya boleh dipanggil sekali per event
    updateInstallUI();
    await ev.prompt();
    await ev.userChoice;
  } else if (isIOS) {
    toast('Di Safari: ketuk Bagikan, lalu "Tambah ke Layar Utama".', 6000);
  }
};
updateInstallUI();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const hadController = !!navigator.serviceWorker.controller;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* abaikan */ }); });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Versi baru tersedia. Muat ulang untuk memakainya.', 6000);
  });
}
