// Pitch clip audio, mengikuti pola dari hasil bedah libFLM.so FL Studio Mobile 3.4.5 (CSamplerLine / CSampleBank / CSampleStream).
//
// Dua jalur, dipilih lewat tombol Sync pada clip:
//   A. Sync mati  = varispeed: pitch hanya mengubah kecepatan baca (playbackRate). Durasi ikut berubah.
//   B. Sync aktif = pitch tanpa mengubah durasi. Dirender dulu ke AudioBuffer (offline), di-cache dengan kunci
//      (file, stretch, pitch), lalu diputar dengan kecepatan normal. Polanya sama dengan élastique:
//        1. time-stretch dengan faktor stretch x pitch
//        2. resample dengan rasio 1 / pitch  ->  durasi akhir = stretch, frekuensi bergeser sebesar pitch.
//
// Mesin utama: Signalsmith Stretch (MIT, WASM), bukan élastique. Library-nya dijalankan OFFLINE tanpa AudioWorklet: kelas
// pemroses bawaannya ditangkap lewat shim registerProcessor lalu dipanggil blok demi blok (128 sampel, sama seperti worklet).
// WSOLA buatan sendiri (renderPitchedWsola) tetap disimpan tapi TIDAK dipakai sebagai fallback: jauh lebih sederhana dan
// terdengar "berair" untuk campuran padat dan pitch jauh. Kalau Signalsmith gagal, render dibatalkan (null) dan error dicatat.
// Antarmuka renderPitched sengaja sempit supaya mesinnya bisa diganti tanpa mengubah pemanggil.

export const PITCH_MIN = -24;   // semitone, langkah bulat (sama dengan FL: nilai 0..1 x 48 - 24, dipotong ke arah nol)
export const PITCH_MAX = 24;

/** semitone -> rasio frekuensi (2 pangkat semitone/12) */
export const pitchRatio = (st: number): number => Math.pow(2, st / 12);
export const clampPitch = (st: number): number => Math.max(PITCH_MIN, Math.min(PITCH_MAX, Math.trunc(st)));
/** nilai ternormalisasi 0..1 (0,5 = netral) -> semitone bulat, persis rumus parameter pitch sampler FL */
export const normToSemitone = (v: number): number => Math.trunc(v * 48 - 24);

const breathe = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/* ---------- time-stretch: WSOLA ---------- */

/**
 * Time-stretch dengan WSOLA. Panjang keluaran = panjang masukan x factor. Nada tidak berubah.
 * Semua channel memakai posisi segmen yang sama (dicari dari campuran mono), jadi citra stereo terjaga.
 */
async function wsolaStretch(chans: Float32Array[], sr: number, factor: number, isCancelled: () => boolean): Promise<Float32Array[]> {
  const n = chans[0].length, nch = chans.length;
  const outLen = Math.max(1, Math.round(n * factor));
  const out = chans.map(() => new Float32Array(outLen + 8192));
  // jendela ±46 ms, hop keluaran setengah jendela, toleransi pencarian ±12 ms
  const N = Math.max(256, 2 * Math.round(sr * 0.023));
  const Hs = N / 2, Ha = Hs / factor, tol = Math.max(32, Math.round(sr * 0.012));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / N);   // Hann (jumlah 50% overlap = 1)
  // campuran mono untuk korelasi
  const mono = new Float32Array(n);
  for (let c = 0; c < nch; c++) { const d = chans[c]; for (let i = 0; i < n; i++) mono[i] += d[i] / nch; }

  const STEP = 4;   // korelasi dihitung tiap 4 sampel saja: 4x lebih cepat, cukup untuk memilih titik sambung
  const frames = Math.ceil(outLen / Hs) + 1;
  let prev = 0, tPrevNat = -1;   // prev = awal segmen terpilih sebelumnya; tPrevNat = awal "kelanjutan alami" segmen itu
  const t0 = performance.now();
  for (let m = 0; m < frames; m++) {
    const nominal = Math.round(m * Ha);
    let q = nominal;
    if (m > 0) {
      const nat = prev + Hs;   // kelanjutan alami segmen sebelumnya
      tPrevNat = nat;
      let best = -Infinity, bestQ = nominal;
      const lo = Math.max(0, nominal - tol), hi = Math.min(n - N, nominal + tol);
      for (let cand = lo; cand <= hi; cand++) {
        let s = 0;
        for (let i = 0; i < Hs; i += STEP) {
          const a = nat + i, b = cand + i;
          if (a >= n || b >= n) break;
          s += mono[a] * mono[b];
        }
        if (s > best) { best = s; bestQ = cand; }
      }
      q = hi >= lo ? bestQ : Math.max(0, Math.min(n - 1, nominal));
    }
    const o = m * Hs;
    if (o >= outLen) break;
    for (let c = 0; c < nch; c++) {
      const src = chans[c], dst = out[c];
      for (let i = 0; i < N; i++) {
        const si = q + i;
        if (si >= n) break;
        dst[o + i] += src[si] * win[i];
      }
    }
    prev = q;
    if ((m & 63) === 63 && performance.now() - t0 > 12) {   // beri napas ke UI tiap beberapa ms kerja
      await breathe();
      if (isCancelled()) return [];
    }
  }
  void tPrevNat;
  return out.map(d => d.subarray(0, outLen));
}

