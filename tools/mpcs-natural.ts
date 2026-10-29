// Tes "natural" MPCS (Node, tanpa DOM): seberapa dekat HASIL geser nada (nada diseret tangan, geseran besar) dengan vokal yang MEMANG dinyanyikan di nada itu.
// Vokal sintetis source-filter: formant tetap (F1 700 / F2 1200 / F3 2600 Hz) tidak peduli pitch, jadi referensi di nada tujuan punya envelope yang sama.
// Metrik per geseran (semiton) dan pitch sumber:
//   env   : galat bentuk envelope (dB RMS) = amplitudo tiap harmonik hasil vs referensi, penguatan global dibuang. Mengukur formant ikut geser / warna suara berubah.
//   gain  : selisih level global hasil vs referensi (dB)
//   hnr   : HNR hasil - HNR referensi (dB, negatif = lebih serak / berisik)
//   mod   : kedalaman modulasi amplitudo pada laju pitch (rasio, 0 = mulus; "buzz" / gemeretak PSOLA)
//   pitch : galat pitch hasil terhadap tujuan (sen)
// Pakai:  node tools/mpcs-natural.ts [path-ke-mpcs-dsp.ts]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const modPath = process.argv[2] ?? new URL('../src/mpcs-dsp.ts', import.meta.url).pathname;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dsp: any = await import(pathToFileURL(resolve(modPath)).href);
const SR = 44100;
const hz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FORM: Array<[number, number, number]> = [[700, 250, 1], [1200, 300, 0.7], [2600, 400, 0.45]];
const envAt = (f: number): number => 0.04 + FORM.reduce((s, [c, w, a]) => s + a * Math.exp(-(((f - c) / w) ** 2)), 0);

