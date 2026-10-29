// Kesehatan audio untuk SEMUA perangkat. Logika murni (tanpa DOM / Web Audio) supaya bisa dites di Node: tools/audio-health-test.ts.
//
// Masalah yang dijaga: di HP lambat thread audio bisa kewalahan. Gejalanya: suara putus / tidak bunyi, lalu menyusul cepat, atau masih
// terdengar sesudah Pause (suara yang sudah terlanjur dirender menunggu giliran keluar). Apa pun penyebabnya (terlalu banyak voice, efek berat,
// CPU dipakai aplikasi lain, hemat daya), gejala itu SELALU tampak sebagai jam audio (AudioContext.currentTime) yang maju LEBIH LAMBAT dari jam
// dinding, atau berhenti sama sekali (context suspended / interrupted). Jadi yang diukur bukan satu perangkat tertentu, melainkan rasio
// jam audio : jam dinding, ditambah hitungan underrun dari browser kalau tersedia. Dari situ kualitas diturunkan bertahap sampai stabil.

// ---------- pemantau jam audio ----------
// 'ok'        sehat (atau jendela ukur belum penuh -> null)
// 'slow'      jam audio tertinggal terus-menerus / underrun berulang: thread audio kewalahan
// 'stalled'   context 'running' tapi jam audio hampir tidak maju
// 'suspended' context tidak 'running' (suspended / interrupted: autoplay, telepon, alarm, ganti output, hemat daya)
export type Verdict = 'ok' | 'slow' | 'stalled' | 'suspended';

export interface ClockSample {
  audio: number;        // AudioContext.currentTime (detik)
  wall: number;         // jam dinding (detik), mis. performance.now() / 1000
  running: boolean;     // AudioContext.state === 'running'
  underruns?: number;   // hitungan kumulatif underrun dari browser (AudioContext.playbackStats.underrunEvents), kalau ada
}

export interface ClockOpts {
  windowSec: number;           // lama satu jendela ukur
  slowBelow: number;           // rasio jam audio/jam dinding di bawah ini = jendela buruk
  stallBelow: number;          // di bawah ini = hampir berhenti
  underrunsPerWindow: number;  // underrun sebanyak ini dalam satu jendela = jendela buruk
  needBad: number;             // jumlah jendela buruk BERURUTAN sebelum vonis 'slow' (satu lonjakan sesaat tidak cukup)
  maxGapSec: number;           // selang antar sampel lebih panjang dari ini = timer ikut tertahan (tab latar / thread utama beku): tidak dipercaya
}

// Jam audio dibaca per buffer keluaran: puluhan ms di mode 'playback', bisa sampai ~200 ms lewat Bluetooth. Satu jendela 2,5 detik punya galat kuantisasi
// paling banyak ~8% untuk buffer 200 ms, jadi ambang 0,88 berada di atas galat itu (lebih baik terlambat mendeteksi daripada menurunkan kualitas tanpa alasan).
// Butuh 2 jendela buruk berurutan (~5 detik) supaya gangguan sesaat (notifikasi, GC) tidak menurunkan kualitas.
export const CLOCK_DEFAULTS: ClockOpts = { windowSec: 2.5, slowBelow: 0.88, stallBelow: 0.35, underrunsPerWindow: 5, needBad: 2, maxGapSec: 3 };

export class ClockWatch {
  private o: ClockOpts;
  private prev: ClockSample | null = null;
  private a = 0; private w = 0; private u = 0;   // akumulasi jendela berjalan: jam audio, jam dinding, underrun
  private bad = 0; private dead = 0; private settle = 0;
  ratio = 1;   // rasio jendela terakhir (untuk log / debug)

  constructor(o: Partial<ClockOpts> = {}) { this.o = { ...CLOCK_DEFAULTS, ...o }; }

  reset(): void { this.prev = null; this.a = this.w = this.u = 0; this.bad = this.dead = this.settle = 0; this.ratio = 1; }

  // Setelah sebuah tindakan (kualitas diturunkan, jadwal ulang) beri n jendela napas: dampaknya belum boleh dihitung sebagai masalah baru.
  calm(windows: number): void { this.settle = windows; this.bad = 0; this.a = this.w = this.u = 0; }

  push(s: ClockSample): Verdict | null {
    const p = this.prev; this.prev = s;
    if (!p) return null;
    const dw = s.wall - p.wall;
    if (dw <= 0) return null;
    if (dw > this.o.maxGapSec) { this.a = this.w = this.u = 0; this.bad = 0; return null; }
    if (!s.running) {
      this.a = this.w = this.u = 0; this.bad = 0; this.dead += dw;
      if (this.dead >= this.o.windowSec) { this.dead = 0; return 'suspended'; }
      return null;
    }
    this.dead = 0;
    if (!p.running) { this.a = this.w = this.u = 0; return null; }   // sampel pertama setelah kembali running: hanya dasar baru
    this.a += Math.max(0, s.audio - p.audio); this.w += dw;
    if (s.underruns !== undefined && p.underruns !== undefined) this.u += Math.max(0, s.underruns - p.underruns);
    if (this.w < this.o.windowSec) return null;
    const ratio = this.a / this.w, u = this.u;
    this.ratio = ratio; this.a = this.w = this.u = 0;
    if (this.settle > 0) { this.settle--; return 'ok'; }
    if (ratio < this.o.stallBelow) { this.bad = 0; return 'stalled'; }
    if (ratio < this.o.slowBelow || u >= this.o.underrunsPerWindow) {
      if (++this.bad >= this.o.needBad) { this.bad = 0; return 'slow'; }
      return 'ok';
    }
    this.bad = 0;
    return 'ok';
  }
}

