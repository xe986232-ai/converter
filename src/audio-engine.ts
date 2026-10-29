// Mesin audio clip: decode file, simpan buffer, gambar waveform sederhana, dan putar sesuai posisi playhead.
// Satu clip di timeline = elemen .pattern dengan data-clip (id buffer) dan data-off (offset dalam detik).

import { buildPyramid, getPeaks, type Pyramid } from './waveform';
import { deesserLoaded, loadDeesser, createDeesser } from './deesser';
import { vocalfLoaded, loadVocalf, createVocalf } from './vocalf';
import { autotuneLoaded, loadAutotune, createAutotune, autotuneLatencySec } from './autotune-dsp';
import { livetuneLoaded, loadLivetune, createLivetune, livetuneLatencySec } from './livetune-dsp';   // LIVETUNE: mesin salinan mandiri (tidak berbagi kode dengan autotune-dsp.ts)
import { mxLoaded, mxLoad, mxActive, createMxStage, type MxStage } from './autotune-fx';   // tahap efek mixer SETELAH autotune (algoritma autotune-dsp.ts tidak diubah)
import { createDelay, type DelayParams, type DelayUnit } from './delay-fx';
import { reverbLoaded, loadReverb, createReverb } from './reverb-dsp';
import { clipWindow } from './audio-health';

interface Entry { buf: AudioBuffer; pyr?: Pyramid; }
const buffers = new Map<number, Entry>();
let seq = 0;

export interface ClipPlacement {
  track: string;
  clip: number;
  startBar: number;
  endBar: number;
  offsetSec: number;
}

export async function decodeFile(ctx: AudioContext, file: File): Promise<AudioBuffer> {
  return ctx.decodeAudioData(await file.arrayBuffer());
}

// Decode file untuk plugin (mis. DERIZ) tanpa AudioContext yang sedang berjalan: OfflineAudioContext tidak butuh gestur pengguna.
export async function decodeStandalone(file: File): Promise<AudioBuffer> {
  const Ctor = window.OfflineAudioContext || (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  return new Ctor(2, 1, 44100).decodeAudioData(await file.arrayBuffer());
}

// Puncak (min, max) per "bucket" rata di seluruh durasi; semua channel digabung. Hasil: [min0, max0, min1, max1, ...]
export function bucketPeaks(buf: AudioBuffer, n: number): Float32Array {
  const p = new Float32Array(n * 2), len = buf.length;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let b = 0; b < n; b++) {
      const s0 = Math.floor(b * len / n), s1 = Math.min(len, Math.max(s0 + 1, Math.floor((b + 1) * len / n)));
      let lo = p[b * 2], hi = p[b * 2 + 1];
      for (let i = s0; i < s1; i++) { const v = d[i]; if (v < lo) lo = v; else if (v > hi) hi = v; }
      p[b * 2] = lo; p[b * 2 + 1] = hi;
    }
  }
  return p;
}

export function addBuffer(buf: AudioBuffer): number {
  const entry: Entry = { buf };
  buffers.set(++seq, entry);
  // piramid peak dibangun bertahap di belakang layar (tidak menahan UI); selesai -> semua waveform digambar ulang
  void buildPyramid(buf).then(p => { entry.pyr = p; document.dispatchEvent(new CustomEvent('wavepyr')); }).catch(() => { /* waveform gagal: clip tetap bisa diputar */ });
  return seq;
}

export const getBuffer = (id: number): AudioBuffer | undefined => buffers.get(id)?.buf;

// AudioBuffer -> WAV 16-bit PCM (dipakai untuk menyimpan audio clip ke file project)
export function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, len * ch * 2, true);
  const data = Array.from({length: ch}, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, data[c][i]));
    out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([out.buffer], {type: 'audio/wav'});
}

export const bufferDuration = (id: number): number => buffers.get(id)?.buf.duration ?? 0;

// ---------- waveform (mengikuti FL Studio Mobile: StudioUI::DrawAudioWave) ----------
// Envelope min/max dari piramid peak (waveform.ts), digambar di <canvas> dengan satu batang 1 piksel perangkat per kolom, garis nol tipis di tengah,
// skala linear tanpa normalisasi. Mode "2 batang" (Pengaturan) = kiri di lajur atas, kanan di lajur bawah; "1 batang" = semua channel digabung.
// Canvas hanya menutupi bagian clip yang terlihat di layar (+ margin), jadi biayanya sebanding lebar layar, bukan panjang clip / level zoom.
export interface WaveView { left: number; width: number; v0: number; v1: number; force: boolean; }   // satuan px timeline: posisi + lebar clip, bagian timeline yang terlihat

interface WaveState { key: string; x0: number; x1: number; h: number; color: string; }
const waveState = new WeakMap<HTMLElement, WaveState>();
let wMax = new Float32Array(0), wMin = new Float32Array(0);
let waveEpoch = 0;
/** Warna / ukuran berubah di luar data clip (tema, warna Customize, ukuran jendela): paksa semua waveform digambar ulang pada sync berikutnya. */
export const invalidateWaves = (): void => { waveEpoch++; };

