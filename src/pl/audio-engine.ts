// Engine audio bersama: satu AudioContext untuk playlist, piano roll, mixer, dan panel efek.
//
// Jalur sinyal (wiring):
//   suara (note instrumen / clip audio)
//     -> chain efek milik pattern (clip)         [panel Efek: LFO, Filter, Delay, Reverb, EQ1, EQ2]
//     -> strip channel milik track clip itu      [panel Mixer: fader, pan, aktivator/solo]
//          (output channel = Master, atau channel FX pilihan lewat titik tiga di mixer: strip FX -> Master)
//          |-- send A -> Return A (reverb) -+
//          |-- send B -> Return B (delay)  -+--> Master
//          '-----------------------------------> Master
//     -> chain efek Master (tab Efek > Master)    [sama: LFO, Filter, Delay, Reverb, EQ1, EQ2; memproses semua channel + return]
//     -> Master (fader, pan) -> speaker (tanpa compressor / limiter)
//
// Level meter tiap strip diambil dari AnalyserNode (setelah fader) lalu dikirim lewat mixer.setMeter(); hanya aktif saat panel Mixer terbuka.
import type { MixerHandle } from './mixer-panel';
import { moduleDef } from './modules';

export interface FxDev { id: number; type: string; on: boolean; params: Record<string, number>; }

/* ---------- node efek ---------- */
export interface DevNode { type: string; input: GainNode; output: GainNode; update(p: Record<string, number>): void; dispose(): void; }
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const TC = 0.02;       // penghalus parameter efek (detik), supaya knob tidak bunyi "krek"
const MIX_TC = 0.004;  // penghalus fader/pan/send: cepat (±FLM: pole 0,01 per sample), tetap tanpa zipper noise

function mkFilter(a: AudioContext): DevNode {
  const input = a.createGain(), output = a.createGain(), dry = a.createGain(), wet = a.createGain();
  const f = a.createBiquadFilter(); f.type = 'lowpass';
  input.connect(dry); dry.connect(output);
  input.connect(f); f.connect(wet); wet.connect(output);
  return {
    type: 'filter', input, output,
    update(p) {
      const t = a.currentTime, m = clamp(p.mix / 100, 0, 1);
      f.frequency.setTargetAtTime(clamp(p.freq, 20, 20000), t, TC);
      f.Q.setTargetAtTime(0.5 + clamp(p.reso, 0, 100) / 100 * 14.5, t, TC);
      wet.gain.setTargetAtTime(m, t, TC); dry.gain.setTargetAtTime(1 - m, t, TC);
    },
    dispose() { input.disconnect(); output.disconnect(); f.disconnect(); dry.disconnect(); wet.disconnect(); }
  };
}

function mkDelay(a: AudioContext, wetOnly = false): DevNode {
  const input = a.createGain(), output = a.createGain(), dry = a.createGain(), wet = a.createGain();
  const d = a.createDelay(1), fb = a.createGain();
  dry.gain.value = wetOnly ? 0 : 1;
  input.connect(dry); dry.connect(output);
  input.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(output);
  return {
    type: 'delay', input, output,
    update(p) {
      const t = a.currentTime;
      d.delayTime.setTargetAtTime(clamp(p.time, 1, 1000) / 1000, t, TC);
      fb.gain.setTargetAtTime(clamp(p.fb, 0, 95) / 100, t, TC);
      wet.gain.setTargetAtTime(clamp(p.mix, 0, 100) / 100, t, TC);
    },
    dispose() { input.disconnect(); output.disconnect(); d.disconnect(); fb.disconnect(); dry.disconnect(); wet.disconnect(); }
  };
}

