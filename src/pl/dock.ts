// Bar bawah LAMA (card transport dari app lama): M (metronome + BPM), Mundur / Putar-Jeda / Maju, Undo / Redo, dan panah tutup-buka.
// Markup dan CSS (dock.css) disalin dari app lama; logikanya disambungkan ke playlist canvas lewat DockOpts di main.ts.
import './dock.css';
import { initMetronomePanel, type MetroApi, type MetroPanel } from '../metronome-panel';

export interface DockOpts {
  onPlay(): void;                 // Putar / jeda
  onRewind(): void;               // Mundur: kembali ke titik Play terakhir
  onSeek(bars: number): void;     // Maju / mundur per bar (tombol Maju: tahan untuk terus bergeser)
  onUndo(): void;
  onRedo(): void;
  metro: MetroApi;
}
export interface Dock {
  setPlaying(on: boolean): void;
  setHistory(canUndo: boolean, canRedo: boolean): void;
  setOpen(open: boolean): void;
  metro: MetroPanel;
}

const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <symbol id="play-icon" viewBox="0 0 24 24"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l11-6.86a1 1 0 0 0 0-1.7l-11-6.86A1 1 0 0 0 8 5.14z"/></symbol>
  <symbol id="pause-icon" viewBox="0 0 24 24"><path d="M7 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/></symbol>
  <symbol id="rewind-icon" viewBox="0 0 24 24"><path d="M11.5 6.2v11.6a.7.7 0 0 1-1.1.57L1.9 12.6a.7.7 0 0 1 0-1.16l8.5-5.8a.7.7 0 0 1 1.1.56z"/><path transform="translate(9.5 0)" d="M11.5 6.2v11.6a.7.7 0 0 1-1.1.57L1.9 12.6a.7.7 0 0 1 0-1.16l8.5-5.8a.7.7 0 0 1 1.1.56z"/></symbol>
  <symbol id="forward-icon" viewBox="0 0 24 24"><g transform="translate(24 0) scale(-1 1)"><path d="M11.5 6.2v11.6a.7.7 0 0 1-1.1.57L1.9 12.6a.7.7 0 0 1 0-1.16l8.5-5.8a.7.7 0 0 1 1.1.56z"/><path transform="translate(9.5 0)" d="M11.5 6.2v11.6a.7.7 0 0 1-1.1.57L1.9 12.6a.7.7 0 0 1 0-1.16l8.5-5.8a.7.7 0 0 1 1.1.56z"/></g></symbol>
</svg>`;

const MARKUP = `${SPRITE}
<footer class="transportbar" id="dockBar">
<div class="dock-clip" id="dockClip">
<div class="tp-dock" id="dockCard"><div role="group" aria-label="Kontrol transport" class="tp">
  <div class="tp__side tp__side--l">
    <button type="button" class="hist-btn metro-btn" id="btnMetro" aria-label="Metronome dan BPM" title="Metronome &amp; BPM">M</button>
  </div>
  <div class="tp__mid">
    <button aria-label="Mundur" title="Mundur ke titik Play terakhir" class="rewind tp__btn bs-md txt-lg bare-btn"><span class="ico ico--svg ic-rewind"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#rewind-icon"></use></svg></span></button>
    <button aria-label="Putar" title="Putar/jeda (Space)" class="play tp__btn bs-md txt-lg inv-on bare-btn"><span class="ico ico--svg ic-play"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#play-icon"></use></svg></span></button>
    <button aria-label="Maju cepat" title="Maju 1 bar (tahan untuk terus maju)" class="forward tp__btn bs-md txt-lg bare-btn"><span class="ico ico--svg ic-forward"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#forward-icon"></use></svg></span></button>
  </div>
  <div class="tp__side tp__side--r">
    <button type="button" class="hist-btn hist-ico" id="btnUndo" aria-label="Urungkan (Ctrl+Z)" title="Undo (Ctrl+Z)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg></button>
    <button type="button" class="hist-btn hist-ico" id="btnRedo" aria-label="Ulangi (Ctrl+Shift+Z)" title="Redo (Ctrl+Shift+Z)" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg></button>
  </div>
