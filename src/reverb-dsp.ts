// Reverb algoritmik (FDN), jalan di AudioWorklet. Pengganti ConvolverNode.
//
// Kenapa: konvolusi biayanya naik sebanding panjang gema (5 detik = ~220 ribu tap per sampel) dan dibayar terus, walau track lagi hening.
// Di HP biasa beberapa Reverb sekaligus bikin blok audio telat -> suara patah-patah dan terdengar "speed up" saat browser mengejar ketinggalan.
// FDN: biaya TETAP per sampel, berapa pun panjang gema. Panjang gema (RT60) hanya mengubah gain umpan balik, bukan jumlah kerja.
//
// Algoritma:
//   1. Input stereo -> mid / side. Mid melewati 3 allpass, side 2 allpass (difusi awal: pukulan tajam jadi gema padat, bukan "ting-ting" per delay line).
//   2. 8 delay line (panjang saling prima, 32..96 ms) dengan umpan balik lewat matriks Hadamard 8x8 (ortogonal = tidak menambah energi, hanya mencampur).
//   3. Tiap line punya gain g = 10^(-3 * delay / RT60) (tepat meluruh 60 dB dalam RT60 detik) dan low-pass satu kutub (treble meluruh lebih cepat, seperti ruang sungguhan).
//   4. Keluaran stereo = dua kombinasi ortogonal dari 8 line (kiri / kanan tidak berkorelasi -> lebar). Level dinormalisasi supaya energi respons ~ sama
//      untuk gema pendek maupun panjang (sama seperti impuls lama yang energinya dibuat 1), jadi posisi knob Mix tidak berubah rasanya.
//   5. Otomatis berhenti menghitung: kalau input senyap dan ekor sudah di bawah -100 dB, state dikosongkan dan blok berikutnya hanya mengisi nol
//      sampai ada suara masuk lagi. Track yang tidak sedang berbunyi tidak memakan CPU.
//
// Pre-delay, Tone, Low Cut dan Mix tetap di luar (node biasa di audio-engine.ts), karena linear: hasilnya sama.
// Pesan ke prosesor: { t: 'p', rt (detik, 0.4..5) }  dan  { t: 'r' } (kosongkan ekor, dipakai saat pause).