export function renderWave(el: HTMLElement, clipId: number, offSec: number, durSec: number, view: WaveView): void {
  const e = buffers.get(clipId);
  if (!e || durSec <= 0 || view.width <= 0) return;
  let host = el.querySelector<HTMLElement>('.pattern__wave');
  if (!host) {
    host = document.createElement('div');
    host.className = 'pattern__wave';
    el.insertBefore(host, el.querySelector('.pattern__handle'));
  }
  let cv = host.querySelector('canvas');
  if (!cv) { cv = document.createElement('canvas'); cv.setAttribute('aria-hidden', 'true'); host.replaceChildren(cv); }

  const need0 = Math.max(0, view.v0 - view.left), need1 = Math.min(view.width, view.v1 - view.left);   // bagian clip yang terlihat
  if (need1 <= need0) {   // di luar layar: lepaskan backing store
    if (waveState.has(host)) { waveState.delete(host); cv.width = 0; }
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2), mode = document.documentElement.dataset.wfmode === 'stereo' ? 's' : 'm';
  const key = [clipId, offSec.toFixed(4), durSec.toFixed(4), Math.round(view.width * 10), dpr, mode, waveEpoch, e.pyr ? 1 : 0].join('|');
  const st = waveState.get(host);
  if (!view.force && st && st.key === key && need0 >= st.x0 && need1 <= st.x1) return;   // sudah tergambar dan menutupi layar

  const pad = (view.v1 - view.v0) * .5;
  let x0 = Math.max(0, Math.floor(need0 - pad)), x1 = Math.min(view.width, Math.ceil(need1 + pad));
  if ((x1 - x0) * dpr > 16000) { x1 = Math.min(view.width, Math.ceil(need1)); x0 = Math.max(0, Math.min(x0, Math.floor(x1 - 16000 / dpr))); }
  const cs = st && !view.force && st.key === key ? st : null;   // tinggi & warna hanya dibaca ulang kalau perlu (hindari paksa layout tiap frame)
  const h = cs ? cs.h : host.clientHeight, color = cs ? cs.color : getComputedStyle(host).color;
  waveState.set(host, { key, x0, x1, h, color });

  const wpx = Math.max(1, Math.round((x1 - x0) * dpr)), hpx = Math.max(1, Math.round(h * dpr));
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  if (cv.width !== wpx || cv.height !== hpx) { cv.width = wpx; cv.height = hpx; } else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, wpx, hpx); }
  cv.style.left = x0 + 'px'; cv.style.width = (x1 - x0) + 'px';
  const pyr = e.pyr;
  if (!pyr) return;   // piramid belum jadi: digambar begitu event 'wavepyr' datang

  const buf = e.buf, sr = buf.sampleRate;
  const fpp = sr * durSec / (view.width * dpr);                              // frame per piksel perangkat (terikat tempo & zoom)
  const start = (offSec + x0 / view.width * durSec) * sr;                    // frame di kolom pertama
  const cols = Math.min(wpx, Math.ceil((buf.length - start) / fpp));          // potong di ujung audio
  if (!(fpp > 0) || cols <= 0) return;
  const ch = pyr.ch;
  if (wMax.length < cols * ch) { wMax = new Float32Array(cols * ch); wMin = new Float32Array(cols * ch); }
  getPeaks(pyr, buf, start, fpp, cols, wMax, wMin);

  const stereo = mode === 's', lanes = stereo ? 2 : 1, laneH = hpx / lanes, amp = laneH / 2 - 0.5;
  ctx.fillStyle = color;
  for (let l = 0; l < lanes; l++) {
    const mid = laneH * (l + 0.5), c0 = Math.min(l, ch - 1);   // file mono: kedua lajur sama
    ctx.globalAlpha = 0.45; ctx.fillRect(0, Math.round(mid), cols, 1);   // garis nol
    ctx.globalAlpha = 1;
    for (let i = 0; i < cols; i++) {
      let hi: number, lo: number;
      if (stereo || ch === 1) { hi = wMax[i * ch + c0]; lo = wMin[i * ch + c0]; }
      else { hi = Math.max(wMax[i * ch], wMax[i * ch + 1]); lo = Math.min(wMin[i * ch], wMin[i * ch + 1]); }   // 1 batang: channel digabung
      const top = mid - hi * amp, bot = mid - lo * amp;
      ctx.fillRect(i, top, 1, Math.max(1, bot - top));
    }
  }
}

// ---------- playback ----------
const volumes = new Map<string, number>();       // persen per track (slider volume: 0-150, 100 = default)
const gains = new Map<string, GainNode>();
const active = new Set<{ src: AudioBufferSourceNode; env: GainNode; track: string }>();
const pctToLin = (pct: number) => pct / 100;   // 100% = gain 1.0 (tanpa perubahan), 150% = boost x1.5

const muted = new Set<string>();                  // track yang dimatikan lewat switch on/off di header track
export function setTrackMuted(track: string, off: boolean): void {
  if (off) muted.add(track); else muted.delete(track);
  const o = dests.get(track) as GainNode | undefined;   // `out` track: meter level ikut turun ke nol saat mati
  if (o) o.gain.setTargetAtTime(off ? 0 : 1, o.context.currentTime, .015);
  const ch = chains.get(track); if (ch) ch.mu.gain.setTargetAtTime(off ? 0 : 1, ch.ctx.currentTime, .015);   // kiriman reverb track yang dimatikan ikut mati
}

export function setTrackVolume(track: string, pct: number): void {
  volumes.set(track, pct);
  const g = gains.get(track);
  if (g) g.gain.setTargetAtTime(pctToLin(pct), g.context.currentTime, .02);
}

export function trackInput(ctx: AudioContext, dest: AudioNode, track: string): GainNode {   // titik masuk jalur track (fader -> efek -> out); dipakai juga oleh synth
  return trackGain(ctx, dest, track);
}

function trackGain(ctx: AudioContext, dest: AudioNode, track: string): GainNode {
  let g = gains.get(track);
  if (!g || g.context !== ctx) {
    g = ctx.createGain();
    g.gain.value = pctToLin(volumes.get(track) ?? 100);
    // titik akhir jalur track: semua efek bermuara ke `out`, lalu ke master. Meter level membaca dari sini (setelah fader + efek).
    const out = ctx.createGain();
    out.gain.value = muted.has(track) ? 0 : 1;
    out.connect(dest);
    masterDest = dest;   // reverb bersama keluar langsung ke master (bukan lewat `out` track, supaya tidak dihitung dua kali)
    g.connect(out);
    gains.set(track, g);
    dests.set(track, out);
    makeMeter(ctx, track, out);
    syncFx(track);   // track ini sudah punya kartu efek sebelum pernah diputar
  }
  return g;
}

// ---------- meter level stereo per track ----------
interface Meter { ctx: BaseAudioContext; l: AnalyserNode; r: AnalyserNode; bufL: Float32Array<ArrayBuffer>; bufR: Float32Array<ArrayBuffer>; }
const meters = new Map<string, Meter>();

function makeMeter(ctx: BaseAudioContext, track: string, from: AudioNode): void {
  const split = ctx.createChannelSplitter(2), l = ctx.createAnalyser(), r = ctx.createAnalyser(), mute = ctx.createGain();
  l.fftSize = r.fftSize = 1024; l.smoothingTimeConstant = r.smoothingTimeConstant = 0;
  mute.gain.value = 0; mute.connect(ctx.destination);   // sambungan senyap: beberapa browser baru memproses node yang tersambung ke output
  from.connect(split); split.connect(l, 0); split.connect(r, 1); l.connect(mute); r.connect(mute);
  meters.set(track, { ctx, l, r, bufL: new Float32Array(l.fftSize), bufR: new Float32Array(r.fftSize) });
}