// impuls reverb sintetis: noise stereo yang meluruh eksponensial (RT60 = decay), panjang ikut Size
function makeIR(a: AudioContext, size: number, decay: number): AudioBuffer {
  const dec = Math.max(0.05, decay);
  const len = clamp(dec * (0.4 + 0.6 * clamp(size, 0, 100) / 100), 0.1, 10);
  const n = Math.max(1, Math.floor(len * a.sampleRate));
  const buf = a.createBuffer(2, n, a.sampleRate);
  for (let c = 0; c < 2; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.exp(-6.9 * (i / a.sampleRate) / dec) * (1 - i / n);
  }
  return buf;
}
function mkReverb(a: AudioContext, wetOnly = false): DevNode {
  const input = a.createGain(), output = a.createGain(), dry = a.createGain(), wet = a.createGain();
  const conv = a.createConvolver();
  dry.gain.value = wetOnly ? 0 : 1;
  input.connect(dry); dry.connect(output);
  input.connect(conv); conv.connect(wet); wet.connect(output);
  let key = '', timer = 0;
  return {
    type: 'reverb', input, output,
    update(p) {
      wet.gain.setTargetAtTime(clamp(p.mix, 0, 100) / 100, a.currentTime, TC);
      const k = p.size + '|' + p.decay;
      if (k === key) return;
      key = k;
      clearTimeout(timer);
      if (!conv.buffer) conv.buffer = makeIR(a, p.size, p.decay);   // pertama kali: langsung
      else timer = window.setTimeout(() => { conv.buffer = makeIR(a, p.size, p.decay); }, 120);   // geser knob: tunda
    },
    dispose() { clearTimeout(timer); input.disconnect(); output.disconnect(); conv.disconnect(); dry.disconnect(); wet.disconnect(); }
  };
}

// LFO dipasang sebagai tremolo (modulasi volume sinyal yang lewat): Rate = kecepatan, Depth = kedalaman, Offset = geser titik tengah, Phase = fase awal
function mkLfo(a: AudioContext): DevNode {
  const input = a.createGain(), output = a.createGain(), amp = a.createGain(), depthG = a.createGain();
  const osc = a.createOscillator();
  input.connect(amp); amp.connect(output);
  osc.connect(depthG); depthG.connect(amp.gain);
  osc.start();
  let ph = NaN;
  return {
    type: 'lfo', input, output,
    update(p) {
      const t = a.currentTime, d = clamp(p.depth, 0, 100) / 100;
      amp.gain.setTargetAtTime(Math.max(0, 1 - d / 2 + clamp(p.offset, -100, 100) / 200), t, TC);
      depthG.gain.setTargetAtTime(d / 2, t, TC);
      osc.frequency.setTargetAtTime(clamp(p.rate, 0.01, 20), t, TC);
      if (p.phase !== ph) {
        ph = p.phase;
        const r = ph * Math.PI / 180;
        osc.setPeriodicWave(a.createPeriodicWave(new Float32Array([0, Math.sin(r)]), new Float32Array([0, Math.cos(r)])));
      }
    },
    dispose() { try { osc.stop(); } catch { /* sudah berhenti */ } osc.disconnect(); depthG.disconnect(); input.disconnect(); amp.disconnect(); output.disconnect(); }
  };
}

// EQ1: tiga band sederhana. Low = low-shelf 200 Hz, Mid = peaking 1 kHz, High = high-shelf 4 kHz (gain dB, 0 = netral)
function mkEq1(a: AudioContext): DevNode {
  const input = a.createGain(), output = a.createGain();
  const lo = a.createBiquadFilter(), mid = a.createBiquadFilter(), hi = a.createBiquadFilter();
  lo.type = 'lowshelf'; lo.frequency.value = 200;
  mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8;
  hi.type = 'highshelf'; hi.frequency.value = 4000;
  input.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(output);
  return {
    type: 'eq1', input, output,
    update(p) {
      const t = a.currentTime;
      lo.gain.setTargetAtTime(clamp(p.low, -18, 18), t, TC);
      mid.gain.setTargetAtTime(clamp(p.mid, -18, 18), t, TC);
      hi.gain.setTargetAtTime(clamp(p.high, -18, 18), t, TC);
    },
    dispose() { input.disconnect(); output.disconnect(); lo.disconnect(); mid.disconnect(); hi.disconnect(); }
  };
}

// EQ2: lima band di frekuensi tetap (b1..b5). Ujung = shelf, tengah = peaking. Daftar frekuensi dipakai juga oleh UI (fx-panel.ts)
export const EQ2_BANDS = [60, 250, 1000, 4000, 12000];
function mkEq2(a: AudioContext): DevNode {
  const input = a.createGain(), output = a.createGain();
  const fs = EQ2_BANDS.map((f, i) => {
    const b = a.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === EQ2_BANDS.length - 1 ? 'highshelf' : 'peaking';
    b.frequency.value = f; b.Q.value = 1;
    return b;
  });
  let prev: AudioNode = input;
  for (const b of fs) { prev.connect(b); prev = b; }
  prev.connect(output);
  return {
    type: 'eq2', input, output,
    update(p) {
      const t = a.currentTime;
      fs.forEach((b, i) => b.gain.setTargetAtTime(clamp(p['b' + (i + 1)] ?? 0, -18, 18), t, TC));
    },
    dispose() { input.disconnect(); output.disconnect(); for (const b of fs) b.disconnect(); }
  };
}

