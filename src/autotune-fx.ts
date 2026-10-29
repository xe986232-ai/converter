// AUTOTUNE FX MIXER (mesin): tahap efek TERPISAH yang dipasang SETELAH node AUTOTUNE (audio-engine.ts). Tidak menyentuh algoritma autotune-dsp.ts sama sekali:
//   suara hasil autotune masuk ke sini sebagai "LEAD", lalu bisa ditambah lapisan Harmony 1 / Harmony 2 / Pitch / Double dan Reverb, masing-masing punya fader, pan, mute, solo.
//   Kalau semua fader efek di 0 dan Lead / Master di setelan bawaan, tahap ini TIDAK dipasang (mxActive = false), jadi jalur audio persis sama seperti sebelum ada mixer.
//
// Penggeser pitch lapisan: delay-line dua tap (grain 35 ms, window Hann, jumlah window = 1) di AudioWorklet 'deriz-atfx-shift'.
//   Harmony bisa "SCALE" (interval = derajat tangga nada, mengikuti nada hasil autotune dan nada yang diizinkan di keyboard plugin) atau "FIXED" (interval semiton tetap).
// Latensi: lapisan bergeser ~17 ms di belakang Lead (rata-rata tunda delay-line); sengaja tidak dikompensasi supaya jalur Lead tidak berubah.

const SHIFT_SRC = `
class DerizAtShift extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.N = 8192; this.M = this.N - 1;
    this.bL = new Float32Array(this.N); this.bR = new Float32Array(this.N);
    this.w = 0; this.W = Math.round(sampleRate * 0.035); this.ph = 0;
    this.ratio = o.ratio > 0 ? o.ratio : 1; this.tr = this.ratio;
    this.k = 1 - Math.exp(-1 / (0.006 * sampleRate));
    this.port.onmessage = e => { const m = e.data; if (m && m.t === 'r' && m.ratio > 0) this.tr = Math.min(4, Math.max(0.25, m.ratio)); };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const inp = inputs[0], L = inp && inp[0] ? inp[0] : null, R = inp && inp[1] ? inp[1] : L;
    const n = out[0].length, M = this.M, W = this.W, bL = this.bL, bR = this.bR, oL = out[0], oR = out[1] || out[0], TP = Math.PI * 2;
    let w = this.w, ph = this.ph, ratio = this.ratio;
    for (let i = 0; i < n; i++) {
      bL[w & M] = L ? L[i] : 0; bR[w & M] = R ? R[i] : 0;
      ratio += (this.tr - ratio) * this.k;
      let p2 = ph + 0.5; if (p2 >= 1) p2 -= 1;
      const g1 = 0.5 - 0.5 * Math.cos(TP * ph), g2 = 1 - g1;
      const a = w - (ph * W + 2), b = w - (p2 * W + 2), a0 = Math.floor(a), b0 = Math.floor(b), fa = a - a0, fb = b - b0;
      const A = a0 & M, A1 = (a0 + 1) & M, B = b0 & M, B1 = (b0 + 1) & M;
      oL[i] = g1 * (bL[A] + (bL[A1] - bL[A]) * fa) + g2 * (bL[B] + (bL[B1] - bL[B]) * fb);
      oR[i] = g1 * (bR[A] + (bR[A1] - bR[A]) * fa) + g2 * (bR[B] + (bR[B1] - bR[B]) * fb);
      ph += (1 - ratio) / W; if (ph >= 1) ph -= 1; else if (ph < 0) ph += 1;
      w++;
    }
    this.w = w & 0x3fffffff; this.ph = ph; this.ratio = ratio;
    return true;
  }
}
registerProcessor('deriz-atfx-shift', DerizAtShift);
`;
export const MX_SHIFT_SRC = SHIFT_SRC;   // dipakai tes di tools/

const loaded = new WeakSet<BaseAudioContext>();
const loading = new WeakMap<BaseAudioContext, Promise<void>>();
export const mxLoaded = (ctx: BaseAudioContext): boolean => loaded.has(ctx);
export function mxLoad(ctx: BaseAudioContext): Promise<void> {
  let p = loading.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([SHIFT_SRC], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(url).then(() => { loaded.add(ctx); }).finally(() => URL.revokeObjectURL(url));
    p.catch(() => loading.delete(ctx));
    loading.set(ctx, p);
  }
  return p;
}

