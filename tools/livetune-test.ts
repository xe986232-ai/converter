// Tes LIVETUNE (src/livetune-dsp.ts): jalankan prosesor worklet di Node dengan sinyal vokal sintetis.
//   node --experimental-transform-types tools/livetune-test.ts
import { readFileSync } from 'node:fs';
import { LIVETUNE_SRC, livetuneLatencySec } from '../src/livetune-dsp.ts';

const SR = 48000;
let Proc: any;
(globalThis as any).sampleRate = SR;
(globalThis as any).AudioWorkletProcessor = class { port: any = { postMessage() { /* */ } }; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
new Function(LIVETUNE_SRC)();

const LAT = Math.ceil(SR / 80 * 3);
const MASK_AMIN = [9, 11, 0, 2, 4, 5, 7].reduce((m, c) => m | (1 << c), 0);   // A minor natural (A B C D E F G)
const ALL = 0xFFF;
let fail = 0;
const ok = (name: string, cond: boolean, info: string): void => { console.log((cond ? 'PASS ' : 'FAIL ') + name + '  ' + info); if (!cond) fail++; };

interface P { amount?: number; tc?: number; mask?: number; on?: boolean }
function run(x: Float32Array, p: P = {}): { y: Float32Array; frames: Array<{ raw: number; out: number }>; ms: number } {
  const frames: Array<{ raw: number; out: number }> = [];
  const node = new Proc({ processorOptions: { amount: p.amount ?? 1, tc: p.tc ?? 0, mask: p.mask ?? ALL, on: p.on ?? true } });
  node.port.postMessage = (m: any) => { if (m.t === 'f') frames.push({ raw: m.raw, out: m.out }); };
  const y = new Float32Array(x.length), t0 = performance.now();
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i), a = x.slice(i, i + n), o = [new Float32Array(n), new Float32Array(n)];
    node.process([[a, a]], [o]); y.set(o[0], i);
  }
  return { y, frames, ms: performance.now() - t0 };
}

// vokal sintetis: pulsa glotal (harmonik 1/h^1.2) + formant sederhana, f0(t) bebas
function voice(sec: number, f0: (t: number) => number, amp = 0.4): Float32Array {
  const n = Math.round(sec * SR), x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = f0(t); ph += f / SR;
    let s = 0;
    for (let h = 1; h * f < 5000 && h < 40; h++) {
      const fh = h * f, form = 1 / (1 + Math.pow((fh - 700) / 500, 2)) + 0.6 / (1 + Math.pow((fh - 1800) / 700, 2)) + 0.15;
      s += Math.sin(2 * Math.PI * h * ph) * form / Math.pow(h, 0.8);
    }
    x[i] = s * amp * 0.5;
  }
  return x;
}
// pitch (Hz) di jendela [a, b) lewat autokorelasi + interpolasi parabola
function pitchOf(x: Float32Array, a: number, b: number, fmin = 70, fmax = 1000): number {
  const lo = Math.floor(SR / fmax), hi = Math.ceil(SR / fmin), W = b - a - hi; let best = -1, bv = -1e9;
  const r = new Float64Array(hi + 2);
  for (let t = lo - 1; t <= hi + 1; t++) { let s = 0, e1 = 0, e2 = 0; for (let j = 0; j < W; j++) { s += x[a + j] * x[a + j + t]; e1 += x[a + j] ** 2; e2 += x[a + j + t] ** 2; } r[t] = s / Math.sqrt(e1 * e2 + 1e-12); }
  for (let t = lo; t <= hi; t++) if (r[t] > bv && r[t] >= r[t - 1] && r[t] >= r[t + 1]) { // puncak pertama yang mendekati maksimum
    if (bv < 0 || r[t] > bv * 1.02) { bv = r[t]; best = t; }
  }
  if (best < 0) return 0;
  const A = r[best - 1], B = r[best], C = r[best + 1], den = A - 2 * B + C, tf = den < 0 ? best + 0.5 * (A - C) / den : best;
  return SR / tf;
}
const cents = (f: number, ref: number): number => 1200 * Math.log2(f / ref);
const mid = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const rms = (x: Float32Array, a: number, b: number): number => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

const W0 = 0.6 * SR;   // abaikan awal (lock + latensi)

