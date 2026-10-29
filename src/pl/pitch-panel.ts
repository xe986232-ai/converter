// Panel Sample (dulu "Pitch"; tab ketiga di bilah bawah, di samping "Efek" dan "Mixer"): pengaturan clip audio terpilih — knob pitch, Fade In, Fade Out, tombol Auto dan Rev.
// - Volume: volume clip 0..100% (100% = level asli file, default). Real-time selama knob diseret, ketuk dua kali = 100%.
// - Fade In / Fade Out: panjang fade dalam ketukan (0 = mati). Di clip tampak sebagai tanjakan (fade in) / turunan (fade out) dan volume mengikutinya.
// - Knob: geser nada dalam semitone bulat (-24..+24). Seret ke atas/bawah, ketuk dua kali = kembali ke 0.
//         Selama diseret hanya angkanya yang berubah; proses pitch baru jalan setelah knob dilepas.
// - Auto: aktif = clip ikut BPM project: tempo project diubah ke berapa pun, audio di-time-stretch otomatis supaya tetap pas di ketukan yang sama
//                 (tempo saat Auto dinyalakan jadi acuan), dan pitch tidak lagi mengubah kecepatan (dirender dulu, lihat pitch.ts);
//         mati  = kecepatan ikut pitch (varispeed, durasi berubah) dan tidak mengikuti BPM.
// - Rev:  putar clip terbalik.
// - Progres: garis tipis polos di sisi atas panel bawah (tampak di semua tab), berwarna pattern, berjalan selama pitch diproses lalu hilang kalau selesai.
import './pitch-panel.css';
import { el, SVGNS, polar, arc } from './ui-util';
import { PITCH_MIN, PITCH_MAX, clampPitch } from './pitch';

export interface PitchTargetInfo { id: number; name: string; pitch: number; auto: boolean; busy: boolean; rev: boolean; progress: number | null; len: number; fadeIn: number; fadeOut: number; vol: number; }
export interface PitchPanelOptions {
  getTarget(): PitchTargetInfo | null;   // clip audio terpilih (null = tidak ada)
  setPitch(st: number): void;
  setAuto(on: boolean): void;
  setReverse(on: boolean): void;
  setFade(kind: 'in' | 'out', beats: number, live?: boolean): void;   // live = dipanggil terus selama knob diseret
  endFade?(): void;   // seretan knob selesai
  setVolume(v: number, live?: boolean): void;   // volume clip 0..1; live = dipanggil terus selama knob diseret
  endVolume?(): void;   // seretan knob volume selesai
}
export interface PitchPanelHandle { refresh(): void; bar: HTMLElement; setExtra(p: number | null): void; }   // setExtra = progres proses lain (mis. render Reverse vsynth) di garis yang sama: null = sembunyi, <= 0 = berjalan tanpa angka   // bar = garis progres; dipasang fx-panel di sisi atas panel bawah (tampak di semua tab)

const fmtSt = (st: number): string => (st > 0 ? '+' : '') + st + ' st';