// ---------- tingkat kualitas ----------
// Yang diturunkan HANYA beban render, bukan isi lagu: nada tetap sama, hanya yang paling tidak terdengar yang dilepas lebih cepat / dibuat lebih ringan.
//   voices   batas voice Supersaw sekaligus (tiap voice = 7 saw + panner + filter; ekor release ikut dihitung)
//   saws     jumlah saw per voice (7 = penuh; 3 = tipis tapi level disamakan di synth-engine)
//   derizCap batas nada DERIZ hidup lintas plugin (batas atas untuk governor milik worklet)
//   derizFull jatah frame WSOLA berkualitas penuh per blok audio
//   loud     rantai Master Loudness (2 compressor, EQ, saturasi) dipakai atau dilewati
//   reverbMax batas panjang gema Reverb (detik): konvolusi adalah node termahal di graf dan dibayar per track yang punya Reverb
export interface Quality { level: number; voices: number; saws: number; derizCap: number; derizFull: number; loud: boolean; reverbMax: number }

export const LEVELS: readonly Quality[] = [
  { level: 0, voices: 28, saws: 7, derizCap: 48, derizFull: 4, loud: true, reverbMax: 5 },
  { level: 1, voices: 16, saws: 7, derizCap: 24, derizFull: 2, loud: true, reverbMax: 2.5 },
  { level: 2, voices: 10, saws: 3, derizCap: 12, derizFull: 1, loud: false, reverbMax: 1.2 },
];

export const RECOVER_AFTER_SEC = 120;   // sehat selama ini tanpa gangguan: coba naik satu tingkat
export const RELAPSE_SEC = 60;          // kalau setelah naik kembali bermasalah dalam waktu ini: kunci di tingkat itu sampai sesi berikutnya

export class QualityGovernor {
  level = 0;
  private okSince = 0;
  private lastUp = -1e9;
  private locked = false;

  get quality(): Quality { return LEVELS[this.level]; }
  get isLocked(): boolean { return this.locked; }

  reset(nowSec = 0): void { this.level = 0; this.okSince = nowSec; this.lastUp = -1e9; this.locked = false; }

  // Masukkan vonis terbaru. Mengembalikan Quality baru kalau tingkat berubah, selain itu null.
  step(v: Verdict, nowSec: number): Quality | null {
    if (v === 'suspended') { this.okSince = nowSec; return null; }   // context dihentikan sistem: bukan soal beban, jangan menghukum kualitas
    if (v === 'slow' || v === 'stalled') {
      this.okSince = nowSec;
      if (nowSec - this.lastUp < RELAPSE_SEC) this.locked = true;     // baru naik lalu bermasalah lagi: jangan naik-turun terus (tiap perpindahan bisa terdengar)
      if (this.level >= LEVELS.length - 1) return null;
      this.level++;
      return this.quality;
    }
    if (this.level > 0 && !this.locked && nowSec - this.okSince >= RECOVER_AFTER_SEC) {
      this.level--; this.lastUp = nowSec; this.okSince = nowSec;
      return this.quality;
    }
    return null;
  }
}

// ---------- clip yang waktunya sudah lewat saat dijadwalkan ----------
// Thread utama sibuk di HP lambat: saat kerja penjadwalan selesai, waktu mulai sebuah clip bisa sudah lewat. AudioBufferSourceNode.start(when di masa lalu)
// memutar dari `offset` SEKARANG, jadi suara tertinggal dari playhead sebesar telatnya (terdengar melenceng / lambat lalu "mengejar" saat clip lain mulai).
// Di sini bagian yang sudah lewat dilompati, supaya yang terdengar tetap sejajar dengan timeline. null = sudah habis sebelum sempat bunyi.
export interface ClipWin { when: number; off: number; dur: number }

export function clipWindow(when: number, off: number, dur: number, now: number, bufDur: number, minLead = 0.003): ClipWin | null {
  const earliest = now + minLead;
  if (when < earliest) { const skip = earliest - when; when = earliest; off += skip; dur -= skip; }
  if (off < 0) return null;
  dur = Math.min(dur, bufDur - off);
  if (dur < 0.001) return null;
  return { when, off, dur };
}

// ---------- jeda awal Play ----------
// Jeda dari "sekarang" ke titik play harus lebih panjang dari waktu kerja penjadwalan (membuat node, antrean nada). Di HP lambat 50 ms bawaan tidak
// cukup, sehingga awal lagu telat. Jeda dikalibrasi sendiri: setiap kali sisa jeda setelah penjadwalan terlalu tipis, jeda dinaikkan sebesar kekurangannya
// plus bantalan, lalu penjadwalan diulang (maksimal beberapa kali). Hasilnya diingat, jadi Play / loop berikutnya langsung memakai jeda yang cukup.
export const LEAD_MIN = 0.05, LEAD_MAX = 0.6, LEAD_SLACK = 0.02, LEAD_PAD = 0.08;

// Setelah penjadwalan berhasil tanpa ulang: jeda disusutkan ke waktu kerja nyata + bantalan. Tanpa ini satu hiccup sesaat (JIT, GC) membuat jeda menempel tinggi
// seumur sesi (celah di titik loop dan tunda Play yang tidak perlu). Kalau nanti kerja memang lebih lama, nextLead menaikkannya lagi.
export function settleLead(current: number, spentSec: number): number {
  return Math.max(LEAD_MIN, Math.min(current, spentSec + LEAD_SLACK + LEAD_PAD, LEAD_MAX));
}

export function nextLead(current: number, slack: number): number | null {
  if (slack >= LEAD_SLACK) return null;                  // cukup
  if (current >= LEAD_MAX) return null;                  // sudah di batas: terima apa adanya (clipWindow melompati bagian yang telat)
  return Math.min(LEAD_MAX, current + (LEAD_SLACK - slack) + LEAD_PAD);
}
