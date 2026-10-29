// Halaman "Manage Plugin" di Menu (kategori sejajar Project / Export / Pengaturan).
// Semua plugin bawaan berstatus "Terpasang" (tab Plugin saya). Tab Shop hanya menampung plugin gratis yang ditambahkan lewat tombol + di panel efek (item `free`).
// Tombol "Browse plugin" membuka halaman plugin di website (PLUGIN_STORE_URL). Tampilan memakai kelas menu yang sama (mp__seg/mp__segbtn, mp__card), lihat blok ".shop" di styles.css.

type ShopKind = 'instrument' | 'effect';
interface ShopItem { id: string; name: string; kind: ShopKind; desc: string; img: string; ar: string; free?: boolean }   // free = plugin gratis yang ditambahkan lewat tombol + di panel efek (label Free, status Tambahkan)

const CATALOG: ShopItem[] = [
  { id: 'deriz', name: 'DERIZ', kind: 'instrument', desc: 'Sampler: upload audio, mainkan dari keyboard atau piano roll, atur Speed, Pitch, dan Volume.', img: 'deriz', ar: '720/465' },
  { id: 'mpcs', name: 'MPCS', kind: 'instrument', desc: 'Manual Pitch Correct Sample: edit pitch sample dengan blok nada, seret naik atau turun.', img: 'mpcs', ar: '720/400' },
  { id: 'mgchord', name: 'MGCHORD', kind: 'instrument', desc: 'Pembuat chord progression: pilih Key, Length, Sound, dan Style strum.', img: 'mgchord', ar: '720/419' },
  { id: 'supersaw', name: 'Supersaw', kind: 'instrument', desc: 'Synth supersaw dengan Detune, Mix, filter, dan envelope.', img: 'supersaw', ar: '720/467' },
  { id: 'reverb', name: 'Reverb', kind: 'effect', desc: 'Gema ruang: Mix, Size, Pre-Delay, Tone, dan Low Cut.', img: 'reverb', ar: '1/1' },
  { id: 'equalizer', name: 'Equalizer', kind: 'effect', desc: 'EQ 5 band dengan grafik respons dan level Output.', img: 'equalizer', ar: '4/5' },
  { id: 'filter', name: 'Filter', kind: 'effect', desc: 'Low-pass dan high-pass dalam satu knob Cutoff, plus Reso.', img: 'filter', ar: '720/467' },
  { id: 'deesser', name: 'De-esser', kind: 'effect', desc: 'Meredam desis (sibilance) pada vokal: Freq, Thresh, Amount.', img: 'deesser', ar: '720/467' },
  { id: 'delay', name: 'Delay', kind: 'effect', desc: 'Delay stereo dengan panel sendiri.', img: 'delay', ar: '720/436' },
  { id: 'sampler', name: 'SAMPLER', kind: 'instrument', desc: 'Sampler sederhana: upload audio, ganti nada = ganti kecepatan putar. Pitch, Attack, Release, Volume.', img: 'sampler', ar: '534/526' },
  { id: 'cute', name: 'CUTE', kind: 'effect', desc: 'Pemotong audio dengan waveform: pilih bagian, putar, lalu seret ke DERIZ atau timeline.', img: 'cute', ar: '960/500' },
  { id: 'printer', name: 'PRINTER', kind: 'effect', desc: 'Melody Printer: upload atau rekam vokal, melodinya dicetak jadi nada MIDI.', img: 'printer', ar: '720/1159' },
  { id: 'bpmtune', name: 'BPMTUNE', kind: 'effect', desc: 'BPM finder + tuner: cari BPM dan nada dari audio.', img: 'bpmtune', ar: '720/510' },
  { id: 'vocalf', name: 'VocalF', kind: 'effect', desc: 'Exciter udara untuk vokal: Mid Air, High Air, Trim. Mengecil saat ada desis S.', img: 'vocalf', ar: '534/346' },
  { id: 'autotune', name: 'AUTOTUNE', kind: 'effect', desc: 'Koreksi pitch real-time untuk vokal + FX Mixer (Harmony, Pitch, Double, Reverb).', img: 'autotune', ar: '1440/816' },
  { id: 'livetune', name: 'LIVETUNE', kind: 'effect', desc: 'Koreksi pitch vokal dengan piano roll live: lihat garis suara asli dan hasil koreksi, atur Speed, Key, dan Scale.', img: 'livetune', ar: '980/604' },
];
const isFree = (id: string): boolean => !!CATALOG.find(c => c.id === id)?.free;

// Halaman plugin di website. Tombol "Browse plugin" membuka alamat ini di tab baru.
const PLUGIN_STORE_URL = 'https://melvocofficial.vercel.app/plugin';
const KIND_LABEL: Record<ShopKind, string> = { instrument: 'Instrumen', effect: 'Efek' };
const esc = (t: string): string => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

// Gambar tiap plugin = screenshot tampilan aslinya (public/shop/<img>.webp)
const IMG_BASE = import.meta.env.BASE_URL + 'shop/';

const IC_SHOP ='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/></svg>';
const IC_CHEV = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';

