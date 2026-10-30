// Memasang playlist canvas di #playlistHost (di sebelah kolom channel). Fungsi modul (mixer, efek, piano roll, transport, project)
// belum disambungkan ke playlist ini; itu dikerjakan belakangan lewat handle `playlist` (window.__playlist untuk percobaan).
import { mountPlaylist, type PlaylistCanvasHandle, type PLNote, type PLClip } from './playlist-canvas';
import { openPianoRoll, isPianoRollOpen, setPianoRollNotes, getPianoRollNotes, setPianoRollPlaying, setPianoRollPlayhead, type NoteData } from '../piano-roll';
import './playlist-host.css';

const host = document.getElementById('playlistHost') as HTMLElement;
const ws = document.querySelector('.workspace') as HTMLElement;
// channel mixer (kolom kiri): kartu track mengikuti zoom vertikal dan gulir vertikal playlist canvas (lihat onView di bawah)
const tlist = document.querySelector('.tracklist') as HTMLElement;
const hdrs = tlist.querySelector('.headers') as HTMLElement;

// Pengait ke instrumen di main.ts (plugin DERIZ di mixer): main.ts mengisi objek ini setelah modul ini dimuat.
export const plugHooks: {
  playSample?: (clipId: number, key: number, vel: number, when: number | null | undefined, dur: number | undefined, segs?: { off: number; key: number; dur: number }[]) => { stop(at?: number): void; start?: number } | null;   // bunyikan satu nada clip lewat instrumen track-nya (null = pakai suara bawaan playlist)
  openClip?: (clip: { id: number; track: number }) => string | undefined;   // clip dibuka di piano roll: arahkan preview nada ke instrumennya; mengembalikan nama plugin untuk toolbar piano roll
  changed?: () => void;                    // data track / clip playlist berubah
  transport?: (playing: boolean) => void;  // play / stop
} = {};

// ---- pattern <-> piano roll ----
// nada clip disimpan di piano roll dengan kunci 'plc:<id clip>'. PLNote {key, beat, len, vel 1..255, slide} <-> NoteData {p, s, l, v 0..1, sl}; beat relatif awal clip di kedua sisi.
const PK = 'plc:';
let loading = false;
const toPr = (n: PLNote): NoteData => { const v = Math.round((n.vel ?? 180) / 255 * 1000) / 1000; return { p: n.key, s: n.beat, l: n.len, ...(n.slide ? { sl: true } : {}), ...(v < 0.999 ? { v } : {}) }; };
const fromPr = (n: NoteData): PLNote => ({ key: n.p, beat: n.s, len: n.l, vel: Math.max(1, Math.min(255, Math.round((n.v ?? 1) * 255))), ...(n.sl ? { slide: true } : {}) });
/** dipanggil handler perubahan piano roll (main.ts): true = nada milik clip playlist canvas (sudah ditulis balik ke clip), jangan diproses logika lama */
export function plNotesChanged(id: string): boolean {
  if (!id.startsWith(PK)) return false;
  if (!loading) playlist.setClipNotes(+id.slice(PK.length), getPianoRollNotes(id).map(fromPr));
  return true;
}

// file audio yang di-upload lewat alur Audio clip: id -> File; dibaca playlist canvas lewat getAudioBlob (diputar dan digambar gelombangnya)
export const audioFiles = new Map<string, Blob>();

// playhead piano roll mengikuti transport playlist canvas (dulu hanya diisi transport timeline lama, jadi saat play playhead piano roll diam):
// selama play, posisi playhead playlist diteruskan ke piano roll clip yang terbuka (relatif awal clip, mengikuti loop clip), ±30 fps
let openedClip: number | null = null, phRaf = 0, phLast = 0;
function pushPlayhead(): void {
  if (openedClip === null || !isPianoRollOpen()) return;
  setPianoRollPlayhead(playlist.getClipPlayhead(openedClip) ?? 0);
}
function phLoop(t: number): void {
  phRaf = requestAnimationFrame(phLoop);
  if (t - phLast < 33) return;
  phLast = t; pushPlayhead();
}

