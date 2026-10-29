// Renderer offline DERIZ ("bake"): menjalankan KODE WORKLET YANG SAMA (WORKLET_SRC) blok demi blok di luar thread audio, hasilnya audio jadi.
// Saat Play, pattern DERIZ cukup memutar audio jadi itu (AudioBufferSourceNode), bukan menghitung WSOLA + sinc per nada di thread audio.
// Modul ini murni (tanpa DOM / Web Audio), jadi bisa jalan di Web Worker dan dites di Node: tools/deriz-bake-test.ts.
//
// Beda dengan realtime (semuanya menguntungkan kualitas): governor beban MATI dan jatah frame WSOLA penuh tidak dibatasi, karena tidak ada tenggat blok.
// Isi nada, urutan event, dan algoritma identik dengan worklet (buildSchedEvents dipakai bersama).

import { WORKLET_SRC, buildSchedEvents, type DerizNote, type PreparedSample } from './deriz-synth';

export interface BakeJob {
  notes: DerizNote[];   // waktu `at` RELATIF terhadap awal pattern (detik), id unik per nada
  length: number;       // panjang pattern (detik); nada sudah dipotong di akhir pattern
  sampleRate: number;   // sama dengan AudioContext.sampleRate
}
export interface BakeResult { l: Float32Array; r: Float32Array; frames: number; blocks: number; }

const BLK = 128, SILENCE = 1e-5, TAIL_MAX = 1.0;   // TAIL_MAX: ekor maksimum setelah akhir pattern (detik)

// Scope baru per job: variabel global worklet (governor, kolam buffer, jam blok) mulai bersih, hasil tidak bergantung job sebelumnya.
function makeScope(sr: number): { make: () => any; setTime: (t: number) => void } {
  const src = WORKLET_SRC.replace('let FULL_FRAMES = 4;', 'let FULL_FRAMES = 1e9;');   // offline: jatah frame penuh tak terbatas
  const body = 'let currentTime = 0; const sampleRate = ' + sr + '; let __C = null;\n'
    + 'class AudioWorkletProcessor { constructor() { this.port = { postMessage() {}, onmessage: null }; } }\n'
    + 'function registerProcessor(n, c) { __C = c; }\n'
    + src + '\nreturn { make: () => new __C(), setTime: (t) => { currentTime = t; } };';
  return new Function(body)();
}

export function bakeDeriz(sample: PreparedSample, job: BakeJob): BakeResult {
  const sr = job.sampleRate, scope = makeScope(sr), node = scope.make();
  const send = (m: unknown): void => node.port.onmessage({ data: m });
  send({ t: 'gov', on: false });
  send({ t: 'buf', ch: sample.ch, mono: sample.mono, ons: sample.ons, rate: sample.rate, sid: sample.sid });
  send({ t: 'sched', ev: buildSchedEvents(job.notes) });

  let lastEnd = job.length;
  for (const n of job.notes) lastEnd = Math.max(lastEnd, n.at + n.dur);
  const capBlocks = Math.ceil((lastEnd + TAIL_MAX) * sr / BLK) + 1;
  const L = new Float32Array(capBlocks * BLK), R = new Float32Array(capBlocks * BLK);
  const oL = new Float32Array(BLK), oR = new Float32Array(BLK), outs = [[oL, oR]];
  let k = 0, done = 0;
  while (k < capBlocks) {
    // senyap dan nada berikutnya masih jauh: lompat langsung ke blok sebelum nada itu (hasil sama, hemat waktu)
    if (!node.voices.length && node.si < node.sq.length && !node.pend.length) {
      const kt = Math.ceil(node.sq[node.si].at * sr / BLK - 1);
      if (kt > k) k = Math.min(kt, capBlocks - 1);
    }
    scope.setTime(k * BLK / sr);
    oL.fill(0); oR.fill(0);
    node.process([], outs);
    L.set(oL, k * BLK); R.set(oR, k * BLK);
    done++; k++;
    if (!node.voices.length && node.si >= node.sq.length && !node.pend.length) break;   // semua event sudah jalan dan semua suara habis
  }
  // potong senyap di ujung
  let end = Math.min(L.length, k * BLK);
  while (end > 0 && Math.abs(L[end - 1]) < SILENCE && Math.abs(R[end - 1]) < SILENCE) end--;
  end = Math.min(L.length, Math.max(end, 1));
  return { l: L.slice(0, end), r: R.slice(0, end), frames: end, blocks: done };
}