// Tombol kategori di halaman utama Menu
export const SHOP_CAT =
  '<button type="button" class="mp__cat mp__item" style="--i:3" data-go="shop">' + IC_SHOP +
  '<span class="mp__cat__t"><b>Manage Plugin</b><small>Plugin saya &amp; Shop</small></span>' + IC_CHEV + '</button>';

// Halaman Manage Plugin (data-page="shop", memakai sistem halaman Menu: ada tombol kembali)
export const SHOP_PAGE =
  '<section class="mp__page shop" data-page="shop" aria-label="Manage Plugin" hidden>' +
    '<div class="mp__seg mp__item" style="--i:1" role="radiogroup" aria-label="Bagian plugin">' +
      '<button type="button" class="mp__segbtn is-on" role="radio" aria-checked="true" data-shopt="mine">Plugin saya<span class="shop__n" data-n="mine"></span></button>' +
      '<button type="button" class="mp__segbtn" role="radio" aria-checked="false" data-shopt="shop">Shop<span class="shop__n" data-n="shop"></span></button>' +
    '</div>' +
    '<div class="mp__seg shop__kinds mp__item" style="--i:2" role="radiogroup" aria-label="Jenis plugin">' +
      '<button type="button" class="mp__segbtn is-on" role="radio" aria-checked="true" data-shopf="all">Semua</button>' +
      '<button type="button" class="mp__segbtn" role="radio" aria-checked="false" data-shopf="instrument">Instrumen</button>' +
      '<button type="button" class="mp__segbtn" role="radio" aria-checked="false" data-shopf="effect">Efek</button>' +
    '</div>' +
    '<a class="plg__btn shop__browse mp__item" style="--i:3" href="' + PLUGIN_STORE_URL + '" target="_blank" rel="noopener noreferrer">Browse plugin</a>' +
    '<ul class="shop__list mp__item" style="--i:3">' +
      CATALOG.map(p =>
        '<li class="shop__item mp__card" data-kind="' + p.kind + '" data-plugin="' + p.id + '">' +
          '<div class="shop__art" style="aspect-ratio:' + p.ar + '"><img src="' + IMG_BASE + p.img + '.webp" alt="Tampilan plugin ' + esc(p.name) + '" loading="lazy" decoding="async"></div>' +
          '<div class="shop__top"><b class="shop__name">' + esc(p.name) + '</b><span class="shop__tag">' + KIND_LABEL[p.kind] + '</span></div>' +
          '<p class="shop__desc">' + esc(p.desc) + '</p>' +
          (p.free ? '<div class="shop__act"><b class="shop__price">Free</b><span class="shop__state shop__state--add"><i aria-hidden="true"></i>Tambahkan</span></div>'
            : '<span class="shop__state"><i aria-hidden="true"></i>Terpasang</span>') +
        '</li>').join('') +
    '</ul>' +
    '<p class="mp__hint shop__empty" hidden></p>' +
  '</section>';

// Tab Plugin saya / Shop + filter Semua / Instrumen / Efek (hanya menyembunyikan kartu; tidak menyimpan apa pun).
// Plugin "saya" = semua plugin bawaan; plugin Free (ditambahkan lewat tombol +) ada di Shop.
const isMine = (id: string): boolean => !isFree(id);

export function initShopPage(panel: HTMLElement): void {
  const tabs = [...panel.querySelectorAll<HTMLButtonElement>('[data-shopt]')];
  const chips = [...panel.querySelectorAll<HTMLButtonElement>('[data-shopf]')];
  const items = [...panel.querySelectorAll<HTMLElement>('.shop__item')];
  const empty = panel.querySelector<HTMLElement>('.shop__empty')!;
  let tab = 'mine', kind = 'all';
  const apply = (): void => {
    tabs.forEach(c => { const on = c.dataset.shopt === tab; c.classList.toggle('is-on', on); c.setAttribute('aria-checked', String(on)); });
    chips.forEach(c => { const on = c.dataset.shopf === kind; c.classList.toggle('is-on', on); c.setAttribute('aria-checked', String(on)); });
    const n = { mine: 0, shop: 0 };
    let shown = 0;
    items.forEach(it => {
      const mine = isMine(it.dataset.plugin as string);
      n[mine ? 'mine' : 'shop']++;
      const show = (tab === 'mine') === mine && (kind === 'all' || it.dataset.kind === kind);
      it.hidden = !show; if (show) shown++;
    });
    panel.querySelectorAll<HTMLElement>('[data-n]').forEach(el => { el.textContent = String(n[el.dataset.n as 'mine' | 'shop']); });
    empty.hidden = shown > 0;
    if (shown === 0) empty.textContent = tab === 'shop'
      ? 'Belum ada plugin yang dijual. Yang baru akan muncul di Shop.'
      : 'Belum ada plugin di jenis ini.';
  };
  tabs.forEach(c => c.addEventListener('click', () => { tab = c.dataset.shopt as string; apply(); }));
  chips.forEach(c => c.addEventListener('click', () => { kind = c.dataset.shopf as string; apply(); }));
  apply();
}