// Compressor: DynamicsCompressorNode bawaan browser (Threshold / Ratio / Knee / Attack / Release) + Makeup gain (dB) + Mix dry/wet (kompresi paralel).
// Catatan: kompresor bawaan browser sudah menambah makeup otomatis sesuai Threshold / Ratio, jadi knob Makeup ditambahkan di atasnya.
function mkCompressor(a: AudioContext): DevNode {
  const input = a.createGain(), output = a.createGain(), dry = a.createGain(), wet = a.createGain(), makeup = a.createGain();
  const c = a.createDynamicsCompressor();
  input.connect(dry); dry.connect(output);
  input.connect(c); c.connect(makeup); makeup.connect(wet); wet.connect(output);
  return {
    type: 'compressor', input, output,
    update(p) {
      const t = a.currentTime, m = clamp((p.mix ?? 100) / 100, 0, 1);
      c.threshold.setTargetAtTime(clamp(p.thresh ?? -24, -60, 0), t, TC);
      c.ratio.setTargetAtTime(clamp(p.ratio ?? 4, 1, 20), t, TC);
      c.knee.setTargetAtTime(clamp(p.knee ?? 6, 0, 40), t, TC);
      c.attack.setTargetAtTime(clamp(p.attack ?? 10, 0.1, 200) / 1000, t, TC);
      c.release.setTargetAtTime(clamp(p.release ?? 120, 10, 1000) / 1000, t, TC);
      makeup.gain.setTargetAtTime(Math.pow(10, clamp(p.makeup ?? 0, 0, 24) / 20), t, TC);
      wet.gain.setTargetAtTime(m, t, TC); dry.gain.setTargetAtTime(1 - m, t, TC);
    },
    dispose() { input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect(); c.disconnect(); makeup.disconnect(); }
  };
}

function makeDevice(a: AudioContext, type: string): DevNode | null {
  switch (type) {
    case 'filter': return mkFilter(a);
    case 'delay': return mkDelay(a);
    case 'reverb': return mkReverb(a);
    case 'lfo': return mkLfo(a);
    case 'eq1': return mkEq1(a);
    case 'eq2': return mkEq2(a);
    case 'compressor': return mkCompressor(a);
    default: return moduleDef(type)?.create(a) ?? null;   // plugin buatan sendiri (tab Module, lihat modules.ts)
  }
}

/* ---------- meter + strip ---------- */
interface Meter { split: ChannelSplitterNode; l: AnalyserNode; r: AnalyserNode; }
function mkMeter(a: AudioContext): Meter {   // belum tersambung ke sumber: dipasang hanya saat meter terlihat (setMetering)
  const split = a.createChannelSplitter(2), l = a.createAnalyser(), r = a.createAnalyser();
  l.fftSize = r.fftSize = 1024;
  split.connect(l, 0); split.connect(r, 1);
  return { split, l, r };
}
// pan = balance linear (seperti FL Studio Mobile): tengah = gain 1,0 di kedua sisi, ke ujung sisi lawan turun ke 0 (tanpa potongan 3 dB di tengah)
interface Balance { in: GainNode; out: ChannelMergerNode; set(pan: number, t: number): void; dispose(): void; }
function mkBalance(a: AudioContext): Balance {
  const inp = a.createGain(), split = a.createChannelSplitter(2), gl = a.createGain(), gr = a.createGain(), out = a.createChannelMerger(2);
  inp.channelCount = 2; inp.channelCountMode = 'explicit'; inp.channelInterpretation = 'speakers';   // sumber mono otomatis jadi L = R
  inp.connect(split); split.connect(gl, 0); split.connect(gr, 1); gl.connect(out, 0, 0); gr.connect(out, 0, 1);
  return {
    in: inp, out,
    set(pan, t) {
      const p = (clamp(pan, -1, 1) + 1);   // 0..2, 1 = tengah
      gl.gain.setTargetAtTime(clamp(2 - p, 0, 1), t, MIX_TC);
      gr.gain.setTargetAtTime(clamp(p, 0, 1), t, MIX_TC);
    },
    dispose() { for (const n of [inp, split, gl, gr, out]) n.disconnect(); }
  };
}
// Strip: in -> fader -> (langsung ke tujuan | lewat balance kalau pan tidak di tengah). Meter menyadap fader dan hanya tersambung saat panel Mixer terbuka.
interface Strip { in: GainNode; fader: GainNode; bal: Balance; dest: AudioNode; centered: boolean; meter: Meter; metering: boolean; sendA?: GainNode; sendB?: GainNode; aOn?: boolean; bOn?: boolean; }

