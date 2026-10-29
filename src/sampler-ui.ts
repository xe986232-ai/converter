// Tampilan plugin SAMPLER: kartu di panel efek track (nama, tombol Upload audio, waveform sample, knob Pitch / Attack / Release / Volume).
// Hanya markup + gambar waveform; logika knob dan upload memakai mesin kartu yang sama dengan plugin lain (fx-rack.ts).
// Suaranya sendiri ada di sampler-engine.ts (mandiri, tanpa algoritma DERIZ).

export interface SamplerData { name: string; dur: number; buf: AudioBuffer; }

const ICON_UP = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>';

const esc = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
export const fmtDur = (s: number): string => (s < 10 ? s.toFixed(2) : s < 100 ? s.toFixed(1) : Math.round(s).toString()) + ' s';

// knob(key) = markup satu knob dari mesin kartu (fx-rack.ts)
export function samplerHtml(z: SamplerData | undefined, accept: string, knob: (key: string) => string): string {
  return `<div class="fxc__knobs smp"><div class="smp__col">` +
    `<div class="smp__knobs">${knob('pitch')}${knob('attack')}${knob('release')}${knob('volume')}</div>` +
    `<div class="smp__stage${z ? ' has-audio' : ''}"><canvas class="smp__cv" role="img" aria-label="Waveform audio SAMPLER"></canvas>` +
    `<button type="button" class="smp__up">${ICON_UP}<span>Upload audio</span></button></div>` +
    `<div class="smp__foot"><span class="smp__name">${z ? esc(z.name) : 'Belum ada audio'}</span><span class="smp__dur">${z ? fmtDur(z.dur) : ''}</span>` +
    `<button type="button" class="smp__swap"${z ? '' : ' hidden'}>Ganti</button></div>` +
    `<input type="file" class="smp__file" accept="${accept}" hidden></div></div>`;
}

// perbarui teks nama / durasi / tombol Ganti setelah audio dimuat (tanpa merender ulang kartu)
export function updateSamplerUi(card: HTMLElement, z: SamplerData | undefined): void {
  card.querySelector('.smp__stage')?.classList.toggle('has-audio', !!z);
  card.querySelector('.smp__stage')?.classList.remove('is-loading');
  const n = card.querySelector<HTMLElement>('.smp__name'), d = card.querySelector<HTMLElement>('.smp__dur'), sw = card.querySelector<HTMLElement>('.smp__swap');
  if (n) { n.textContent = z ? z.name : 'Belum ada audio'; n.title = z ? z.name : ''; }
  if (d) d.textContent = z ? fmtDur(z.dur) : '';
  if (sw) sw.hidden = !z;
}

// waveform: min / max per kolom piksel, mono dari semua kanal; kanvas kosong kalau belum ada audio
export function paintSampler(card: HTMLElement, z: SamplerData | undefined): void {
  const cv = card.querySelector<HTMLCanvasElement>('.smp__cv'); if (!cv) return;
  const dpr = window.devicePixelRatio || 1, w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w) cv.width = w;
  if (cv.height !== h) cv.height = h;
  const g = cv.getContext('2d'); if (!g) return;
  g.clearRect(0, 0, w, h);
  if (!z) return;
  const cs = getComputedStyle(cv), ink = cs.getPropertyValue('--smp-wave').trim() || '#b9a6ff', mid = h / 2;
  const chs: Float32Array[] = []; for (let c = 0; c < z.buf.numberOfChannels; c++) chs.push(z.buf.getChannelData(c));
  const len = chs[0].length, per = len / w, step = Math.max(1, Math.floor(per / 48));
  g.fillStyle = ink;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x * per), b = Math.min(len, Math.max(a + 1, Math.floor((x + 1) * per)));
    let lo = 0, hi = 0;
    for (let i = a; i < b; i += step) {
      let s = 0; for (let c = 0; c < chs.length; c++) s += chs[c][i];
      s /= chs.length;
      if (s < lo) lo = s; if (s > hi) hi = s;
    }
    const y0 = mid - Math.min(1, hi) * mid * 0.92, y1 = mid - Math.max(-1, lo) * mid * 0.92;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.fillStyle = 'rgba(255,255,255,.12)'; g.fillRect(0, Math.round(mid), w, 1);   // garis nol
}
