// Spectrogram untuk canvas audio module vsynth: STFT (FFT 2048, jendela Hann) -> skala dB -> peta warna.
// Sumbu X = waktu, sumbu Y = frekuensi (skala log, rendah di bawah).

const FFT_N = 2048;

export interface Spectro { cols: number; rows: number; dur: number; data: Uint8Array; }   // dur = durasi file (detik)   // data[col * rows + row], 0..255, row 0 = frekuensi terendah

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/** Hitung spectrogram dari AudioBuffer (mono mix). Bertahap (async) supaya UI tidak macet. */
export async function computeSpectrogram(buf: AudioBuffer, cols = 1600, rows = 160): Promise<Spectro> {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const mono = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }

  const win = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_N - 1));

  // peta baris tampilan -> bin FFT (skala log 30 Hz .. Nyquist)
  const fMin = 30, fMax = Math.min(sr / 2, 20000), half = FFT_N / 2;
  const binOf = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    const f = fMin * Math.pow(fMax / fMin, r / (rows - 1));
    binOf[r] = Math.min(half - 1, f * FFT_N / sr);
  }

  const data = new Uint8Array(cols * rows);
  const re = new Float32Array(FFT_N), im = new Float32Array(FFT_N), mag = new Float32Array(half);
  const DB_MIN = -90, DB_MAX = -10;
  for (let c = 0; c < cols; c++) {
    const center = Math.floor((c + 0.5) * len / cols), start = center - FFT_N / 2;
    for (let i = 0; i < FFT_N; i++) { const s = start + i; re[i] = s >= 0 && s < len ? mono[s] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]) / (FFT_N / 4);
    for (let r = 0; r < rows; r++) {
      const b = binOf[r], i0 = Math.floor(b), i1 = Math.min(half - 1, i0 + 1), fr = b - i0;
      const m = mag[i0] * (1 - fr) + mag[i1] * fr;
      const db = 20 * Math.log10(m + 1e-9);
      const v = (db - DB_MIN) / (DB_MAX - DB_MIN);
      data[c * rows + r] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    if (c % 24 === 23) await new Promise(res => setTimeout(res, 0));
  }
  return { cols, rows, dur: buf.duration, data };
}

// peta warna: hitam -> ungu tua -> merah/oranye -> kuning -> putih
const STOPS: [number, number, number, number][] = [
  [0.00, 8, 6, 20], [0.25, 60, 15, 110], [0.50, 190, 50, 80], [0.75, 245, 150, 40], [1.00, 255, 250, 200]
];
const LUT = (() => {
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let s = 0;
    while (s < STOPS.length - 2 && v > STOPS[s + 1][0]) s++;
    const a = STOPS[s], b = STOPS[s + 1], f = (v - a[0]) / (b[0] - a[0]);
    for (let k = 0; k < 3; k++) t[i * 3 + k] = Math.round(a[k + 1] + (b[k + 1] - a[k + 1]) * f);
  }
  return t;
})();

/** Gambar spectrogram ke canvas untuk rentang waktu v0..v1 (pecahan 0..1 dari tampilan), dengan interpolasi halus saat zoom.
 *  flip = tampilan terbalik (Reverse): waktu dibaca dari ujung file, jadi v0..v1 adalah posisi pada waktu terbalik. */
export function drawSpectrogram(canvas: HTMLCanvasElement, sp: Spectro, v0 = 0, v1 = 1, flip = false): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  const img = ctx.createImageData(W, H);
  const xa = new Int32Array(W), xb = new Int32Array(W), xf = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const f = v0 + (x + 0.5) / W * (v1 - v0), pos = (flip ? 1 - f : f) * sp.cols - 0.5, c0 = Math.floor(pos);
    xf[x] = pos - c0;
    xa[x] = Math.max(0, Math.min(sp.cols - 1, c0)); xb[x] = Math.max(0, Math.min(sp.cols - 1, c0 + 1));
  }
  for (let y = 0; y < H; y++) {
    const rp = (H - 1 - y + 0.5) / H * sp.rows - 0.5, r0 = Math.floor(rp), fy = rp - r0;   // atas = frekuensi tinggi
    const ra = Math.max(0, Math.min(sp.rows - 1, r0)), rb = Math.max(0, Math.min(sp.rows - 1, r0 + 1));
    for (let x = 0; x < W; x++) {
      const a = sp.data[xa[x] * sp.rows + ra], b = sp.data[xb[x] * sp.rows + ra];
      const c = sp.data[xa[x] * sp.rows + rb], d = sp.data[xb[x] * sp.rows + rb];
      const top = a + (b - a) * xf[x], bot = c + (d - c) * xf[x];
      const v = Math.round(top + (bot - top) * fy), o = (y * W + x) * 4;
      img.data[o] = LUT[v * 3]; img.data[o + 1] = LUT[v * 3 + 1]; img.data[o + 2] = LUT[v * 3 + 2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