function mkStrip(a: AudioContext, dest: AudioNode): Strip {
  const inp = a.createGain(), fader = a.createGain(), bal = mkBalance(a);
  fader.channelCount = 2; fader.channelCountMode = 'explicit'; fader.channelInterpretation = 'speakers';   // mono -> L = R (meter + balance sama untuk semua sumber)
  inp.connect(fader); fader.connect(dest); bal.out.connect(dest);
  return { in: inp, fader, bal, dest, centered: true, meter: mkMeter(a), metering: false };
}
function setPan(s: { fader: GainNode; bal: Balance; dest: AudioNode; centered: boolean }, pan: number, t: number): void {
  const c = Math.abs(pan) < 0.001;
  if (c !== s.centered) {   // di tengah = jalur langsung (tanpa node balance); di luar tengah = lewat balance
    s.centered = c;
    if (c) { s.fader.disconnect(s.bal.in); s.fader.connect(s.dest); }
    else { s.fader.disconnect(s.dest); s.fader.connect(s.bal.in); }
  }
  if (!c) s.bal.set(pan, t);
}
function setMetering(s: { fader: GainNode; meter: Meter; metering: boolean }, on: boolean): void {
  if (on === s.metering) return;
  s.metering = on;
  if (on) s.fader.connect(s.meter.split); else s.fader.disconnect(s.meter.split);
}
function setDest(s: Strip, dest: AudioNode): void {   // pindahkan output strip (Master <-> channel FX) tanpa menyentuh send dan meter
  if (s.dest === dest) return;
  s.bal.out.disconnect(s.dest); s.bal.out.connect(dest);
  if (s.centered) { s.fader.disconnect(s.dest); s.fader.connect(dest); }
  s.dest = dest;
}
function killStrip(s: Strip): void {
  setMetering(s, false);
  for (const n of [s.in, s.fader, s.meter.split, s.meter.l, s.meter.r, s.sendA, s.sendB]) n?.disconnect();
  s.bal.dispose();
}

interface DevSlot { id: number; node: DevNode; on: boolean; }
interface Chain { id: number; in: GainNode; out: GainNode; devs: DevSlot[]; track: number | null; }

export class AudioEngine {
  private a: AudioContext | null = null;
  private mixer: MixerHandle | null = null;
  private masterIn!: GainNode;
  private master_!: Strip;   // strip master: in = masterIn, fader = masterFader, tujuan = speaker
  private channels = new Map<number, Strip>();
  private rets = {} as Record<'A' | 'B', Strip & { fx: DevNode }>;
  private fxs = new Map<number, Strip>();   // channel FX (bus): in -> fader -> pan -> master
  private chains = new Map<number, Chain>();
  private masterDevs: DevSlot[] = [];   // efek Master: masterIn -> devices -> fader master
  private fxDevs = new Map<number, DevSlot[]>();   // efek channel FX: strip.in -> devices -> fader FX (dipisah dari strip supaya tidak hilang kalau strip dibuat ulang)
  private clipTrack = new Map<number, number>();
  private buf = new Float32Array(1024);
  private raf = 0;
  private frameNo = 0;
  private metering = false;
  private metersVisible: () => boolean = () => true;

  /** AudioContext bersama (dibuat saat pertama dipakai; sengaja menunggu sentuhan pengguna lewat context()/resume) */
  context(): AudioContext {
    if (!this.a) this.build();
    const a = this.a!;
    if (a.state === 'suspended') void a.resume();
    return a;
  }

  /** titik masuk untuk suara yang tidak punya pattern (fallback langsung ke master) */
  master(): AudioNode { this.context(); return this.masterIn; }

  /** titik masuk chain efek milik pattern (clip): sambungkan semua suara clip itu ke sini */
  pattern(clipId: number): AudioNode { this.context(); return this.chain(clipId).in; }

