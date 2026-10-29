// BPM Finder: perkiraan tempo dari audio. Alur: audio -> mono -> envelope onset (pita bawah + seluruh pita, ~200 fps) ->
// autokorelasi -> pilih tempo 60..200 BPM dengan skor "comb" (lag 1x, 2x, 4x) dan prior lebar di sekitar 120 BPM.
// Hasil bisa meleset oktaf (setengah / dua kali): tombol ½ dan ×2 di panel Tools untuk mengoreksinya.

export interface BpmResult { bpm: number; confidence: number }   // confidence: rasio puncak terhadap rata-rata skor (>= 1); audio berirama jelas ~25+, noise tanpa ritme ~14

export const BPM_SCAN_MIN = 60;
export const BPM_SCAN_MAX = 200;
const ENV_FPS = 200;

function flux(e: Float32Array): Float32Array {
  const out = new Float32Array(e.length);
  let sum = 0;
  for (let i = 1; i < e.length; i++) { const d = e[i] - e[i - 1]; out[i] = d > 0 ? d : 0; sum += out[i]; }
  const mean = sum / Math.max(1, e.length) || 1e-9;
  for (let i = 0; i < out.length; i++) out[i] /= mean;
  return out;
}

export function detectBpm(buf: { sampleRate: number; length: number; numberOfChannels: number; getChannelData(c: number): Float32Array }, maxSeconds = 150): BpmResult | null {
  const sr = buf.sampleRate;
  const n = Math.min(buf.length, Math.floor(maxSeconds * sr));
  if (n < sr * 8) return null;   // terlalu pendek (< 8 detik) untuk tempo yang bisa dipercaya

  const ch = buf.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }

  const hop = Math.max(1, Math.round(sr / ENV_FPS));
  const fps = sr / hop;
  const frames = Math.floor(n / hop);
  const low = new Float32Array(frames), full = new Float32Array(frames);
  const a = 1 - Math.exp((-2 * Math.PI * 200) / sr);   // low-pass ~200 Hz (kick / bass)
  let lp = 0, prev = 0;
  for (let f = 0; f < frames; f++) {
    let sl = 0, sf = 0;
    for (let i = f * hop, e = i + hop; i < e; i++) {
      const x = mono[i];
      lp += a * (x - lp);
      const hp = x - prev; prev = x;
      sl += lp * lp; sf += hp * hp;
    }
    low[f] = Math.log1p(100 * Math.sqrt(sl / hop));
    full[f] = Math.log1p(100 * Math.sqrt(sf / hop));
  }

  const fl = flux(low), ff = flux(full);
  const nov = new Float32Array(frames);
  for (let i = 0; i < frames; i++) nov[i] = fl[i] + ff[i];

  // buang rata-rata lokal (jendela ~0,5 dtk tiap sisi) supaya hanya puncak onset yang tersisa
  const cum = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cum[i + 1] = cum[i] + nov[i];
  const w = Math.round(fps * 0.5);
  const flat = new Float32Array(frames);
  let gsum = 0;
  for (let i = 0; i < frames; i++) {
    const lo = Math.max(0, i - w), hi = Math.min(frames, i + w + 1);
    const v = nov[i] - (cum[hi] - cum[lo]) / (hi - lo);
    flat[i] = v > 0 ? v : 0; gsum += flat[i];
  }
  const gmean = gsum / frames;
  for (let i = 0; i < frames; i++) flat[i] -= gmean;

  // autokorelasi sampai lag 4x periode tempo paling lambat
  const maxLag = Math.ceil((fps * 60 / BPM_SCAN_MIN) * 4) + 2;
  if (frames < maxLag * 2) return null;
  const acf = new Float32Array(maxLag + 2);
  for (let l = 1; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0, e = frames - l; i < e; i++) s += flat[i] * flat[i + l];
    acf[l] = s / (frames - l);
  }
  const acfAt = (lag: number): number => {
    const i = Math.floor(lag), fr = lag - i;
    return acf[i] * (1 - fr) + acf[i + 1] * fr;
  };
  const raw = (bpm: number): number => {
    const lag = (fps * 60) / bpm;
    return acfAt(lag) + 0.5 * acfAt(lag * 2) + 0.25 * acfAt(lag * 4);
  };
  const prior = (bpm: number): number => { const o = Math.log2(bpm / 120) / 1.0; return Math.exp(-0.5 * o * o); };

  let best = 0, bestScore = -Infinity, rawSum = 0, cnt = 0;
  for (let bpm = BPM_SCAN_MIN; bpm <= BPM_SCAN_MAX; bpm += 0.5) {
    const r = raw(bpm); rawSum += Math.max(0, r); cnt++;
    const s = r * prior(bpm);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  if (!(bestScore > 0)) return null;

  // halusi di sekitar puncak (langkah 0,02 BPM)
  let fine = best, fineScore = -Infinity;
  for (let bpm = Math.max(BPM_SCAN_MIN, best - 1); bpm <= Math.min(BPM_SCAN_MAX, best + 1); bpm += 0.02) {
    const s = raw(bpm) * prior(bpm);
    if (s > fineScore) { fineScore = s; fine = bpm; }
  }
  const mean = rawSum / cnt || 1e-9;
  return { bpm: Math.round(fine * 10) / 10, confidence: Math.max(1, raw(fine) / mean) };
}
