// Memasang playlist canvas di #playlistHost (di sebelah kolom channel). Fungsi modul (mixer, efek, piano roll, transport, project)
// belum disambungkan ke playlist ini; itu dikerjakan belakangan lewat handle `playlist` (window.__playlist untuk percobaan).
import { mountPlaylist, type PlaylistCanvasHandle } from './playlist-canvas';
import './playlist-host.css';

const host = document.getElementById('playlistHost') as HTMLElement;
const ws = document.querySelector('.workspace') as HTMLElement;

// file audio yang di-upload lewat alur Audio clip: id -> File; dibaca playlist canvas lewat getAudioBlob (diputar dan digambar gelombangnya)
export const audioFiles = new Map<string, Blob>();

export const playlist: PlaylistCanvasHandle = mountPlaylist(host, {
  theme: 'web',
  getAudioBlob: async id => audioFiles.get(id) ?? null,
  // ikon tombol Play di bilah bawah ikut berubah (Putar / Jeda) saat playlist canvas play / stop
  onTransport: playing => {
    const btn = document.querySelector('.tp .play');
    if (!btn) return;
    btn.setAttribute('aria-label', playing ? 'Jeda' : 'Putar');
    btn.querySelector('use')?.setAttribute('href', playing ? '#pause-icon' : '#play-icon');
  }
});
(window as unknown as { __playlist: PlaylistCanvasHandle }).__playlist = playlist;

// tinggi wadah = tinggi area workspace (host sticky, jadi tidak ikut tergulung kalau kolom channel lebih panjang)
const fit = () => { host.style.height = ws.clientHeight + 'px'; playlist.resize(); };
new ResizeObserver(fit).observe(ws);
new ResizeObserver(() => playlist.resize()).observe(host);
fit();
