// AUTOTUNE (mesin): koreksi pitch real-time untuk vokal, jalan di AudioWorklet, dipasang sebagai efek track (audio clip vokal).
// Mesin ini BERDIRI SENDIRI: tidak memakai kode MPCS / DERIZ / plugin lain (algoritmanya sejenis, tetapi ditulis ulang di sini).
//
// Algoritma:
//   1. Deteksi pitch (YIN): sinyal mono (kiri + kanan) di-downsample ke ~11 kHz, dihitung fungsi selisih d(tau) lalu cumulative-mean-normalized.
//      Dip pertama di bawah 0,15 dipilih (supaya tidak lompat oktaf), lalu periodenya dihaluskan dengan interpolasi parabola dan DIPERHALUS
//      lagi di sample rate penuh (akurasi < 1 sen untuk vokal). Perlindungan lompat oktaf (harus bertahan 4 frame), median 3 frame,
//      histeresis voiced/unvoiced (2 frame masuk, 4 frame keluar), gerbang level -56 dB.
//   2. Target nada: nada terdekat dari kelas nada yang diizinkan (bitmask 12 bit dari keyboard / skala), dipilih dari PUSAT NADA (rata-rata lambat ~120 ms,
//      bukan pitch sesaat) dengan histeresis, supaya vibrato lebar di dekat batas dua nada tidak membuat target bolak-balik. Saat Speed tinggi (tc kecil),
//      pusat nada cuma ~15 ms dan histeresis kecil, jadi nada langsung terkunci seperti hard-tune; saat Speed rendah ~120 ms dan histeresis lebih lebar. Koreksi (semiton) = (target - nada asli) x Amount, lalu dihaluskan satu kutub dengan waktu Speed:
//      Fast (0 ms) = lompat seketika (efek robotik), Slow = vibrato alami ikut terjaga.
//   3. Penggeser pitch (pitch-synchronous overlap-add): tanda periode dilacak di sinyal masuk lewat KEMIRIPAN BENTUK GELOMBANG (korelasi ternormalisasi satu periode
//      terhadap tanda sebelumnya, dihaluskan ke pecahan sample), bukan puncak gelombang, jadi fase antar siklus konsisten (derau antar-harmonik jauh lebih kecil).
//      Potongan 2 periode ber-window Hann diambil di tanda terdekat, lalu ditaruh ulang dengan jarak periode / rasio. Pecahan sample dijaga lewat interpolasi linear;
//      level dinormalkan dengan JUMLAH WINDOW SEBENARNYA di tiap sample (tanpa riak amplitudo walau jarak potongan tak teratur). Suara tak-bernada (desis, napas, hening) lewat jalur dry yang ditunda sama panjang.
//   4. Latensi tetap = 3 x periode terpanjang (80 Hz) ~ 37 ms (sr/80 x 3 sample); audio-engine mengimbanginya di jadwal clip.
//
// Pesan ke prosesor: { t: 'p', amount (0..1), tc (ms, waktu retune), mask (bitmask 12 kelas nada), on }.
// Pesan dari prosesor: { t: 'f', raw, out } = nada MIDI (pecahan) suara asli dan hasil, atau -1 kalau tak-bernada (untuk strip tuner).

