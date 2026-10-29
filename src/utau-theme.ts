// UtauTheme: gaya UI ketiga (atribut data-uistyle="utau" di <html>), bentuk playlist + pattern (piano roll) meniru OpenUtau Mobile.
// BERDIRI SENDIRI: file ini tidak mengimpor / mengubah ui-theme.ts (Default / Flat). Tema lain tidak membaca apa pun dari sini,
// dan semua cabang UtauTheme di file lain hanya aktif kalau isUtau() = true. CSS-nya ada di utau-ui.css (token --utau-*).
//
// Sumber warna: skema gelap Material You OpenUtau Mobile dengan seed bawaan #66CCFF (OpenUtau.Core Preferences.ThemeColorSeedHex),
// dipetakan seperti ThemeGenerator.cs: WhiteKey = Outline, BlackKey = Surface, CenterKey = PrimaryContainer, dst.
// Nilai di sini HARUS sama dengan token --utau-* di utau-ui.css (CSS sumber utama; tabel ini cermin untuk canvas).

/** true bila gaya UI UtauTheme sedang aktif (aman dipanggil di Node / tes: tanpa document = false). */
export const isUtau = (): boolean => typeof document !== 'undefined' && document.documentElement.dataset.uistyle === 'utau';

export interface UtauCols {
  // permukaan
  bg: string; surface: string; lowest: string; low: string; container: string; high: string; highest: string; dim: string;
  // teks & garis
  onSurface: string; onSurfaceVariant: string; outline: string; outlineVariant: string;
  // aksen
  primary: string; onPrimary: string; primaryContainer: string; onPrimaryContainer: string;
  // piano roll (pemetaan WhiteKey / BlackKey / CenterKey seperti ThemeGenerator.cs, varian gelap)
  whiteKey: string; blackKey: string; centerKey: string; whiteRow: string; blackRow: string;
  // playhead
  play: string;
}

export const UTAU: UtauCols = {
  bg: '#191C1E', surface: '#191C1E', lowest: '#0C0F10', low: '#191C1E', container: '#1D2022', high: '#282A2C', highest: '#323537', dim: '#111416',
  onSurface: '#E1E2E5', onSurfaceVariant: '#C0C7CD', outline: '#8A9297', outlineVariant: '#41484D',
  primary: '#79D1FF', onPrimary: '#003549', primaryContainer: '#004C68', onPrimaryContainer: '#C3E8FF',
  whiteKey: '#8A9297', blackKey: '#191C1E', centerKey: '#004C68', whiteRow: '#1D2022', blackRow: '#191C1E',
  play: '#79D1FF'
};

// Warna inti untuk animasi transisi logo (logo-transition.ts): bentuknya sama dengan Swatch di ui-theme.ts (bg, text, accent),
// didefinisikan di sini supaya ui-theme.ts tidak perlu diubah.
export const UTAU_SWATCH: { bg: string; text: string; accent: string } = { bg: UTAU.bg, text: UTAU.onSurface, accent: UTAU.primary };

// Konstanta bentuk (px), dari OpenUtau Mobile: PartsCanvas / NotesCanvas / ViewConstants
export const UTAU_SHAPE = {
  partRadius: 4,          // PartCornerRadius
  partIdleAlpha: 0.64,    // part tidak terpilih = 64% warna track, terpilih = 100% + garis primary 2px
  noteRadius: 4,          // NoteBodyCornerRadius
  noteAlpha: 0.88,        // badan nada
  noteBorderSel: 1.5,     // garis primary saat nada terpilih
  noteBorder: 0.5,        // garis outlineVariant saat tidak terpilih
  barLine: 1.5,           // garis bar (primary)
  trackLine: 1.5          // pemisah track (primary)
} as const;

// Mengubah '#RRGGBB' menjadi 'rgba(r,g,b,a)' (kecil, mandiri supaya tidak bergantung pada ui-theme.ts)
export const utauRgba = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
};
export const utauTriplet = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
};