const peakOf = (a: AnalyserNode, buf: Float32Array<ArrayBuffer>): number => {
  a.getFloatTimeDomainData(buf);
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; }
  return m;
};

// Level puncak [kiri, kanan] track ini, 0..1 linear (0 = senyap / track belum pernah diputar).
export function trackLevels(track: string): [number, number] {
  const m = meters.get(track);
  return m ? [peakOf(m.l, m.bufL), peakOf(m.r, m.bufR)] : [0, 0];
}

// ---------- effect per track: equalizer -> filter -> reverb ----------
// Jalur: gain track -> [EQ: low shelf -> low-mid -> mid -> high-mid peaking -> high shelf -> output] -> [Filter: low-pass -> high-pass] -> [Delay: delay-fx.ts] -> dry -> output, dan -> wet -> pre-delay / low cut / tone -> Reverb FDN (reverb-dsp.ts) -> master.
// Mix reverb memakai crossfade equal-power. Urutan di jalur audio selalu EQ, Filter, Delay, lalu reverb (tidak tergantung urutan card).
export interface ReverbParams { on: boolean; mix: number; size: number; pre?: number; tone?: number; low?: number }   // mix 0..1, size 0..1 (-> gema 0,4 s .. 5 s); pre = pre-delay, tone = peredam treble gema, low = potong bass gema (kosong = bawaan, suara sama seperti sebelum knob ini ada)
export const reverbPreSec = (v: number): number => 0.2 * Math.max(0, Math.min(1, v));                                   // pre-delay 0 .. 200 ms
export const reverbToneHz = (v: number): number => 1500 * Math.pow(20000 / 1500, Math.max(0, Math.min(1, v)));          // tone: 1,5 kHz .. 20 kHz (log); 1 = terbuka
export const reverbLowHz = (v: number): number => 20 * Math.pow(50, Math.max(0, Math.min(1, v)));                       // low cut: 20 Hz .. 1 kHz (log); 0 = mati
const reverbs = new Map<string, ReverbParams>();
const dests = new Map<string, GainNode>();
export interface EqParams { on: boolean; v: Record<string, number> }   // semua nilai 0..1: gain per band (key band, 0,5 = 0 dB), <band>F = frekuensi, <band>Q = lebar (hanya band peaking), out = level akhir
const eqs = new Map<string, EqParams>();
// Filter ala DJ: satu knob Cutoff. Tengah = bypass, ke kiri = low-pass (makin kiri makin gelap), ke kanan = high-pass (makin kanan makin tipis).
export interface FilterParams { on: boolean; cutoff: number; reso: number }   // cutoff 0..1 (0,5 = bypass), reso 0..1
const filters = new Map<string, FilterParams>();
const FILTER_DEAD = 0.03;   // zona mati di sekitar tengah knob: benar-benar bypass
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
export const filterMode = (cutoff: number): 'off' | 'lp' | 'hp' => { const d = clamp01(cutoff) - 0.5; return Math.abs(d) * 2 < FILTER_DEAD ? 'off' : d < 0 ? 'lp' : 'hp'; };
// frekuensi potong (Hz): low-pass 20 kHz -> 80 Hz ke arah kiri, high-pass 20 Hz -> 8 kHz ke arah kanan (skala log)
export const filterHz = (cutoff: number): number => {
  const x = Math.abs(clamp01(cutoff) - 0.5) * 2, m = filterMode(cutoff);
  return m === 'lp' ? 20000 * Math.pow(80 / 20000, x) : m === 'hp' ? 20 * Math.pow(8000 / 20, x) : 0;
};
export const filterQ = (reso: number): number => 0.707 + clamp01(reso) * 11.3;   // 0.707 (datar) .. 12 (resonansi tajam)
export const EQ_RANGE_DB = 12;   // knob penuh = ±12 dB
export const eqDb = (v: number): number => (Math.max(0, Math.min(1, v)) - 0.5) * 2 * EQ_RANGE_DB;
// Equalizer 5 band: Low shelf, Low-Mid / Mid / High-Mid (peaking), High shelf. Tiap band punya jangkauan frekuensi sendiri (skala log) supaya band tidak saling menyeberang jauh.
// Default frekuensi Low / Mid / High sama dengan EQ lama (150 Hz / 1 kHz / 6 kHz, Q 0,8), band baru gain 0 dB, jadi project lama terdengar sama persis.
export interface EqBand { key: string; name: string; short: string; type: 'lowshelf' | 'peaking' | 'highshelf'; lo: number; hi: number; def: number; q: boolean; defQ: number }
export const EQ_BANDS: EqBand[] = [
  { key: 'low', name: 'Low', short: 'LOW', type: 'lowshelf', lo: 20, hi: 500, def: 150, q: false, defQ: 0.7 },
  { key: 'lm', name: 'Low-Mid', short: 'LM', type: 'peaking', lo: 80, hi: 1600, def: 400, q: true, defQ: 1 },
  { key: 'mid', name: 'Mid', short: 'MID', type: 'peaking', lo: 200, hi: 6000, def: 1000, q: true, defQ: 0.8 },
  { key: 'hm', name: 'High-Mid', short: 'HM', type: 'peaking', lo: 800, hi: 12000, def: 3200, q: true, defQ: 1 },
  { key: 'high', name: 'High', short: 'HIGH', type: 'highshelf', lo: 1500, hi: 20000, def: 6000, q: false, defQ: 0.7 },
];
export const eqHz = (b: EqBand, v: number): number => b.lo * Math.pow(b.hi / b.lo, clamp01(v));
export const eqFreqV = (b: EqBand, hz: number): number => clamp01(Math.log(Math.max(b.lo, hz) / b.lo) / Math.log(b.hi / b.lo));
export const eqQ = (v: number): number => 0.3 * Math.pow(8 / 0.3, clamp01(v));   // 0,3 (lebar) .. 8 (sempit), log
export const eqQV = (q: number): number => clamp01(Math.log(Math.max(0.3, q) / 0.3) / Math.log(8 / 0.3));
// De-esser: pereda desis "S" (worklet, lihat deesser.ts). Selalu di awal jalur efek, sebelum EQ / Filter / Reverb, supaya desis tidak ikut diperkeras atau dipantulkan reverb.
export interface DeesserParams { on: boolean; freq: number; thresh: number; amount: number }   // semua 0..1
const deessers = new Map<string, DeesserParams>();
// VocalF: exciter udara vokal (worklet, lihat vocalf.ts). Dipasang setelah EQ / Filter dan sebelum Delay / Reverb, supaya udara yang ditambahkan tidak dipotong Filter dan ikut masuk ke gema.
export interface VocalfParams { on: boolean; mid: number; high: number; trim: number }   // semua 0..1 (trim 0,5 = 0 dB)
const vocalfs = new Map<string, VocalfParams>();
export const vocalfTrimDb = (v: number): number => (clamp01(v) - 0.5) * 24;   // Trim: -12 .. +12 dB
const delays = new Map<string, DelayParams>();   // Delay: parameter lengkap di delay-fx.ts
// AUTOTUNE: koreksi pitch vokal (worklet, lihat autotune-dsp.ts). Paling awal di jalur efek (sebelum De-esser / EQ / Reverb), supaya efek lain memproses suara yang sudah disetel.
export interface AutotuneParams { on: boolean; amount: number; tc: number; mask: number; gi?: number; go?: number; mix?: number; mx?: Record<string, number> | null }   // gi / go = gain input / output (linear), mix = campuran hasil 0..1   // amount 0..1, tc = waktu retune (ms), mask = bitmask 12 kelas nada yang diizinkan
const autotunes = new Map<string, AutotuneParams>();
const atPitch = new Map<string, { raw: number; out: number }>();
const atLevel = new Map<string, { li: number; lo: number }>();
/** Level puncak (0..1) sebelum / sesudah AUTOTUNE untuk meter jendela plugin; null = tidak ada AUTOTUNE yang jalan. */
export const autotuneLevels = (track: string): { li: number; lo: number } | null => atLevel.get(track) ?? null;
/** Puncak (0..1) tiap strip mixer efek AUTOTUNE (urutan MX_STRIPS); null = tahap mixer tidak sedang jalan. */
export const autotuneMxLevels = (track: string): number[] | null => chains.get(track)?.mx?.levels() ?? null;
/** Pitch terakhir track ini untuk strip tuner: nada MIDI (pecahan) suara asli dan hasil; null = tak-bernada / tidak ada AUTOTUNE yang jalan. */
export const autotunePitch = (track: string): { raw: number; out: number } | null => { const v = atPitch.get(track); return v && v.raw >= 0 ? v : null; };
// LIVETUNE: koreksi pitch vokal dengan jendela piano roll live (worklet, lihat livetune-dsp.ts). Berdiri sendiri, terpisah dari AUTOTUNE (peta, node, dan pesan sendiri); kalau dua-duanya ada di satu track,
// LIVETUNE berada paling awal, lalu AUTOTUNE.
export interface LivetuneParams { on: boolean; amount: number; tc: number; mask: number; gi?: number; go?: number; mix?: number }   // sama artinya dengan AutotuneParams (tanpa mixer efek)
const livetunes = new Map<string, LivetuneParams>();
const ltPitch = new Map<string, { raw: number; out: number }>();
const ltLevel = new Map<string, { li: number; lo: number }>();
/** Level puncak (0..1) sebelum / sesudah LIVETUNE; null = tidak ada LIVETUNE yang jalan. */
export const livetuneLevels = (track: string): { li: number; lo: number } | null => ltLevel.get(track) ?? null;
/** Pitch terakhir track ini untuk piano roll LIVETUNE: nada MIDI (pecahan) suara asli dan hasil; null = tak-bernada / tidak ada LIVETUNE yang jalan. */
export const livetunePitch = (track: string): { raw: number; out: number } | null => { const v = ltPitch.get(track); return v && v.raw >= 0 ? v : null; };
export const deesserHz = (v: number): number => 3000 * Math.pow(4, clamp01(v));          // 3 kHz .. 12 kHz (log)
export const deesserThr = (v: number): number => -60 + clamp01(v) * 50;                  // -60 .. -10 dB
export const deesserMaxDb = (v: number): number => clamp01(v) * 20;                      // reduksi maksimum 0 .. 20 dB
interface Chain {
  ctx: BaseAudioContext; topo: string; lt: AudioWorkletNode | null; at: AudioWorkletNode | null; mx: MxStage | null; ds: AudioWorkletNode | null; vf: AudioWorkletNode | null; dl: DelayUnit | null;
  low: BiquadFilterNode; lm: BiquadFilterNode; mid: BiquadFilterNode; hm: BiquadFilterNode; high: BiquadFilterNode; eo: GainNode; an: AnalyserNode;
  lp: BiquadFilterNode; hp: BiquadFilterNode;
  dry: GainNode; wet: GainNode; mu: GainNode; rv: AudioWorkletNode | null; ro: GainNode; pd: DelayNode; rh: BiquadFilterNode; rl: BiquadFilterNode; decay: number; hold: number[];
}
const chains = new Map<string, Chain>();

