// Tes VocalF (src/vocalf.ts): jalankan prosesor worklet di Node dengan sinyal sintetis.
//   node tools/vocalf-test.ts
import { VOCALF_SRC } from '../src/vocalf.ts';

const SR = 44100;
let Proc: any;
(globalThis as any).sampleRate = SR;
(globalThis as any).AudioWorkletProcessor = class { port: any = {}; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
new Function(VOCALF_SRC)();

function run(x: Float32Array, p: { mid: number; high: number; trim: number; on: boolean }): Float32Array {
  const node = new Proc({ processorOptions: p }); node.port.onmessage({ data: { t: 'p', ...p } });
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i), a = x.slice(i, i + n), o = [new Float32Array(n), new Float32Array(n)];
    node.process([[a, a]], [o]); out.set(o[0], i);
  }
  return out;
}
// energi pada satu frekuensi (Goertzel) -> dB
function tone(x: Float32Array, f: number, a: number, b: number): number {
  const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
  for (let i = a; i < b; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return 10 * Math.log10((s1 * s1 + s2 * s2 - c * s1 * s2) / ((b - a) * (b - a)) + 1e-18);
}
const rms = (x: Float32Array, a: number, b: number) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const db = (v: number) => 20 * Math.log10(v + 1e-12);
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

const N = SR * 2;
const noise = new Float32Array(N).map(() => rnd() * 0.05);   // ~ -26 dBFS puncak: level wajar untuk band udara vokal

// 1) semua nol, trim 0: lolos persis
const same = run(noise, { mid: 0, high: 0, trim: 0, on: true });
let maxd = 0; for (let i = 0; i < N; i++) maxd = Math.max(maxd, Math.abs(same[i] - noise[i]));
console.log('bypass (0/0/0 dB): selisih maks', maxd, '(harus 0)');

// 2) vokal sintetis: dasar 220 Hz + 12 harmonik turun 1/h (sedikit konten > 6 kHz), ada "S" di tengah
const T = SR * 1.2, v = new Float32Array(T), s0 = Math.floor(SR * 0.6), s1 = Math.floor(SR * 0.9); let lp = 0;
for (let i = 0; i < T; i++) {
  let y = 0; for (let h = 1; h <= 12; h++) y += Math.sin(2 * Math.PI * 220 * h * i / SR) / (h * h);
  v[i] = 0.3 * y;
  if (i >= s0 && i < s1) { const n = rnd(); lp += 0.35 * (n - lp); v[i] += 0.5 * (n - lp); }
}
// band udara (>6 kHz) diukur lewat derau berpita pada tiap pita
// level pita (dB): rata-rata daya Goertzel di 40 frekuensi sekitar f (+-12%), supaya variansi derau tidak mengacaukan pengukuran
const bandDb = (x: Float32Array, f: number) => { let acc = 0; for (let k = 0; k < 40; k++) acc += Math.pow(10, tone(x, f * (0.88 + 0.24 * k / 39), 4000, 20000) / 10); return 10 * Math.log10(acc / 40); };
console.log('Derau putih, selisih level per frekuensi (dB) -> respons efektif');
for (const [name, p] of [['Mid 100%', { mid: 1, high: 0 }], ['High 100%', { mid: 0, high: 1 }], ['Mid 50% / High 50%', { mid: .5, high: .5 }], ['Mid 100% / High 100%', { mid: 1, high: 1 }]] as const) {
  const y = run(noise, { ...p, trim: 0, on: true }); const r: string[] = [];
  for (const f of [1000, 3000, 5000, 7000, 10000, 14000, 18000]) r.push(f / 1000 + 'k:' + (bandDb(y, f) - bandDb(noise, f)).toFixed(1));
  console.log(name.padEnd(22), r.join('  '));
}

// 3) vokal rendah tidak berubah
const yv = run(v, { mid: 1, high: 1, trim: 0, on: true });
console.log('\nvokal (<2 kHz) 0.1-0.5s: selisih', (db(rms(yv, 4000, 20000)) - db(rms(v, 4000, 20000))).toFixed(2), 'dB');

// 4) dinamika: derau pelan (napas / ujung kata) dapat tambahan udara lebih besar daripada derau keras (desis)
const g10 = (amp: number) => { const x = new Float32Array(N).map(() => rnd() * amp), y = run(x, { mid: 1, high: 1, trim: 0, on: true }); return bandDb(y, 10000) - bandDb(x, 10000); };
console.log('tambahan di 10 kHz: pelan(0.01)', g10(0.01).toFixed(1), 'dB   sedang(0.1)', g10(0.1).toFixed(1), 'dB   keras(0.5)', g10(0.5).toFixed(1), 'dB  (harus menurun)');

// 5) trim, off, stabil
const t = run(noise, { mid: 0, high: 0, trim: 6, on: true });
console.log('trim +6 dB: selisih RMS', (db(rms(t, 8000, N)) - db(rms(noise, 8000, N))).toFixed(2), 'dB');
const off = run(noise, { mid: 1, high: 1, trim: 6, on: false });
let mo = 0; for (let i = 20000; i < N; i++) mo = Math.max(mo, Math.abs(off[i] - noise[i]));
console.log('off: selisih maks (setelah ramp)', mo.toExponential(2), '(harus ~0)');
const loud = new Float32Array(N).map(() => rnd());
const yl = run(loud, { mid: 1, high: 1, trim: 12, on: true });
let pk = 0, bad = 0; for (let i = 0; i < N; i++) { pk = Math.max(pk, Math.abs(yl[i])); if (!Number.isFinite(yl[i])) bad++; }
console.log('derau keras + semua max: puncak', pk.toFixed(2), 'NaN/Inf:', bad);
