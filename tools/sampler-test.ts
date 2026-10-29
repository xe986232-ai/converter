// Tes mesin SAMPLER (sampler-engine.ts): render offline lalu ukur hasilnya.
// Jalankan: npm i --no-save node-web-audio-api && node --experimental-transform-types tools/sampler-test.ts
// Cek: pitch tepat (nada tuts + knob Pitch + Pitch Project), TANPA time stretching (nada naik 1 oktaf = durasi setengah),
//      Attack naik sesuai waktunya, Release hilang sesuai waktunya, Volume, velocity, glide, one-shot, polifoni tidak pecah, track tanpa audio senyap.
import { setSampler, startSamplerVoice, releaseSamplerVoice, playSamplerNote, isSamplerTrack, samplerPitchSemis, samplerAttackSec, samplerReleaseSec, configureSampler } from '../src/sampler-engine.ts';

let masterPitch = 0;   // Pitch Project (di aplikasi: master-pitch.ts)
const setMasterPitch = (n: number): void => { masterPitch = n; };
configureSampler({ trackInput: (_c, d) => d, velGain: v => v ?? 1, getMasterPitch: () => masterPitch, onMasterPitch: () => { /* tes tidak memutar knob saat nada bunyi */ } });

let wa: typeof import('node-web-audio-api');
try { wa = await import('node-web-audio-api'); } catch { console.log('SKIP node-web-audio-api belum terpasang: npm i --no-save node-web-audio-api'); process.exit(0); }

let fail = 0;
const check = (name: string, ok: boolean, info = ''): void => { if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); };
const SR = 44100, T = 't1';
const P = (o: Partial<{ on: boolean; pitch: number; attack: number; release: number; volume: number }> = {}) => ({ on: true, pitch: 0.5, attack: 0, release: 0.35, volume: 0.8, ...o });

// sample uji: sinus 440 Hz (A4) 1 detik, amplitudo 0.5 (stereo)
function sineBuf(c: BaseAudioContext, hz = 440, sec = 1, amp = 0.5): AudioBuffer {
  const b = c.createBuffer(2, Math.round(SR * sec), SR);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin(2 * Math.PI * hz * i / SR); }
  return b;
}
// frekuensi dari lintasan nol positif (akurat untuk sinus murni) pada jendela [a, b) detik
function freqOf(x: Float32Array, a: number, b: number): number {
  const i0 = Math.floor(a * SR), i1 = Math.floor(b * SR); let first = -1, last = -1, n = 0;
  for (let i = i0 + 1; i < i1; i++) if (x[i - 1] < 0 && x[i] >= 0) { const f = i - 1 + (-x[i - 1]) / (x[i] - x[i - 1]); if (first < 0) first = f; last = f; n++; }
  return n < 2 ? 0 : (n - 1) * SR / (last - first);
}
const peakIn = (x: Float32Array, a: number, b: number): number => { let m = 0; for (let i = Math.floor(a * SR); i < Math.min(x.length, Math.floor(b * SR)); i++) m = Math.max(m, Math.abs(x[i])); return m; };
const lastLoud = (x: Float32Array, th: number): number => { let l = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > th) l = i; return l / SR; };

// render: setup(ctx, dest) menjadwalkan nada; dest = master. trackInput() membuat jalur track dari ctx + dest.
async function render(secs: number, params: ReturnType<typeof P>, setup: (c: AudioContext, dest: AudioNode) => void, buf?: (c: BaseAudioContext) => AudioBuffer | null, track = T): Promise<Float32Array> {
  const c = new wa.OfflineAudioContext(2, Math.ceil(SR * secs), SR) as unknown as AudioContext;
  const b = buf ? buf(c) : sineBuf(c);
  setSampler(track, params, b);
  setup(c, c.destination);
  const out = await (c as unknown as OfflineAudioContext).startRendering();
  setSampler(track, null);
  return out.getChannelData(0).slice();
}

// --- konversi knob ---
check('Pitch knob: tengah 0, kiri -12, kanan +12', samplerPitchSemis(0.5) === 0 && samplerPitchSemis(0) === -12 && samplerPitchSemis(1) === 12);
check('Attack knob: 0 = 2 ms, 1 = 2 s, naik monoton', Math.abs(samplerAttackSec(0) - 0.002) < 1e-9 && Math.abs(samplerAttackSec(1) - 2) < 1e-9 && samplerAttackSec(0.4) < samplerAttackSec(0.6));
check('Release knob: 0 = 10 ms, 1 = 3 s', Math.abs(samplerReleaseSec(0) - 0.01) < 1e-9 && Math.abs(samplerReleaseSec(1) - 3) < 1e-6);