// buka clip nada di piano roll (double-tap clip, atau menu pattern di plugin DERIZ lewat openClipById). keepView: zoom / scroll piano roll tetap
function openClipEditor(clip: PLClip & { id: number }, keepView = false): void {
  if (clip.audio) return;   // clip audio tidak punya nada
  const key = PK + clip.id; openedClip = clip.id;
  loading = true; setPianoRollNotes(key, (clip.notes ?? []).map(toPr)); loading = false;
  const t = playlist.getTracks().find(x => x.id === clip.track);
  const plugin = plugHooks.openClip?.(clip);   // nama plugin (mis. DERIZ) di toolbar piano roll; preview nada ikut bunyi lewat plugin itu
  openPianoRoll({ id: key, track: t?.name ?? 'Track', pattern: clip.name, color: t?.color, keepView, ...(plugin ? { plugin } : {}) });
  pushPlayhead();
}
export function openClipById(id: number, keepView = false): boolean {
  const c = playlist.getState().clips.find(x => x.id === id);
  if (!c || c.audio) return false;
  openClipEditor(c as PLClip & { id: number }, keepView);
  return true;
}

export const playlist: PlaylistCanvasHandle = mountPlaylist(host, {
  theme: 'web',
  getAudioBlob: async id => audioFiles.get(id) ?? null,
  // clip instrumen berbunyi lewat plugin track-nya (DERIZ = sampler-nya, melewati fader + efek track); tanpa plugin: suara bawaan playlist
  playSample: (clipId, key, vel, when, dur, segs) => plugHooks.playSample?.(clipId, key, vel, when, dur, segs) ?? null,
  onChange: () => plugHooks.changed?.(),
  // double-tap pattern (clip nada) = buka piano roll; nada diedit langsung ke clip itu (lihat plNotesChanged)
  onOpenClip: clip => openClipEditor(clip),
  // zoom vertikal playlist -> tinggi kartu channel mixer (--pl-row) dan gulir vertikal playlist -> posisi kartu (top negatif). Zoom horizontal tidak mengubah apa pun di sini.
  // data-rowsize menyesuaikan isi kartu dengan tingginya (xs: tanpa baris volume/pan, s: rapat, m: normal, l: renggang), lihat styles.css
  onView: ({ rowH, scrollY }) => {
    tlist.classList.add('tracklist--pl');
    tlist.style.setProperty('--pl-row', rowH.toFixed(2) + 'px');
    hdrs.style.top = (-scrollY).toFixed(2) + 'px';
    const sz = rowH < 56 ? 'xs' : rowH < 68 ? 's' : rowH >= 90 ? 'l' : 'm';
    if (tlist.dataset.rowsize !== sz) tlist.dataset.rowsize = sz;
  },
  // ikon tombol Play di bilah bawah ikut berubah (Putar / Jeda) saat playlist canvas play / stop
  onTransport: playing => {
    plugHooks.transport?.(playing);
    cancelAnimationFrame(phRaf); if (playing) phRaf = requestAnimationFrame(phLoop); else pushPlayhead();   // berhenti: playhead piano roll diam di posisi stop
    const btn = document.querySelector('.tp .play');
    if (!btn) return;
    btn.setAttribute('aria-label', playing ? 'Jeda' : 'Putar');
    btn.querySelector('use')?.setAttribute('href', playing ? '#pause-icon' : '#play-icon');
    setPianoRollPlaying(playing);   // tombol Play di piano roll tersembunyi saat main
  }
});
(window as unknown as { __playlist: PlaylistCanvasHandle }).__playlist = playlist;

// tinggi wadah = tinggi area workspace (host sticky, jadi tidak ikut tergulung kalau kolom channel lebih panjang)
const fit = () => { host.style.height = ws.clientHeight + 'px'; tlist.style.height = ws.clientHeight + 'px'; playlist.resize(); };   // kolom channel mixer setinggi area yang sama: digulung lewat onView, bukan oleh scroll workspace
new ResizeObserver(fit).observe(ws);
new ResizeObserver(() => playlist.resize()).observe(host);
fit();