// ---------- Reverb (FDN, reverb-dsp.ts) ----------
// Dulu tiap track memakai ConvolverNode (dibagi lewat bus per panjang gema). Konvolusi biayanya naik sebanding panjang gema dan dibayar terus walau hening;
// di HP biasa beberapa Reverb bikin blok audio telat -> audio patah-patah dan "speed up". Sekarang tiap track yang punya Reverb memakai satu AudioWorklet FDN:
// biaya tetap berapa pun panjang gema (Size hanya mengubah gain umpan balik) dan berhenti menghitung sendiri saat input senyap dan ekornya habis.
// Pre-delay, Tone, Low Cut dan Mix tetap node biasa SEBELUM reverb (hasilnya sama karena linear). Keluaran reverb langsung ke master (bukan lewat `out` track).
let masterDest: AudioNode | null = null;

export const reverbSeconds = (size: number): number => Math.round((0.4 + Math.max(0, Math.min(1, size)) * 4.6) * 10) / 10;
// Dulu: batas panjang gema dari penjaga beban (audio-health.ts), karena biaya Convolver naik sebanding panjang gema. FDN biayanya tetap, jadi batas tidak perlu lagi:
// Size penuh (5 s) selalu diizinkan. Fungsi dipertahankan supaya pemanggil lama (main.ts) tetap jalan.
export function setReverbCap(_sec: number): void { /* biaya reverb tidak bergantung panjang gema */ }

