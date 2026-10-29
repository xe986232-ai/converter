// Instrumen vsynth bersama (keyboard preview, piano roll, dan playlist memakai instrumen yang sama).
// Sampel yang dijatuhkan di canvas audio dimainkan pada nada note, DURASI TETAP: tiap nada dirender offline oleh
// Signalsmith Stretch (lihat renderPitched di pitch.ts), di-cache, lalu diputar dengan kecepatan normal.
//
// Supaya terasa hampir realtime, waktu render disembunyikan:
//  - nada dirender begitu note ditambahkan / file dimuat (prepare), bukan saat Play;
//  - saat nada belum ada, suara dimulai begitu render selesai (render diprioritaskan), dan nada tetangga dirender di latar belakang;
//  - render hanya sepanjang yang dibutuhkan note (+ ekor), dibatasi 10 detik sumber.
// Satu render berjalan pada satu waktu (antrean), hasilnya dibuang kalau pengaturan berubah (pitch / speed / reverse / start / file).
import { renderPitched } from './pitch';
import { slideInfo } from './slide';

export interface VSource { devId: number; buf: AudioBuffer; start: number; serial: number; pitch: number; volume: number; speed: number; reverse: boolean; attack?: number; release?: number; }   // attack / release (ms, khusus Sampler) hanya membentuk volume saat diputar: tidak ikut render nada
export interface VVoice { stop(at?: number): void; start: number; }
export interface VSeg { off: number; midi: number; dur: number; }   // note slide: pada off detik sejak awal voice, sampel yang sama meluncur ke nada midi selama dur detik

const VEL_FULL = 0.5;               // velocity (0..1) ke atas = level penuh
const ROOT = 60;                    // C4 = nada asli sampel
const REL = 0.008;                  // fade-out pendek (detik) di akhir note: tetap tegas, tapi tidak memotong gelombang di tengah (penyebab bunyi "jet"/klik)
const TAIL = 0.01;                  // fade-out sangat pendek di ujung buffer hasil render (supaya potongan render tidak berbunyi klik)
const MAX_BYTES = 192 * 1024 * 1024; // batas memori cache (entri terlama dibuang lebih dulu)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

interface Cached { buf: AudioBuffer; covers: number; stamp: number; }   // covers = detik sumber yang tercakup render
interface Entry { sig: string; gen: number; bufs: Map<number, Cached>; }
// kemajuan render per device: total / selesai nada dalam satu gelombang render + kemajuan nada yang sedang jalan (0..1)
interface Prog { total: number; done: number; cur: number; }
interface Job { src: VSource; midi: number; needSrc: number; pr: Prog; }
interface Waiter { devId: number; midi: number; expire: number; fn: (b: AudioBuffer) => void; }

