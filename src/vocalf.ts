// VocalF: exciter "udara" untuk vokal (terinspirasi Fresh Air): dua kontrol Mid Air + High Air, plus Trim (level keluaran). Jalan di AudioWorklet.
//
// Algoritma (tiap channel, kiri / kanan terpisah, tanpa latensi):
//   MID AIR  : band sumber = high-pass 3,5 kHz. Dua bahan yang ditambahkan ke sinyal asli:
//              (a) harmonik: band sumber -> kuadrat ternormalisasi (harmonik genap, amplitudo ikut level band) -> high-pass 6,5 kHz (hanya harmonik baru yang lolos),
//              (b) linear: high-pass 1 kutub 4,5 kHz dari sinyal asli (kilau / kehadiran).
//   HIGH AIR : sama, tetapi sumber high-pass 8 kHz, harmonik di atas 11 kHz (+ low-pass 19 kHz / 0,45 fs, supaya aliasing tidak terdengar),
//              dan bagian linear high-pass 1 kutub 9 kHz.
//   DINAMIS  : tambahan tiap band dikalikan 1 / (1 + 8 * envelope band sumber): saat band atas sedang keras (desis "S", konsonan) tambahan mengecil,
//              saat band atas tipis (napas, ujung kata) tambahan penuh. Itu yang membuat vokal terbuka tanpa jadi tajam (ala sirkuit exciter + dinamika).
//   OUTPUT   : sinyal asli + tambahan Mid + tambahan High, lalu Trim (+-12 dB). Mid = 0, High = 0, Trim 0 dB = lolos persis sama (bit-exact).
//
// Pesan ke prosesor: { t: 'p', mid (0..1), high (0..1), trim (dB), on }.