const WORKLET_SRC = `
const RT_COMP = __COMP__;
class DerizReverb extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const k = sampleRate / 44100;
    const D = [1423, 1747, 2111, 2503, 2909, 3361, 3797, 4241];   // panjang delay line (sampel @44,1 kHz), saling prima
    const A = [142, 107, 379, 277, 211];                          // allpass difusi: 3 untuk mid, 2 untuk side
    this.N = 8;
    this.len = D.map(d => Math.max(16, Math.round(d * k)));
    this.buf = this.len.map(n => new Float32Array(n));
    this.pos = new Int32Array(8);
    this.lp = new Float64Array(8);
    this.g = new Float64Array(8); this.tg = new Float64Array(8);
    this.alen = A.map(a => Math.max(8, Math.round(a * k)));
    this.abuf = this.alen.map(n => new Float32Array(n));
    this.apos = new Int32Array(5);
    this.damp = 1 - Math.exp(-2 * Math.PI * 9000 / sampleRate);   // low-pass umpan balik: treble meluruh lebih cepat
    this.norm = 1; this.tnorm = 1; this.rt = 0;
    this.idle = true; this.quiet = 0;
    this.tmp = new Float64Array(8); this.inj = new Float64Array(8);
    this.setRt(o.rt !== undefined ? o.rt : 1.6, true);
    this.port.onmessage = e => {
      const m = e.data;
      if (m.t === 'p') this.setRt(m.rt, false);
      else if (m.t === 'r') this.clear();
    };
  }
  setRt(rt, now) {
    rt = Math.max(0.2, Math.min(8, rt));
    this.rt = rt;
    const re = rt * RT_COMP;   // kompensasi: damping treble + difusi membuat RT60 terukur lebih pendek dari setelan
    for (let i = 0; i < 8; i++) this.tg[i] = Math.pow(10, -3 * (this.len[i] / sampleRate) / re);
    this.tnorm = __NORM__ * Math.pow(rt, -0.118);   // energi respons naik pelan terhadap RT60 (damping menahan), hasil ukur: kompensasi supaya level wet ~ sama untuk semua panjang gema
    if (now) { for (let i = 0; i < 8; i++) this.g[i] = this.tg[i]; this.norm = this.tnorm; }
  }
  clear() {
    for (let i = 0; i < 8; i++) this.buf[i].fill(0);
    for (let i = 0; i < 5; i++) this.abuf[i].fill(0);
    this.lp.fill(0); this.idle = true; this.quiet = 0;
  }
  ap(i, x) {   // allpass Schroeder g = 0,6
    const b = this.abuf[i], p = this.apos[i], d = b[p], v = x + d * -0.6;
    b[p] = v; this.apos[i] = p + 1 >= b.length ? 0 : p + 1;
    return d + v * 0.6;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const oL = out[0], oR = out[1] || out[0], n = oL.length;
    const inp = inputs[0], L = inp && inp[0], R = inp && (inp[1] || inp[0]);
    let peak = 0;
    if (L) { for (let i = 0; i < n; i++) { const a = Math.abs(L[i]), b = Math.abs(R[i]); if (a > peak) peak = a; if (b > peak) peak = b; } }
    if (this.idle) {
      if (peak < 1e-7) { oL.fill(0); if (oR !== oL) oR.fill(0); return true; }   // senyap dan ekor sudah habis: tidak ada yang dihitung
      this.idle = false; this.quiet = 0;
    }
    const buf = this.buf, len = this.len, pos = this.pos, lp = this.lp, g = this.g, tg = this.tg, damp = this.damp, t = this.tmp;
    const gs = 0.02;   // pergeseran gain per blok (RT60 diputar: geser mulus, tanpa klik)
    let outPeak = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0) { for (let j = 0; j < 8; j++) g[j] += (tg[j] - g[j]) * gs; this.norm += (this.tnorm - this.norm) * gs; }
      const xl = L ? L[i] : 0, xr = R ? R[i] : 0;
      const mid = this.ap(2, this.ap(1, this.ap(0, (xl + xr) * 0.5)));
      const side = this.ap(4, this.ap(3, (xl - xr) * 0.5));
      // baca 8 line, redam (low-pass), kali gain
      for (let j = 0; j < 8; j++) {
        const y = buf[j][pos[j]];
        lp[j] += damp * (y - lp[j]);
        t[j] = lp[j] * g[j];
      }
      // keluaran stereo: dua baris ortogonal dari line mentah (sebelum redam, supaya kilau awal tetap)
      let l = 0, r = 0;
      l += buf[0][pos[0]] - buf[1][pos[1]] + buf[2][pos[2]] - buf[3][pos[3]] + buf[4][pos[4]] - buf[5][pos[5]] + buf[6][pos[6]] - buf[7][pos[7]];
      r += buf[0][pos[0]] + buf[1][pos[1]] - buf[2][pos[2]] - buf[3][pos[3]] + buf[4][pos[4]] + buf[5][pos[5]] - buf[6][pos[6]] - buf[7][pos[7]];
      // matriks Hadamard 8x8 (transformasi cepat Walsh-Hadamard, 24 penjumlahan), diskala 1/sqrt(8)
      let a0 = t[0] + t[1], a1 = t[0] - t[1], a2 = t[2] + t[3], a3 = t[2] - t[3], a4 = t[4] + t[5], a5 = t[4] - t[5], a6 = t[6] + t[7], a7 = t[6] - t[7];
      let b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3, b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
      const s = 0.35355339059327373;
      const h0 = (b0 + b4) * s, h1 = (b1 + b5) * s, h2 = (b2 + b6) * s, h3 = (b3 + b7) * s, h4 = (b0 - b4) * s, h5 = (b1 - b5) * s, h6 = (b2 - b6) * s, h7 = (b3 - b7) * s;
      const m = mid * 0.5, sd = side * 0.5;   // injeksi: mid ke semua line, side dengan tanda berselang-seling (lebar stereo)
      let v;
      v = h0 + m + sd; buf[0][pos[0]] = v; v = h1 + m - sd; buf[1][pos[1]] = v;
      v = h2 + m + sd; buf[2][pos[2]] = v; v = h3 + m - sd; buf[3][pos[3]] = v;
      v = h4 + m + sd; buf[4][pos[4]] = v; v = h5 + m - sd; buf[5][pos[5]] = v;
      v = h6 + m + sd; buf[6][pos[6]] = v; v = h7 + m - sd; buf[7][pos[7]] = v;
      for (let j = 0; j < 8; j++) { const p = pos[j] + 1; pos[j] = p >= len[j] ? 0 : p; }
      const nk = this.norm * 0.35355339059327373;
      const ol = l * nk, or = r * nk;
      oL[i] = ol; oR[i] = or;
      const ab = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
      if (ab > outPeak) outPeak = ab; if (ar > outPeak) outPeak = ar;
    }
    // input senyap + ekor < -100 dB selama ~0,1 detik: berhenti menghitung dan bersihkan state (juga membuang denormal)
    if (peak < 1e-7 && outPeak < 1e-5) { if (++this.quiet > sampleRate / 1280) this.clear(); } else this.quiet = 0;
    return true;
  }
}
registerProcessor('deriz-reverb', DerizReverb);
`;

export const REVERB_COMP = 1.25;   // diatur dari hasil tes: RT60 terukur = setelan
export const REVERB_NORM = 1.8;   // diatur dari hasil tes (tools/reverb-test.ts): energi respons ~ impuls lama (energi 1)
export const REVERB_SRC = WORKLET_SRC.replace('__NORM__', String(REVERB_NORM)).replace('__COMP__', String(REVERB_COMP));   // dipakai tes di tools/

const loaded = new WeakSet<BaseAudioContext>();
const loading = new WeakMap<BaseAudioContext, Promise<void>>();

export const reverbLoaded = (ctx: BaseAudioContext): boolean => loaded.has(ctx);

export function loadReverb(ctx: BaseAudioContext): Promise<void> {
  let p = loading.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([REVERB_SRC], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(url).then(() => { loaded.add(ctx); }).finally(() => URL.revokeObjectURL(url));
    p.catch(() => loading.delete(ctx));   // gagal: boleh dicoba lagi
    loading.set(ctx, p);
  }
  return p;
}

export function createReverb(ctx: BaseAudioContext, rt: number): AudioWorkletNode {
  return new AudioWorkletNode(ctx, 'deriz-reverb', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { rt } });
}
