// Helper kecil yang dipakai bersama panel efek dan panel mixer.
export const SVGNS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// koordinat di kanvas knob 40x40 (pusat 20,20); sudut 0 = jam 12
export function polar(r: number, deg: number): [number, number] {
  const a = (deg - 90) * Math.PI / 180;
  return [20 + r * Math.cos(a), 20 + r * Math.sin(a)];
}

export function arc(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 >= a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// warna teks yang terbaca di atas warna latar hex (gelap di warna terang, terang di warna gelap)
export function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#1D2226';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.5 ? '#1D2226' : '#F2F3F6';
}

// semua warna track yang tersedia (20): 7 pertama diekstrak dari piksel clip audio di gambar referensi, 13 sisanya melengkapi spektrum;
// dipakai untuk warna acak track baru, menu Color di playlist, dan menu Color di titik tiga channel mixer
export const TRACK_COLORS = [
  '#FE32CF', '#33BB03', '#F96303', '#9741A2', '#C32862', '#2D4793', '#584893',
  '#E8212B', '#FFB300', '#F2E205', '#A6D608', '#00A86B', '#12B5A6', '#00B7EB', '#1E88E5', '#5E35E8', '#B04BFF', '#FF6FA5', '#8D5A3B', '#7C8794'
];