</div></div>
</div>
<button class="kbd-toggle tp__btn bare-btn" id="kbdToggle" type="button" aria-controls="dockClip" aria-expanded="true" aria-label="Tutup panel bawah" title="Tutup panel bawah"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg></button>
</footer>`;

export function mountDock(host: HTMLElement, o: DockOpts): Dock {
  host.classList.add('dock-host');
  host.innerHTML = MARKUP;
  const q = <T extends HTMLElement>(s: string): T => host.querySelector<T>(s)!;
  const bar = q('#dockBar'), clip = q('#dockClip'), toggle = q<HTMLButtonElement>('#kbdToggle');
  const btnPlay = q<HTMLButtonElement>('.play'), btnRew = q<HTMLButtonElement>('.rewind'), btnFwd = q<HTMLButtonElement>('.forward');
  const btnUndo = q<HTMLButtonElement>('#btnUndo'), btnRedo = q<HTMLButtonElement>('#btnRedo'), btnMetro = q<HTMLButtonElement>('#btnMetro');

  /* panah di kanan card: menutup / membuka seluruh panel bawah (saat tertutup hanya panah yang tersisa) */
  const collapsed = (): boolean => bar.classList.contains('is-collapsed');
  function setOpen(open: boolean): void {
    bar.classList.toggle('is-collapsed', !open);
    clip.toggleAttribute('inert', !open);   // card tersembunyi: tombolnya tidak bisa difokus / ditekan
    const t = open ? 'Tutup panel bawah' : 'Buka panel bawah';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', t); toggle.title = t;
  }
  toggle.addEventListener('click', () => setOpen(collapsed()));

  btnPlay.addEventListener('click', () => o.onPlay());
  btnRew.addEventListener('click', () => o.onRewind());

  /* maju: 1 bar per klik, tahan untuk terus bergeser (sama seperti app lama) */
  let to = 0, iv = 0;
  const stopSeek = (): void => { clearTimeout(to); clearInterval(iv); to = iv = 0; };
  btnFwd.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    o.onSeek(1); stopSeek();
    to = window.setTimeout(() => { iv = window.setInterval(() => o.onSeek(1), 90); }, 380);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btnFwd.addEventListener(ev, stopSeek);
  btnFwd.addEventListener('click', e => { if (e.detail === 0) o.onSeek(1); });   // aktivasi lewat keyboard (Enter / Space)

  /* undo / redo: kedip kecil saat baru aktif dan saat ditekan */
  const pulse = (b: HTMLElement, cls: string): void => { b.classList.remove(cls); void b.offsetWidth; b.classList.add(cls); };
  btnUndo.addEventListener('click', () => { pulse(btnUndo, 'is-tap'); o.onUndo(); });
  btnRedo.addEventListener('click', () => { pulse(btnRedo, 'is-tap'); o.onRedo(); });

  const metro = initMetronomePanel(btnMetro, o.metro);
  metro.sync();

  return {
    metro,
    setOpen,
    setPlaying(on: boolean): void {
      btnPlay.querySelector('use')!.setAttribute('href', on ? '#pause-icon' : '#play-icon');
      btnPlay.setAttribute('aria-label', on ? 'Jeda' : 'Putar');
      btnPlay.title = on ? 'Jeda (Space)' : 'Putar (Space)';
    },
    setHistory(u: boolean, r: boolean): void {
      if (btnUndo.disabled && u) pulse(btnUndo, 'is-pop');   // baru jadi aktif
      if (btnRedo.disabled && r) pulse(btnRedo, 'is-pop');
      btnUndo.disabled = !u; btnRedo.disabled = !r;
    }
  };
}
