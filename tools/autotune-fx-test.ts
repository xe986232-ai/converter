// Tes AUTOTUNE FX MIXER (src/autotune-fx.ts): penggeser pitch worklet + hitungan interval tangga nada.
//   node tools/autotune-fx-test.ts
import { MX_SHIFT_SRC, scaleOffset, faderGain, faderDb, mxActive, MX_DEF, mxClean } from '../src/autotune-fx.ts';

const SR = 48000;
let Proc: any;
(globalThis as any).sampleRate = SR;
(globalThis as any).AudioWorkletProcessor = class { port: any = { onmessage: null, postMessage() { /* */ } }; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
new Function(MX_SHIFT_SRC)();
let fail = 0;
const ok = (name: string, cond: boolean, info: string): void => { console.log((cond ? 'PASS ' : 'FAIL ') + name + '  ' + info); if (!cond) fail++; };

function shift(x: Float32Array, ratio: number): Float32Array {
  const node = new Proc({ processorOptions: { ratio } }), y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i), a = x.slice(i, i + n), o = [new Float32Array(n), new Float32Array(n)];
    node.process([[a, a]], [o]); y.set(o[0], i);
  }
  return y;
}
function voice(sec: number, f0: number): Float32Array {   // pulsa glotal + formant sederhana
  const n = Math.round(sec * SR), x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += f0 / SR; let s = 0;
    for (let h = 1; h * f0 < 5000; h++) { const fh = h * f0; s += Math.sin(2 * Math.PI * h * ph) * (1 / (1 + Math.pow((fh - 700) / 500, 2)) + 0.15) / Math.pow(h, 0.8); }
    x[i] = s * 0.2;
  }
  return x;
}
function pitchOf(x: Float32Array, a: number, b: number, fmin = 70, fmax = 1000): number {
  const lo = Math.floor(SR / fmax), hi = Math.ceil(SR / fmin), W = b - a - hi; let best = -1, bv = -1e9;
  const r = new Float64Array(hi + 2);
  for (let t = lo - 1; t <= hi + 1; t++) { let s = 0, e1 = 0, e2 = 0; for (let j = 0; j < W; j++) { s += x[a + j] * x[a + j + t]; e1 += x[a + j] ** 2; e2 += x[a + j + t] ** 2; } r[t] = s / Math.sqrt(e1 * e2 + 1e-12); }
  for (let t = lo; t <= hi; t++) if (r[t] > bv && r[t] >= r[t - 1] && r[t] >= r[t + 1]) { if (bv < 0 || r[t] > bv * 1.02) { bv = r[t]; best = t; } }
  const A = r[best - 1], B = r[best], C = r[best + 1], den = A - 2 * B + C, tf = den < 0 ? best + 0.5 * (A - C) / den : best;
  return SR / tf;
}
const cents = (f: number, ref: number): number => 1200 * Math.log2(f / ref);
const rms = (x: Float32Array, a: number, b: number): number => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

