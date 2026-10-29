// Peak pyramid waveform, mengikuti hasil bedah CSampleBankItem::CreatePeaks / GetPeaks / StudioUI::DrawAudioWave
// FL Studio Mobile 3.4.5 (lihat FLM-waveform-audioclip.md).
//
// Ide utamanya:
//  - Peak disimpan sebagai MIN dan MAX terpisah (int8, -127..127), bukan nilai mutlak, jadi bentuk asli gelombang terjaga.
//  - Min dan max dimulai dari 0, jadi envelope selalu mencakup garis nol (bagian sunyi menempel di tengah).
//  - Banyak tingkat resolusi (piramid): tiap level setengah resolusi dari level di bawahnya.
//    Saat digambar dipilih level yang menghasilkan ±2 sampai 4 entri per pixel, jadi biaya gambar sebanding lebar layar,
//    bukan panjang file.
//  - Antar dua entri bertetangga dilakukan interpolasi linear (scroll dan zoom pelan tidak "melompat").
//  - Di bawah resolusi level paling halus, nilai dihitung langsung dari sampel mentah (zoom sangat dalam tetap akurat).

const BASE = 16;      // jumlah frame yang diwakili 1 entri di level 0 (level k = BASE << k)
const SLICE = 1 << 20; // frame diproses per irisan sebelum memberi napas ke UI thread

export interface PeakLevel { step: number; n: number; min: Int8Array; max: Int8Array; }
export interface Pyramid { ch: number; frames: number; levels: PeakLevel[]; }

const q8 = (v: number): number => { const r = (v * 127) | 0; return r > 127 ? 127 : r < -127 ? -127 : r; };   // dipotong ke arah nol, seperti FL
const breathe = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/** Bangun piramid peak dari AudioBuffer. Berjalan bertahap (async) supaya file panjang tidak menahan UI. */
export async function buildPyramid(buf: AudioBuffer): Promise<Pyramid> {
  const ch = Math.min(2, buf.numberOfChannels), frames = buf.length;
  const n0 = Math.max(1, Math.ceil(frames / BASE));
  const min0 = new Int8Array(n0 * ch), max0 = new Int8Array(n0 * ch);
  const per = Math.max(1, SLICE / BASE);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let e0 = 0; e0 < n0; e0 += per) {
      const e1 = Math.min(n0, e0 + per);
      for (let e = e0; e < e1; e++) {
        const a = e * BASE, b = Math.min(frames, a + BASE);
        let lo = 0, hi = 0;   // mulai dari nol: envelope selalu mencakup garis nol
        for (let i = a; i < b; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        min0[e * ch + c] = q8(lo); max0[e * ch + c] = q8(hi);
      }
      await breathe();
    }
  }
  const levels: PeakLevel[] = [{ step: BASE, n: n0, min: min0, max: max0 }];
  // level atas: gabung dua entri level bawah jadi satu
  for (let prev = levels[0]; prev.n > 2;) {
    const n = Math.ceil(prev.n / 2), mn = new Int8Array(n * ch), mx = new Int8Array(n * ch);
    for (let e = 0; e < n; e++) {
      const i = e * 2, j = Math.min(prev.n - 1, i + 1);
      for (let c = 0; c < ch; c++) {
        mn[e * ch + c] = Math.min(prev.min[i * ch + c], prev.min[j * ch + c]);
        mx[e * ch + c] = Math.max(prev.max[i * ch + c], prev.max[j * ch + c]);
      }
    }
    const lv = { step: prev.step * 2, n, min: mn, max: mx };
    levels.push(lv); prev = lv;
  }
  return { ch, frames, levels };
}

const INV = 1 / 127;

/**
 * Isi outMax / outMin dengan `cols` kolom pixel untuk rentang frame [start, start + cols * fpp).
 * Layout keluaran selang-seling per channel: indeks = kolom * ch + channel. Nilai 1..-1.
 * Kolom yang jatuh sebelum frame 0 atau sesudah akhir file dibiarkan 0.
 */
export function getPeaks(p: Pyramid, buf: AudioBuffer, start: number, fpp: number, cols: number, outMax: Float32Array, outMin: Float32Array): void {
  const ch = p.ch, total = p.frames;
  outMax.fill(0, 0, cols * ch); outMin.fill(0, 0, cols * ch);
  if (!(fpp > 0) || cols < 1) return;

  // level terbesar yang ukuran entrinya <= setengah frame per pixel (±2..4 entri per pixel; FL memakai ±1..2, ini sedikit lebih
  // teliti karena kesalahan di dua ujung kolom jadi lebih kecil); lebih halus dari level 0 = hitung dari sampel mentah
  let lv: PeakLevel | null = null;
  for (const l of p.levels) { if (l.step * 2 <= fpp) lv = l; else break; }

  if (!lv) {   // zoom sangat dalam: hitung langsung dari sampel (rentang terlihat kecil, jadi murah)
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let col = 0; col < cols; col++) {
        const s0 = start + col * fpp;
        if (s0 >= total) break;
        if (s0 + fpp <= 0) continue;
        const i0 = Math.max(0, Math.floor(s0)), i1 = Math.min(total - 1, Math.floor(s0 + fpp) + 1);   // +1: sertakan sampel berikutnya supaya kurva tersambung
        let lo = 0, hi = 0;
        for (let i = i0; i <= i1; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        outMax[col * ch + c] = hi; outMin[col * ch + c] = lo;
      }
    }
    return;
  }

  const { step, n, min, max } = lv, last = n - 1;
  const per = fpp / step;   // entri per pixel
  for (let col = 0; col < cols; col++) {
    const s0 = start + col * fpp;
    if (s0 >= total) break;
    if (s0 + fpp <= 0) continue;
    const a = Math.max(0, s0) / step, b = a + per;
    const i = Math.min(last, Math.floor(a)), fa = a - Math.floor(a), j = Math.min(last, i + 1);
    const ie = Math.min(last, Math.floor(b)), fb = b - Math.floor(b), je = Math.min(last, ie + 1);
    for (let c = 0; c < ch; c++) {
      // ujung kiri: interpolasi linear antara entri i dan i + 1
      let lo = min[i * ch + c] + (min[j * ch + c] - min[i * ch + c]) * fa;
      let hi = max[i * ch + c] + (max[j * ch + c] - max[i * ch + c]) * fa;
      // entri penuh di antara kedua ujung
      for (let k = i + 1; k <= ie; k++) {
        const m = min[k * ch + c], x = max[k * ch + c];
        if (m < lo) lo = m; if (x > hi) hi = x;
      }
      // ujung kanan: interpolasi linear antara entri ie dan ie + 1
      const m2 = min[ie * ch + c] + (min[je * ch + c] - min[ie * ch + c]) * fb;
      const x2 = max[ie * ch + c] + (max[je * ch + c] - max[ie * ch + c]) * fb;
      if (m2 < lo) lo = m2; if (x2 > hi) hi = x2;
      outMax[col * ch + c] = hi > 0 ? hi * INV : 0;    // jepit: min <= 0 <= max
      outMin[col * ch + c] = lo < 0 ? lo * INV : 0;
    }
  }
}