const WORKLET_SRC = `
class VocalF extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};   // nilai awal ikut dibawa saat node dibuat: blok audio pertama sudah memakai setelan yang benar
    this.mid = this.tmid = o.mid || 0; this.high = this.thigh = o.high || 0;
    this.trim = this.ttrim = Math.pow(10, (o.trim || 0) / 20); this.on = o.on !== false;
    const sr = sampleRate;
    this.smooth = 1 - Math.exp(-1 / (0.02 * sr));
    this.eA = 1 - Math.exp(-1 / (0.001 * sr)); this.eR = 1 - Math.exp(-1 / (0.06 * sr));
    // biquad high-pass Butterworth (2 kutub) / low-pass; koefisien b0 b1 b2 a1 a2
    const hp = f => { const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
      return [(1 + cs) / 2 / a0, -(1 + cs) / a0, (1 + cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0]; };
    const lp = f => { const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
      return [(1 - cs) / 2 / a0, (1 - cs) / a0, (1 - cs) / 2 / a0, -2 * cs / a0, (1 - al) / a0]; };
    // biquad per channel: 0 mid-src HP3.5k, 1 mid-harm HP6.5k, 2 hi-src HP8k, 3 hi-harm HP11k, 4 hi-harm LP19k
    this.c = [hp(3500), hp(6500), hp(8000), hp(11000), lp(Math.min(19000, sr * 0.45))];
    this.z = [0, 1].map(() => new Float64Array(this.c.length * 2));
    // bagian linear: high-pass 1 kutub (fase maks. 90 derajat, jadi menjumlah ke sinyal asli sebagai shelf mulus, tanpa cekungan akibat fase)
    this.pa = [Math.exp(-2 * Math.PI * 4500 / sr), Math.exp(-2 * Math.PI * 9000 / sr)];
    this.p = [0, 1].map(() => new Float64Array(4));   // per channel: [x1, y1] mid, [x1, y1] high
    this.eM = [0, 0]; this.eH = [0, 0];
    this.port.onmessage = e => {
      const m = e.data;
      if (m.t === 'p') { this.on = m.on; this.tmid = m.on ? m.mid : 0; this.thigh = m.on ? m.high : 0; this.ttrim = m.on ? Math.pow(10, m.trim / 20) : 1; }
    };
  }
  f(i, ch, x) {   // satu biquad (transposed direct form II)
    const c = this.c[i], z = this.z[ch], k = i * 2, y = c[0] * x + z[k];
    z[k] = c[1] * x - c[3] * y + z[k + 1];
    z[k + 1] = c[2] * x - c[4] * y;
    return y;
  }
  h(k, ch, x) {   // high-pass 1 kutub
    const p = this.p[ch], a = this.pa[k], y = a * (p[k * 2 + 1] + x - p[k * 2]);
    p[k * 2] = x; p[k * 2 + 1] = y;
    return y;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    if (!inp || !inp.length) return true;
    const n = out[0].length, nch = Math.min(out.length, inp.length, 2);
    const idle = this.mid < 1e-4 && this.high < 1e-4 && this.tmid < 1e-4 && this.thigh < 1e-4 && Math.abs(this.trim - 1) < 1e-4 && Math.abs(this.ttrim - 1) < 1e-4;
    if (idle) {   // semua nol dan trim 0 dB: lolos persis, tanpa hitung (state filter dibiarkan; saat dinyalakan lagi dia melesat dalam beberapa ms)
      for (let ch = 0; ch < out.length; ch++) { const s = inp[Math.min(ch, inp.length - 1)], o = out[ch]; for (let i = 0; i < n; i++) o[i] = s[i]; }
      this.mid = this.high = 0; this.trim = 1;
      return true;
    }
    for (let ch = 0; ch < nch; ch++) {
      const s = inp[ch], o = out[ch];
      let mid = this.mid, high = this.high, trim = this.trim, eM = this.eM[ch], eH = this.eH[ch];
      const sm = this.smooth;
      for (let i = 0; i < n; i++) {
        const x = s[i];
        mid += (this.tmid - mid) * sm; high += (this.thigh - high) * sm; trim += (this.ttrim - trim) * sm;
        // MID AIR
        const ms = this.f(0, ch, x);
        const a = ms < 0 ? -ms : ms; eM += (a - eM) * (a > eM ? this.eA : this.eR);
        const mh = this.f(1, ch, Math.min(ms * ms / (eM + 0.003), 3 * eM + 0.003));   // kuadrat ternormalisasi = harmonik genap murni (tidak berkorelasi dengan sinyal asli, jadi tidak ada cekungan akibat fase); high-pass membuang DC + selisih nada
        const ml = this.h(0, ch, x);
        const midAdd = (2.6 * mid * mid * mh + 1.3 * mid * ml) / (1 + 8 * eM);
        // HIGH AIR
        const hs = this.f(2, ch, x);
        const b = hs < 0 ? -hs : hs; eH += (b - eH) * (b > eH ? this.eA : this.eR);
        const hh = this.f(4, ch, this.f(3, ch, Math.min(hs * hs / (eH + 0.003), 3 * eH + 0.003)));
        const hl = this.h(1, ch, x);
        const hiAdd = (3.0 * high * high * hh + 1.4 * high * hl) / (1 + 8 * eH);
        o[i] = (x + midAdd + hiAdd) * trim;
      }
      this.mid = mid; this.high = high; this.trim = trim; this.eM[ch] = eM; this.eH[ch] = eH;
    }
    if (out.length > nch) for (let ch = nch; ch < out.length; ch++) out[ch].set(out[nch - 1]);   // sumber mono: channel kedua sama
    return true;
  }
}
registerProcessor('deriz-vocalf', VocalF);
`;

export const VOCALF_SRC = WORKLET_SRC;   // dipakai tes di tools/

const loaded = new WeakSet<BaseAudioContext>();
const loading = new WeakMap<BaseAudioContext, Promise<void>>();

export const vocalfLoaded = (ctx: BaseAudioContext): boolean => loaded.has(ctx);

export function loadVocalf(ctx: BaseAudioContext): Promise<void> {
  let p = loading.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(url).then(() => { loaded.add(ctx); }).finally(() => URL.revokeObjectURL(url));
    p.catch(() => loading.delete(ctx));   // gagal: boleh dicoba lagi
    loading.set(ctx, p);
  }
  return p;
}

export interface VocalfMsg { mid: number; high: number; trim: number; on: boolean }   // mid / high 0..1, trim dalam dB

export function createVocalf(ctx: BaseAudioContext, init?: VocalfMsg): AudioWorkletNode {
  return new AudioWorkletNode(ctx, 'deriz-vocalf', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: init });
}