  /** hubungkan mixer: fader / pan / send / mute / solo langsung mempengaruhi audio, dan meter terisi dari audio */
  attachMixer(m: MixerHandle, metersVisible: () => boolean = () => true): void {
    this.mixer = m; this.metersVisible = metersVisible;
    m.onChange(() => this.syncMixer());
    if (this.a) this.syncMixer();
  }

  /** daftar clip terkini (id + track): menentukan clip mana lewat strip channel yang mana */
  setClips(list: { id: number; track: number }[]): void {
    const ids = new Set<number>();
    for (const c of list) { ids.add(c.id); this.clipTrack.set(c.id, c.track); }
    for (const id of [...this.clipTrack.keys()]) if (!ids.has(id)) this.clipTrack.delete(id);
    if (!this.a) return;
    for (const [id, ch] of this.chains) {
      if (!ids.has(id)) { this.disposeChain(ch); this.chains.delete(id); continue; }
      const t = this.clipTrack.get(id) ?? null;
      if (t !== ch.track) { ch.track = t; this.route(ch); }
    }
  }

  /** samakan chain efek pattern dengan daftar device dari panel Efek (diff per id: parameter diubah di tempat, tanpa membangun ulang) */
  setPatternFx(clipId: number, devs: FxDev[]): void {
    if (!this.a && !devs.length) return;
    const a = this.context(), c = this.chain(clipId);
    const r = this.syncDevs(a, c.devs, devs);
    c.devs = r.next;
    if (r.structural) this.rewire(c);
  }

  /** samakan chain efek Master (tab Efek > Master) dengan daftar device: sama seperti pattern, tapi dipasang antara input master dan fader master */
  setMasterFx(devs: FxDev[]): void {
    if (!this.a && !devs.length) return;
    const a = this.context();
    const r = this.syncDevs(a, this.masterDevs, devs);
    this.masterDevs = r.next;
    if (r.structural) this.rewireMaster();
  }

  /** samakan chain efek channel FX (Mixer > titik tiga FX > Effect) dengan daftar device: dipasang antara input strip FX dan fader FX */
  setFxChannelFx(id: number, devs: FxDev[]): void {
    if (!devs.length && !this.fxDevs.get(id)?.length) return;
    const a = this.context();
    const r = this.syncDevs(a, this.fxDevs.get(id) ?? [], devs);
    if (r.next.length) this.fxDevs.set(id, r.next); else this.fxDevs.delete(id);
    if (!this.fxs.has(id)) { if (r.next.length) this.ensureFx(id); }   // ensureFx langsung memasang rantai efek
    else if (r.structural) this.rewireFx(id);
  }

  /** buang efek semua channel FX (dipanggil sebelum memuat project baru) */
  clearFxChannelFx(): void { for (const id of [...this.fxDevs.keys()]) this.setFxChannelFx(id, []); }

  /** buang semua efek semua pattern (dipanggil sebelum memuat project baru) */
  clearPatternFx(): void { for (const id of [...this.chains.keys()]) this.setPatternFx(id, []); }

  /* ---------- internal ---------- */
  private build(): void {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // latencyHint 'playback' = buffer output besar (setara mode ULTRASAFE FL Studio Mobile): latensi lebih tinggi, tapi tahan putus-putus / suara pecah
    const a = (this.a = new Ctor({ latencyHint: 'playback' }));
    // master: input -> fader -> (balance) -> speaker. Tanpa compressor / limiter (seperti FL Studio Mobile): sinyal lewat apa adanya.
    this.master_ = mkStrip(a, a.destination);
    this.masterIn = this.master_.in;   // unity: clip audio keluar di level aslinya (headroom instrumen diatur di suara instrumennya)
    // return A = reverb, return B = delay (100% wet; sinyal dry datang dari strip channel langsung ke master)
    for (const k of ['A', 'B'] as const) {
      const s = mkStrip(a, this.masterIn);
      const fx = k === 'A' ? mkReverb(a, true) : mkDelay(a, true);
      s.in.disconnect(); s.in.connect(fx.input); fx.output.connect(s.fader);
      fx.update(k === 'A' ? { size: 70, decay: 2.5, mix: 100 } : { time: 375, fb: 40, mix: 100 });
      this.rets[k] = Object.assign(s, { fx });
    }
    this.syncMixer();
    this.rewireMaster();
    for (const ch of this.chains.values()) this.route(ch);
    this.raf = requestAnimationFrame(this.tick);
  }