function syncFx(track: string): void {
  const g = gains.get(track), dest = dests.get(track), rv = reverbs.get(track), eq = eqs.get(track), fl = filters.get(track), ds = deessers.get(track), dly = delays.get(track), at = autotunes.get(track), vf = vocalfs.get(track), lt = livetunes.get(track);
  if (!g || !dest) return;                       // belum pernah diputar: dipasang saat gain track dibuat
  const ctx = g.context;
  let ch = chains.get(track);
  if (ds && !deesserLoaded(ctx)) loadDeesser(ctx).then(() => syncFx(track), () => { /* worklet gagal dimuat: jalur jalan tanpa de-esser */ });
  if (vf && !vocalfLoaded(ctx)) loadVocalf(ctx).then(() => syncFx(track), () => { /* worklet gagal dimuat: jalur jalan tanpa VocalF */ });
  const vfOn = !!vf && vocalfLoaded(ctx);
  const dsOn = !!ds && deesserLoaded(ctx);      // node baru dipasang setelah modul worklet siap (beberapa ms)
  if (at && !autotuneLoaded(ctx)) loadAutotune(ctx).then(() => syncFx(track), () => { /* worklet gagal dimuat: jalur jalan tanpa AUTOTUNE */ });
  const atOn = !!at && autotuneLoaded(ctx);
  if (lt && !livetuneLoaded(ctx)) loadLivetune(ctx).then(() => syncFx(track), () => { /* worklet gagal dimuat: jalur jalan tanpa LIVETUNE */ });
  const ltOn = !!lt && livetuneLoaded(ctx);
  // Reverb hanya dipasang di jalur kalau BENAR-BENAR terdengar (On dan Mix > 0). Reverb yang cuma dikali gain 0 tetap dihitung tiap blok;
  // dengan jalur langsung, hasil suara sama persis (wet = 0, dry = 1) tapi bebannya hilang.
  if (rv && rv.on && rv.mix > 0.004 && !reverbLoaded(ctx)) loadReverb(ctx).then(() => syncFx(track), () => { /* worklet gagal dimuat: jalur jalan tanpa Reverb */ });
  const rvA = !!rv && rv.on && rv.mix > 0.004 && reverbLoaded(ctx);   // node baru dipasang setelah modul worklet siap (beberapa ms)
  if (at && atOn && mxActive(at.mx) && !mxLoaded(ctx)) mxLoad(ctx).then(() => syncFx(track), () => { /* worklet gagal dimuat: jalur jalan tanpa mixer efek */ });
  const mxOn = atOn && !!at && mxActive(at.mx) && mxLoaded(ctx);   // mixer efek hanya dipasang kalau ada yang diubah dari bawaan
  if (!rv && !eq && !fl && !dsOn && !vfOn && !dly && !atOn && !ltOn) {              // semua card efek dihapus: kembali ke jalur langsung
    if (ch) {
      g.disconnect(); [ch.low, ch.lm, ch.mid, ch.hm, ch.high, ch.eo, ch.lp, ch.hp, ch.dry, ch.wet, ch.mu, ch.pd, ch.rh, ch.rl, ch.ro].forEach(n => n.disconnect());
      if (ch.rv) { ch.rv.port.onmessage = null; ch.rv.disconnect(); ch.rv = null; }
      if (ch.ds) ch.ds.disconnect();
      if (ch.vf) ch.vf.disconnect();
      if (ch.at) { ch.at.port.onmessage = null; ch.at.disconnect(); }
      if (ch.lt) { ch.lt.port.onmessage = null; ch.lt.disconnect(); }
      ltPitch.delete(track); ltLevel.delete(track);
      if (ch.mx) { ch.mx.dispose(); ch.mx = null; }
      atPitch.delete(track); atLevel.delete(track);
      if (ch.dl) { ch.dl.output.disconnect(); ch.dl.dispose(); ch.dl = null; }
      g.connect(dest); chains.delete(track);
    }
    return;
  }
  if (!ch || ch.ctx !== ctx) {
    const [low, lm, mid, hm, high] = EQ_BANDS.map(b => { const n = ctx.createBiquadFilter(); n.type = b.type; n.frequency.value = b.def; if (b.q) n.Q.value = b.defQ; return n; });
    const eo = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0.82; an.minDecibels = -110; an.maxDecibels = -10;   // spektrum untuk grafik Equalizer
    const lp = ctx.createBiquadFilter(), hp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 20000; lp.Q.value = 0.707;
    hp.type = 'highpass'; hp.frequency.value = 20; hp.Q.value = 0.707;
    const pd = ctx.createDelay(0.5), rh = ctx.createBiquadFilter(), rl = ctx.createBiquadFilter();   // pre-delay, low cut (high-pass), tone (low-pass): hanya di jalur wet
    rh.type = 'highpass'; rh.frequency.value = 20; rh.Q.value = 0.707;
    rl.type = 'lowpass'; rl.frequency.value = 20000; rl.Q.value = 0.707;
    ch = { ctx, topo: '', lt: null, at: null, mx: null, ds: null, vf: null, dl: null, low, lm, mid, hm, high, eo, an, lp, hp, dry: ctx.createGain(), wet: ctx.createGain(), mu: (() => { const m = ctx.createGain(); m.gain.value = muted.has(track) ? 0 : 1; return m; })(), rv: null, ro: ctx.createGain(), pd, rh, rl, decay: 0, hold: [0, 0, 0, 0, 0] };
    chains.set(track, ch);
  }
  if (atOn && at && !ch.at) {
    ch.at = createAutotune(ctx, { amount: at.amount, tc: at.tc, mask: at.mask, on: at.on, gi: at.gi, go: at.go, mix: at.mix });
    ch.at.port.onmessage = e => { const m = e.data; if (m && m.t === 'f') { atPitch.set(track, { raw: m.raw, out: m.out }); atLevel.set(track, { li: m.li || 0, lo: m.lo || 0 }); if (m.out >= 0) chains.get(track)?.mx?.pitch(m.out); } };
  }
  if (ltOn && lt && !ch.lt) {
    ch.lt = createLivetune(ctx, { amount: lt.amount, tc: lt.tc, mask: lt.mask, on: lt.on, gi: lt.gi, go: lt.go, mix: lt.mix });
    ch.lt.port.onmessage = e => { const m = e.data; if (m && m.t === 'f') { ltPitch.set(track, { raw: m.raw, out: m.out }); ltLevel.set(track, { li: m.li || 0, lo: m.lo || 0 }); } };
  }
  if (mxOn && !ch.mx) { ch.mx = createMxStage(ctx); ch.topo = ''; }
  if (!mxOn && ch.mx) { ch.mx.dispose(); ch.mx = null; ch.topo = ''; }
  if (dsOn && ds && !ch.ds) ch.ds = createDeesser(ctx, { fc: deesserHz(ds.freq), thr: deesserThr(ds.thresh), max: deesserMaxDb(ds.amount), on: ds.on });
  if (vfOn && vf && !ch.vf) ch.vf = createVocalf(ctx, { mid: vf.mid, high: vf.high, trim: vocalfTrimDb(vf.trim), on: vf.on });
  if (dly && !ch.dl) ch.dl = createDelay(ctx);
  if (!dly && ch.dl) { ch.dl.output.disconnect(); ch.dl.dispose(); ch.dl = null; ch.topo = ''; }
  const now0 = performance.now() / 1000;
  const rvDec = rvA ? reverbSeconds(rv!.size) : 0;
  if (rvA) {
    if (!ch.rv) { ch.rv = createReverb(ctx, rvDec); ch.mu.connect(ch.rv); ch.rv.connect(ch.ro); ch.ro.connect(masterDest!); }
    ch.decay = rvDec;
  } else if (ch.rv) { ch.mu.disconnect(); ch.rv.port.onmessage = null; ch.rv.disconnect(); ch.ro.disconnect(); ch.rv = null; }
  // Band EQ yang gain-nya 0 dB itu identitas (hasil sama persis kalau dilewati), tapi tiap biquad tetap menghitung tiap blok. Hanya band yang dipakai dipasang di jalur;
  // band yang baru dikembalikan ke 0 ditahan 250 ms supaya geser knob ke nol tidak terdengar loncat.
  const bandOn: boolean[] = EQ_BANDS.map((b, i) => {
    if (!eq) return false;
    const want = eq.on && Math.abs(eqDb(eq.v[b.key] ?? 0.5)) > 0.05;
    if (want) { ch!.hold[i] = now0 * 1000; return true; }
    return now0 * 1000 - ch!.hold[i] < 250;
  });
  if (eq && bandOn.some((on, i) => on && !(eq.on && Math.abs(eqDb(eq.v[EQ_BANDS[i].key] ?? 0.5)) > 0.05))) setTimeout(() => syncFx(track), 280);   // band yang masih ditahan: periksa lagi setelah masa tahan habis
  const topo = (atOn ? 'a' : '-') + (dsOn ? 'd' : '-') + (eq ? 'e' : '-') + (fl ? 'f' : '-') + (dly ? 'y' : '-') + (rvA ? 'r' : '-') + (mxOn ? 'x' : '-') + (vfOn ? 'v' : '-') + (ltOn ? 'l' : '-') + bandOn.map(x => x ? '1' : '0').join('');   // huruf di belakang: indeks lain tidak bergeser
  const rvM = rvA ? Math.max(0, Math.min(1, rv!.mix)) : 0;
  if (topo !== ch.topo) {                        // susun ulang jalur sesuai efek yang ada
    if (rvA) { ch.dry.gain.value = Math.cos(rvM * Math.PI / 2); ch.wet.gain.value = Math.sin(rvM * Math.PI / 2); }   // nilai awal langsung (bukan 1): reverb baru dinyalakan tidak boleh meledak sesaat
    g.disconnect(); [ch.low, ch.lm, ch.mid, ch.hm, ch.high, ch.eo, ch.lp, ch.hp, ch.dry, ch.wet, ch.pd, ch.rh, ch.rl].forEach(n => n.disconnect());
    if (ch.ds) { ch.ds.disconnect(); if (!dsOn) ch.ds = null; }
    if (ch.vf) { ch.vf.disconnect(); if (!vfOn) ch.vf = null; }
    if (ch.mx) ch.mx.output.disconnect();
    if (ch.at) { ch.at.disconnect(); if (!atOn) { ch.at.port.onmessage = null; ch.at = null; atPitch.delete(track); atLevel.delete(track); } }
    if (ch.lt) { ch.lt.disconnect(); if (!ltOn) { ch.lt.port.onmessage = null; ch.lt = null; ltPitch.delete(track); ltLevel.delete(track); } }
    if (ch.dl) ch.dl.output.disconnect();
    let s: AudioNode = g;
    if (ltOn && ch.lt) { s.connect(ch.lt); s = ch.lt; }   // LIVETUNE paling awal
    if (atOn && ch.at) { s.connect(ch.at); s = ch.at; if (mxOn && ch.mx) { s.connect(ch.mx.input); s = ch.mx.output; } }
    if (dsOn && ch.ds) { s.connect(ch.ds); s = ch.ds; }
    if (eq) { const bn = [ch.low, ch.lm, ch.mid, ch.hm, ch.high]; for (let i = 0; i < 5; i++) if (bandOn[i]) { s.connect(bn[i]); s = bn[i]; } s.connect(ch.eo); s = ch.eo; }   // analyser spektrum EQ tidak dipasang: tidak terpakai (eqSpectrum selalu false) tapi tetap menghitung FFT 4096 tiap blok
    if (fl) { s.connect(ch.lp); ch.lp.connect(ch.hp); s = ch.hp; }
    if (vfOn && ch.vf) { s.connect(ch.vf); s = ch.vf; }
    if (dly && ch.dl) { s.connect(ch.dl.input); s = ch.dl.output; }
    if (rvA) { s.connect(ch.dry); ch.dry.connect(dest); s.connect(ch.wet); ch.wet.connect(ch.pd); ch.pd.connect(ch.rh); ch.rh.connect(ch.rl); ch.rl.connect(ch.mu); }   // mu -> Reverb FDN (ch.rv) -> ro -> master
    else s.connect(dest);
    ch.topo = topo;
  }
  const now = ctx.currentTime;
  if (ltOn && lt && ch.lt) ch.lt.port.postMessage({ t: 'p', amount: lt.amount, tc: lt.tc, mask: lt.mask, on: lt.on, gi: lt.gi, go: lt.go, mix: lt.mix });
  if (atOn && at && ch.at) ch.at.port.postMessage({ t: 'p', amount: at.amount, tc: at.tc, mask: at.mask, on: at.on, gi: at.gi, go: at.go, mix: at.mix });
  if (mxOn && at && ch.mx) ch.mx.update(at.mx!, at.mask);
  if (vfOn && vf && ch.vf) ch.vf.port.postMessage({ t: 'p', mid: vf.mid, high: vf.high, trim: vocalfTrimDb(vf.trim), on: vf.on });
  if (dsOn && ds && ch.ds) ch.ds.port.postMessage({ t: 'p', fc: deesserHz(ds.freq), thr: deesserThr(ds.thresh), max: deesserMaxDb(ds.amount), on: ds.on });
  if (dly && ch.dl) ch.dl.update(dly);
  if (eq) {
    const nodes = [ch.low, ch.lm, ch.mid, ch.hm, ch.high], v = eq.v;
    EQ_BANDS.forEach((b, i) => {
      nodes[i].gain.setTargetAtTime(eq.on ? eqDb(v[b.key] ?? 0.5) : 0, now, .02);
      nodes[i].frequency.setTargetAtTime(eqHz(b, v[b.key + 'F'] ?? eqFreqV(b, b.def)), now, .02);
      if (b.q) nodes[i].Q.setTargetAtTime(eqQ(v[b.key + 'Q'] ?? eqQV(b.defQ)), now, .02);
    });
    ch.eo.gain.setTargetAtTime(eq.on ? Math.pow(10, eqDb(v.out ?? 0.5) / 20) : 1, now, .02);
  }
  if (fl) {   // dua biquad seri: yang tidak aktif dibiarkan di luar jangkauan dengar (20 kHz / 20 Hz), Q datar
    const m = fl.on ? filterMode(fl.cutoff) : 'off', hz = filterHz(fl.cutoff), q = filterQ(fl.reso);
    ch.lp.frequency.setTargetAtTime(m === 'lp' ? hz : 20000, now, .02);
    ch.hp.frequency.setTargetAtTime(m === 'hp' ? hz : 20, now, .02);
    ch.lp.Q.setTargetAtTime(m === 'lp' ? q : 0.707, now, .02);
    ch.hp.Q.setTargetAtTime(m === 'hp' ? q : 0.707, now, .02);
  }
  if (rvA) {
    ch.dry.gain.setTargetAtTime(Math.cos(rvM * Math.PI / 2), now, .02);
    ch.wet.gain.setTargetAtTime(Math.sin(rvM * Math.PI / 2), now, .02);
    ch.pd.delayTime.setTargetAtTime(reverbPreSec(rv!.pre ?? 0), now, .03);
    ch.rl.frequency.setTargetAtTime(reverbToneHz(rv!.tone ?? 1), now, .02);
    ch.rh.frequency.setTargetAtTime(reverbLowHz(rv!.low ?? 0), now, .02);
    if (ch.rv) ch.rv.port.postMessage({ t: 'p', rt: rvDec });
  }
}

