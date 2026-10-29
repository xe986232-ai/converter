// Tes Reverb FDN (src/reverb-dsp.ts): jalankan prosesor worklet di Node dengan sinyal sintetis.
//   node tools/reverb-test.ts
import { REVERB_SRC } from '../src/reverb-dsp.ts';

const SR = 44100;
let Proc: any;
(globalThis as any).sampleRate = SR;
(globalThis as any).AudioWorkletProcessor = class { port: any = {}; };
(globalThis as any).registerProcessor = (_: string, c: any) => { Proc = c; };
new Function(REVERB_SRC)();

const mk = (rt: number) => new Proc({ processorOptions: { rt } });
function run(node: any, L: Float32Array, R: Float32Array): [Float32Array, Float32Array] {
  const oL = new Float32Array(L.length), oR = new Float32Array(L.length);
  for (let i = 0; i < L.length; i += 128) {
    const n = Math.min(128, L.length - i), a = L.slice(i, i + n), b = R.slice(i, i + n), o = [new Float32Array(n), new Float32Array(n)];
    node.process([[a, b]], [o]); oL.set(o[0], i); oR.set(o[1], i);
  }
  return [oL, oR];
}
const energy = (x: Float32Array, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return s; };
const db = (v: number) => 10 * Math.log10(v + 1e-30);
let fails = 0;
const check = (name: string, ok: boolean, info: string) => { console.log((ok ? 'OK   ' : 'GAGAL'), name, info); if (!ok) fails++; };
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;

// 1) energi impuls respons ~ 1 (sama dengan impuls Convolver lama) untuk semua panjang gema; dan RT60 terukur dekat setelan
for (const rt of [0.4, 1.0, 2.5, 5.0]) {
  const N = Math.floor(SR * (rt * 1.6 + 0.5)), imp = new Float32Array(N); imp[0] = 1;
  const [l, r] = run(mk(rt), imp, imp);
  const e = energy(l) + energy(r);   // jumlah dua channel; impuls lama: tiap channel energinya 1
  // Schroeder backward integration untuk RT60 (T20 dari -5 dB ke -25 dB, dikali 3)
  const tot = energy(l), cum = new Float64Array(N); let s = 0; for (let i = N - 1; i >= 0; i--) { s += l[i] * l[i]; cum[i] = s; }
  let t5 = -1, t25 = -1; for (let i = 0; i < N; i++) { const d = db(cum[i] / tot); if (t5 < 0 && d <= -5) t5 = i; if (t25 < 0 && d <= -25) { t25 = i; break; } }
  const rtm = (t25 - t5) / SR * 3;
  check('energi impuls rt=' + rt, Math.abs(db(e / 2)) < 1.5, 'per channel ' + db(e / 2).toFixed(2) + ' dB (target ~0)');
  check('RT60 rt=' + rt, Math.abs(rtm - rt) / rt < 0.35, 'terukur ' + rtm.toFixed(2) + ' s');
}

// 2) level derau putih: wet ~ dry (daya sama) untuk pendek dan panjang
for (const rt of [0.5, 3]) {
  const N = SR * 8, x = new Float32Array(N).map(() => rnd() * 0.3), [l] = run(mk(rt), x, x);
  const g = db(energy(l, SR * 4, N) / energy(x, SR * 4, N));
  check('level derau rt=' + rt, Math.abs(g) < 2, 'wet/dry ' + g.toFixed(2) + ' dB');
}

// 3) stabil: tidak meledak dengan input keras terus-menerus, tidak ada NaN
{
  const N = SR * 6, x = new Float32Array(N).map(() => rnd()), [l, r] = run(mk(5), x, x);
  let mx = 0, bad = false; for (let i = 0; i < N; i++) { mx = Math.max(mx, Math.abs(l[i]), Math.abs(r[i])); if (!isFinite(l[i]) || !isFinite(r[i])) bad = true; }
  check('stabil (input penuh 6 dtk, rt=5)', !bad && mx < 8, 'puncak ' + mx.toFixed(2));
}

// 4) stereo: kiri / kanan tidak identik (lebar), input mono tetap menghasilkan stereo
{
  const N = SR * 2, x = new Float32Array(N).map(() => rnd() * 0.3), [l, r] = run(mk(1.5), x, x);
  let c = 0; for (let i = SR; i < N; i++) c += l[i] * r[i];
  const corr = c / Math.sqrt(energy(l, SR, N) * energy(r, SR, N));
  check('lebar stereo', Math.abs(corr) < 0.3, 'korelasi L/R ' + corr.toFixed(3));
}

