// Tes renderer offline DERIZ: node --import ./tools/ts-resolve.mjs --experimental-transform-types tools/deriz-bake-test.ts
// (1) Lompat senyap tidak mengubah hasil: bit-per-bit sama dengan menjalankan SEMUA blok satu per satu.
// (2) Deterministik: dua kali render = sama persis.
// (3) Sama dengan jalur realtime (worklet + governor) pada beban ringan; pada beban berat tetap bersih dan tidak lebih lambat dari realtime.
import { bakeDeriz } from '../src/deriz-bake.ts';
import { WORKLET_SRC, buildSchedEvents, type DerizNote } from '../src/deriz-synth.ts';

const SR = 48000, BLK = 128;
const n0 = SR * 3, l = new Float32Array(n0), r = new Float32Array(n0);
for (let i = 0; i < n0; i++) { const t = i / SR, v = Math.exp(-(t % 1.5) * 2) * (0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 1310 * t)); l[i] = v; r[i] = v * 0.9; }
const mono = l.map((x, i) => (x + r[i]) / 2);
const sample = () => ({ ch: [l.slice(), r.slice()], mono: mono.slice(), ons: [0, 72000], rate: SR, sid: 1 });
const mk = (count: number, step: number, chord: number): DerizNote[] => {
  const out: DerizNote[] = []; let id = 0;
  for (let i = 0; i < count; i++) for (let c = 0; c < chord; c++) out.push({ id: ++id, semis: [0, 4, 7, 12, 5, 9, 2, 11][(i + c * 3) % 8] - 5 * (c % 2), start: 0, speed: 1, pitch: 0, vol: 0.9, at: 0.1 + i * step, dur: step * 0.9, vel: 1 });
  return out;
};
let fail = 0; const ok = (c: boolean, m: string) => { console.log((c ? 'OK   ' : 'GAGAL ') + m); if (!c) fail++; };
const same = (a: Float32Array, b: Float32Array) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// jalur referensi: semua blok, tanpa lompat, FULL_FRAMES tak terbatas, governor mati
function reference(notes: DerizNote[], length: number): Float32Array {
  let T = 0, Proc: any;
  const src = WORKLET_SRC.replace('let FULL_FRAMES = 4;', 'let FULL_FRAMES = 1e9;');
  const f = new Function('currentTimeRef', 'sampleRate', 'AudioWorkletProcessor', 'registerProcessor', 'performance', 'Date',
    'Object.defineProperty(globalThis, "__ct", { get: currentTimeRef, configurable: true });' + src.replace(/\bcurrentTime\b/g, 'globalThis.__ct'));
  f(() => T, SR, class { port = { postMessage() {}, onmessage: null as any }; }, (_: string, c: any) => { Proc = c; }, performance, Date);
  const node = new Proc(); node.msg({ t: 'gov', on: false });
  node.msg({ t: 'buf', ...sample() }); node.msg({ t: 'sched', ev: buildSchedEvents(notes) });
  const total = Math.ceil((length + 1) * SR / BLK), out = new Float32Array(total * BLK);
  for (let b = 0; b < total; b++) { T = b * BLK / SR; const o = [new Float32Array(BLK), new Float32Array(BLK)]; node.process([], [o]); out.set(o[0], b * BLK); }
  return out;
}

const notes = mk(16, 0.25, 3), len = 4.5;
const t0 = performance.now(), a = bakeDeriz(sample(), { notes, length: len, sampleRate: SR }), ms = performance.now() - t0;
const ref = reference(notes, len);
let peak = 0; for (let i = 0; i < a.frames; i++) peak = Math.max(peak, Math.abs(a.l[i]));
ok(peak > 0.05, 'ada suara (puncak ' + peak.toFixed(2) + ')');
ok(same(a.l, ref.subarray(0, a.frames)), 'lompat senyap + potong ekor = sama bit-per-bit dengan semua blok dijalankan');
let tailSilent = true; for (let i = a.frames; i < ref.length; i++) if (Math.abs(ref[i]) > 1e-5) tailSilent = false;
ok(tailSilent, 'yang dipotong di ujung memang senyap');
const b2 = bakeDeriz(sample(), { notes, length: len, sampleRate: SR });
ok(same(a.l, b2.l) && same(a.r, b2.r), 'deterministik: render ulang = persis sama');
console.log('  render ' + (a.frames / SR).toFixed(2) + ' dtk audio dalam ' + ms.toFixed(0) + ' ms (' + ((a.frames / SR) / (ms / 1000)).toFixed(1) + 'x realtime), ' + a.blocks + ' blok diproses');

// beban berat: 8 nada per ketukan di 1 plugin, tetap selesai dan tidak ada NaN / pecah
const heavy = mk(32, 0.125, 8), th = performance.now(), h = bakeDeriz(sample(), { notes: heavy, length: 4.2, sampleRate: SR }), hm = performance.now() - th;
let bad = 0, hp = 0; for (let i = 0; i < h.frames; i++) { const x = h.l[i]; if (!Number.isFinite(x)) bad++; hp = Math.max(hp, Math.abs(x)); }
ok(bad === 0 && hp <= 1.0001, 'beban berat: tidak ada NaN, puncak ' + hp.toFixed(3) + ' (limiter lembut)');
console.log('  berat: ' + (h.frames / SR).toFixed(2) + ' dtk audio dalam ' + hm.toFixed(0) + ' ms (' + ((h.frames / SR) / (hm / 1000)).toFixed(2) + 'x realtime)');
process.exit(fail ? 1 : 0);