// null = track tidak punya reverb
export function setReverb(track: string, p: ReverbParams | null): void {
  if (p) reverbs.set(track, { ...p }); else reverbs.delete(track);
  syncFx(track);
}

// null = track tidak punya delay
export function setDelay(track: string, p: DelayParams | null): void {
  if (p) delays.set(track, { ...p }); else delays.delete(track);
  syncFx(track);
}

// puncak output Delay track ini [kiri, kanan], linear (0 kalau track tidak punya Delay / belum diputar)
export const delayLevels = (track: string): [number, number] => chains.get(track)?.dl?.levels() ?? [0, 0];

// Spektrum frekuensi (dB per bin FFT) di keluaran EQ track ini, untuk digambar di belakang kurva Equalizer.
// Mengembalikan false kalau track belum punya jalur EQ / belum pernah diputar. Array `out` dipakai ulang tiap frame supaya tidak membuat sampah memori.
export function eqSpectrum(track: string, out: Float32Array): { sr: number } | false {
  const ch = chains.get(track);
  if (!ch || ch.topo[1] !== 'e' || ch.ctx.state !== 'running' || out.length !== ch.an.frequencyBinCount) return false;
  ch.an.getFloatFrequencyData(out as Float32Array<ArrayBuffer>);
  return { sr: ch.ctx.sampleRate };
}
export const EQ_FFT_BINS = 2048;   // = fftSize / 2 (ukuran array untuk eqSpectrum)