// vokal tetap: pitch pusat midi + vibrato kecil + jitter / shimmer tipis + sedikit napas (supaya ada komponen noise seperti suara asli)
function vowel(midi: number, dur: number, breath: number, seed: number, vib = 25): Float32Array {
  const n = Math.round(dur * SR), x = new Float32Array(n), r = rng(seed), g = (): number => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  let ph = 0, jt = 0, sh = 0, pk = 0;
  for (let t = 0; t < n; t++) {
    jt = 0.99 * jt + 0.0003 * g(); sh = 0.995 * sh + 0.004 * g();
    const f = hz(midi + (vib / 100) * Math.sin(2 * Math.PI * 5.3 * t / SR)) * (1 + jt); ph += 2 * Math.PI * f / SR;
    let v = 0; const K = Math.floor(0.45 * SR / f);
    for (let k = 1; k <= K; k++) v += Math.sin(k * ph) * k ** -0.9 * envAt(k * f);
    x[t] = (v * (1 + sh) + breath * g()) * Math.min(1, t / (0.03 * SR), (n - t) / (0.03 * SR)); pk = Math.max(pk, Math.abs(x[t]));
  }
  for (let t = 0; t < n; t++) x[t] *= 0.5 / pk;
  return x;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) { const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang); for (let i = 0; i < n; i += len) { let cr = 1, ci = 0; for (let k = 0; k < len / 2; k++) { const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr; re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } } }
}
// amplitudo (dB) tiap harmonik f0 sampai 5 kHz di satu jendela 8192
function harmonics(y: Float32Array, s: number, f0: number): number[] {
  const N = 8192, re = new Float64Array(N), im = new Float64Array(N); for (let j = 0; j < N; j++) re[j] = (y[s + j] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * j / N));
  fft(re, im); const out: number[] = [], bin = SR / N;
  for (let k = 1; k * f0 < 5000; k++) { const c = Math.round(k * f0 / bin); let m = 0; for (let b = c - 2; b <= c + 2; b++) m = Math.max(m, Math.hypot(re[b], im[b])); out.push(20 * Math.log10(m + 1e-9)); }
  return out;
}
// HNR (dB) dari korelasi periode-ke-periode
function hnrOf(y: Float32Array, f0: number, a0: number, a1: number): number {
  const out: number[] = [], T = SR / f0, W = Math.round(3 * T);
  for (let t = a0; t + W + Math.ceil(T * 1.1) < a1; t += Math.round(0.005 * SR)) {
    let best = 0; for (let lag = Math.floor(T * 0.96); lag <= Math.ceil(T * 1.04); lag++) { let sc = 0, e0 = 0, e1 = 0; for (let i = 0; i < W; i++) { const p = y[t + i], q = y[t + i + lag]; sc += p * q; e0 += p * p; e1 += q * q; } best = Math.max(best, sc / Math.sqrt(e0 * e1 + 1e-12)); }
    const r = Math.max(0.01, Math.min(0.9995, best)); out.push(10 * Math.log10(r / (1 - r)));
  }
  return out.reduce((q, w) => q + w, 0) / Math.max(1, out.length);
}
// modulasi amplitudo pada laju pitch: envelope |y| dihaluskan setengah periode, lalu (maks-min)/(maks+min) di tiap periode, dirata-rata
function modDepth(y: Float32Array, f0: number, a0: number, a1: number): number {
  const T = SR / f0, h = Math.max(2, Math.round(T / 2)), e = new Float64Array(a1 - a0); for (let i = 0; i < e.length; i++) e[i] = y[a0 + i] * y[a0 + i];
  const sm = new Float64Array(e.length); let acc = 0; for (let i = 0; i < e.length; i++) { acc += e[i]; if (i >= h) acc -= e[i - h]; sm[i] = acc / h; }
  const out: number[] = []; for (let t = h; t + 4 * T < e.length; t += Math.round(4 * T)) { let mx = 0, mn = 1e9; for (let i = 0; i < 4 * T; i++) { mx = Math.max(mx, sm[t + i]); mn = Math.min(mn, sm[t + i]); } out.push((mx - mn) / (mx + mn + 1e-12)); }
  return out.reduce((q, w) => q + w, 0) / Math.max(1, out.length);
}
// "hantu": level (dB terhadap harmonik tujuan terkuat) harmonik pitch ASLI yang tidak berimpit dengan harmonik tujuan. Naik = suara asli masih bocor di belakang hasil geseran
function ghost(y: Float32Array, fSrc: number, fTgt: number, s: number): number {
  const N = 8192, re = new Float64Array(N), im = new Float64Array(N); for (let j = 0; j < N; j++) re[j] = (y[s + j] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * j / N));
  fft(re, im); const bin = SR / N, mag = (f: number): number => { const c = Math.round(f / bin); let m = 0; for (let b = c - 2; b <= c + 2; b++) m = Math.max(m, Math.hypot(re[b], im[b])); return m; };
  let top = 0; for (let k = 1; k * fTgt < 5000; k++) top = Math.max(top, mag(k * fTgt));
  let g = 0; for (let k = 1; k * fSrc < 5000; k++) { const f = k * fSrc, kt = Math.round(f / fTgt); if (Math.abs(f - kt * fTgt) < 0.06 * fTgt || Math.abs(f - kt * fTgt) < 0.06 * fSrc) continue; g = Math.max(g, mag(f)); }
  return 20 * Math.log10(g / top + 1e-9);
}
function pitchErr(y: Float32Array, f0: number, s: number): number {
  const T = SR / f0, W = Math.round(4 * T), lo = Math.floor(T * 0.9), hi = Math.ceil(T * 1.1); let bl = lo, bv = -1;
  for (let l = lo; l <= hi; l++) { let c = 0, e0 = 0, e1 = 0; for (let j = 0; j < W; j++) { c += y[s + j] * y[s + j + l]; e0 += y[s + j] ** 2; e1 += y[s + j + l] ** 2; } const v = c / Math.sqrt(e0 * e1 + 1e-12); if (v > bv) { bv = v; bl = l; } }
  return 1200 * Math.log2(T / bl);
}