// 1) snap: A4 sedikit flat (-35 ct) -> A4 persis (A ada di skala)
{
  const f = mid(69) * Math.pow(2, -35 / 1200), x = voice(2, () => f), r = run(x, { mask: MASK_AMIN });
  const o = pitchOf(r.y, W0 + LAT, W0 + LAT + 6000), c = cents(o, 440);
  ok('snap A4 flat -35ct', Math.abs(c) < 4, `hasil ${o.toFixed(2)} Hz (${c.toFixed(1)} ct dari 440)`);
}
// 2) nada di luar skala ditarik ke nada terdekat yang diizinkan: A# (-> A atau B), pakai skala hanya A,C,E
{
  const x = voice(2, () => mid(70) + 0), r = run(x, { mask: (1 << 9) | (1 << 0) | (1 << 4) });   // A#4 -> A4 (jarak 1) bukan C (jarak 2... C5 +2)
  const o = pitchOf(r.y, W0 + LAT, W0 + LAT + 6000), c = cents(o, 440);
  ok('A#4 -> A4 (skala A,C,E)', Math.abs(c) < 5, `hasil ${o.toFixed(2)} Hz (${c.toFixed(1)} ct dari 440)`);
}
// 3) Amount 50%: setengah jalan
{
  const f = mid(69) * Math.pow(2, 40 / 1200), x = voice(2, () => f), r = run(x, { amount: 0.5, mask: MASK_AMIN });
  const o = pitchOf(r.y, W0 + LAT, W0 + LAT + 6000), c = cents(o, 440);
  ok('Amount 50% (+40ct -> ~+20ct)', Math.abs(c - 20) < 5, `hasil ${c.toFixed(1)} ct`);
}
// 4) Amount 0: pitch tidak berubah
{
  const f = mid(69) * Math.pow(2, 40 / 1200), x = voice(2, () => f), r = run(x, { amount: 0, mask: MASK_AMIN });
  const o = pitchOf(r.y, W0 + LAT, W0 + LAT + 6000), c = cents(o, f);
  ok('Amount 0 = pitch asli', Math.abs(c) < 4, `selisih ${c.toFixed(1)} ct`);
}
// 5) bypass: output = input tertunda LAT (identik)
{
  const x = voice(1.5, () => 233), r = run(x, { on: false });
  let md = 0; for (let i = LAT + 2000; i < x.length; i++) md = Math.max(md, Math.abs(r.y[i] - x[i - LAT]));
  ok('bypass = dry tertunda tepat', md < 1e-6, `selisih maks ${md.toExponential(2)}, latensi ${LAT} sample = ${(livetuneLatencySec(SR) * 1000).toFixed(1)} ms`);
}
// 6) hening: tidak ada NaN / suara
{
  const x = new Float32Array(SR), r = run(x), bad = r.y.some(v => !Number.isFinite(v)), mx = r.y.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  ok('hening', !bad && mx === 0, `maks ${mx}`);
}
// 7) vibrato (5,5 Hz, +-60 ct di sekitar A4+0): Fast meratakan, Slow menjaga
{
  const f0 = (t: number): number => 440 * Math.pow(2, (60 * Math.sin(2 * Math.PI * 5.5 * t)) / 1200), x = voice(3, f0);
  const dev = (y: Float32Array): number => { const cs: number[] = []; for (let a = W0 + LAT; a + 3000 < y.length; a += 1500) cs.push(cents(pitchOf(y, a, a + 3000), 440)); const m = cs.reduce((s, v) => s + v, 0) / cs.length; return Math.sqrt(cs.reduce((s, v) => s + (v - m) ** 2, 0) / cs.length); };
  const fast = run(x, { tc: 0, mask: MASK_AMIN }), slow = run(x, { tc: 400, mask: MASK_AMIN });
  const dIn = dev(x), dF = dev(fast.y), dS = dev(slow.y);
  ok('vibrato: Fast meratakan', dF < dIn * 0.4, `std asli ${dIn.toFixed(1)} ct -> ${dF.toFixed(1)} ct`);
  ok('vibrato: Slow menjaga', dS > dIn * 0.4, `std ${dS.toFixed(1)} ct`);
}
// 8) glide: nada naik pelan A4 -> B4 tanpa lompatan besar dengan Slow (tc 200 ms): tidak ada patahan > 1 semiton antar frame
{
  const x = voice(3, t => 440 * Math.pow(2, (2 * Math.min(1, Math.max(0, (t - 0.8) / 1.2))) / 12)), r = run(x, { tc: 200, mask: MASK_AMIN });
  const outs = r.frames.filter(f => f.out > 0).map(f => f.out); let mj = 0; for (let i = 1; i < outs.length; i++) mj = Math.max(mj, Math.abs(outs[i] - outs[i - 1]));
  ok('glide mulus (Slow)', mj < 0.6, `lompatan maks antar frame ${mj.toFixed(2)} st`);
}
// 9) vokal rendah (104 Hz ~ G#2: terdekat di A minor = A2 110 Hz) dan tinggi (G5 + 30 ct)
{
  const lowF = 104, tgtLow = mid(45) /* A2 = 110 Hz */, xl = voice(2.5, () => lowF), rl = run(xl, { mask: MASK_AMIN });
  const ol = pitchOf(rl.y, W0 + LAT, W0 + LAT + 9000, 70, 300), cl = cents(ol, tgtLow);
  ok('vokal rendah 104 Hz -> A2', Math.abs(cl) < 8, `hasil ${ol.toFixed(2)} Hz (${cl.toFixed(1)} ct dari A2)`);
  const hiF = mid(79) * Math.pow(2, 30 / 1200) /* G5 +30ct = 800 Hz area */, xh = voice(2, () => hiF), rh = run(xh, { mask: MASK_AMIN });
  const oh = pitchOf(rh.y, W0 + LAT, W0 + LAT + 4000, 300, 1100), ch = cents(oh, mid(79));
  ok('vokal tinggi G5+30ct -> G5', Math.abs(ch) < 5, `hasil ${oh.toFixed(2)} Hz (${ch.toFixed(1)} ct)`);
}
// 10) level stabil: RMS keluaran ~ RMS masukan (+-1,5 dB) saat dikoreksi
{
  const f = mid(69) * Math.pow(2, -45 / 1200), x = voice(2, () => f), r = run(x, { mask: MASK_AMIN });
  const a = rms(x, W0, W0 + 12000), b = rms(r.y, W0 + LAT, W0 + LAT + 12000), db = 20 * Math.log10(b / a);
  ok('level terjaga', Math.abs(db) < 1.5, `${db.toFixed(2)} dB`);
  // dan geser besar: D5 dengan hanya G diizinkan -> G5 terdekat (+5 st)
  const x2 = voice(2, () => mid(74) /* D5 */), r2 = run(x2, { mask: (1 << 7) /* hanya G */ });
  const a2 = rms(x2, W0, W0 + 12000), b2 = rms(r2.y, W0 + LAT, W0 + LAT + 12000), db2 = 20 * Math.log10(b2 / a2);
  const o2 = pitchOf(r2.y, W0 + LAT, W0 + LAT + 8000), c2 = cents(o2, mid(79));
  ok('geser besar D5 -> G5 (+5 st)', Math.abs(c2) < 8 && Math.abs(db2) < 2.5, `${c2.toFixed(1)} ct, level ${db2.toFixed(2)} dB`);
}
// 11) suara tak-bernada (derau) lewat tanpa terdistorsi: RMS sama
{
  let s = 7; const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const x = new Float32Array(SR * 1.5).map(() => rnd() * 0.2), r = run(x);
  const a = rms(x, W0, W0 + 12000), b = rms(r.y, W0 + LAT, W0 + LAT + 12000), db = 20 * Math.log10(b / a);
  ok('derau lewat apa adanya', Math.abs(db) < 1, `${db.toFixed(2)} dB`);
}
// 12) CPU
{
  const x = voice(10, () => 220 * Math.pow(2, (50 * Math.sin(2 * Math.PI * 5 * 0)) / 1200)), r = run(x, { mask: MASK_AMIN });
  const load = r.ms / 10000 * 100;
  ok('CPU', load < 12, `${load.toFixed(1)}% satu core (10 dtk audio dalam ${r.ms.toFixed(0)} ms)`);
}

// 13) LIVETUNE berdiri sendiri dan terdaftar sebagai plugin berbayar (diperiksa dari teks sumber, tanpa menjalankan kode browser)
{
  const rd = (p: string): string => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const dsp = rd('src/livetune-dsp.ts'), win = rd('src/livetune.ts');
  ok('livetune-dsp.ts tidak mengimpor apa pun', !/^\s*import\s/m.test(dsp), 'tanpa import');
  ok('livetune*.ts tidak mengimpor autotune*', !/from\s+['"]\.\/autotune/.test(dsp + win), 'terpisah dari AUTOTUNE');
  ok('nama prosesor sendiri', /registerProcessor\('deriz-livetune'/.test(dsp) && !/deriz-autotune/.test(dsp), "'deriz-livetune'");
  ok('katalog Shop memuat livetune', /id: 'livetune'/.test(rd('src/shop-page.ts')), 'kartu');
  const rack = rd('src/fx-rack.ts');
  ok('fx-rack: kartu + daftar plugin', /type: 'livetune'/.test(rack) && /d\.type === 'livetune'/.test(rack), 'kartu + masuk daftar');
}
console.log(fail ? `\n${fail} tes GAGAL` : '\nSemua tes lulus');
process.exit(fail ? 1 : 0);