export function mountPitchPanel(host: HTMLElement, opts: PitchPanelOptions): PitchPanelHandle {
  host.innerHTML = '';
  const root = el('div', 'pt');
  const empty = el('div', 'pt-empty', 'Pilih clip audio di playlist untuk mengatur sample');

  // knob (gaya sama seperti knob panel efek)
  const knob = el('div', 'fx-knob pt-knob');
  knob.tabIndex = 0;
  knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', 'Pitch');
  knob.setAttribute('aria-valuemin', String(PITCH_MIN));
  knob.setAttribute('aria-valuemax', String(PITCH_MAX));
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  const track = document.createElementNS(SVGNS, 'path');
  track.setAttribute('class', 'k-track'); track.setAttribute('d', arc(15, -135, 135));
  const val = document.createElementNS(SVGNS, 'path'); val.setAttribute('class', 'k-val');
  const tick = document.createElementNS(SVGNS, 'line'); tick.setAttribute('class', 'k-tick');
  svg.append(track, val, tick);
  const lab = el('span', 'k-label', 'Pitch');
  const read = el('span', 'k-read');
  knob.append(svg, lab, read);

  // knob fade (unipolar, 0 .. panjang clip dalam ketukan): sama gaya dengan knob pitch; nilai diterapkan real-time selama knob diseret
  const fmtBeat = (b: number): string => (b <= 0 ? 'off' : (Math.round(b * 100) / 100) + ' b');
  function fadeKnob(label: string, kind: 'in' | 'out') {
    const k = el('div', 'fx-knob pt-knob');
    k.tabIndex = 0;
    k.setAttribute('role', 'slider');
    k.setAttribute('aria-label', label);
    k.setAttribute('aria-valuemin', '0');
    const sv = document.createElementNS(SVGNS, 'svg');
    sv.setAttribute('viewBox', '0 0 40 40');
    const tr = document.createElementNS(SVGNS, 'path'); tr.setAttribute('class', 'k-track'); tr.setAttribute('d', arc(15, -135, 135));
    const vl = document.createElementNS(SVGNS, 'path'); vl.setAttribute('class', 'k-val');
    const tk = document.createElementNS(SVGNS, 'line'); tk.setAttribute('class', 'k-tick');
    sv.append(tr, vl, tk);
    const lb = el('span', 'k-label', label), rd = el('span', 'k-read');
    k.append(sv, lb, rd);
    let prev: number | null = null;
    const value = (): number => (kind === 'in' ? cur?.fadeIn : cur?.fadeOut) ?? 0;
    const paintK = (): void => {
      const max = Math.max(0.25, cur?.len ?? 1), v = prev ?? value();
      const a = -135 + Math.min(1, v / max) * 270;
      vl.setAttribute('d', v > 0 ? arc(15, -135, a) : '');
      const [x0, y0] = polar(6, a), [x1, y1] = polar(13, a);
      tk.setAttribute('x1', x0.toFixed(2)); tk.setAttribute('y1', y0.toFixed(2));
      tk.setAttribute('x2', x1.toFixed(2)); tk.setAttribute('y2', y1.toFixed(2));
      rd.textContent = fmtBeat(v);
      k.setAttribute('aria-valuemax', String(max));
      k.setAttribute('aria-valuenow', String(v));
      k.setAttribute('aria-valuetext', fmtBeat(v));
    };
    // batas: fade in + fade out tidak melebihi panjang clip
    const limit = (v: number): number => {
      const max = Math.max(0, (cur?.len ?? 0) - (kind === 'in' ? cur?.fadeOut : cur?.fadeIn)!);
      return Math.max(0, Math.min(Math.round(v * 16) / 16, max));
    };
    let sy = 0, sv0 = 0, lastTapK = 0;
    k.addEventListener('pointerdown', e => {
      if (!cur) return;
      e.preventDefault();
      k.setPointerCapture(e.pointerId); k.classList.add('drag');
      sy = e.clientY; sv0 = value(); prev = sv0;
      const now = performance.now();
      if (now - lastTapK < 300) { prev = 0; sv0 = 0; opts.setFade(kind, 0, true); paint(); }   // ketuk dua kali: fade mati
      lastTapK = now;
    });
    k.addEventListener('pointermove', e => {
      if (!k.hasPointerCapture(e.pointerId) || prev == null || !cur) return;
      prev = limit(sv0 + (sy - e.clientY) / 150 * Math.max(0.25, cur.len));   // 150 px = seluruh panjang clip
      if (Math.abs(prev - value()) > 1e-9) opts.setFade(kind, prev, true);   // real-time: clip dan suara langsung mengikuti
      paint();
    });
    const done = (e: PointerEvent, apply: boolean): void => {
      k.classList.remove('drag');
      if (k.hasPointerCapture(e.pointerId)) k.releasePointerCapture(e.pointerId);
      const v = prev; prev = null;
      if (apply && v != null && cur && Math.abs(v - value()) > 1e-9) opts.setFade(kind, v, true);
      opts.endFade?.();
      paint();
    };
    k.addEventListener('pointerup', e => done(e, true));
    k.addEventListener('pointercancel', e => done(e, false));
    k.addEventListener('keydown', e => {
      if (!cur) return;
      const step = e.shiftKey ? 1 : 0.25;
      let v: number | null = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = value() + step;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = value() - step;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = cur.len;
      if (v == null) return;
      e.preventDefault();
      opts.setFade(kind, limit(v)); paint();
    });
    return { knob: k, paint: paintK };
  }
  // knob volume (unipolar 0..100%, 100% = level asli file): gaya sama dengan knob lain; nilai diterapkan real-time selama knob diseret
  const fmtVol = (v: number): string => Math.round(v * 100) + '%';
  function volumeKnob() {
    const k = el('div', 'fx-knob pt-knob');
    k.tabIndex = 0;
    k.setAttribute('role', 'slider');
    k.setAttribute('aria-label', 'Volume');
    k.setAttribute('aria-valuemin', '0'); k.setAttribute('aria-valuemax', '100');
    const sv = document.createElementNS(SVGNS, 'svg');
    sv.setAttribute('viewBox', '0 0 40 40');
    const tr = document.createElementNS(SVGNS, 'path'); tr.setAttribute('class', 'k-track'); tr.setAttribute('d', arc(15, -135, 135));
    const vl = document.createElementNS(SVGNS, 'path'); vl.setAttribute('class', 'k-val');
    const tk = document.createElementNS(SVGNS, 'line'); tk.setAttribute('class', 'k-tick');
    sv.append(tr, vl, tk);
    const lb = el('span', 'k-label', 'Volume'), rd = el('span', 'k-read');
    k.append(sv, lb, rd);
    let prev: number | null = null;
    const value = (): number => cur?.vol ?? 1;
    const clamp01 = (v: number): number => Math.max(0, Math.min(1, Math.round(v * 100) / 100));
    const paintK = (): void => {
      const v = prev ?? value(), a = -135 + v * 270;
      vl.setAttribute('d', v > 0 ? arc(15, -135, a) : '');
      const [x0, y0] = polar(6, a), [x1, y1] = polar(13, a);
      tk.setAttribute('x1', x0.toFixed(2)); tk.setAttribute('y1', y0.toFixed(2));
      tk.setAttribute('x2', x1.toFixed(2)); tk.setAttribute('y2', y1.toFixed(2));
      rd.textContent = fmtVol(v);
      k.setAttribute('aria-valuenow', String(Math.round(v * 100)));
      k.setAttribute('aria-valuetext', fmtVol(v));
    };
    let sy = 0, sv0 = 0, lastTapV = 0;
    k.addEventListener('pointerdown', e => {
      if (!cur) return;
      e.preventDefault();
      k.setPointerCapture(e.pointerId); k.classList.add('drag');
      sy = e.clientY; sv0 = value(); prev = sv0;
      const now = performance.now();
      if (now - lastTapV < 300) { prev = 1; sv0 = 1; opts.setVolume(1, true); paint(); }   // ketuk dua kali: kembali ke 100%
      lastTapV = now;
    });
    k.addEventListener('pointermove', e => {
      if (!k.hasPointerCapture(e.pointerId) || prev == null || !cur) return;
      prev = clamp01(sv0 + (sy - e.clientY) / 150);   // 150 px = seluruh rentang 0..100%
      if (Math.abs(prev - value()) > 1e-9) opts.setVolume(prev, true);   // real-time: suara langsung mengikuti
      paint();
    });
    const done = (e: PointerEvent, apply: boolean): void => {
      k.classList.remove('drag');
      if (k.hasPointerCapture(e.pointerId)) k.releasePointerCapture(e.pointerId);
      const v = prev; prev = null;
      if (apply && v != null && cur && Math.abs(v - value()) > 1e-9) opts.setVolume(v, true);
      opts.endVolume?.();
      paint();
    };
    k.addEventListener('pointerup', e => done(e, true));
    k.addEventListener('pointercancel', e => done(e, false));
    k.addEventListener('keydown', e => {
      if (!cur) return;
      const step = e.shiftKey ? 0.1 : 0.01;
      let v: number | null = null;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') v = value() + step;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') v = value() - step;
      else if (e.key === 'Home') v = 0;
      else if (e.key === 'End') v = 1;
      if (v == null) return;
      e.preventDefault();
      opts.setVolume(clamp01(v)); paint();
    });
    return { knob: k, paint: paintK };
  }
  const volK = volumeKnob();
  const fiK = fadeKnob('Fade In', 'in'), foK = fadeKnob('Fade Out', 'out');

  // tombol bulat: Auto (kecepatan) dan Rev (terbalik), masing-masing dengan keterangan kecil di bawahnya
  function roundBtn(label: string, aria: string): { wrap: HTMLElement; btn: HTMLButtonElement; sub: HTMLElement } {
    const wrap = el('div', 'pt-rwrap');
    const btn = el('button', 'pt-round', label);
    btn.setAttribute('aria-label', aria);
    const sub = el('span', 'pt-sub');
    wrap.append(btn, sub);
    return { wrap, btn, sub };
  }
  const autoB = roundBtn('Auto', 'Auto: ikut BPM project (time-stretch otomatis)');
  const revB = roundBtn('Rev', 'Reverse: putar terbalik');

  // progres proses pitch: garis tipis di sisi atas panel, tanpa kartu / label; hanya tampil selama proses berjalan
  const bar = el('div', 'pt-bar');
  bar.hidden = true;
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', 'Proses');
  bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100');
  const barFill = el('div', 'pt-bar-fill');
  bar.appendChild(barFill);

  const name = el('div', 'pt-name');
  const body = el('div', 'pt-body');
  body.append(knob, volK.knob, fiK.knob, foK.knob, autoB.wrap, revB.wrap);
  root.append(name, body);
  host.append(empty, root);

  let cur: PitchTargetInfo | null = null;
  let preview: number | null = null;   // nilai sementara selama knob diseret (belum diproses)

  function paint(): void {
    cur = opts.getTarget();
    empty.hidden = !!cur;
    root.hidden = !cur;
    paintProgress(cur);
    if (!cur) return;
    name.textContent = cur.name;
    const st = preview ?? cur.pitch;
    const a = st / PITCH_MAX * 135;   // bipolar: 0 di jam 12, ke kiri minus, ke kanan plus
    val.setAttribute('d', st !== 0 ? arc(15, 0, a) : '');
    const [x0, y0] = polar(6, a), [x1, y1] = polar(13, a);
    tick.setAttribute('x1', x0.toFixed(2)); tick.setAttribute('y1', y0.toFixed(2));
    tick.setAttribute('x2', x1.toFixed(2)); tick.setAttribute('y2', y1.toFixed(2));
    read.textContent = fmtSt(st) + (preview == null && cur.busy ? ' …' : '');
    knob.setAttribute('aria-valuenow', String(st));
    knob.setAttribute('aria-valuetext', fmtSt(st));
    volK.paint(); fiK.paint(); foK.paint();
    autoB.btn.classList.toggle('on', cur.auto);
    autoB.btn.setAttribute('aria-pressed', String(cur.auto));
    autoB.sub.textContent = cur.auto ? 'ikut BPM' : 'ikut pitch';
    revB.btn.classList.toggle('on', cur.rev);
    revB.btn.setAttribute('aria-pressed', String(cur.rev));
    revB.sub.textContent = cur.rev ? 'terbalik' : 'normal';
  }
  let extra: number | null = null;   // progres proses non-pitch; kalah dari progres pitch clip yang sedang berjalan
  function paintProgress(t: PitchTargetInfo | null): void {
    const p = t && t.progress != null ? t.progress : extra;
    bar.hidden = p == null;   // selesai (atau tidak ada proses): garis hilang
    if (p == null) { barFill.classList.remove('indet'); barFill.style.width = '0'; return; }
    const pct = Math.round(Math.min(1, Math.max(0, p)) * 100);
    barFill.classList.toggle('indet', p <= 0);   // library / WASM sedang dimuat: belum ada angka
    barFill.style.width = p <= 0 ? '' : pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
  }
  const commit = (st: number): void => { opts.setPitch(clampPitch(st)); paint(); };   // langsung diproses (dipakai keyboard)

  let startY = 0, startSt = 0, lastTap = 0;
  knob.addEventListener('pointerdown', e => {
    if (!cur) return;
    e.preventDefault();
    knob.setPointerCapture(e.pointerId);
    knob.classList.add('drag');
    startY = e.clientY; startSt = cur.pitch;
    preview = startSt;
    const now = performance.now();
    if (now - lastTap < 300) { preview = 0; startSt = 0; paint(); }   // ketuk dua kali: kembali ke 0 (diproses saat dilepas)
    lastTap = now;
  });
  knob.addEventListener('pointermove', e => {
    if (!knob.hasPointerCapture(e.pointerId) || preview == null) return;
    preview = clampPitch(startSt + Math.round((startY - e.clientY) / 5));   // 5 px = 1 semitone; hanya tampilan, belum diproses
    paint();
  });
  const finish = (e: PointerEvent, apply: boolean): void => {
    knob.classList.remove('drag');
    if (knob.hasPointerCapture(e.pointerId)) knob.releasePointerCapture(e.pointerId);
    const v = preview; preview = null;
    if (apply && v != null && cur && v !== cur.pitch) opts.setPitch(v);   // knob dilepas: baru proses pitch
    paint();
  };
  knob.addEventListener('pointerup', e => finish(e, true));
  knob.addEventListener('pointercancel', e => finish(e, false));
  knob.addEventListener('keydown', e => {
    if (!cur) return;
    const step = e.shiftKey ? 12 : 1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { commit(cur.pitch + step); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { commit(cur.pitch - step); e.preventDefault(); }
    else if (e.key === 'Home') { commit(PITCH_MIN); e.preventDefault(); }
    else if (e.key === 'End') { commit(PITCH_MAX); e.preventDefault(); }
  });
  autoB.btn.onclick = () => { if (!cur) return; opts.setAuto(!cur.auto); paint(); };
  revB.btn.onclick = () => { if (!cur) return; opts.setReverse(!cur.rev); paint(); };

  paint();
  return { refresh: paint, bar, setExtra(p) { extra = p; paintProgress(cur); } };
}
