// Note slide (seperti FL Studio): note slide TIDAK memainkan sampel dari awal. Suara note yang sedang berbunyi (mis. C panjang)
// diteruskan, dan pada saat note slide mulai (mis. A pendek di bawahnya) pitch-nya langsung pindah ke nada slide, di posisi sampel
// yang sama. Jadi satu "voice" = satu note induk + deret perpindahan pitch (segs).
//
// Aturan: note slide menempel ke voice yang masih berbunyi saat slide mulai (note induk, atau voice yang sudah berpindah lewat slide
// sebelumnya). Kalau ada beberapa, dipilih yang mulainya paling akhir (seri: nada paling dekat). Voice berbunyi sampai ujung terpanjang
// antara note induk dan note slide yang menempel. Kalau tidak ada voice yang berbunyi, note slide dimainkan seperti note biasa
// (tetap berbunyi tepat di posisinya sendiri).
export interface SlideSrc { key: number; beat: number; len: number; slide?: boolean; }
export interface SlideSeg { off: number; key: number; len: number; }   // off = ketukan sejak awal voice, key = nada baru, len = panjang note slide (ketukan)
/** Segmen siap pakai player (detik): `dur` = lama luncuran. Seperti project DERIZ: lama luncuran = panjang note slide, maksimum 1 ketuk
 *  (slide pendek = transisi cepat, slide panjang = transisi lambat); pitch meluncur linear dalam semiton. */
export const GLIDE_MAX = 1;
export const segsToSec = (segs: SlideSeg[] | undefined, bps: number): { off: number; key: number; dur: number }[] | undefined =>
  segs?.map(g => ({ off: g.off / bps, key: g.key, dur: Math.min(g.len, GLIDE_MAX) / bps }));
export interface SlideInfo {
  len: number;          // panjang voice (ketukan) untuk note induk, sudah termasuk note slide yang menempel
  skip?: boolean;       // note slide yang menempel ke voice lain: tidak dimainkan sendiri
  from?: number;        // (hanya skip) nada sebelum pindah, untuk gambar penanda
  segs?: SlideSeg[];    // perpindahan pitch di tengah voice (urut waktu)
}

const EPS = 1e-6;
/** Info slide untuk tiap note (urutan sama dengan `notes`). Murah kalau tidak ada note slide sama sekali. */
export function slideInfo(notes: SlideSrc[]): SlideInfo[] {
  const out: SlideInfo[] = notes.map(n => ({ len: n.len }));
  if (!notes.some(n => n.slide)) return out;
  interface Chain { root: number; end: number; cur: number; last: number; segs: SlideSeg[]; }
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].beat - notes[b].beat || a - b);
  const chains: Chain[] = [];
  for (const i of order) {
    const n = notes[i];
    if (n.slide) {
      let best: Chain | null = null;
      for (const c of chains) {
        if (c.end < n.beat - EPS) continue;     // voice itu sudah selesai
        if (c.last >= n.beat - EPS) continue;   // di beat ini voice itu sudah berganti nada / baru mulai
        if (!best || c.last > best.last + EPS || (Math.abs(c.last - best.last) <= EPS && Math.abs(c.cur - n.key) < Math.abs(best.cur - n.key))) best = c;
      }
      if (best) {
        best.segs.push({ off: n.beat - notes[best.root].beat, key: n.key, len: n.len });
        out[i].skip = true; out[i].from = best.cur;
        best.cur = n.key; best.last = n.beat; best.end = Math.max(best.end, n.beat + n.len);
        continue;
      }
    }
    chains.push({ root: i, end: n.beat + n.len, cur: n.key, last: n.beat, segs: [] });
  }
  for (const c of chains) {
    const o = out[c.root];
    o.len = c.end - notes[c.root].beat;
    if (c.segs.length) o.segs = c.segs;
  }
  return out;
}