  private ensureChannel(id: number): Strip {
    let s = this.channels.get(id);
    if (s) return s;
    const a = this.a!;
    s = mkStrip(a, this.masterIn);
    s.sendA = a.createGain(); s.sendB = a.createGain();
    s.sendA.gain.value = 0; s.sendB.gain.value = 0;
    s.aOn = false; s.bOn = false;   // send hanya disambung ke Return kalau levelnya > 0 (lihat syncMixer): reverb/delay tidak diproses percuma
    this.channels.set(id, s);
    if (this.metering) setMetering(s, true);
    return s;
  }

  private ensureFx(id: number): Strip {
    let s = this.fxs.get(id);
    if (s) return s;
    s = mkStrip(this.a!, this.masterIn);
    this.fxs.set(id, s);
    if (this.metering) setMetering(s, true);
    if (this.fxDevs.get(id)?.length) this.rewireFx(id);   // efek channel ini sudah ada (mis. project baru dibuka): pasang di strip
    return s;
  }

  private syncMixer(): void {
    const a = this.a, m = this.mixer;
    if (!a || !m) return;
    const t = a.currentTime, st = m.getState();
    let topology = false;
    for (const f of st.fx) this.ensureFx(f.id);   // strip FX dibuat dulu, supaya channel bisa diarahkan ke sana
    for (const k of Object.keys(st.chans)) { const id = +k; if (!this.channels.has(id)) { this.ensureChannel(id); topology = true; } }
    for (const [id, s] of [...this.channels]) if (!(id in st.chans)) { killStrip(s); this.channels.delete(id); topology = true; }
    for (const [id, s] of this.channels) {
      const o = m.getChannel(id);
      if (!o) continue;
      s.fader.gain.setTargetAtTime(o.gain, t, MIX_TC);
      setPan(s, o.pan, t);
      const fxs = o.out != null ? this.fxs.get(o.out) : undefined;
      setDest(s, fxs ? fxs.in : this.masterIn);   // routing titik tiga: Master atau channel FX
      s.sendA!.gain.setTargetAtTime(o.sendA, t, MIX_TC);
      s.sendB!.gain.setTargetAtTime(o.sendB, t, MIX_TC);
      this.setSend(s, 'A', o.sendA > 0.0005);
      this.setSend(s, 'B', o.sendB > 0.0005);
    }
    for (const [id, s] of [...this.fxs]) {
      const o = m.getFx(id);
      if (!o) { killStrip(s); this.fxs.delete(id); continue; }   // channel FX dihapus (track yang mengarah ke sini sudah dipindah ke Master di atas)
      s.fader.gain.setTargetAtTime(o.gain, t, MIX_TC);
      setPan(s, o.pan, t);
    }
    for (const k of ['A', 'B'] as const) {
      const o = m.getReturn(k);
      this.rets[k].fader.gain.setTargetAtTime(o.gain, t, MIX_TC);
      setPan(this.rets[k], o.pan, t);
    }
    const mo = m.getMaster();
    this.master_.fader.gain.setTargetAtTime(mo.gain, t, MIX_TC);
    setPan(this.master_, mo.pan, t);
    if (topology) for (const ch of this.chains.values()) this.route(ch);
  }

  // send: setelah fader, sebelum pan. Disambung hanya saat level > 0, supaya ConvolverNode (reverb) dan delay Return diam saat tidak dipakai
  private setSend(s: Strip, k: 'A' | 'B', on: boolean): void {
    const g = k === 'A' ? s.sendA! : s.sendB!;
    if ((k === 'A' ? s.aOn : s.bOn) === on) return;
    if (k === 'A') s.aOn = on; else s.bOn = on;
    if (on) { s.fader.connect(g); g.connect(this.rets[k].in); }
    else { s.fader.disconnect(g); g.disconnect(); }
  }

  private chain(id: number): Chain {
    let c = this.chains.get(id);
    if (c) return c;
    const a = this.a!;
    c = { id, in: a.createGain(), out: a.createGain(), devs: [], track: this.clipTrack.get(id) ?? null };
    this.chains.set(id, c);
    this.rewire(c);
    this.route(c);
    return c;
  }