const SHIFTS = (process.env.SHIFTS ?? '-12,-6,-3,-1,1,3,6,12').split(',').map(Number);
const SRCS = [{ name: 'pria', midi: 48 }, { name: 'wanita', midi: 62 }];
const BREATH = Number(process.env.BREATH ?? 0.02);
const DUR = 1.6;
console.log('MPCS natural (nada diseret tangan, formant tetap): ' + modPath + '   napas ' + BREATH);
console.log('sumber'.padEnd(8) + 'geser'.padStart(6) + 'env dB'.padStart(8) + 'gain dB'.padStart(9) + 'dHNR dB'.padStart(9) + 'mod'.padStart(7) + 'mod ref'.padStart(9) + 'pitch c'.padStart(9) + 'hantu'.padStart(8) + 'hantu ref'.padStart(10));
let sEnv = 0, sH = 0, sMod = 0, cnt = 0, worstEnv = 0;
for (const src of SRCS) for (const sh of SHIFTS) {
  const x = vowel(src.midi, DUR, BREATH, 3), tgt = src.midi + sh, f1 = hz(tgt);
  const ref = vowel(tgt, DUR, BREATH, 9);
  const r = dsp.analyze(x, SR);
  if (!r.notes.length) { console.log(src.name.padEnd(8) + String(sh).padStart(6) + '  (tidak ada nada terdeteksi)'); continue; }
  for (const n of r.notes) { n.target = n.midi + sh; n.man = true; }
  const y: Float32Array = dsp.render(x, r.pt, r.notes, 12, 45, { center: 1, variation: 1, transition: 0.5 });
  const a0 = Math.round(0.3 * SR), a1 = Math.round(1.3 * SR);
  const hy = harmonics(y, a0, f1), hr = harmonics(ref, a0, f1), L = Math.min(hy.length, hr.length);
  let off = 0; for (let k = 0; k < L; k++) off += hy[k] - hr[k]; off /= L;
  let e2 = 0; for (let k = 0; k < L; k++) e2 += (hy[k] - hr[k] - off) ** 2; const env = Math.sqrt(e2 / L);
  const dH = hnrOf(y, f1, a0, a1) - hnrOf(ref, f1, a0, a1), md = modDepth(y, f1, a0, a1), mr = modDepth(ref, f1, a0, a1), pe = pitchErr(y, f1, a0), gh = ghost(y, hz(src.midi), f1, a0), ghr = ghost(ref, hz(src.midi), f1, a0);
  sEnv += env; sH += dH; sMod += md; cnt++; worstEnv = Math.max(worstEnv, env);
  console.log(src.name.padEnd(8) + String(sh).padStart(6) + env.toFixed(1).padStart(8) + off.toFixed(1).padStart(9) + dH.toFixed(1).padStart(9) + md.toFixed(2).padStart(7) + mr.toFixed(2).padStart(9) + pe.toFixed(0).padStart(9) + gh.toFixed(1).padStart(8) + ghr.toFixed(1).padStart(10));
}
console.log('rata-rata: env ' + (sEnv / cnt).toFixed(2) + ' dB (terburuk ' + worstEnv.toFixed(1) + '), dHNR ' + (sH / cnt).toFixed(1) + ' dB, mod ' + (sMod / cnt).toFixed(2));