export function createVsynth(getCtx: () => BaseAudioContext) {
  const entries = new Map<number, Entry>();
  const queue: Job[] = [];
  const waiters: Waiter[] = [];
  const listeners = new Set<() => void>();
  const progListeners = new Set<() => void>();
  let running = false, stamp = 0;
  const emit = (): void => { for (const cb of listeners) cb(); };
  const prog = new Map<number, Prog>();
  const progOf = (devId: number): Prog => { let p = prog.get(devId); if (!p) { p = { total: 0, done: 0, cur: 0 }; prog.set(devId, p); } return p; };
  const finish = (devId: number, p: Prog): void => { p.done++; p.cur = 0; if (p.done >= p.total && prog.get(devId) === p) prog.delete(devId); };
  /** kemajuan render nada milik device (0..1; 0 = belum ada angka, mis. library dimuat), null kalau tidak sedang ada yang dirender */
  const progress = (devId: number): number | null => {
    const p = prog.get(devId);
    return p && p.total > 0 ? Math.min(1, (p.done + p.cur) / p.total) : null;
  };

  const sigOf = (s: VSource): string => `${s.serial}|${clamp(s.start, 0, 1).toFixed(4)}|${s.speed.toFixed(4)}|${s.reverse ? 1 : 0}|${s.pitch}`;
  const stretchOf = (s: VSource): number => 1 / clamp(s.speed, 0.25, 4);
  const availSrc = (s: VSource): number => (s.buf.length - Math.floor(clamp(s.start, 0, 0.999) * s.buf.length)) / s.buf.sampleRate;
  // detik sumber yang perlu dirender agar note sepanjang needOut detik (hasil) tercakup: dibatasi sisa file dan 10 detik / 12 detik hasil
  const needSrcOf = (s: VSource, needOut: number): number => {
    const st = stretchOf(s);
    return Math.max(0.05, Math.min(availSrc(s), 10, 12 / st, needOut / st + 0.25));
  };
  const semisOf = (s: VSource, midi: number): number => clamp(midi - ROOT + s.pitch, -48, 48);

  function entryOf(s: VSource): Entry {
    const sig = sigOf(s);
    let e = entries.get(s.devId);
    if (!e) { e = { sig, gen: 0, bufs: new Map() }; entries.set(s.devId, e); }
    else if (e.sig !== sig) {   // pengaturan berubah: semua render lama kedaluwarsa
      const had = e.bufs.size > 0;
      e.sig = sig; e.gen++; e.bufs.clear();
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].src.devId === s.devId) queue.splice(i, 1);
      prog.delete(s.devId);   // gelombang render baru: hitungan lama (termasuk render berjalan yang akan dibuang) tidak ikut
      if (had) emit();
    }
    return e;
  }

  // potongan sumber yang dirender: dari titik start. Reverse aktif: start dihitung pada waktu terbalik (0 = ujung file, sama seperti tampilan canvas yang dibalik)
  function makeSlice(s: VSource, needSrc: number): AudioBuffer {
    const b = s.buf, sr = b.sampleRate, i0 = Math.floor(clamp(s.start, 0, 0.999) * b.length);
    const len = Math.max(1, Math.min(b.length - i0, Math.floor(sr * needSrc)));
    const out = getCtx().createBuffer(Math.min(2, b.numberOfChannels), len, sr);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const d = b.getChannelData(c), o = out.getChannelData(c);
      if (s.reverse) for (let i = 0; i < len; i++) o[i] = d[b.length - 1 - (i0 + i)];
      else for (let i = 0; i < len; i++) o[i] = d[i0 + i];
    }
    return out;
  }

  // ujung buffer dihaluskan beberapa milidetik (slice dan hasil render adalah salinan, aman diubah)
  function fadeTail(b: AudioBuffer): void {
    const n = Math.min(b.length, Math.max(1, Math.floor(b.sampleRate * TAIL)));
    for (let c = 0; c < b.numberOfChannels; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[b.length - n + i] *= 1 - (i + 1) / n;
    }
  }

  function trim(): void {
    let total = 0;
    for (const e of entries.values()) for (const c of e.bufs.values()) total += c.buf.length * c.buf.numberOfChannels * 4;
    while (total > MAX_BYTES) {
      let oe: Entry | null = null, ok = -1, os = Infinity;
      for (const e of entries.values()) for (const [k, c] of e.bufs) if (c.stamp < os) { os = c.stamp; oe = e; ok = k; }
      if (!oe) break;
      const c = oe.bufs.get(ok)!; total -= c.buf.length * c.buf.numberOfChannels * 4; oe.bufs.delete(ok);
    }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const job = queue.shift()!, e = entries.get(job.src.devId), pr = job.pr, dev = job.src.devId;
        if (!e || e.sig !== sigOf(job.src)) { finish(dev, pr); continue; }   // sudah kedaluwarsa
        const gen = e.gen, slice = makeSlice(job.src, job.needSrc);
        const st = stretchOf(job.src), semis = semisOf(job.src, job.midi);
        // pitch & speed netral: pakai sampel asli apa adanya. Signalsmith (phase vocoder) melunakkan serangan awal bunyi.
        const out = Math.abs(st - 1) < 1e-6 && semis === 0 ? slice : await renderPitched(slice, getCtx(), st, semis, () => e.gen !== gen, f => { pr.cur = f; for (const cb of progListeners) cb(); });
        finish(dev, pr);
        for (const cb of progListeners) cb();
        if (e.gen !== gen || !out) continue;
        fadeTail(out);
        e.bufs.set(job.midi, { buf: out, covers: slice.length / slice.sampleRate, stamp: ++stamp });
        trim();
        const now = (getCtx() as AudioContext).currentTime;
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i];
          if (w.devId === job.src.devId && w.midi === job.midi) { waiters.splice(i, 1); w.fn(out); }
          else if (w.expire < now) waiters.splice(i, 1);
        }
        emit();
      }
    } finally { running = false; }
  }

  /** Minta nada midi dirender (needOut = detik hasil yang dibutuhkan). urgent = didahulukan dari antrean. */
  function request(src: VSource, midi: number, needOut = 6, urgent = false): void {
    const e = entryOf(src), need = needSrcOf(src, needOut), have = e.bufs.get(midi);
    if (have && have.covers >= need - 1e-3) return;
    const q = queue.find(j => j.src.devId === src.devId && j.midi === midi);
    if (q) {
      q.src = src; q.needSrc = Math.max(q.needSrc, need);
      if (urgent) { queue.splice(queue.indexOf(q), 1); queue.unshift(q); }
      return;
    }
    const pr = progOf(src.devId);
    pr.total++;
    const job: Job = { src, midi, needSrc: need, pr };
    if (urgent) queue.unshift(job); else queue.push(job);
    void pump();
  }

  function get(src: VSource, midi: number): AudioBuffer | null {
    const e = entries.get(src.devId);
    if (!e || e.sig !== sigOf(src)) return null;
    const c = e.bufs.get(midi);
    if (!c) return null;
    c.stamp = ++stamp;
    return c.buf;
  }

  /** Siapkan semua nada yang dipakai sebuah clip (dipanggil saat note / pengaturan / file berubah). Note slide ikut: nada tujuannya juga dirender. */
  function prepare(src: VSource, notes: { key: number; len: number; beat?: number; slide?: boolean }[], bpm: number): void {
    const need = new Map<number, number>();
    const add = (k: number, secs: number): void => { need.set(k, Math.max(need.get(k) ?? 0, secs)); };
    const info = slideInfo(notes.map(n => ({ key: n.key, beat: n.beat ?? 0, len: n.len, slide: n.slide })));
    notes.forEach((n, i) => {
      if (info[i].skip) return;
      const secs = info[i].len * 60 / Math.max(1, bpm);
      add(n.key, secs);
      for (const g of info[i].segs ?? []) add(g.key, secs + 1);   // sampel yang sama lanjut di nada baru: perlu cakupan sepanjang voice (+ sisa karena posisi sampel bisa lebih maju saat meluncur naik)
    });
    const tail = Math.max(0, (src.release ?? 0) / 1000);   // ekor Release: render harus mencakup note + ekornya
    for (const [key, secs] of [...need].sort((a, b) => Math.abs(a[0] - ROOT) - Math.abs(b[0] - ROOT))) request(src, key, secs + 0.1 + tail, false);
  }

  /** Mainkan satu note. when = waktu AudioContext (null = sekarang), dur = detik (kosong = sampai stop()).
   *  segs = note slide: SAMPEL YANG SAMA terus berjalan (tidak diputar ulang). Pada off detik pitch-nya meluncur linear (dalam semiton)
   *  ke nada baru selama dur detik, lalu diserahkan ke buffer nada tujuan (crossfade pendek) di posisi sampel yang sama. */
  function play(src: VSource, midi: number, vel: number, when: number | null, dur: number | undefined, dest: AudioNode, segsIn?: VSeg[]): VVoice {
    const ctx = dest.context as AudioContext;
    const t0 = when == null ? ctx.currentTime : when;
    // level sama seperti preview di panel browser (file diputar apa adanya): velocity tidak lagi mengecilkan suara.
    // vel >= VEL_FULL = level penuh (note baru default 0,7 sudah penuh); hanya note yang sengaja dibuat lembut yang turun.
    const peak = Math.max(0, src.volume / 100) * clamp(vel / VEL_FULL, 0.05, 1);
    const atk = Math.max(0, (src.attack ?? 0) / 1000), rel = Math.max(REL, (src.release ?? 0) / 1000);   // Sampler: Attack = fade-in awal note; Release > REL = ekor setelah note berakhir
    const segs: VSeg[] = (segsIn ?? []).filter(g => g.off > 1e-6).sort((a, b) => a.off - b.off);
    let stopped = false, started = false, base = t0;
    interface Piece { s: AudioBufferSourceNode; g: GainNode; at: number; }
    const pieces: Piece[] = [];   // pieces[i] = potongan voice ke-i: 0 = nada awal, i >= 1 = nada tujuan slide ke-i
    interface Plan { tGs: number; D: number; at: number; c: number; }
    const plan: Plan[] = [];      // plan[k] = serah-terima dari potongan k ke k+1 (waktu mulai luncuran, lama, saat potongan baru mulai, posisi sampelnya)
    const pieceMidi = (i: number): number => (i === 0 ? midi : segs[i - 1].midi);
    const endT = (): number | undefined => (dur == null ? undefined : base + dur);

    // rencana serah-terima: posisi sampel dilacak (potongan stabil = laju 1, luncuran = laju 2^(semiton/12) yang berubah linear dalam semiton)
    const buildPlan = (): void => {
      let atPrev = base, cPrev = 0, mPrev = midi;
      segs.forEach((g, k) => {
        const tGs = base + g.off;
        let D = Math.max(0.005, g.dur);
        if (k + 1 < segs.length) D = Math.min(D, Math.max(0.005, segs[k + 1].off - g.off));   // luncuran selesai sebelum slide berikutnya mulai
        if (dur != null) D = Math.min(D, Math.max(0.005, dur - g.off));
        const semis = g.midi - mPrev, r = Math.pow(2, semis / 12);
        const P = Math.abs(semis) < 1e-9 ? D : D * (r - 1) / Math.log(r);   // detik sampel yang terbaca selama luncuran
        const cEnd = cPrev + (tGs - atPrev) + P;
        const XF = Math.min(0.03, D * 0.5);                                  // crossfade pendek di ujung luncuran
        plan.push({ tGs, D, at: tGs + D - XF, c: cEnd - XF });
        atPrev = tGs + D - XF; cPrev = cEnd - XF; mPrev = g.midi;
      });
    };
    const startPiece = (i: number, buf: AudioBuffer, at: number, c: number): void => {
      const et = endT();
      if (et != null && et <= at + 1e-4) return;
      const s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = buf;   // sudah ber-pitch + ber-speed, diputar dengan kecepatan normal
      const XF = i === 0 ? 0 : Math.min(0.03, plan[i - 1].D * 0.5);
      if (XF > 0) { g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + XF); }   // serah-terima antar potongan slide: crossfade pendek
      else if (i === 0 && atk > 0.0015) {                                                            // Attack (Sampler): fade-in dari 0, tidak lebih panjang dari note
        const A = et == null ? atk : Math.min(atk, Math.max(0.002, et - at - (rel > REL ? 0 : REL)));
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(peak, at + A);
      } else g.gain.setValueAtTime(peak, at);                                                        // awal note: langsung penuh, tanpa fade-in
      s.connect(g); g.connect(dest);
      s.start(at, Math.min(Math.max(0, c), Math.max(0, buf.duration - 0.001)));
      if (et != null && rel > REL) {   // Release panjang (Sampler): note berakhir di et, suara memudar linear sampai et + rel
        g.gain.setValueAtTime(peak, et);   // (Attack sudah dipendekkan supaya selesai paling lambat di et)
        g.gain.linearRampToValueAtTime(0, et + rel);
        try { s.stop(et + rel + 0.005); } catch { /* sudah berhenti */ }
      } else if (et != null) {   // akhir note: fade-out sangat pendek (REL) yang selesai tepat di akhir note, bukan potong mendadak
        const r = Math.min(REL, Math.max(0.001, et - at));
        g.gain.setValueAtTime(peak, et - r); g.gain.linearRampToValueAtTime(0, et);
        try { s.stop(et + 0.005); } catch { /* sudah berhenti */ }
      }
      s.onended = () => { s.disconnect(); g.disconnect(); };
      const p: Piece = { s, g, at };
      pieces[i] = p;
      if (i > 0) {   // potongan sebelumnya (yang sedang meluncur) memudar keluar saat potongan ini masuk
        const old = pieces[i - 1];
        if (old) { old.g.gain.setValueAtTime(peak, at); old.g.gain.linearRampToValueAtTime(0, at + XF); try { old.s.stop(at + XF); } catch { /* abaikan */ } }
      }
      nodes.push(p);
      if (i < segs.length) {   // luncuran ke nada slide berikutnya: detune sumber yang sama naik/turun linear dalam cent
        const semis = segs[i].midi - pieceMidi(i);
        if (Math.abs(semis) > 1e-9) {
          s.detune.setValueAtTime(0, plan[i].tGs);
          s.detune.linearRampToValueAtTime(semis * 100, plan[i].tGs + plan[i].D);
        }
        schedulePiece(i + 1);
      }
    };
    const schedulePiece = (i: number): void => {
      const m = pieceMidi(i), b = get(src, m), pl = plan[i - 1];
      if (b) { startPiece(i, b, pl.at, pl.c); return; }
      // buffer nada tujuan belum selesai dirender: potongan sebelumnya terus meluncur / berbunyi, serah-terima menyusul begitu siap
      waiters.push({ devId: src.devId, midi: m, expire: ctx.currentTime + 6, fn: buf => {
        if (stopped) return;
        const now = ctx.currentTime;
        startPiece(i, buf, Math.max(now, pl.at), pl.c + Math.max(0, now - pl.at));
      } });
    };
    const begin = (buf: AudioBuffer, t: number): void => {
      base = t; started = true;
      buildPlan();
      startPiece(0, buf, t, 0);
    };
    const nodes: Piece[] = [];
    const cutAll = (at: number): void => {
      for (const n of nodes) {
        if (n.at >= at) {   // belum mulai: tidak berbunyi sama sekali
          n.g.gain.cancelScheduledValues(at); n.g.gain.setValueAtTime(0, at);
          try { n.s.stop(n.at); } catch { /* sudah berhenti */ }
        } else {            // sedang berbunyi: turun cepat dari level saat ini (bukan potong mendadak)
          n.g.gain.cancelScheduledValues(at); n.g.gain.setTargetAtTime(0, at, rel / 3);   // Release Sampler berlaku juga saat tuts dilepas
          try { n.s.stop(at + rel * 3); } catch { /* sudah berhenti */ }
        }
      }
    };

    const total = (dur != null ? dur + 0.1 : 6) + (segs.length ? 1 : 0) + (rel > REL ? rel : 0);
    const have = get(src, midi);
    request(src, midi, total, true);
    for (const g of segs) request(src, g.midi, total, false);   // nada tujuan slide ikut disiapkan
    if (when == null) for (let d = 1; d <= 8; d++) { request(src, midi + d, 3); request(src, midi - d, 3); }   // tetangga dirender di latar belakang
    if (have) begin(have, t0);
    else waiters.push({ devId: src.devId, midi, expire: ctx.currentTime + 6, fn: buf => {
      if (stopped) return;
      const now = ctx.currentTime;
      if (when != null && now - t0 > 0.15) return;   // terlambat terlalu jauh dari jadwal: dilewati supaya ritme tidak kacau
      begin(buf, Math.max(now, t0));
    } });

    return {
      start: t0,
      stop(at?: number): void {
        if (stopped) return;
        stopped = true;
        if (!started) return;
        cutAll(at == null ? ctx.currentTime : at);
      }
    };
  }

  return {
    get, request, prepare, play, progress,
    onProgress(cb: () => void): () => void { progListeners.add(cb); return () => { progListeners.delete(cb); }; },
    ready: (src: VSource, midis: number[]): number => midis.filter(m => get(src, m)).length,
    onChange(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
}
export type VsynthHandle = ReturnType<typeof createVsynth>;
