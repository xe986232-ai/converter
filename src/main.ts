// Entry point: playlist lama (kolom track + timeline DOM + lane/pattern) sudah diganti total dengan playlist canvas (src/playlist/).
// Fungsi modul (mixer, efek, piano roll, transport, simpan project, dst.) SENGAJA belum disambungkan ke playlist baru.
// Logika lama utuh ada di src/main-old.ts (tidak diimpor) sebagai acuan waktu menyambungkan fungsi satu per satu.
import '@fontsource/syncopate/700.css';
import '@fontsource/plus-jakarta-sans/latin-400.css';
import '@fontsource/plus-jakarta-sans/latin-600.css';
import '@fontsource/plus-jakarta-sans/latin-700.css';
import './no-context-menu';
import './no-zoom';
import './ui-theme';
import { registerSW } from './pwa';
import { initLandscape } from './landscape';
import { initMenuPanel } from './menu-panel';
import { mountPlaylist, type PlaylistCanvasHandle } from './playlist/playlist-canvas';
import './playlist/playlist-host.css';

registerSW();
initLandscape();
initMenuPanel();

const host = document.getElementById('playlistHost') as HTMLElement;
export const playlist: PlaylistCanvasHandle = mountPlaylist(host, { theme: 'dark' });

// ukuran canvas mengikuti wadahnya (rotasi layar, panel dibuka / ditutup)
new ResizeObserver(() => playlist.resize()).observe(host);
