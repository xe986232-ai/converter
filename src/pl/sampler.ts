// Mesin Sampler: TANPA Signalsmith dan TANPA render offline. Sample dimainkan langsung lewat AudioBufferSourceNode:
// pitch = kecepatan baca (playbackRate x detune), seperti sampler FL (durasi ikut berubah). Semua knob / slider REALTIME:
// tiap perubahan Pitch / Volume langsung dikirim ke suara yang sedang berbunyi (juga note yang sudah dijadwalkan), tanpa menunggu knob dilepas.
// Attack = fade-in awal note, Release = ekor setelah note berakhir / tuts dilepas (dibaca saat itu juga, jadi ikut berubah live).
// vsynth tetap memakai mesinnya sendiri (vsynth.ts + pitch.ts), tidak disentuh.

export interface SmpSource { devId: number; buf: AudioBuffer; params: Record<string, number>; }   // params = objek parameter device yang SAMA (hidup), bukan salinan
export interface SmpVoice { stop(at?: number): void; start: number; }
export interface SmpSeg { off: number; midi: number; dur: number; }   // note slide: pada off detik sejak awal note, pitch meluncur ke nada midi selama dur detik

const ROOT = 60;          // C4 = nada asli sample
const VEL_FULL = 0.5;     // velocity >= 0,5 = level penuh
const REL = 0.008;        // fade-out minimal di akhir note (tidak memotong gelombang mendadak)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface Live { s: AudioBufferSourceNode; vol: GainNode; src: SmpSource; velScale: number; }

export function createSampler() {
  const live = new Map<number, Set<Live>>();
  const pitchRate = (p: Record<string, number>): number => Math.pow(2, Math.round(p.pitch ?? 0) / 12);
  const peakOf = (p: Record<string, number>, velScale: number): number => Math.max(0, (p.volume ?? 100) / 100) * velScale;
  const relOf = (p: Record<string, number>): number => Math.max(REL, (p.release ?? 0) / 1000);
  const atkOf = (p: Record<string, number>): number => { const a = p.attack ?? 0; return a > 1.5 ? a / 1000 : 0; };

  /** Dipanggil tiap knob / slider bergerak: Pitch dan Volume langsung berlaku di semua suara device ini. */
  function refresh(devId: number): void {
    const set = live.get(devId);
    if (!set) return;
    for (const v of set) {
      const now = (v.vol.context as BaseAudioContext).currentTime;
      v.s.playbackRate.setTargetAtTime(pitchRate(v.src.params), now, 0.008);
      v.vol.gain.setTargetAtTime(peakOf(v.src.params, v.velScale), now, 0.008);
    }
  }

  function play(src: SmpSource, midi: number, vel: number, when: number | null, dur: number | undefined, dest: AudioNode, segsIn?: SmpSeg[]): SmpVoice {
    const ctx = dest.context as AudioContext;
    const t0 = when == null ? ctx.currentTime : Math.max(when, 0);
    const P = src.params;
    const velScale = clamp(vel / VEL_FULL, 0.05, 1);
    const atk = atkOf(P), rel = relOf(P);
    const et = dur == null ? undefined : t0 + dur;

    const s = ctx.createBufferSource(), env = ctx.createGain(), vol = ctx.createGain();
    s.buffer = src.buf;
    s.playbackRate.value = pitchRate(P);         // Pitch knob (live lewat refresh)
    s.detune.setValueAtTime((midi - ROOT) * 100, t0);   // nada tuts
    vol.gain.value = peakOf(P, velScale);        // Volume slider (live lewat refresh)

    // envelope: Attack (fade-in) lalu Release / fade-out pendek di akhir note
    if (atk > 0.0015) {
      const A = et == null ? atk : Math.min(atk, Math.max(0.002, et - t0 - (rel > REL ? 0 : REL)));
      env.gain.setValueAtTime(0, t0); env.gain.linearRampToValueAtTime(1, t0 + A);
    } else env.gain.setValueAtTime(1, t0);

    // note slide: sample yang sama terus berjalan, pitch meluncur linear (dalam cent)
    const segs = (segsIn ?? []).filter(g => g.off > 1e-6).sort((a, b) => a.off - b.off);
    let mPrev = midi;
    segs.forEach((g, k) => {
      const tGs = t0 + g.off;
      let D = Math.max(0.005, g.dur);
      if (k + 1 < segs.length) D = Math.min(D, Math.max(0.005, segs[k + 1].off - g.off));
      if (dur != null) D = Math.min(D, Math.max(0.005, dur - g.off));
      s.detune.setValueAtTime((mPrev - ROOT) * 100, tGs);
      s.detune.linearRampToValueAtTime((g.midi - ROOT) * 100, tGs + D);
      mPrev = g.midi;
    });

    if (et != null) {
      if (rel > REL) { env.gain.setValueAtTime(1, et); env.gain.linearRampToValueAtTime(0, et + rel); }
      else { const r = Math.min(REL, Math.max(0.001, et - t0)); env.gain.setValueAtTime(1, et - r); env.gain.linearRampToValueAtTime(0, et); }
    }

    s.connect(env); env.connect(vol); vol.connect(dest);
    s.start(t0);
    const endAt = et == null ? undefined : et + (rel > REL ? rel : 0) + 0.005;
    if (endAt != null) { try { s.stop(endAt); } catch { /* sudah berhenti */ } }

    const item: Live = { s, vol, src, velScale };
    let set = live.get(src.devId);
    if (!set) { set = new Set(); live.set(src.devId, set); }
    set.add(item);
    s.onended = () => {
      set!.delete(item); if (!set!.size && live.get(src.devId) === set) live.delete(src.devId);
      try { s.disconnect(); env.disconnect(); vol.disconnect(); } catch { /* abaikan */ }
    };

    let stopped = false;
    return {
      start: t0,
      stop(at?: number): void {
        if (stopped) return;
        stopped = true;
        const t = at == null ? ctx.currentTime : at;
        const g = env.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
        if (t <= t0) {   // belum mulai: tidak berbunyi sama sekali
          g.cancelScheduledValues(t); g.setValueAtTime(0, t);
          try { s.stop(t0); } catch { /* sudah berhenti */ }
          return;
        }
        const r = relOf(P);   // Release dibaca saat tuts dilepas: knob Release yang digeser langsung terasa
        if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else g.cancelScheduledValues(t);
        g.setTargetAtTime(0, t, r / 3);
        try { s.stop(t + r * 3 + 0.01); } catch { /* sudah berhenti */ }
      }
    };
  }

  return { play, refresh };
}
export type SamplerHandle = ReturnType<typeof createSampler>;