  // diff daftar device: yang hilang dibuang, yang baru dibuat, parameter yang ada diubah di tempat. structural = urutan / aktif / jumlah berubah (perlu rewire)
  private syncDevs(a: AudioContext, old: DevSlot[], devs: FxDev[]): { next: DevSlot[]; structural: boolean } {
    const keep = new Set(devs.map(d => d.id));
    let structural = false;
    for (const s of old) if (!keep.has(s.id)) { s.node.dispose(); structural = true; }
    const next: DevSlot[] = [];
    for (const d of devs) {
      let s = old.find(x => x.id === d.id && x.node.type === d.type);
      if (!s) {
        const node = makeDevice(a, d.type);
        if (!node) continue;
        s = { id: d.id, node, on: d.on };
        structural = true;
      } else if (s.on !== d.on) { s.on = d.on; structural = true; }
      s.node.update(d.params);
      next.push(s);
    }
    const survivors = old.filter(s => keep.has(s.id));
    if (next.length !== survivors.length || next.some((s, i) => survivors[i] !== s)) structural = true;
    return { next, structural };
  }

  // masterIn -> (device Master yang aktif, berurutan) -> fader master (menggantikan sambungan langsung masterIn -> fader)
  private rewireMaster(): void {
    const m = this.master_;
    if (!m) return;
    m.in.disconnect();
    for (const s of this.masterDevs) s.node.output.disconnect();
    let prev: AudioNode = m.in;
    for (const s of this.masterDevs) { if (!s.on) continue; prev.connect(s.node.input); prev = s.node.output; }
    prev.connect(m.fader);   // meter menyadap fader, bukan input, jadi tidak terpengaruh
  }

  // strip FX: in -> (device channel FX yang aktif, berurutan) -> fader FX (meter menyadap fader, jadi tidak terpengaruh)
  private rewireFx(id: number): void {
    const s = this.fxs.get(id);
    if (!s) return;
    const devs = this.fxDevs.get(id) ?? [];
    s.in.disconnect();
    for (const d of devs) d.node.output.disconnect();
    let prev: AudioNode = s.in;
    for (const d of devs) { if (!d.on) continue; prev.connect(d.node.input); prev = d.node.output; }
    prev.connect(s.fader);
  }

  // in -> (device yang aktif, berurutan) -> out
  private rewire(c: Chain): void {
    c.in.disconnect();
    for (const s of c.devs) s.node.output.disconnect();
    let prev: AudioNode = c.in;
    for (const s of c.devs) { if (!s.on) continue; prev.connect(s.node.input); prev = s.node.output; }
    prev.connect(c.out);
  }

  // out -> strip channel track pemilik clip (kalau channel belum ada: langsung ke master)
  private route(c: Chain): void {
    c.out.disconnect();
    const ch = c.track != null ? this.channels.get(c.track) : undefined;
    c.out.connect(ch ? ch.in : this.masterIn);
  }

  private disposeChain(c: Chain): void {
    for (const s of c.devs) s.node.dispose();
    c.in.disconnect(); c.out.disconnect();
  }

  private peak(an: AnalyserNode): number {
    an.getFloatTimeDomainData(this.buf);
    let m = 0;
    for (let i = 0; i < this.buf.length; i++) { const v = Math.abs(this.buf[i]); if (v > m) m = v; }
    return m;
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const m = this.mixer;
    if (!m || !this.a || this.a.state !== 'running') return;
    // meter hanya tersambung + dibaca kalau panel Mixer terbuka, ±30 fps: analyser memakan CPU (audio dan main thread)
    const vis = this.metersVisible();
    if (vis !== this.metering) {
      this.metering = vis;
      for (const s of this.channels.values()) setMetering(s, vis);
      for (const s of this.fxs.values()) setMetering(s, vis);
      for (const k of ['A', 'B'] as const) setMetering(this.rets[k], vis);
      setMetering(this.master_, vis);
    }
    if (!vis || (++this.frameNo & 1)) return;
    for (const [id, s] of this.channels) m.setMeter(id, this.peak(s.meter.l), this.peak(s.meter.r));
    for (const [id, s] of this.fxs) m.setMeter(`fx:${id}`, this.peak(s.meter.l), this.peak(s.meter.r));
    for (const k of ['A', 'B'] as const) m.setMeter(k, this.peak(this.rets[k].meter.l), this.peak(this.rets[k].meter.r));
    m.setMeter('master', this.peak(this.master_.meter.l), this.peak(this.master_.meter.r));
  };
}

export const engine = new AudioEngine();
