// SAMPLER: plugin sampler sederhana yang BERDIRI SENDIRI (tidak memakai worklet / algoritma DERIZ, tidak ada time stretching).
// Audio yang di-upload dimainkan apa adanya: mengganti nada = mengganti kecepatan putar (seperti sampler klasik), jadi nada naik = lebih cepat,
// nada turun = lebih lambat. C4 (MIDI 60) memutar sample dengan nada aslinya.
//
// Jalur suara per nada:  AudioBufferSourceNode (detune = nada) -> GainNode envelope (Attack / Release) -> trim track (Volume) -> jalur track.
//   - Pitch    : knob -12..+12 semitone (bulat), ditambah Pitch Project (card transport). Dipakai lewat AudioParam `detune`, jadi mulus saat knob diputar.
//   - Attack   : waktu naik dari senyap ke penuh (2 ms - 2 s, skala logaritmik).
//   - Release  : waktu hilang setelah nada dilepas (10 ms - 3 s, skala logaritmik). Sample yang lebih pendek dari nadanya berhenti sendiri (one-shot).
//   - Volume   : level akhir semua nada plugin (bawaan 80% = penguatan 0.9, sama seperti DERIZ).
// Modul ini TIDAK mengimpor berkas DERIZ (atau berkas lain): hanya Web Audio.
// Sengaja TANPA import (bisa dites di Node): jalur track, velocity, dan Pitch Project dipasang sekali lewat configureSampler() (dipanggil synth-engine.ts).
export interface SamplerDeps {
  trackInput(ctx: AudioContext, dest: AudioNode, track: string): AudioNode;   // titik masuk jalur track (fader -> efek -> out)
  velGain(vel?: number): number;                                               // velocity nada -> penguatan 0..1
  getMasterPitch(): number;                                                    // Pitch Project (semitone)
  onMasterPitch(cb: () => void): void;                                         // dipanggil saat Pitch Project berubah
}
let D: SamplerDeps = { trackInput: (_c, d) => d, velGain: v => v ?? 1, getMasterPitch: () => 0, onMasterPitch: () => { /* tidak ada */ } };
export function configureSampler(d: SamplerDeps): void { D = d; d.onMasterPitch(() => { for (const v of live) if (!v.glided) v.src.detune.setTargetAtTime(voiceCents(v), v.ctx.currentTime, 0.02); }); }   // Pitch Project diputar: nada yang sedang bunyi ikut bergeser mulus

export interface SamplerParams { on: boolean; pitch: number; attack: number; release: number; volume: number; }   // semua 0..1 seperti knob di panel efek

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const expMap = (v: number, min: number, max: number): number => min * Math.pow(max / min, clamp01(v));

export const KROOT = 60;                                                                         // C4 = nada asli sample
export const samplerPitchSemis = (v: number | undefined): number => Math.round(((v ?? 0.5) - 0.5) * 24);   // knob Pitch: tengah = 0, kiri -12, kanan +12 (bulat)
export const samplerAttackSec = (v: number | undefined): number => expMap(v ?? 0, 0.002, 2);
export const samplerReleaseSec = (v: number | undefined): number => expMap(v ?? 0.35, 0.01, 3);
export const samplerGain = (v: number | undefined): number => (v ?? 0.8) * 1.125;               // 80% = 0.9, 100% = 1.125

interface Slot { params: SamplerParams; buf: AudioBuffer | null; ctx: AudioContext | null; trim: GainNode | null; }
const slots = new Map<string, Slot>();

export const isSamplerTrack = (track: string): boolean => slots.has(track);

// null = track ini bukan track SAMPLER (nada yang sedang bunyi dimatikan). buf: undefined = buffer tidak diubah, null = kosongkan.
export function setSampler(track: string, p: SamplerParams | null, buf?: AudioBuffer | null): void {
  if (!p) {
    for (const v of live) if (v.track === track) kill(v, v.ctx.currentTime);
    const s = slots.get(track); if (s?.trim) { try { s.trim.disconnect(); } catch { /* sudah lepas */ } }
    slots.delete(track);
    return;
  }
  let s = slots.get(track);
  if (!s) slots.set(track, s = { params: p, buf: null, ctx: null, trim: null });
  const wasOn = s.params.on;
  s.params = { ...p };
  if (buf !== undefined) s.buf = buf;
  const now = s.ctx?.currentTime ?? 0;
  if (s.trim && s.ctx) s.trim.gain.setTargetAtTime(samplerGain(p.volume), now, 0.015);   // Volume: berlaku langsung ke semua nada yang sedang bunyi
  for (const v of live) {
    if (v.track !== track) continue;
    if (!p.on && wasOn) { kill(v, v.ctx.currentTime); continue; }
    if (!v.glided) v.src.detune.setTargetAtTime(voiceCents(v), v.ctx.currentTime, 0.02);   // Pitch: ikut berubah mulus
  }
}
export const samplerBuffer = (track: string): AudioBuffer | null => slots.get(track)?.buf ?? null;
export const hasSamplerAudio = (track: string): boolean => !!slots.get(track)?.buf;

