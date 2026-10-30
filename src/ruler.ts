// Penggaris (ruler) bersama playlist canvas dan piano roll: hanya angka (tanpa garis tick, tanpa bulatan), nomor bar di garis bar,
// "bar.ketukan" saat zoom cukup dekat. Kedua canvas memanggil fungsi ini, jadi tampilannya selalu sama.
// Langkah label dipilih otomatis supaya teks tidak saling menimpa: 1 ketukan -> 1 bar -> 2 bar -> 4 bar -> ...
export interface RulerOpts {
  ctx: CanvasRenderingContext2D;
  areaX: number; areaW: number; rulerH: number;   // area penggaris (px canvas); tinggi = rulerH
  cell: number; V: number;                        // ukuran cell dan skala garis
  posH: number; pxBeat: number; bpb: number;      // gulir horizontal (ketukan), px per ketukan, ketukan per bar
  bg: string; tick: string; tickBar: string;      // warna latar, nomor ketukan (redup), nomor bar (terang)
  avoid?: { l: number; r: number } | null;        // rentang x yang ditutup tombol play: label di bawahnya dihindari (null = tombol tersembunyi)
  maxBeat?: number;                               // label tidak digambar mulai ketukan ini (panjang clip di piano roll)
  underlay?: () => void;                          // digambar di atas latar, di bawah angka (mis. blok seleksi piano roll); sudah di-clip ke penggaris
}
const near = (v: number): boolean => Math.abs(v - Math.round(v)) < 1e-6;
export function rulerLabelStep(fontPx: number, pxBeat: number, bpb: number): number {
  const minPx = fontPx * 3.4;   // ruang untuk teks selebar "128.4" + napas
  let s = bpb > 1 ? 1 : bpb;
  while (s * pxBeat < minPx) s = s < bpb ? bpb : s * 2;
  return s;
}
export function drawRulerLabels(o: RulerOpts): void {
  const { ctx, areaX, areaW, rulerH, cell, V, posH, pxBeat: pb, bpb } = o;
  ctx.save();
  ctx.beginPath(); ctx.rect(areaX, 0, areaW, rulerH); ctx.clip();
  ctx.fillStyle = o.bg; ctx.fillRect(areaX, 0, areaW, rulerH);
  o.underlay?.();
  const fontPx = Math.round(cell * 0.46);
  const step = rulerLabelStep(fontPx, pb, bpb);
  const bx = (b: number): number => areaX + (b - posH) * pb;
  const k0 = Math.floor(posH / step) - 1, k1 = Math.ceil((posH + areaW / pb) / step);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const pad = Math.round(cell * 0.28), cy = Math.round(rulerH / 2) + V;
  const bl = o.avoid ? o.avoid.l : Infinity, br = o.avoid ? o.avoid.r : -Infinity;
  for (let k = Math.max(0, k0); k <= k1; k++) {
    const b = k * step, x = bx(b);
    if (x > areaX + areaW) break;
    if (o.maxBeat !== undefined && b >= o.maxBeat - 1e-9) break;
    const bar = Math.floor(b / bpb + 1e-9), isBar = near(b / bpb);
    ctx.font = (isBar ? '600 ' : '400 ') + fontPx + 'px system-ui,sans-serif';
    ctx.fillStyle = isBar ? o.tickBar : o.tick;   // nomor bar terang, ketukan lebih redup
    const text = isBar ? String(bar + 1) : `${bar + 1}.${Math.round(b - bar * bpb) + 1}`;
    let tx = Math.round(x + pad);
    const tw = ctx.measureText(text).width;
    if (tx < br && tx + tw > bl) {   // label tertutup tombol play
      if (k !== 0) continue;         // label lain disembunyikan selama tertimpa tombol
      const next = bx(b + step) + pad;   // bar 1: geser ke kanan tombol kalau label berikutnya masih muat
      if (next - (br + pad) < fontPx * 1.8) continue;
      tx = Math.round(br + pad);
    }
    ctx.fillText(text, tx, cy);
  }
  ctx.restore();
}
