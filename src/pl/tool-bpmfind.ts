// Tool "bpmfind" (kartu di panel Tools):
// - TAP: ketuk mengikuti ketukan; BPM = rata-rata interval dari maksimal 8 ketukan terakhir (reset otomatis kalau berhenti > 2,2 dtk).
// - File: pilih file audio dari perangkat, tempo diperkirakan lewat src/bpm-finder.ts (bisa meleset oktaf: pakai ½ / ×2).
// - Kotak HASIL: tempat BPM terdeteksi (angka + keterangan sumbernya). Pakai = pasang hasil (dibulatkan) sebagai BPM project.
import { el } from './ui-util';
import { detectBpm } from './bpm-finder';
import type { ToolContext } from './tools';

const TAP_RESET_MS = 2200, TAP_MAX = 8, BPM_LO = 20, BPM_HI = 400;

export function mountBpmFind(body: HTMLElement, ctx: ToolContext): void {
  const tap = el('button', 'tl-tap', 'TAP'); tap.type = 'button'; tap.title = 'Ketuk mengikuti ketukan';

  const fileBtn = el('button', 'tl-btn', 'File'); fileBtn.type = 'button'; fileBtn.title = 'Analisis tempo dari file audio';
  const fileIn = el('input'); fileIn.type = 'file'; fileIn.accept = 'audio/*,.wav,.mp3,.ogg,.m4a,.flac'; fileIn.hidden = true;
  const left = el('div', 'tl-col'); left.append(fileBtn);

  // tempat hasil BPM terdeteksi
  const lcd = el('div', 'tl-lcd');
  lcd.append(el('div', 'tl-cap', 'HASIL'));
  const top = el('div', 'tl-top');
  const val = el('div', 'tl-val', '—');
  top.append(val, el('span', 'tl-unit', 'BPM'));
  const status = el('div', 'tl-status');
  lcd.append(top, status);

  const half = el('button', 'tl-btn', '½'); half.type = 'button'; half.title = 'Setengah tempo';
  const dbl = el('button', 'tl-btn', '×2'); dbl.type = 'button'; dbl.title = 'Dua kali tempo';
  const useBtn = el('button', 'tl-btn tl-use', 'Pakai'); useBtn.type = 'button'; useBtn.title = 'Pasang sebagai BPM project';
  const adj = el('div', 'tl-col'); const hd = el('div', 'tl-pair'); hd.append(half, dbl); adj.append(hd, useBtn);

  body.append(tap, left, lcd, adj, fileIn);

  let bpm: number | null = null;
  const show = (v: number | null, msg: string): void => {
    bpm = v;
    val.textContent = v == null ? '—' : v.toFixed(1);
    status.textContent = msg;
    useBtn.disabled = half.disabled = dbl.disabled = v == null;
  };
  show(null, 'Ketuk TAP atau pilih File');

  // ---- TAP ----
  let taps: number[] = [];
  const doTap = (): void => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > TAP_RESET_MS) taps = [];
    taps.push(now);
    if (taps.length > TAP_MAX) taps.shift();
    tap.classList.add('hit'); window.setTimeout(() => tap.classList.remove('hit'), 90);
    if (taps.length < 2) { show(null, 'Ketuk lagi…'); return; }
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    show(Math.round(Math.min(BPM_HI, Math.max(BPM_LO, 60000 / avg)) * 10) / 10, 'Tap · ' + taps.length + ' ketukan');
  };
  tap.addEventListener('pointerdown', e => { e.preventDefault(); doTap(); });
  tap.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); doTap(); } });
  tap.addEventListener('click', e => e.preventDefault());

  // ---- ½ / ×2 ----
  const scale = (k: number): void => {
    if (bpm == null) return;
    show(Math.round(Math.min(BPM_HI, Math.max(BPM_LO, bpm * k)) * 10) / 10, k < 1 ? 'Setengah tempo' : 'Dua kali tempo');
  };
  half.onclick = () => scale(0.5);
  dbl.onclick = () => scale(2);

  // ---- File ----
  let busy = false;
  fileBtn.onclick = () => { if (!busy) fileIn.click(); };
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0]; fileIn.value = '';
    if (!f || busy) return;
    busy = true; fileBtn.disabled = true; show(null, 'Menganalisis…');
    try {
      const data = await f.arrayBuffer();
      const buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);
      await new Promise(r => window.setTimeout(r, 30));   // beri kesempatan UI menampilkan "Menganalisis…"
      const r = detectBpm(buf);
      if (!r) show(null, 'Audio terlalu pendek (min. 8 dtk) / tidak berirama');
      else show(r.bpm, 'Keyakinan ' + (r.confidence >= 25 ? 'tinggi' : r.confidence >= 16 ? 'sedang' : 'rendah') + ' · ' + f.name);
    } catch {
      show(null, 'File tidak bisa dibaca');
    } finally { busy = false; fileBtn.disabled = false; }
  };

  // ---- Pakai ----
  let useTimer = 0;
  useBtn.onclick = () => {
    if (bpm == null) return;
    ctx.setBpm(Math.round(bpm));
    const now = ctx.getBpm();
    useBtn.textContent = now === Math.round(bpm) ? 'Terpasang ✓' : 'Dibatasi ' + now;
    window.clearTimeout(useTimer);
    useTimer = window.setTimeout(() => { useBtn.textContent = 'Pakai'; }, 1500);
  };
}