// --- pitch ---
let x = await render(1.5, P(), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.8));
let f = freqOf(x, 0.2, 0.8);
check('C4 memutar sample dengan nada aslinya (440 Hz)', Math.abs(f - 440) < 1.5, f.toFixed(2) + ' Hz');
x = await render(1.5, P(), (c, d) => playSamplerNote(c, d, T, 72, 0.1, 0.4));
f = freqOf(x, 0.15, 0.45);
check('C5 (+12 tuts) = 880 Hz', Math.abs(f - 880) < 3, f.toFixed(2) + ' Hz');
x = await render(1.5, P(), (c, d) => playSamplerNote(c, d, T, 48, 0.1, 0.8));
f = freqOf(x, 0.2, 0.8);
check('C3 (-12 tuts) = 220 Hz', Math.abs(f - 220) < 1, f.toFixed(2) + ' Hz');
x = await render(1.5, P({ pitch: 1 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.4));
f = freqOf(x, 0.15, 0.45);
check('knob Pitch +12 st = 880 Hz', Math.abs(f - 880) < 3, f.toFixed(2) + ' Hz');
x = await render(1.5, P({ pitch: 0 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.8));
f = freqOf(x, 0.2, 0.8);
check('knob Pitch -12 st = 220 Hz', Math.abs(f - 220) < 1, f.toFixed(2) + ' Hz');
setMasterPitch(7);
x = await render(1.5, P(), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.5));
f = freqOf(x, 0.15, 0.55);
setMasterPitch(0);
check('Pitch Project +7 st ikut (659.3 Hz)', Math.abs(f - 440 * Math.pow(2, 7 / 12)) < 2.5, f.toFixed(2) + ' Hz');

// --- TANPA time stretching: nada naik = lebih cepat habis, nada turun = lebih lama ---
x = await render(3, P({ release: 0 }), (c, d) => playSamplerNote(c, d, T, 72, 0.1, 5));   // sample 1 s diputar 2x lebih cepat
let end = lastLoud(x, 0.01);
check('+12 st: sample 1 s habis sendiri sekitar 0.5 s (bukan 1 s: tanpa time stretching)', Math.abs(end - 0.6) < 0.06, 'berakhir di ' + end.toFixed(3) + ' s');
x = await render(3, P({ release: 0 }), (c, d) => playSamplerNote(c, d, T, 48, 0.1, 5));   // 2x lebih lambat
end = lastLoud(x, 0.01);
check('-12 st: sample 1 s menjadi sekitar 2 s', Math.abs(end - 2.1) < 0.08, 'berakhir di ' + end.toFixed(3) + ' s');
x = await render(2, P({ release: 0 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 5));
end = lastLoud(x, 0.01);
check('C4: durasi tetap 1 s (one-shot, tidak di-loop)', Math.abs(end - 1.1) < 0.05, 'berakhir di ' + end.toFixed(3) + ' s');

// --- Attack ---
x = await render(2, P({ attack: 0.85 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 1.5));   // attack ~0.87 s: hampir selama nada
const atk = samplerAttackSec(0.85);
const p0 = peakIn(x, 0.1, 0.1 + atk * 0.1), p5 = peakIn(x, 0.1 + atk * 0.45, 0.1 + atk * 0.55), p1 = peakIn(x, 0.1 + atk + 0.02, 0.1 + atk + 0.1);
const FULL = 0.5 * 0.9;   // amplitudo sample x penguatan Volume 80%
check('Attack: awal nada hampir senyap', p0 < 0.12 * FULL + 0.01, `peak awal ${p0.toFixed(3)}`);
check('Attack: setengah jalan sekitar setengah level', Math.abs(p5 / FULL - 0.5) < 0.12, `${(p5 / FULL).toFixed(2)}x`);
check('Attack: setelah selesai level penuh', Math.abs(p1 / FULL - 1) < 0.06, `${(p1 / FULL).toFixed(2)}x`);
x = await render(1, P({ attack: 0 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.5));
check('Attack minimum (2 ms): serangan cepat tapi tidak klik', peakIn(x, 0.1, 0.103) > 0.15 && peakIn(x, 0.102, 0.2) <= 0.5 * 0.9 * 1.001 + 1e-6);

// --- Release ---
const rl = samplerReleaseSec(0.7);
x = await render(5, P({ release: 0.7 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.5));   // sample 1 s, nada dilepas di 0.6 s
const inNote = peakIn(x, 0.4, 0.55), midRel = peakIn(x, 0.6 + rl * 0.5, 0.6 + rl * 0.5 + 0.02);
end = lastLoud(x, 0.005);
check('Release: level turun bertahap setelah dilepas', midRel < inNote * 0.4 && midRel > inNote * 0.01, `${inNote.toFixed(3)} -> ${midRel.toFixed(3)}`);
check('Release: hilang dalam waktu Release (sekitar ' + rl.toFixed(2) + ' s)', end > 0.6 + rl * 0.4 && end < 0.6 + rl * 1.7, 'berakhir di ' + end.toFixed(3) + ' s');
x = await render(3, P({ release: 0 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.3));
end = lastLoud(x, 0.005);
check('Release minimum (10 ms): nada berhenti nyaris tepat saat dilepas', end < 0.4 + 0.05, 'berakhir di ' + end.toFixed(3) + ' s');
// lepas sebelum Attack selesai: tidak melompat ke level penuh
x = await render(3, P({ attack: 0.85, release: 0.5 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.3));
check('lepas sebelum Attack selesai: tidak ada lonjakan', peakIn(x, 0.4, 3) < 0.5 * 0.9 * 0.5, 'puncak setelah lepas ' + peakIn(x, 0.4, 3).toFixed(3));

// --- Volume + velocity ---
const xv = await render(1.5, P({ volume: 0.4 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.8));
const xf = await render(1.5, P({ volume: 0.8 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.8));
check('Volume 80% = penguatan 0.9 (sama seperti DERIZ)', Math.abs(peakIn(xf, 0.2, 0.8) - 0.45) < 0.01, peakIn(xf, 0.2, 0.8).toFixed(3));
check('Volume 40% = setengah dari 80%', Math.abs(peakIn(xv, 0.2, 0.8) / peakIn(xf, 0.2, 0.8) - 0.5) < 0.02);
const xvel = await render(1.5, P(), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.8, undefined, 0.5));
check('velocity 0.5 mengecilkan nada (lebih pelan dari velocity penuh)', peakIn(xvel, 0.2, 0.8) < peakIn(xf, 0.2, 0.8) * 0.9);

// --- on / off ---
x = await render(1, P({ on: false }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.5));
check('plugin mati = senyap', peakIn(x, 0, 1) === 0);
x = await render(1, P(), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.5), () => null);
check('belum ada audio = senyap, tidak error', peakIn(x, 0, 1) === 0);

// --- glide (slide piano roll): meluncur 60 -> 72 ---
x = await render(2, P({ release: 0 }), (c, d) => playSamplerNote(c, d, T, 60, 0.1, 0.9, [{ when: 0.5, from: 60, to: 72, dur: 0.2 }]));
const f1 = freqOf(x, 0.15, 0.45), f2 = freqOf(x, 0.8, 0.95);   // sample 1 s: setelah naik, sample habis lebih cepat -> ukur sebelum habis
check('glide: nada mulai 440 Hz lalu naik ke 880 Hz', Math.abs(f1 - 440) < 3 && Math.abs(f2 - 880) < 8, `${f1.toFixed(1)} -> ${f2.toFixed(1)} Hz`);

// --- polifoni: akor 12 nada tidak NaN dan tidak lebih dari batas ---
x = await render(2, P(), (c, d) => { for (let i = 0; i < 40; i++) playSamplerNote(c, d, T, 48 + (i % 24), 0.1 + i * 0.01, 0.6); });
let bad = 0; for (const v of x) if (!Number.isFinite(v)) bad++;
check('banyak nada sekaligus (40): tidak ada NaN', bad === 0);

// --- track ---
setSampler('tz', P(), null);
check('isSamplerTrack true setelah setSampler', isSamplerTrack('tz'));
setSampler('tz', null);
check('isSamplerTrack false setelah dibuang', !isSamplerTrack('tz'));

// --- lepas manual (keyboard bawah): startSamplerVoice + releaseSamplerVoice ---
x = await render(3, P({ release: 0.5 }), (c, d) => { const v = startSamplerVoice(c, d, T, 60, 0.1); releaseSamplerVoice(v, 0.5); });
end = lastLoud(x, 0.005);
check('keyboard: tahan lalu lepas = ikut Release', end > 0.5 && end < 0.5 + samplerReleaseSec(0.5) * 1.8, 'berakhir di ' + end.toFixed(3) + ' s');

console.log(fail ? `\n${fail} GAGAL` : '\nsemua lolos');
process.exit(fail ? 1 : 0);