// 5) auto-berhenti: setelah input senyap, ekor mati dan blok berikutnya nol persis; bangun lagi saat ada suara
{
  const node = mk(1.0), burst = new Float32Array(SR / 2).map(() => rnd() * 0.5), sil = new Float32Array(SR * 4);
  run(node, burst, burst);
  const [l] = run(node, sil, sil);
  check('ekor habis -> idle', node.idle === true, 'idle=' + node.idle);
  let nz = 0; for (let i = SR * 3; i < l.length; i++) if (l[i] !== 0) nz++;
  check('keluaran idle nol persis', nz === 0, nz + ' sampel tidak nol');
  const [l2] = run(node, burst, burst);
  check('bangun lagi saat ada suara', energy(l2) > 0.01 && node.idle === false, 'energi ' + energy(l2).toFixed(2));
  // tail ikut terdengar sampai cukup redam (tidak dipotong terlalu cepat): ekor 0,3 s setelah input berhenti masih ada
  const n2 = mk(2.0); run(n2, burst, burst); const [t] = run(n2, new Float32Array(SR), new Float32Array(SR));
  check('ekor tidak terpotong dini', energy(t, Math.floor(SR * 0.3), Math.floor(SR * 0.6)) > 1e-4, 'energi 0,3-0,6 s ' + energy(t, Math.floor(SR * 0.3), Math.floor(SR * 0.6)).toExponential(2));
}

// 6) reset ('r') mengosongkan ekor
{
  const node = mk(3), burst = new Float32Array(SR / 4).map(() => rnd() * 0.5);
  run(node, burst, burst); node.port.onmessage({ data: { t: 'r' } });
  const [l] = run(node, new Float32Array(SR), new Float32Array(SR));
  check('reset membuang ekor', energy(l) === 0, 'energi ' + energy(l));
}

// 7) ganti RT60 saat jalan: tidak ada loncatan (klik) dan tetap berhingga
{
  const node = mk(0.5), N = 128 * 1035, x = new Float32Array(N).map(() => rnd() * 0.3), oL = new Float32Array(N);
  for (let i = 0; i < N; i += 128) {
    if (i === SR) node.port.onmessage({ data: { t: 'p', rt: 5 } }); if (i === SR * 2) node.port.onmessage({ data: { t: 'p', rt: 0.4 } });
    const o = [new Float32Array(128), new Float32Array(128)]; node.process([[x.slice(i, i + 128), x.slice(i, i + 128)]], [o]); oL.set(o[0], i);
  }
  let mx = 0; for (let i = 1; i < N; i++) mx = Math.max(mx, Math.abs(oL[i] - oL[i - 1]));
  check('ganti RT60 mulus', isFinite(mx) && mx < 3, 'loncatan sampel terbesar ' + mx.toFixed(2));
}

// 8) kecepatan: berapa kali realtime (satu instance, derau terus-menerus), konstan untuk RT60 pendek dan panjang
for (const rt of [0.4, 5]) {
  const node = mk(rt), a = new Float32Array(128).map(() => rnd() * 0.3), o = [new Float32Array(128), new Float32Array(128)], blocks = Math.floor(SR * 20 / 128);
  for (let i = 0; i < 200; i++) node.process([[a, a]], [o]);   // pemanasan JIT
  const t0 = performance.now(); for (let i = 0; i < blocks; i++) node.process([[a, a]], [o]); const ms = performance.now() - t0;
  console.log('kecepatan rt=' + rt + ':', (20000 / ms).toFixed(0) + 'x realtime per Reverb');
}
{ // idle: biaya blok senyap
  const node = mk(2), z = new Float32Array(128), o = [new Float32Array(128), new Float32Array(128)];
  node.process([[z, z]], [o]); node.clear();
  const t0 = performance.now(); for (let i = 0; i < 200000; i++) node.process([[z, z]], [o]); const ms = performance.now() - t0;
  console.log('kecepatan idle:', (200000 * 128 / SR * 1000 / ms).toFixed(0) + 'x realtime (senyap)');
}

console.log(fails ? '\n' + fails + ' tes GAGAL' : '\nSemua tes lolos');
process.exit(fails ? 1 : 0);
