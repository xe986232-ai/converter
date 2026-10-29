// Entry tahap 1: HANYA playlist canvas (dari repo akuhanya, kode asli di src/pl/). Aplikasi deriz lama (main.ts, track header, ruler DOM,
// lane / pattern DOM) tidak dimuat lagi; modul DSP / plugin lama masih ada di src/ dan akan disambung bertahap.
import './pl-shell.css';
import { mountPlaylist, demoState, type PlaylistCanvasHandle } from './playlist-canvas';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const host = $('pl-host');

// file audio yang sudah dimasukkan (id -> Blob); playlist membaca isinya lewat getAudioBlob (decode + waveform + diputar)
const blobs = new Map<string, Blob>();
let fileSeq = 0;

const playlist: PlaylistCanvasHandle = mountPlaylist(host, {
  title: 'Melvox',
  theme: 'dark',
  getAudioBlob: async id => blobs.get(id) ?? null
});

async function dropAudio(files: FileList | File[], x: number, y: number): Promise<void> {
  let i = 0;
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('audio/') && !/\.(wav|mp3|ogg|m4a|aac|flac|webm)$/i.test(f.name)) continue;
    const id = 'f' + (++fileSeq);
    blobs.set(id, f);
    // tiap file berikutnya diturunkan satu baris supaya tidak bertumpuk
    await playlist.addAudioClip(id, f.name, x, y + i * 40);
    i++;
  }
}

// tombol + Audio: file diletakkan di area clip bagian kiri-atas playlist
const fileIn = $<HTMLInputElement>('file-audio');
$('btn-audio').onclick = () => fileIn.click();
fileIn.onchange = () => {
  const r = host.getBoundingClientRect();
  if (fileIn.files?.length) void dropAudio(fileIn.files, r.left + r.width * 0.25, r.top + r.height * 0.3);
  fileIn.value = '';
};

// seret file audio dari komputer ke playlist
host.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); host.classList.add('is-drop'); } });
host.addEventListener('dragleave', () => host.classList.remove('is-drop'));
host.addEventListener('drop', e => {
  host.classList.remove('is-drop');
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  void dropAudio(e.dataTransfer.files, e.clientX, e.clientY);
});

$('btn-new').onclick = () => { if (confirm('Mulai project kosong? Perubahan yang belum disimpan hilang.')) { playlist.stop(); blobs.clear(); playlist.setState({ tracks: [], clips: [] }); } };
$('btn-demo').onclick = () => { playlist.stop(); playlist.setState(demoState()); };