const WORKLET_SRC = `
class DerizAutotune extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const sr = sampleRate;
    this.N = 16384; this.M = 16383;
    this.iL = new Float32Array(this.N); this.iR = new Float32Array(this.N); this.iM = new Float32Array(this.N);
    this.oL = new Float32Array(this.N); this.oR = new Float32Array(this.N); this.ws = new Float32Array(this.N); this.ctr = NaN;
    this.wp = 0;
    this.LAT = Math.ceil(sr / 80 * 3);
    this.D = Math.max(1, Math.round(sr / 11025));
    this.Wd = 320;
    this.tMin = Math.max(2, Math.floor(sr / this.D / 1000));
    this.tMax = Math.ceil(sr / this.D / 80);
    this.xd = new Float64Array(this.Wd + this.tMax + 2);
    this.d = new Float64Array(this.tMax + 2); this.cm = new Float64Array(this.tMax + 2);
    this.amount = o.amount !== undefined ? o.amount : 1; this.tc = o.tc !== undefined ? o.tc : 40;
    this.mask = o.mask !== undefined ? o.mask : 0xFFF; this.on = o.on !== false;
    this.hop = 256; this.since = 0;
    this.pPrev = 0; this.oct = 0; this.h = [0, 0, 0]; this.hn = 0;
    this.vc = 0; this.uc = 0; this.voiced = false;
    this.per = sr / 150; this.tgt = NaN; this.cur = 0; this.ratio = 1;
    this.mk = new Float64Array(1024); this.mn = 0; this.last = 0;
    this.s = 0;
    this.wet = 0; this.fadeStep = 1 / (0.008 * sr);
    this.fr = 0;
    this.gi = 1; this.go = 1; this.mix = 1; this.pkI = 0; this.pkO = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m && m.t === 'p') { this.amount = m.amount; this.tc = m.tc; this.mask = m.mask; this.on = m.on; this.gi = m.gi > 0 ? m.gi : 1; this.go = m.go > 0 ? m.go : 1; this.mix = m.mix >= 0 && m.mix <= 1 ? m.mix : 1; }
    };
  }
  // periode (sample, pecahan) dari YIN; 0 = tak-bernada
  detect() {
    const M = this.M, D = this.D, Wd = this.Wd, tMax = this.tMax, tMin = this.tMin, L = Wd + tMax, xd = this.xd, iM = this.iM, wp = this.wp, d = this.d, cm = this.cm;
    let e = 0;
    for (let i = 1; i <= 1024; i++) { const v = iM[(wp - i) & M]; e += v * v; }
    if (Math.sqrt(e / 1024) < 0.0015) return 0;
    for (let j = 0; j < L; j++) {
      let a = 0; const base = wp - (L - j) * D;
      for (let k = 0; k < D; k++) a += iM[(base + k) & M];
      xd[j] = a / D;
    }
    const o = L - Wd;
    d[0] = 0;
    for (let t = 1; t <= tMax; t++) { let s = 0; for (let j = 0; j < Wd; j++) { const df = xd[o + j] - xd[o + j - t]; s += df * df; } d[t] = s; }
    let run = 0; cm[0] = 1;
    for (let t = 1; t <= tMax; t++) { run += d[t]; cm[t] = run > 0 ? d[t] * t / run : 1; }
    let tau = -1;
    for (let t = tMin; t < tMax; t++) {
      if (cm[t] < 0.15) { while (t + 1 < tMax && cm[t + 1] < cm[t]) t++; tau = t; break; }
    }
    if (tau < 0) {
      let bm = 1e9, bt = -1;
      for (let t = tMin; t < tMax; t++) if (cm[t] < bm) { bm = cm[t]; bt = t; }
      if (bm < 0.3) tau = bt;
    }
    if (tau < 0) return 0;
    let tf = tau;
    if (tau > 1 && tau < tMax) { const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1], den = a - 2 * b + c; if (den > 1e-9) tf = tau + 0.5 * (a - c) / den; }
    // perhalus di sample rate penuh
    const c0 = Math.round(tf * D), lo = Math.max(tMin * D - 1, c0 - D - 1), hi = c0 + D + 1, Wf = 768, n = hi - lo + 1, df = new Float64Array(n);
    let bi = 0;
    for (let k = 0; k < n; k++) {
      const t = lo + k; let s = 0;
      for (let j = 1; j <= Wf; j++) { const x = iM[(wp - j) & M] - iM[(wp - j - t) & M]; s += x * x; }
      df[k] = s; if (s < df[bi]) bi = k;
    }
    let p = lo + bi;
    if (bi > 0 && bi < n - 1) { const a = df[bi - 1], b = df[bi], c = df[bi + 1], den = a - 2 * b + c; if (den > 1e-12) p += 0.5 * (a - c) / den; }
    return p;
  }
  allowed(m) { return (this.mask >> (((m % 12) + 12) % 12)) & 1; }
  nearest(mr) {
    const base = Math.round(mr); let best = null, bd = 1e9;
    for (let m = base - 7; m <= base + 7; m++) { if (!this.allowed(m)) continue; const dd = Math.abs(m - mr); if (dd < bd) { bd = dd; best = m; } }
    return best;
  }
  frame() {
    const sr = sampleRate;
    let p = this.detect();
    if (p > 0) {
      const pv = this.pPrev;
      if (pv > 0) {
        const r = p / pv;
        if (Math.abs(r - 2) < 0.15 || Math.abs(r - 0.5) < 0.08) { if (++this.oct < 4) p = pv; else this.oct = 0; } else this.oct = 0;
      }
      this.h[this.hn % 3] = p; this.hn++;
      if (this.hn >= 3) { const a = this.h[0], b = this.h[1], c = this.h[2]; p = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
      this.vc++; this.uc = 0;
    } else { this.uc++; this.vc = 0; }
    let onset = false;
    if (!this.voiced && this.vc >= 2) { this.voiced = true; onset = true; this.hn = 0; }
    if (this.voiced && this.uc >= 4) { this.voiced = false; this.pPrev = 0; this.tgt = NaN; this.ctr = NaN; }
    if (!this.voiced) { this.fr++; if (this.fr % 3 === 0) this.port.postMessage({ t: 'f', raw: -1, out: -1, li: this.pkI, lo: this.pkO }); this.pkI = 0; this.pkO = 0; return; }
    if (p > 0) {
      this.pPrev = p;
      this.per = Math.min(sr / 70, Math.max(sr / 1100, p));
      const f = sr / p, mr = 69 + 12 * Math.log2(f / 440);
      let des = 0;
      // pusat nada (rata-rata lambat ~120 ms): pemilihan nada tuju memakai ini, bukan pitch sesaat, supaya vibrato lebar di dekat batas dua nada tidak membuat target bolak-balik
      if (onset || this.ctr !== this.ctr || Math.abs(mr - this.ctr) > 0.8) this.ctr = mr; else this.ctr += (mr - this.ctr) * (1 - Math.exp(-(this.hop / sr) / (0.015 + 0.105 * Math.min(1, this.tc / 150))));
      const nr = this.nearest(this.ctr);
      if (nr === null) { this.tgt = NaN; }
      else {
        let t = this.tgt;
        if (onset || t !== t || !this.allowed(t)) t = nr;
        else if (nr !== t && Math.abs(this.ctr - nr) < Math.abs(this.ctr - t) - (0.08 + 0.12 * Math.min(1, this.tc / 100))) t = nr;
        this.tgt = t;
        des = (t - mr) * this.amount;
        if (des > 12) des = 12; else if (des < -12) des = -12;
      }
      const dt = this.hop / sr, a = this.tc <= 2 ? 1 : 1 - Math.exp(-dt * 1000 / this.tc);
      if (onset) this.cur = des; else this.cur += (des - this.cur) * a;
      this.ratio = Math.pow(2, this.cur / 12);
      this.fr++;
      if (this.fr % 3 === 0) { this.port.postMessage({ t: 'f', raw: mr, out: mr + this.cur, li: this.pkI, lo: this.pkO }); this.pkI = 0; this.pkO = 0; }
    }
  }
  extendMarks() {
    // tanda periode berikutnya = posisi dengan bentuk gelombang paling mirip (korelasi ternormalisasi) dengan satu periode di sekitar tanda sebelumnya,
    // dicari di sekitar last + periode, lalu dihaluskan ke pecahan sample (parabola). Jauh lebih konsisten daripada memilih puncak (tidak melompat antar puncak formant).
    const M = this.M, iM = this.iM, mk = this.mk;
    for (let guard = 0; guard < 32; guard++) {
      const T = this.per;
      if (this.last + T * 1.75 + 6 >= this.wp) break;
      const Lw = Math.max(8, Math.min(512, Math.round(T))), hw = Lw >> 1, r = Math.max(2, Math.floor(T * 0.15));
      if (this.mn === 0) {   // tanda pertama: puncak lokal terbesar
        let best = -1e9, bi = Math.round(this.last);
        for (let i = Math.floor(this.last); i < Math.floor(this.last + T); i++) { const v = iM[i & M]; if (v > best) { best = v; bi = i; } }
        this.last = bi; mk[this.mn & 1023] = bi; this.mn++; continue;
      }
      const ref = this.rf || (this.rf = new Float64Array(1024)), L = this.last, l0 = Math.floor(L), lf = L - l0;
      let er = 0;
      for (let j = -hw; j < hw; j++) { const a = iM[(l0 + j) & M], b = iM[(l0 + j + 1) & M], v = a + (b - a) * lf; ref[j + hw] = v; er += v * v; }
      const pred = Math.round(L + T), nc = 2 * r + 1, sc = this.sc || (this.sc = new Float64Array(2048));
      let bk = 0, bv = -2;
      for (let k = 0; k < nc; k++) {
        const c = pred - r + k; let dot = 0, ec = 0;
        for (let j = -hw; j < hw; j++) { const v = iM[(c + j) & M]; dot += ref[j + hw] * v; ec += v * v; }
        const q = dot / Math.sqrt(er * ec + 1e-12) - 0.0002 * Math.abs(c - pred) / r;   // sedikit condong ke prediksi (tanpa melompat)
        sc[k] = q; if (q > bv) { bv = q; bk = k; }
      }
      let pos = pred - r + bk;
      if (bk > 0 && bk < nc - 1) { const A = sc[bk - 1], B = sc[bk], C = sc[bk + 1], den = A - 2 * B + C; if (den < -1e-12) pos += Math.max(-0.5, Math.min(0.5, 0.5 * (A - C) / den)); }
      if (pos <= this.last) pos = this.last + Math.max(1, Math.round(T));
      this.last = pos; mk[this.mn & 1023] = pos; this.mn++;
    }
  }
  nearestMark(s) {
    if (this.mn === 0) return Math.round(s);
    let i = this.mn - 1, steps = 0;
    while (i > 0 && steps < 600 && this.mk[i & 1023] > s) { i--; steps++; }
    const a = this.mk[i & 1023], b = i + 1 < this.mn ? this.mk[(i + 1) & 1023] : a;
    const m = Math.abs(a - s) <= Math.abs(b - s) ? a : b;
    return Math.abs(m - s) > this.per * 2 ? Math.round(s) : m;
  }
  grains() {
    const M = this.M, LAT = this.LAT, iL = this.iL, iR = this.iR, oL = this.oL, oR = this.oR;
    for (let guard = 0; guard < 64; guard++) {
      const T = this.per, ratio = this.ratio, Ts = T / ratio;
      let Lg = 2 * Math.max(T, Ts);
      const cap = LAT - T / 2 - 6;
      if (Lg > cap) Lg = cap;
      if (this.s - Lg / 2 + LAT > this.wp) break;
      if (this.s < this.wp - LAT - Lg) this.s = this.wp - LAT;
      const a = this.nearestMark(this.s);
      if (a + Lg / 2 + 3 >= this.wp) Lg = 2 * (this.wp - a - 3);
      if (Lg < 8) { this.s += Ts; continue; }
      const h = Lg / 2, b = Math.floor(this.s), f = this.s - b, ws = this.ws;
      const n0 = -Math.floor(h) - 1, n1 = Math.floor(h) + 1;
      for (let n = n0; n <= n1; n++) {
        const u = n - f; if (u < -h || u > h) continue;
        const w = 0.5 * (1 + Math.cos(Math.PI * u / h));
        const pos = a + u, i0 = Math.floor(pos), fr = pos - i0, j0 = i0 & M, j1 = (i0 + 1) & M, q = (b + n) & M;
        ws[q] += w; oL[q] += w * (iL[j0] + (iL[j1] - iL[j0]) * fr);
        oR[q] += w * (iR[j0] + (iR[j1] - iR[j0]) * fr);
      }
      this.s += Ts;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out.length) return true;
    const inp = inputs[0], n = out[0].length, M = this.M, LAT = this.LAT;
    const L = inp && inp[0] ? inp[0] : null, R = inp && inp[1] ? inp[1] : L;
    const oL = out[0], oR = out[1] || out[0], wp0 = this.wp;
    for (let i = 0; i < n; i++) {
      const l = L ? L[i] * this.gi : 0, r = R ? R[i] * this.gi : 0, k = (wp0 + i) & M;
      this.iL[k] = l; this.iR[k] = r; this.iM[k] = 0.5 * (l + r);
    }
    this.wp = wp0 + n;
    this.since += n;
    while (this.since >= this.hop) { this.since -= this.hop; this.frame(); }
    this.extendMarks();
    this.grains();
    const tgt = this.on && this.voiced ? 1 : 0, st = this.fadeStep;
    let w = this.wet;
    for (let i = 0; i < n; i++) {
      const q = (wp0 + i - LAT) & M;
      const nrm = 1 / Math.max(this.ws[q], 0.5), wl = this.oL[q] * nrm, wr = this.oR[q] * nrm; this.oL[q] = 0; this.oR[q] = 0; this.ws[q] = 0;
      const dl = this.iL[q], dr = this.iR[q];
      if (w < tgt) { w += st; if (w > tgt) w = tgt; } else if (w > tgt) { w -= st; if (w < tgt) w = tgt; }
      const wm = w * this.mix, go = this.go; oL[i] = (dl + wm * (wl - dl)) * go; oR[i] = (dr + wm * (wr - dr)) * go;
      const a1 = Math.abs(dl); if (a1 > this.pkI) this.pkI = a1; const a2 = Math.abs(oL[i]); if (a2 > this.pkO) this.pkO = a2;
    }
    this.wet = w;
    return true;
  }
}
registerProcessor('deriz-autotune', DerizAutotune);
`;

export const AUTOTUNE_SRC = WORKLET_SRC;   // dipakai tes di tools/

const loaded = new WeakSet<BaseAudioContext>();
const loading = new WeakMap<BaseAudioContext, Promise<void>>();

export const autotuneLoaded = (ctx: BaseAudioContext): boolean => loaded.has(ctx);

export function loadAutotune(ctx: BaseAudioContext): Promise<void> {
  let p = loading.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(url).then(() => { loaded.add(ctx); }).finally(() => URL.revokeObjectURL(url));
    p.catch(() => loading.delete(ctx));   // gagal: boleh dicoba lagi
    loading.set(ctx, p);
  }
  return p;
}

export interface AutotuneMsg { amount: number; tc: number; mask: number; on: boolean; gi?: number; go?: number; mix?: number }

/** Latensi tetap node AUTOTUNE (detik) pada sample rate ini: 3 x periode 80 Hz. */
export const autotuneLatencySec = (sr: number): number => Math.ceil(sr / 80 * 3) / sr;

export function createAutotune(ctx: BaseAudioContext, init?: AutotuneMsg): AudioWorkletNode {
  return new AudioWorkletNode(ctx, 'deriz-autotune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: init });
}