// ---------- Mode DATAR: Glide 0 / Human 0 / Lock 100%, semua nada di satu pitch (C5 = MIDI 72) ----------
// Kasus ekstrem yang sering dipakai: vokal diratakan total ke satu nada. Selain galat envelope / HNR, diukur "hidup": simpangan baku pitch jangka pendek (sen) hasil
// dibandingkan dengan vokal asli yang dinyanyikan lurus di nada itu (tanpa vibrato). Hasil yang terlalu 0 sen = terdengar mati / robotik.
const FLAT = 72, CTLF = { center: 1, variation: 0, transition: 0 };
function shortStd(y: Float32Array, f0: number, a0: number, a1: number): number {
  const T = SR / f0, W = Math.round(4 * T), v: number[] = [];
  for (let s = a0; s + W + Math.ceil(T * 1.2) < a1; s += Math.round(0.01 * SR)) {
    const lo = Math.floor(T * 0.9), hi = Math.ceil(T * 1.1); let bl = lo, bv = -1, rr: number[] = [];
    for (let l = lo - 1; l <= hi + 1; l++) { let c = 0, e0 = 0, e1 = 0; for (let j = 0; j < W; j++) { c += y[s + j] * y[s + j + l]; e0 += y[s + j] ** 2; e1 += y[s + j + l] ** 2; } rr.push(c / Math.sqrt(e0 * e1 + 1e-12)); }
    for (let l = lo; l <= hi; l++) if (rr[l - lo + 1] > bv) { bv = rr[l - lo + 1]; bl = l; }
    const a = rr[bl - lo], m = rr[bl - lo + 1], c = rr[bl - lo + 2], den = a - 2 * m + c, lag = den < 0 ? bl + 0.5 * (a - c) / den : bl;
    v.push(1200 * Math.log2(T / lag));
  }
  const mu = v.reduce((q, w) => q + w, 0) / v.length; return Math.sqrt(v.reduce((q, w) => q + (w - mu) ** 2, 0) / v.length);
}
if (process.env.FLAT !== '0') {
  console.log('\nDATAR (Glide 0 / Human 0 / Lock 100%, semua ke C5): simpangan baku pitch jangka pendek = "hidup" (ref = vokal lurus asli tanpa vibrato)');
  console.log('sumber'.padEnd(8) + 'midi'.padStart(6) + 'geser'.padStart(7) + 'env dB'.padStart(8) + 'dHNR dB'.padStart(9) + 'hidup c'.padStart(9) + 'ref c'.padStart(7) + 'rata c'.padStart(8));
  let se = 0, sh2 = 0, sl = 0, c2 = 0;
  const refV = vowel(FLAT, DUR, BREATH, 21, 0), liveRef = shortStd(refV, hz(FLAT), Math.round(0.3 * SR), Math.round(1.3 * SR));
  for (const m of [55, 60, 64, 69, 72, 76, 79]) {
    const x = vowel(m, DUR, BREATH, 3, 25), r = dsp.analyze(x, SR);
    if (!r.notes.length) continue;
    for (const n of r.notes) n.target = FLAT;
    const y: Float32Array = dsp.render(x, r.pt, r.notes, 12, 45, CTLF), a0 = Math.round(0.3 * SR), a1 = Math.round(1.3 * SR), f1 = hz(FLAT);
    const hy = harmonics(y, a0, f1), hr = harmonics(refV, a0, f1), L = Math.min(hy.length, hr.length);
    let off = 0; for (let k = 0; k < L; k++) off += hy[k] - hr[k]; off /= L;
    let e2 = 0; for (let k = 0; k < L; k++) e2 += (hy[k] - hr[k] - off) ** 2; const env = Math.sqrt(e2 / L);
    const dH = hnrOf(y, f1, a0, a1) - hnrOf(refV, f1, a0, a1), live = shortStd(y, f1, a0, a1), pe = pitchErr(y, f1, a0);
    se += env; sh2 += dH; sl += live; c2++;
    console.log('vokal'.padEnd(8) + String(m).padStart(6) + String(FLAT - m).padStart(7) + env.toFixed(1).padStart(8) + dH.toFixed(1).padStart(9) + live.toFixed(1).padStart(9) + liveRef.toFixed(1).padStart(7) + pe.toFixed(0).padStart(8));
  }
  console.log('rata-rata DATAR: env ' + (se / c2).toFixed(2) + ' dB, dHNR ' + (sh2 / c2).toFixed(1) + ' dB, hidup ' + (sl / c2).toFixed(1) + ' sen (ref ' + liveRef.toFixed(1) + ')');
}