// null = track tidak punya AUTOTUNE
export function setAutotune(track: string, p: AutotuneParams | null): void {
  if (p) autotunes.set(track, { ...p }); else autotunes.delete(track);
  syncFx(track);
}

// latensi (detik) yang ditambahkan AUTOTUNE di track ini; 0 kalau track tidak punya AUTOTUNE yang sedang jalan
const autotuneDelay = (track: string): number => { const ch = chains.get(track); return ch && ch.at ? autotuneLatencySec(ch.ctx.sampleRate) : 0; };

// null = track tidak punya LIVETUNE
export function setLivetune(track: string, p: LivetuneParams | null): void {
  if (p) livetunes.set(track, { ...p }); else livetunes.delete(track);
  syncFx(track);
}
// latensi (detik) yang ditambahkan LIVETUNE di track ini; 0 kalau track tidak punya LIVETUNE yang sedang jalan
const livetuneDelay = (track: string): number => { const ch = chains.get(track); return ch && ch.lt ? livetuneLatencySec(ch.ctx.sampleRate) : 0; };

// null = track tidak punya VocalF
export function setVocalf(track: string, p: VocalfParams | null): void {
  if (p) vocalfs.set(track, { ...p }); else vocalfs.delete(track);
  syncFx(track);
}

// null = track tidak punya de-esser
export function setDeesser(track: string, p: DeesserParams | null): void {
  if (p) deessers.set(track, { ...p }); else deessers.delete(track);
  syncFx(track);
}

// null = track tidak punya equalizer
export function setEq(track: string, p: EqParams | null): void {
  if (p) eqs.set(track, { on: p.on, v: { ...p.v } }); else eqs.delete(track);
  syncFx(track);
}

// null = track tidak punya filter
export function setFilter(track: string, p: FilterParams | null): void {
  if (p) filters.set(track, { ...p }); else filters.delete(track);
  syncFx(track);
}

function release(r: { src: AudioBufferSourceNode; env: GainNode }, now: number): void {
  r.src.onended = null;
  const cur = r.env.gain.value;               // nilai saat ini (bisa sedang di tengah fade-in / fade-out clip)
  r.env.gain.cancelScheduledValues(now);
  r.env.gain.setValueAtTime(cur, now);        // tanpa ini gain loncat balik ke 1 setelah cancel -> klik
  r.env.gain.setTargetAtTime(0, now, .008);   // fade sangat singkat agar tidak ada bunyi "klik"
  try { r.src.stop(now + .06); } catch { /* sudah berhenti */ }
  setTimeout(() => { r.src.disconnect(); r.env.disconnect(); }, 120);
}