// ---------- definisi strip + nilai bawaan (dipakai mesin DAN tampilan) ----------
export type MxKind = 'lead' | 'harm' | 'pitch' | 'dbl' | 'rev' | 'mst';
export interface MxDef { id: string; name: string; kind: MxKind }
export const MX_STRIPS: MxDef[] = [
  { id: 'lead', name: 'LEAD', kind: 'lead' }, { id: 'h1', name: 'HARMONY 1', kind: 'harm' }, { id: 'h2', name: 'HARMONY 2', kind: 'harm' },
  { id: 'pit', name: 'PITCH', kind: 'pitch' }, { id: 'dbl', name: 'DOUBLE', kind: 'dbl' }, { id: 'rev', name: 'REVERB', kind: 'rev' }, { id: 'mst', name: 'MASTER', kind: 'mst' }
];
export const FADER_UNITY = 0.75;   // posisi fader = 0 dB
/** Nilai bawaan. Kunci: <id>Lvl (fader 0..1), <id>Pan (-1..1; DOUBLE = lebar 0..1, REVERB = tone 0..1), <id>Mute, <id>Solo (0 / 1), lalu parameter khusus strip. */
export const MX_DEF: Record<string, number> = {
  leadLvl: FADER_UNITY, leadPan: 0, leadMute: 0, leadSolo: 0,
  h1Lvl: 0, h1Pan: -0.4, h1Mute: 0, h1Solo: 0, h1Int: 2, h1Sc: 1,    // Sc = 1: Int = derajat tangga nada (2 = terts), Sc = 0: Int = semiton
  h2Lvl: 0, h2Pan: 0.4, h2Mute: 0, h2Solo: 0, h2Int: 4, h2Sc: 1,     // 4 derajat = kwint
  pitLvl: 0, pitPan: 0, pitMute: 0, pitSolo: 0, pitInt: -12, pitFine: 0,
  dblLvl: 0, dblPan: 0.7, dblMute: 0, dblSolo: 0, dblAmt: 14,
  revLvl: 0, revPan: 0.65, revMute: 0, revSolo: 0, revSize: 45,
  mstLvl: FADER_UNITY, mstPan: 0, mstMute: 0, mstSolo: 0
};
export const mxClean = (v: Partial<Record<string, number>> | null | undefined): Record<string, number> => {
  const o = { ...MX_DEF };
  if (v) for (const k of Object.keys(MX_DEF)) { const x = v[k]; if (typeof x === 'number' && Number.isFinite(x)) o[k] = x; }
  return o;
};
/** Fader 0..1 -> penguat linear (0 = mati, 0,75 = 0 dB, 1 = +6 dB). */
export const faderGain = (f: number): number => f <= 0.002 ? 0 : f <= FADER_UNITY ? Math.pow(f / FADER_UNITY, 2.2) : Math.pow(10, 6 * ((f - FADER_UNITY) / (1 - FADER_UNITY)) / 20);
export const faderDb = (f: number): number => { const g = faderGain(f); return g <= 0 ? -Infinity : 20 * Math.log10(g); };
const unity = (a: number, b = FADER_UNITY): boolean => Math.abs(a - b) < 0.002;
/** Apakah tahap ini perlu dipasang? (semua bawaan = tidak, jalur audio tidak berubah.) */
export function mxActive(mx: Record<string, number> | null | undefined): boolean {
  if (!mx) return false;
  const m = mxClean(mx);
  const fx = ['h1', 'h2', 'pit', 'dbl', 'rev'].some(id => m[id + 'Lvl'] > 0.002);
  return fx || !unity(m.leadLvl) || Math.abs(m.leadPan) > 0.01 || m.leadMute > 0 || !unity(m.mstLvl);
}