export interface SamplerVoice {
  smp: true; track: string; ctx: AudioContext; src: AudioBufferSourceNode; env: GainNode;
  t0: number; a: number; peak: number; r: number; semis: number; released: boolean; glided: boolean; stopped: boolean;
}
const live = new Set<SamplerVoice>();
const MAX_VOICES = 32;

// total semitone sebuah nada: tuts (relatif C4) + knob Pitch + Pitch Project
const totalSemis = (track: string, midi: number): number => (midi - KROOT) + samplerPitchSemis(slots.get(track)?.params.pitch) + D.getMasterPitch();
const voiceCents = (v: SamplerVoice): number => (v.semis + samplerPitchSemis(slots.get(v.track)?.params.pitch) + D.getMasterPitch()) * 100;

function trimOf(s: Slot, ctx: AudioContext, dest: AudioNode, track: string): GainNode {
  if (!s.trim || s.ctx !== ctx) {
    try { s.trim?.disconnect(); } catch { /* sudah lepas */ }
    const g = ctx.createGain(); g.gain.value = samplerGain(s.params.volume);
    g.connect(D.trackInput(ctx, dest, track));
    s.trim = g; s.ctx = ctx;
  }
  return s.trim;
}

// Mulai satu nada pada waktu `when` (waktu AudioContext). Dilepas lewat releaseSamplerVoice.
export function startSamplerVoice(ctx: AudioContext, dest: AudioNode, track: string, midi: number, when: number, vel?: number): SamplerVoice | null {
  const s = slots.get(track);
  if (!s || !s.params.on || !s.buf) return null;
  while (live.size >= MAX_VOICES) {   // terlalu banyak nada sekaligus: curi yang sudah dilepas / paling tua
    let victim: SamplerVoice | null = null;
    for (const x of live) if (!victim || (x.released && !victim.released) || (x.released === victim.released && x.t0 < victim.t0)) victim = x;
    if (!victim) break;
    kill(victim, ctx.currentTime); live.delete(victim);
  }
  const t0 = Math.max(when, ctx.currentTime);
  const src = ctx.createBufferSource(); src.buffer = s.buf;
  const semis = midi - KROOT;
  src.detune.value = totalSemis(track, midi) * 100;
  const env = ctx.createGain(), a = samplerAttackSec(s.params.attack), peak = D.velGain(vel), r = samplerReleaseSec(s.params.release);
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + a);
  src.connect(env); env.connect(trimOf(s, ctx, dest, track));
  src.start(t0);
  const v: SamplerVoice = { smp: true, track, ctx, src, env, t0, a, peak, r, semis, released: false, glided: false, stopped: false };
  src.onended = () => { try { src.disconnect(); env.disconnect(); } catch { /* sudah lepas */ } live.delete(v); };
  live.add(v);
  return v;
}

// Lepas nada pada waktu `at`: level envelope saat itu dihitung dari rumus (nada bisa dilepas sebelum attack selesai), lalu menghilang selama Release.
export function releaseSamplerVoice(v: SamplerVoice | null, at: number): void {
  if (!v || v.released) return;
  v.released = true;
  const t = Math.max(at, v.t0), dt = t - v.t0, lvl = v.peak * (dt < v.a ? dt / v.a : 1);
  v.env.gain.cancelScheduledValues(t);
  v.env.gain.setValueAtTime(lvl, t);
  v.env.gain.setTargetAtTime(0, t, v.r / 5);   // e^-5 tercapai di v.r: hampir tepat selesai saat Release habis
  try { v.src.stop(t + v.r * 1.6 + 0.02); } catch { /* sudah berhenti */ }
}

export interface SamplerGlide { when: number; from: number; to: number; dur: number }   // meluncur dari MIDI `from` ke `to` mulai `when` selama `dur` detik

// Nada terjadwal dari piano roll: mulai di `when`, lepas setelah `dur` detik
export function playSamplerNote(ctx: AudioContext, dest: AudioNode, track: string, midi: number, when: number, dur: number, glides?: SamplerGlide[], vel?: number): void {
  const v = startSamplerVoice(ctx, dest, track, midi, when, vel);
  if (!v) return;
  if (glides && glides.length) {
    v.glided = true;
    const k = voiceCents(v) - v.semis * 100;   // geser knob Pitch + Pitch Project yang berlaku saat nada dimulai
    for (const g of glides) {
      const t = Math.max(g.when, v.t0), d = Math.max(0.01, g.dur);
      v.src.detune.setValueAtTime((g.from - KROOT) * 100 + k, t);
      v.src.detune.linearRampToValueAtTime((g.to - KROOT) * 100 + k, t + d);
    }
  }
  releaseSamplerVoice(v, when + Math.max(0.01, dur));
}

function kill(v: SamplerVoice, now: number): void {
  v.released = true;
  v.env.gain.cancelScheduledValues(now);
  v.env.gain.setTargetAtTime(0, now, 0.008);
  try { v.src.stop(now + 0.06); } catch { /* sudah berhenti */ }
}

export function stopAllSampler(ctx: AudioContext | null, track?: string): void {
  if (!ctx) return;
  for (const v of live) if (!track || v.track === track) kill(v, ctx.currentTime);
}