export function stopAll(ctx: AudioContext | null): void {
  if (!ctx) return;
  active.forEach(r => release(r, ctx.currentTime));
  active.clear();
}

export function stopTrack(ctx: AudioContext | null, track: string): void {
  if (!ctx) return;
  active.forEach(r => { if (r.track === track) { release(r, ctx.currentTime); active.delete(r); } });
}

// Pause: ekor Reverb / Delay (feedback Delay bisa sampai 200%) tidak ikut berhenti karena hidup di dalam jalur efek, bukan di clip.
// Output track diturunkan ke nol sebentar, lalu ekor Reverb dikosongkan dan unit Delay dibuat ulang, baru output dikembalikan.
// Dipanggil lagi lewat play() sebelum selesai: output langsung dikembalikan (tanpa membangun ulang) supaya Play berikutnya tidak tertahan.
let flushTimer = 0;
function restoreOut(ctx: AudioContext): void {
  chains.forEach(ch => { if (ch.ctx === ctx && ch.rv) { ch.ro.gain.cancelScheduledValues(ctx.currentTime); ch.ro.gain.setTargetAtTime(1, ctx.currentTime, .015); } });
  dests.forEach((o, track) => { if (o.context === ctx) { o.gain.cancelScheduledValues(ctx.currentTime); o.gain.setTargetAtTime(muted.has(track) ? 0 : 1, ctx.currentTime, .015); } });
}
export function flushTails(ctx: AudioContext | null): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  dests.forEach((o, track) => {
    const ch = chains.get(track);
    if (o.context !== ctx || !ch || (!reverbs.has(track) && !delays.has(track))) return;
    o.gain.cancelScheduledValues(now); o.gain.setValueAtTime(o.gain.value, now); o.gain.setTargetAtTime(0, now, .01);
  });
  chains.forEach(ch => { if (ch.ctx === ctx && ch.rv) { ch.ro.gain.cancelScheduledValues(now); ch.ro.gain.setValueAtTime(ch.ro.gain.value, now); ch.ro.gain.setTargetAtTime(0, now, .01); } });   // gema reverb ikut dibungkam
  clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    chains.forEach((ch, track) => {
      if (ch.ctx !== ctx) return;
      if (delays.has(track) && ch.dl) { ch.dl.output.disconnect(); ch.dl.dispose(); ch.dl = null; ch.topo = ''; syncFx(track); }
    });
    chains.forEach(ch => { if (ch.ctx === ctx && ch.rv) ch.rv.port.postMessage({ t: 'r' }); });   // ekor Reverb dikosongkan
    restoreOut(ctx);
  }, 90);
}

const CLIP_FADE_IN = .004, CLIP_FADE_OUT = .006;   // detik; cukup singkat supaya serangan (transien) tidak terasa tumpul

// Jadwalkan semua clip mulai dari posisi `fromBar`; `t0` = waktu AudioContext saat fromBar dimainkan.
export function play(ctx: AudioContext, dest: AudioNode, clips: ClipPlacement[], fromBar: number, secPerBar: number, t0: number): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; restoreOut(ctx); }   // Play sebelum pembersihan ekor selesai: output dikembalikan sekarang
  stopAll(ctx);
  for (const c of clips) {
    const e = buffers.get(c.clip);
    if (!e || c.endBar <= fromBar + 1e-6) continue;
    let when: number, off: number, dur: number;
    if (c.startBar >= fromBar) {
      when = t0 + (c.startBar - fromBar) * secPerBar; off = c.offsetSec; dur = (c.endBar - c.startBar) * secPerBar;
    } else {
      when = t0; off = c.offsetSec + (fromBar - c.startBar) * secPerBar; dur = (c.endBar - fromBar) * secPerBar;
    }
    dur = Math.min(dur, e.buf.duration - off);
    if (dur < .001 || off < 0) continue;
    const gt = trackGain(ctx, dest, c.track);   // (dibuat dulu: jalur efek track, termasuk AUTOTUNE, harus ada sebelum latensinya dihitung)
    const lat = autotuneDelay(c.track) + livetuneDelay(c.track);         // AUTOTUNE / LIVETUNE menunda suara; clip dimulai lebih awal sebanyak itu supaya tetap sejajar dengan track lain
    if (lat > 0) {
      const w = when - lat, nw = ctx.currentTime;
      if (w >= nw) when = w; else { const skip = Math.min(dur - .001, nw - w); when = nw; off += skip; dur -= skip; }   // di awal putar tidak bisa mundur: lompati bagian awal clip
      if (dur < .001 || off + dur > e.buf.duration + 1e-6) continue;
    }
    // Kerja penjadwalan di HP lambat bisa membuat waktu mulai sudah lewat saat sampai di sini: start(when di masa lalu) memutar dari awal SEKARANG,
    // jadi suara tertinggal dari playhead. clipWindow melompati bagian yang sudah lewat supaya tetap sejajar timeline.
    const win = clipWindow(when, off, dur, ctx.currentTime, e.buf.duration, Math.min(.05, (ctx.baseLatency || 0) + .003));
    if (!win) continue;
    when = win.when; off = win.off; dur = win.dur;
    const src = ctx.createBufferSource(), env = ctx.createGain();
    src.buffer = e.buf;
    src.connect(env); env.connect(gt);
    // clip dimulai / diakhiri di titik mana pun pada gelombang (offset, potongan, split): tanpa fade terdengar sebagai klik / kresek
    const fin = Math.min(CLIP_FADE_IN, dur / 2), fout = Math.min(CLIP_FADE_OUT, dur / 2), tNow = Math.max(when, ctx.currentTime);
    env.gain.setValueAtTime(0, tNow);
    env.gain.linearRampToValueAtTime(1, tNow + fin);
    if (when + dur - fout > tNow + fin) { env.gain.setValueAtTime(1, when + dur - fout); env.gain.linearRampToValueAtTime(0, when + dur); }
    const rec = { src, env, track: c.track };
    src.onended = () => { active.delete(rec); src.disconnect(); env.disconnect(); };
    active.add(rec);
    src.start(when, off, dur);
  }
}