const f0 = 220, x = voice(1.5, f0);
for (const st of [-12, -5, 4, 7, 12]) {
  const r = Math.pow(2, st / 12), y = shift(x, r), f = pitchOf(y, 30000, 30000 + 6000);
  const err = cents(f, f0 * r);
  ok(`geser ${st > 0 ? '+' : ''}${st} semiton`, Math.abs(err) < 25, `pitch ${f.toFixed(1)} Hz, target ${(f0 * r).toFixed(1)} Hz, selisih ${err.toFixed(1)} sen`);
}
const y0 = shift(x, 1), gain = rms(y0, 20000, 60000) / rms(x, 20000, 60000);
ok('rasio 1 = level sama', gain > 0.85 && gain < 1.15, `gain ${gain.toFixed(3)}`);
const y7 = shift(x, Math.pow(2, 7 / 12)), g7 = rms(y7, 20000, 60000) / rms(x, 20000, 60000);
ok('+7 semiton level stabil', g7 > 0.6 && g7 < 1.4, `gain ${g7.toFixed(3)}`);
// sinyal kosong tidak menghasilkan derau / NaN
const z = shift(new Float32Array(48000), 1.26); ok('hening tetap hening', z.every(v => v === 0), 'semua nol');
// slew rasio: kirim pesan mid-stream, tidak ada NaN / lonjakan
{
  const node = new Proc({ processorOptions: { ratio: 1 } }); let mx = 0, bad = false;
  for (let i = 0; i < x.length; i += 128) {
    if (i === 24000) node.port.onmessage({ data: { t: 'r', ratio: 1.5 } });
    const n = Math.min(128, x.length - i), a = x.slice(i, i + n), o = [new Float32Array(n), new Float32Array(n)]; node.process([[a, a]], [o]);
    for (const v of o[0]) { if (!Number.isFinite(v)) bad = true; mx = Math.max(mx, Math.abs(v)); }
  }
  ok('ganti rasio saat jalan', !bad && mx < 1.2, `puncak ${mx.toFixed(3)}`);
}
// tangga nada
const AMIN = [9, 11, 0, 2, 4, 5, 7].reduce((m, c) => m | (1 << c), 0), CMAJ = [0, 2, 4, 5, 7, 9, 11].reduce((m, c) => m | (1 << c), 0);
ok('A minor: A + terts = C (+3)', scaleOffset(69, 2, AMIN) === 3, String(scaleOffset(69, 2, AMIN)));
ok('A minor: C + terts = E (+4)', scaleOffset(72, 2, AMIN) === 4, String(scaleOffset(72, 2, AMIN)));
ok('C major: C + terts = E (+4)', scaleOffset(60, 2, CMAJ) === 4, String(scaleOffset(60, 2, CMAJ)));
ok('C major: D + terts = F (+3)', scaleOffset(62, 2, CMAJ) === 3, String(scaleOffset(62, 2, CMAJ)));
ok('C major: kwint dari C = G (+7)', scaleOffset(60, 4, CMAJ) === 7, String(scaleOffset(60, 4, CMAJ)));
ok('C major: oktaf = 12', scaleOffset(64, 7, CMAJ) === 12, String(scaleOffset(64, 7, CMAJ)));
ok('C major: terts ke bawah dari E = C (-4)', scaleOffset(64, -2, CMAJ) === -4, String(scaleOffset(64, -2, CMAJ)));
ok('nada di luar tangga nada ikut ke nada terdekat', Math.abs(scaleOffset(61, 2, CMAJ)) <= 5, String(scaleOffset(61, 2, CMAJ)));
ok('mask kosong: jatuh ke mayor', scaleOffset(60, 2, 0) === 4, String(scaleOffset(60, 2, 0)));
// fader
ok('fader 0,75 = 0 dB', Math.abs(faderDb(0.75)) < 1e-9, String(faderDb(0.75)));
ok('fader 1 = +6 dB', Math.abs(faderDb(1) - 6) < 1e-9, String(faderDb(1)));
ok('fader 0 = mati', faderGain(0) === 0, '');
// aktif / tidak
ok('bawaan = tidak aktif', !mxActive(MX_DEF) && !mxActive(null) && !mxActive({}), '');
ok('Harmony 1 dinaikkan = aktif', mxActive({ ...MX_DEF, h1Lvl: 0.5 }), '');
ok('mxClean membuang nilai rusak', mxClean({ h1Lvl: NaN as number, bogus: 5 } as any).h1Lvl === 0, '');
// kestabilan level lintas f0 dan interval (penggeser dua tap tidak boleh menelan sinyal pada f0 tertentu)
{
  let worst = 0, worstInfo = '';
  for (const f of [110, 147, 196, 220, 262, 330, 440]) {
    const v = voice(1.2, f);
    for (const st of [-12, -7, -5, -3, 3, 4, 5, 7, 12]) {
      const y = shift(v, Math.pow(2, st / 12)), g = Math.abs(20 * Math.log10(rms(y, 24000, 52000) / rms(v, 24000, 52000)));
      if (g > worst) { worst = g; worstInfo = `${f} Hz, ${st} st`; }
    }
  }
  ok('level stabil di semua f0 / interval (selisih terbesar < 3,5 dB)', worst < 3.5, `terbesar ${worst.toFixed(2)} dB (${worstInfo})`);
}
console.log(fail ? `\n${fail} TES GAGAL` : '\nSemua tes lulus'); process.exit(fail ? 1 : 0);