// ---------- tangga nada & interval ----------
const MAJ = [0, 2, 4, 5, 7, 9, 11];
/** Selisih semiton dari nada MIDI n sejauh d derajat tangga nada yang diizinkan (mask 12 bit). Kurang dari 2 nada diizinkan: pakai tangga mayor. */
export function scaleOffset(n: number, d: number, mask: number): number {
  if (d === 0) return 0;
  let cnt = 0; for (let i = 0; i < 12; i++) cnt += (mask >> i) & 1;
  const ok = (m: number): boolean => cnt >= 2 ? ((mask >> (((m % 12) + 12) % 12)) & 1) === 1 : MAJ.includes((((m - 0) % 12) + 12) % 12);
  let base = n;
  if (!ok(base)) { for (let k = 1; k <= 6; k++) { if (ok(n - k)) { base = n - k; break; } if (ok(n + k)) { base = n + k; break; } } }
  let m = base, c = 0; const dir = d > 0 ? 1 : -1, need = Math.abs(d);
  while (c < need) { m += dir; if (ok(m)) c++; }
  return m - n;
}
export const INTERVAL_NAMES = ['Unison', 'min 2nd', 'Maj 2nd', 'min 3rd', 'Maj 3rd', '4th', 'Tritone', '5th', 'min 6th', 'Maj 6th', 'min 7th', 'Maj 7th', 'Octave'];
export const DEGREE_NAMES = ['Unison', '2nd', '3rd', '4th', '5th', '6th', '7th', 'Octave'];
const rat = (st: number): number => Math.pow(2, st / 12);

// ---------- tahap efek ----------
export interface MxStage {
  input: AudioNode; output: AudioNode;
  update(mx: Record<string, number>, mask: number): void;
  /** Nada MIDI (pecahan) hasil autotune saat ini; dipakai harmony mode SCALE. */
  pitch(out: number): void;
  /** Puncak (0..1) tiap strip, urutan MX_STRIPS. */
  levels(): number[];
  dispose(): void;
}

function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate, len = Math.max(1, Math.floor(seconds * sr)), buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c); let lp = 0, e = 0;
    for (let i = 0; i < len; i++) { const t = i / len; lp += (0.6 - 0.45 * t) * ((Math.random() * 2 - 1) - lp); d[i] = lp * Math.pow(1 - t, 3); e += d[i] * d[i]; }
    const k = e > 0 ? 1 / Math.sqrt(e) : 0; for (let i = 0; i < len; i++) d[i] *= k;
  }
  return buf;
}