/* ---------- low-pass anti-aliasing (pitch naik) ---------- */

/** Butterworth orde 4 (dua biquad RBJ berurutan), diterapkan di tempat. */
function lowpass4(d: Float32Array, sr: number, fc: number): void {
  const w0 = 2 * Math.PI * Math.min(fc, sr * 0.49) / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  for (const Q of [0.5412, 1.3066]) {
    const alpha = sw / (2 * Q), a0 = 1 + alpha;
    const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = -2 * cw / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < d.length; i++) {
      const x = d[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; d[i] = y;
    }
  }
}

/* ---------- resample: interpolasi Hermite (kubik) ---------- */

/** Baca d dengan langkah `step` (>1 = lebih cepat/nada naik). Panjang keluaran = ceil(panjang / step). */
function resampleHermite(d: Float32Array, step: number): Float32Array {
  const n = d.length, len = Math.max(1, Math.ceil(n / step)), out = new Float32Array(len), last = n - 1;
  for (let i = 0; i < len; i++) {
    const p = i * step, k = Math.floor(p), f = p - k;
    const y0 = d[k > 0 ? k - 1 : 0], y1 = d[Math.min(last, k)], y2 = d[Math.min(last, k + 1)], y3 = d[Math.min(last, k + 2)];
    const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    out[i] = ((c3 * f + c2) * f + c1) * f + y1;
  }
  return out;
}

/* ---------- render offline + cache ---------- */

/**
 * Mesin alternatif (WSOLA), TIDAK dipakai otomatis (bukan fallback), disimpan untuk dipanggil manual bila diperlukan: time-stretch (stretch x pitchRatio) lalu resample (1 / pitchRatio).
 * Hasil: durasi = durasi asli x stretch, frekuensi digeser sebesar pitchRatio. Mengembalikan null kalau dibatalkan.
 * Faktor stretch x pitch dibatasi minimal 0,1 (sama dengan batas bawah di library FL).
 */
export async function renderPitchedWsola(
  buf: AudioBuffer, ctx: BaseAudioContext, stretch: number, semitones: number, isCancelled: () => boolean = () => false
): Promise<AudioBuffer | null> {
  const ratio = pitchRatio(semitones), sr = buf.sampleRate;
  const factor = Math.max(0.1, stretch * ratio);
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const stretched = await wsolaStretch(chans, sr, factor, isCancelled);
  if (!stretched.length || isCancelled()) return null;
  const outChans: Float32Array[] = [];
  for (const d of stretched) {
    if (ratio > 1.0001) lowpass4(d, sr, 0.45 * sr / ratio);   // isi di atas Nyquist baru dibuang dulu supaya tidak alias
    outChans.push(ratio === 1 ? d : resampleHermite(d, ratio));
    await breathe();
    if (isCancelled()) return null;
  }
  const out = ctx.createBuffer(outChans.length, outChans[0].length, sr);
  outChans.forEach((d, c) => out.copyToChannel(d as Float32Array<ArrayBuffer>, c));
  return out;
}

/* ---------- mesin utama: Signalsmith Stretch (offline) ---------- */

