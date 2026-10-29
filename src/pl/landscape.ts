// Landscape (Pengaturan -> Landscape): layar penuh + kunci orientasi mendatar (Chrome Android) dalam satu ketukan pada Nyala; Mati = keluar.
// screen.orientation.lock() hanya jalan saat layar penuh dan dari sentuhan pengguna, jadi keduanya dipanggil dari satu klik.
// Kalau kunci tidak didukung, tetap layar penuh (tanpa pesan error). Di browser tanpa layar penuh (mis. iPhone Safari) baris ini disembunyikan;
// di sana cukup matikan kunci rotasi layar lalu putar HP, tampilan menyesuaikan sendiri.

/** onChange dipanggil setelah layar penuh / orientasi berubah (canvas perlu menghitung ulang ukurannya). */
export function initLandscape(onChange: () => void): void {
  const root = document.documentElement;
  const row = document.getElementById('ls-row');
  const btns = document.querySelectorAll<HTMLButtonElement>('#ls-seg [data-ls]');
  if (!document.fullscreenEnabled || !root.requestFullscreen) { if (row) row.hidden = true; return; }
  const ori = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;

  let armed = false;   // Nyala dipilih lewat baris ini dan layar penuh masih aktif
  const sync = (): void => {
    const on = armed && !!document.fullscreenElement;
    btns.forEach(b => b.classList.toggle('on', (b.dataset.ls === '1') === on));
  };
  sync();

  btns.forEach(b => {
    b.onclick = async () => {
      try {
        if (b.dataset.ls === '1') {
          if (!document.fullscreenElement) await root.requestFullscreen({ navigationUI: 'hide' });
          armed = true;
          try { await ori?.lock?.('landscape'); } catch { /* tidak didukung: tetap layar penuh */ }
        } else {
          armed = false;
          if (document.fullscreenElement) await document.exitFullscreen();
          try { ori?.unlock?.(); } catch { /* abaikan */ }
        }
      } catch (err) { console.warn('Layar penuh gagal:', err); armed = false; }
      sync();
    };
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) { armed = false; try { ori?.unlock?.(); } catch { /* abaikan */ } }
    sync();
    requestAnimationFrame(onChange);
  });
  ori?.addEventListener('change', () => requestAnimationFrame(onChange));
}