export function createMxStage(ctx: BaseAudioContext): MxStage {
  const input = ctx.createGain(), output = ctx.createGain(), bus = ctx.createGain(), master = ctx.createGain();
  const mkAn = (): AnalyserNode => { const a = ctx.createAnalyser(); a.fftSize = 512; a.smoothingTimeConstant = 0; return a; };
  const shifter = (r: number): AudioWorkletNode => new AudioWorkletNode(ctx, 'deriz-atfx-shift', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { ratio: r } });
  const analysers: Record<string, AnalyserNode> = {};
  const nodes: AudioNode[] = [input, output, bus, master];
  const track = <T extends AudioNode>(n: T): T => { nodes.push(n); return n; };
  const voice = (id: string, src: AudioNode, sh?: AudioWorkletNode): { g: GainNode; p: StereoPannerNode } => {
    const g = track(ctx.createGain()), p = track(ctx.createStereoPanner()), an = analysers[id] ?? (analysers[id] = track(mkAn()));
    if (sh) { track(sh); src.connect(sh); sh.connect(g); } else src.connect(g);
    g.connect(p); p.connect(bus); p.connect(an); return { g, p };
  };
  const sH1 = shifter(1), sH2 = shifter(1), sPit = shifter(0.5), sA = shifter(1), sB = shifter(1), shifters = [sH1, sH2, sPit, sA, sB];
  const lead = voice('lead', input), h1 = voice('h1', input, sH1), h2 = voice('h2', input, sH2), pit = voice('pit', input, sPit);
  // Double: dua lapisan detune berlawanan arah, dibuka ke kiri / kanan
  const dA = voice('dbl', input, sA), dB = voice('dbl', input, sB);
  // reverb: kirim dari bus (setelah fader semua lapisan), kembali ke master
  const pre = track(ctx.createDelay(0.1)), conv = track(ctx.createConvolver()), tone = track(ctx.createBiquadFilter()), revG = track(ctx.createGain()), revAn = analysers.rev = track(mkAn());
  conv.normalize = false; pre.delayTime.value = 0.018; tone.type = 'lowpass'; tone.Q.value = 0.707; tone.frequency.value = 6000;
  bus.connect(master); bus.connect(pre); pre.connect(conv); conv.connect(tone); tone.connect(revG); revG.connect(master); revG.connect(revAn);
  const mAn = analysers.mst = track(mkAn());
  master.connect(output); master.connect(mAn);
  const last: Record<string, number> = {};
  let curMask = 0xFFF, curNote = 69, mxv = mxClean(null), impDecay = 0;
  const send = (s: AudioWorkletNode, key: string, r: number): void => { if (last[key] !== undefined && Math.abs(last[key] - r) < 1e-6) return; last[key] = r; s.port.postMessage({ t: 'r', ratio: r }); };
  const harmRatio = (id: 'h1' | 'h2'): number => {
    const d = Math.round(mxv[id + 'Int']);
    return rat(mxv[id + 'Sc'] > 0 ? scaleOffset(curNote, d, curMask) : d);
  };
  function shifts(): void {
    send(sH1, 'h1', harmRatio('h1')); send(sH2, 'h2', harmRatio('h2'));
    send(sPit, 'pit', rat(Math.round(mxv.pitInt) + mxv.pitFine / 100));
    send(sA, 'dA', Math.pow(2, mxv.dblAmt / 1200)); send(sB, 'dB', Math.pow(2, -mxv.dblAmt / 1200));
  }
  const buf = new Float32Array(512);
  const peak = (a: AnalyserNode): number => { a.getFloatTimeDomainData(buf); let m = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; } return m; };
  return {
    input, output,
    update(mx, mask) {
      mxv = mxClean(mx); curMask = mask; const now = ctx.currentTime, T = 0.02;
      const anySolo = MX_STRIPS.some(s => s.kind !== 'mst' && mxv[s.id + 'Solo'] > 0);
      const gOf = (id: string): number => (mxv[id + 'Mute'] > 0 || (anySolo && !(mxv[id + 'Solo'] > 0))) ? 0 : faderGain(mxv[id + 'Lvl']);
      lead.g.gain.setTargetAtTime(gOf('lead'), now, T); lead.p.pan.setTargetAtTime(mxv.leadPan, now, T);
      h1.g.gain.setTargetAtTime(gOf('h1'), now, T); h1.p.pan.setTargetAtTime(mxv.h1Pan, now, T);
      h2.g.gain.setTargetAtTime(gOf('h2'), now, T); h2.p.pan.setTargetAtTime(mxv.h2Pan, now, T);
      pit.g.gain.setTargetAtTime(gOf('pit'), now, T); pit.p.pan.setTargetAtTime(mxv.pitPan, now, T);
      const dg = gOf('dbl') * 0.8;   // dua lapisan: sedikit diturunkan supaya jumlahnya sebanding dengan satu strip
      dA.g.gain.setTargetAtTime(dg, now, T); dB.g.gain.setTargetAtTime(dg, now, T);
      dA.p.pan.setTargetAtTime(-mxv.dblPan, now, T); dB.p.pan.setTargetAtTime(mxv.dblPan, now, T);
      revG.gain.setTargetAtTime(gOf('rev') * 0.35, now, T);
      tone.frequency.setTargetAtTime(1500 * Math.pow(12000 / 1500, Math.min(1, Math.max(0, mxv.revPan))), now, T);
      const decay = Math.round((0.5 + Math.min(1, Math.max(0, mxv.revSize / 100)) * 3) * 10) / 10;
      if (decay !== impDecay) { conv.buffer = makeImpulse(ctx, decay); impDecay = decay; }
      master.gain.setTargetAtTime(mxv.mstMute > 0 ? 0 : faderGain(mxv.mstLvl), now, T);
      shifts();
    },
    pitch(out) { const n = Math.round(out); if (n !== curNote && out > 0) { curNote = n; shifts(); } },
    levels() { return MX_STRIPS.map(s => analysers[s.id] ? peak(analysers[s.id]) : 0); },
    dispose() { shifters.forEach(s => { s.port.onmessage = null; }); nodes.forEach(n => { try { n.disconnect(); } catch { /* sudah terputus */ } }); }
  };
}