interface SSProc {
  wasmReady: boolean;
  port: { onmessage: ((e: { data: unknown[] }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: unknown): boolean;
}
type SSCtor = new (options: unknown) => SSProc;
const G = globalThis as unknown as Record<string, unknown>;

let ssLoad: Promise<SSCtor> | null = null;
/**
 * Muat library dan tangkap kelas pemrosesnya. Library mendaftarkan kelas itu lewat registerProcessor() saat dievaluasi di
 * AudioWorkletGlobalScope; di sini kita pasang shim sementara supaya kelasnya bisa dipakai langsung di thread biasa.
 * Hanya dimuat saat pertama kali ada clip yang butuh Sync (dynamic import = chunk terpisah, tidak membebani startup).
 */
function loadSignalsmith(): Promise<SSCtor> {
  if (ssLoad) return ssLoad;
  ssLoad = (async () => {
    let cls: SSCtor | null = null;
    const had = { w: 'AudioWorkletProcessor' in G, r: 'registerProcessor' in G };
    G.AudioWorkletProcessor = class { port = { postMessage(): void { /* tidak dipakai */ }, onmessage: null }; };
    G.registerProcessor = (_name: string, c: SSCtor): void => { cls = c; };
    try { await import('signalsmith-stretch'); }
    finally { if (!had.w) delete G.AudioWorkletProcessor; if (!had.r) delete G.registerProcessor; }
    if (!cls) throw new Error('signalsmith: kelas pemroses tidak terdaftar');
    return cls;
  })();
  ssLoad.catch(() => { ssLoad = null; });   // gagal (mis. offline): coba lagi di permintaan berikutnya
  return ssLoad;
}

// Library membaca `sampleRate` dan `currentTime` dari scope global worklet, jadi render dijalankan satu per satu (antrean)
// dan variabel global itu diisi sebelum setiap panggilan. Selesai satu render, kedua variabel dibersihkan lagi.
let ssQueue: Promise<unknown> = Promise.resolve();

async function ssRender(Cls: SSCtor, chans: Float32Array[], sr: number, stretch: number, st: number, isCancelled: () => boolean, onProgress?: (frac: number) => void): Promise<Float32Array[] | null> {
  const nch = Math.min(2, chans.length);   // clip dengan >2 channel hanya dua channel pertama yang dirender (mixer di sini stereo)
  const n = chans[0].length, outN = Math.max(1, Math.round(n * stretch));
  const BLOCK = 128;                       // ukuran render quantum worklet. Blok lebih besar membuat level turun ±2 dB dan waktu bergeser
  G.sampleRate = sr; G.currentTime = 0;
  try {
    const proc = new Cls({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [nch] });
    for (let i = 0; !proc.wasmReady; i++) {   // WASM dimuat async; configure() di dalamnya membaca sampleRate, jadi tetap terpasang
      if (i > 2000) throw new Error('signalsmith: WASM tidak siap');
      await breathe(); G.sampleRate = sr;
      if (isCancelled()) return null;
    }
    const send = (method: string, ...args: unknown[]): void => proc.port.onmessage!({ data: [0, method, ...args] });
    send('addBuffers', chans.slice(0, nch));
    send('schedule', { active: true, input: 0, output: 0, rate: 1 / stretch, semitones: st });
    const out = Array.from({ length: nch }, () => new Float32Array(outN));
    const blk = Array.from({ length: nch }, () => new Float32Array(BLOCK));
    const inputs: Float32Array[][] = [[]], outputs = [blk];
    let t0 = performance.now();
    onProgress?.(0);
    for (let pos = 0, k = 0; pos < outN; pos += BLOCK, k++) {
      G.currentTime = pos / sr; G.sampleRate = sr;
      proc.process(inputs, outputs, {});
      const m = Math.min(BLOCK, outN - pos);
      for (let c = 0; c < nch; c++) out[c].set(blk[c].subarray(0, m), pos);
      if ((k & 63) === 63 && performance.now() - t0 > 12) {   // beri napas ke UI tiap beberapa ms kerja
        onProgress?.(pos / outN);
        await breathe();
        if (isCancelled()) return null;
        t0 = performance.now();
      }
    }
    onProgress?.(1);
    return out;
  } finally { delete G.sampleRate; delete G.currentTime; }
}

/**
 * Render buffer ber-pitch dengan Signalsmith Stretch. Durasi hasil = durasi asli x stretch, frekuensi digeser sebesar
 * 2^(semitone/12). Kalau library tidak bisa dimuat / dijalankan, TIDAK ada fallback: error dicatat dan hasilnya null. Mengembalikan null juga kalau dibatalkan.
 */
export async function renderPitched(
  buf: AudioBuffer, ctx: BaseAudioContext, stretch: number, semitones: number, isCancelled: () => boolean = () => false, onProgress?: (frac: number) => void
): Promise<AudioBuffer | null> {
  let out: Float32Array[] | null = null;
  try {
    const Cls = await loadSignalsmith();
    const chans: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const job = ssQueue.then(() => isCancelled() ? null : ssRender(Cls, chans, buf.sampleRate, stretch, semitones, isCancelled, onProgress));
    ssQueue = job.catch(() => null);
    out = await job;
    if (!out || isCancelled()) return null;
  } catch (e) {
    if (isCancelled()) return null;
    console.error('Signalsmith Stretch gagal dipakai (tanpa fallback WSOLA):', e);
    return null;
  }
  const res = ctx.createBuffer(out.length, out[0].length, buf.sampleRate);
  out.forEach((d, c) => res.copyToChannel(d as Float32Array<ArrayBuffer>, c));
  return res;
}

/**
 * Cache hasil render, kunci (file, stretch, pitch) seperti CSampleBank::ImportSample di FL: permintaan yang sama persis
 * memakai hasil yang sudah ada dan tidak dirender ulang. Dibatasi total memori (entri terlama dibuang lebih dulu).
 */
export interface PitchCache {
  /** buffer siap pakai, atau null kalau belum selesai dirender (render dimulai otomatis) */
  get(fileId: string, src: AudioBuffer, ctx: BaseAudioContext, stretch: number, semitones: number): AudioBuffer | null;
  /** true selama kombinasi itu masih dirender */
  busy(fileId: string, stretch: number, semitones: number): boolean;
  /** kemajuan render 0..1 selama kombinasi itu dirender, null kalau tidak sedang dirender */
  progress(fileId: string, stretch: number, semitones: number): number | null;
  clear(): void;
}
export function createPitchCache(onReady: () => void, maxBytes = 256 * 1024 * 1024, onProgress?: () => void): PitchCache {
  interface Item { buf: AudioBuffer | null; bytes: number; stamp: number; cancelled: boolean; progress: number; }
  const items = new Map<string, Item>();
  let stamp = 0;
  const key = (id: string, stretch: number, st: number): string => `${id}|${stretch.toFixed(6)}|${st}`;
  const total = (): number => { let t = 0; for (const it of items.values()) t += it.bytes; return t; };
  function trim(keep: string): void {
    while (total() > maxBytes) {
      let oldest: string | null = null, os = Infinity;
      for (const [k, it] of items) if (k !== keep && it.buf && it.stamp < os) { os = it.stamp; oldest = k; }
      if (oldest == null) break;
      items.delete(oldest);
    }
  }
  return {
    get(fileId, src, ctx, stretch, st) {
      const k = key(fileId, stretch, st), it = items.get(k);
      if (it) { it.stamp = ++stamp; return it.buf; }
      const item: Item = { buf: null, bytes: 0, stamp: ++stamp, cancelled: false, progress: 0 };
      items.set(k, item);
      void renderPitched(src, ctx, stretch, st, () => item.cancelled, f => { item.progress = f; onProgress?.(); }).then(b => {
        if (!b || item.cancelled) { items.delete(k); return; }
        item.buf = b; item.bytes = b.length * b.numberOfChannels * 4;
        trim(k); onReady();
      }).catch(() => { items.delete(k); });
      return null;
    },
    progress(fileId, stretch, st) { const it = items.get(key(fileId, stretch, st)); return it && !it.buf ? it.progress : null; },
    busy(fileId, stretch, st) { const it = items.get(key(fileId, stretch, st)); return !!it && !it.buf; },
    clear() { for (const it of items.values()) it.cancelled = true; items.clear(); }
  };
}
