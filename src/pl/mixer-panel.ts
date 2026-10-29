// Panel channel mixer (gaya Ableton): satu strip per track playlist + channel FX (tombol + di kiri Return) + Return A/B + Master.
// Channel FX = bus: tiap strip track punya tombol titik tiga untuk memilih output (Master atau salah satu channel FX); channel FX lalu menuju Master.
// Tiap strip: nama berwarna, knob Pan / Send A / Send B, tombol aktivator (nomor), Solo, Arm,
// fader dengan skala dB + meter level L/R, bacaan volume dan puncak (peak).
// Saat ini hanya UI + logic state (mute/solo/arm, pemetaan dB, penyimpanan). Audio belum disambung:
// host membaca hasil akhirnya lewat getChannel()/getReturn()/getMaster() dan mengirim level meter lewat setMeter().
import './mixer-panel.css';
import { el, SVGNS, polar, arc, TRACK_COLORS } from './ui-util';

export interface MixTrack { id: number; name: string; color: string; }
export type MixTarget = number | 'A' | 'B' | 'master' | `fx:${number}`;

interface Chan { vol: number; pan: number; a: number; b: number; on: boolean; solo: boolean; arm: boolean; out: number | null; }   // out = id channel FX tujuan (null = langsung ke Master)
export interface FxCh { id: number; name: string; vol: number; pan: number; on: boolean; solo: boolean; }
interface Ret { vol: number; pan: number; on: boolean; solo: boolean; }
interface Mst { vol: number; pan: number; cue: number; }
export interface MixState { chans: Record<number, Chan>; fx: FxCh[]; ret: { A: Ret; B: Ret }; master: Mst; }

/** Hasil akhir satu channel untuk engine audio: gain sudah 0 kalau channel tidak terdengar (mute / dikalahkan solo). */
export interface ChannelOut { audible: boolean; gain: number; pan: number; sendA: number; sendB: number; armed: boolean; out: number | null; }
export interface ReturnOut { audible: boolean; gain: number; pan: number; }
export interface MasterOut { gain: number; pan: number; cue: number; }

/** Seluruh setelan mixer untuk file project (JSON): channel track (kunci = id track), channel FX, Return A/B, Master. */
export interface MixExport { v: 1; chans: Record<string, Chan>; fx: FxCh[]; ret: { A: Ret; B: Ret }; master: Mst; }

export interface MixerHandle {
  getState(): MixState;
  /** semua setelan mixer (volume, pan, send, aktif, solo, arm, routing, channel FX, Return, Master) untuk disimpan di file project */
  exportState(): MixExport;
  /** muat setelan dari file project; kosong / tidak valid = semua kembali ke bawaan. Nilai di luar rentang dipotong. */
  importState(raw: unknown): void;
  setTracks(tracks: MixTrack[]): void;
  getChannel(id: number): ChannelOut | null;
  getReturn(k: 'A' | 'B'): ReturnOut;
  getFx(id: number): ReturnOut | null;
  getMaster(): MasterOut;
  anySolo(): boolean;
  /** level puncak linear (0..1, boleh >1) kiri/kanan; panggil tiap frame, ballistics (naik cepat, turun pelan) diurus di sini */
  setMeter(target: MixTarget, l: number, r: number): void;
  onChange(cb: () => void): () => void;
  /** menu titik tiga channel FX > Effect: host membuka panel Efek untuk channel FX ini */
  onFxEffect(cb: (id: number) => void): () => void;
  /** channel FX dihapus (menu titik tiga > Hapus channel ini): host membuang efek milik channel itu */
  onFxRemoved(cb: (id: number) => void): () => void;
  /** menu titik tiga channel track > Color: host mengganti warna track itu (semua clip di track ikut) */
  onTrackColor(cb: (trackId: number, color: string) => void): () => void;
}

/* ---------- pemetaan fader <-> dB (0..1 <-> -inf..+6 dB, 0 dB di 85%) ---------- */
const CURVE: [number, number][] = [[0, -70], [0.03, -60], [0.1, -48], [0.2, -36], [0.35, -24], [0.55, -12], [0.7, -6], [0.85, 0], [1, 6]];
const POS0DB = 0.85;
function posToDb(p: number): number {
  if (p <= 0) return -Infinity;
  for (let i = 1; i < CURVE.length; i++) {
    if (p <= CURVE[i][0]) {
      const [p0, d0] = CURVE[i - 1], [p1, d1] = CURVE[i];
      return d0 + (d1 - d0) * (p - p0) / (p1 - p0);
    }
  }
  return 6;
}
function dbToPos(db: number): number {
  if (db <= -70) return 0;
  for (let i = 1; i < CURVE.length; i++) {
    if (db <= CURVE[i][1]) {
      const [p0, d0] = CURVE[i - 1], [p1, d1] = CURVE[i];
      return p0 + (p1 - p0) * (db - d0) / (d1 - d0);
    }
  }
  return 1;
}
const posToGain = (p: number): number => p <= 0 ? 0 : Math.pow(10, posToDb(p) / 20);
function fmtDb(p: number): string {
  if (p <= 0) return '-inf';
  const d = posToDb(p);
  return (d > 0.05 ? '+' : '') + d.toFixed(1);
}
function fmtPeak(db: number): string { return db <= -70 ? '-inf' : (db > 0 ? '+' : '') + db.toFixed(1); }
function fmtPan(v: number): string { const n = Math.round(Math.abs(v)); return n === 0 ? 'C' : n + (v < 0 ? 'L' : 'R'); }
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/* ---------- state ---------- */
const newChan = (): Chan => ({ vol: POS0DB, pan: 0, a: 0, b: 0, on: true, solo: false, arm: false, out: null });
const FX_COLOR = '#A78BFA';
const newRet = (): Ret => ({ vol: POS0DB, pan: 0, on: true, solo: false });
// Setelan mixer tidak disimpan di browser (mengikuti project yang selalu mulai kosong).
const newState = (): MixState => ({ chans: {}, fx: [], ret: { A: newRet(), B: newRet() }, master: { vol: POS0DB, pan: 0, cue: POS0DB } });

/* ---------- warna teks di atas warna track ---------- */
function inkOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#1D2226';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? '#1D2226' : '#F1F1F1';
}

/* ---------- komponen: knob ---------- */
interface KnobDef { label: string; title: string; min: number; max: number; def: number; bipolar?: boolean;
  get(): number; set(v: number): void; fmt(v: number): string; }

function makeKnob(o: KnobDef): { node: HTMLElement; paint: () => void } {
  const wrap = el('div', 'mx-knob');
  wrap.tabIndex = 0;
  wrap.title = o.title;
  wrap.setAttribute('role', 'slider');
  wrap.setAttribute('aria-label', o.title);
  wrap.setAttribute('aria-valuemin', String(o.min));
  wrap.setAttribute('aria-valuemax', String(o.max));
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  const track = document.createElementNS(SVGNS, 'path');
  track.setAttribute('class', 'k-track'); track.setAttribute('d', arc(15, -135, 135));
  const val = document.createElementNS(SVGNS, 'path');
  val.setAttribute('class', 'k-val');
  const tick = document.createElementNS(SVGNS, 'line');
  tick.setAttribute('class', 'k-tick');
  svg.append(track, val, tick);
  const lab = el('span', 'k-lab', o.label);
  wrap.append(svg, lab);

  let dragging = false;
  const span = o.max - o.min;
  function paint(): void {
    const v = o.get();
    const a = -135 + (v - o.min) / span * 270;
    const from = o.bipolar ? 0 : -135;
    val.setAttribute('d', Math.abs(a - from) > 0.5 ? arc(15, from, a) : '');
    const [x0, y0] = polar(5, a), [x1, y1] = polar(13, a);
    tick.setAttribute('x1', x0.toFixed(2)); tick.setAttribute('y1', y0.toFixed(2));
    tick.setAttribute('x2', x1.toFixed(2)); tick.setAttribute('y2', y1.toFixed(2));
    wrap.setAttribute('aria-valuenow', v.toFixed(2));
    wrap.setAttribute('aria-valuetext', o.fmt(v));
    lab.textContent = dragging ? o.fmt(v) : o.label;   // saat digeser, label diganti angka
  }
  const setV = (v: number): void => { o.set(clamp(v, o.min, o.max)); paint(); };
  paint();

  let startY = 0, startV = 0, lastTap = 0;
  wrap.addEventListener('pointerdown', e => {
    e.preventDefault();
    wrap.setPointerCapture(e.pointerId);
    dragging = true; wrap.classList.add('drag');
    startY = e.clientY; startV = o.get();
    const now = performance.now();
    if (now - lastTap < 300) { setV(o.def); startV = o.def; }   // ketuk dua kali: kembali ke default
    lastTap = now;
    paint();
  });
  wrap.addEventListener('pointermove', e => {
    if (!wrap.hasPointerCapture(e.pointerId)) return;
    setV(startV + (startY - e.clientY) / 140 * span);
  });
  const end = (e: PointerEvent): void => {
    dragging = false; wrap.classList.remove('drag');
    if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId);
    paint();
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);
  wrap.addEventListener('keydown', e => {
    const step = span * (e.shiftKey ? 0.1 : 0.02);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setV(o.get() + step); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setV(o.get() - step); e.preventDefault(); }
    else if (e.key === 'Home') { setV(o.min); e.preventDefault(); }
    else if (e.key === 'End') { setV(o.max); e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { setV(o.def); e.preventDefault(); }
  });
  return { node: wrap, paint };
}

/* ---------- komponen: fader ---------- */
const THUMB = 16;   // tinggi thumb (px), harus sama dengan CSS --mx-thumb
const SCALE: [number, string][] = [[6, '6'], [0, '0'], [-12, '12'], [-24, '24'], [-36, '36'], [-60, '60']];

function makeFader(label: string, get: () => number, set: (v: number) => void): { node: HTMLElement; paint: () => void } {
  const wrap = el('div', 'mx-fader');
  const scale = el('div', 'mx-scale');
  scale.setAttribute('aria-hidden', 'true');
  for (const [db, txt] of SCALE) {
    const m = el('span', 'mx-mark', txt);
    m.style.setProperty('--p', String(dbToPos(db)));
    scale.appendChild(m);
  }
  const slot = el('div', 'mx-slot');
  slot.tabIndex = 0;
  slot.setAttribute('role', 'slider');
  slot.setAttribute('aria-label', 'Volume ' + label);
  slot.setAttribute('aria-valuemin', '0');
  slot.setAttribute('aria-valuemax', '1');
  slot.append(el('div', 'mx-groove'), el('div', 'mx-thumb'));
  wrap.append(scale, slot);

  function paint(): void {
    const p = get();
    slot.style.setProperty('--p', String(p));
    slot.setAttribute('aria-valuenow', p.toFixed(3));
    slot.setAttribute('aria-valuetext', fmtDb(p) + ' dB');
  }
  const setP = (p: number): void => { set(clamp(p, 0, 1)); paint(); };
  paint();

  let startY = 0, startP = 0, lastTap = 0;
  slot.addEventListener('pointerdown', e => {
    e.preventDefault();
    slot.setPointerCapture(e.pointerId);
    slot.classList.add('drag');
    startY = e.clientY; startP = get();
    const now = performance.now();
    if (now - lastTap < 300) { setP(POS0DB); startP = POS0DB; }   // ketuk dua kali: 0 dB
    lastTap = now;
  });
  slot.addEventListener('pointermove', e => {
    if (!slot.hasPointerCapture(e.pointerId)) return;
    const usable = Math.max(1, slot.clientHeight - THUMB);
    setP(startP + (startY - e.clientY) / usable);
  });
  const end = (e: PointerEvent): void => { slot.classList.remove('drag'); if (slot.hasPointerCapture(e.pointerId)) slot.releasePointerCapture(e.pointerId); };
  slot.addEventListener('pointerup', end);
  slot.addEventListener('pointercancel', end);
  slot.addEventListener('keydown', e => {
    const step = e.shiftKey ? 0.05 : 0.01;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setP(get() + step); e.preventDefault(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setP(get() - step); e.preventDefault(); }
    else if (e.key === 'Home') { setP(0); e.preventDefault(); }
    else if (e.key === 'End') { setP(1); e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { setP(POS0DB); e.preventDefault(); }
  });
  return { node: wrap, paint };
}

/* ---------- meter ---------- */
interface Meter { fl: HTMLElement; fr: HTMLElement; l: number; r: number; tl: number; tr: number; peak: number; pk: HTMLButtonElement; }
const ampToPos = (a: number): number => a <= 0 ? 0 : clamp(dbToPos(20 * Math.log10(a)), 0, 1);
const ampToDb = (a: number): number => a <= 0 ? -Infinity : 20 * Math.log10(a);

/* ======================================================================== */
export function mountMixer(host: HTMLElement): MixerHandle {
  const S = newState();
  let tracks: MixTrack[] = [];
  let pending: Record<number, Chan> = {};   // setelan dari file project untuk track yang belum muncul (daftar track menyusul)
  let sig = '\u0000';
  const listeners = new Set<() => void>();
  const effectListeners = new Set<(id: number) => void>(), removedListeners = new Set<(id: number) => void>(), colorListeners = new Set<(id: number, color: string) => void>();


  /* ---------- logic: mute / solo ---------- */
  // Solo hanya memengaruhi grup-nya sendiri: solo track membisukan track lain, solo return membisukan return lain.
  const anyTrackSolo = (): boolean => tracks.some(t => S.chans[t.id]?.solo);
  const anyRetSolo = (): boolean => S.ret.A.solo || S.ret.B.solo;
  const trackAudible = (id: number): boolean => { const c = S.chans[id]; return !!c && c.on && (!anyTrackSolo() || c.solo); };
  const retAudible = (k: 'A' | 'B'): boolean => S.ret[k].on && (!anyRetSolo() || S.ret[k].solo);
  const anyFxSolo = (): boolean => S.fx.some(f => f.solo);
  const fxAudible = (f: FxCh): boolean => f.on && (!anyFxSolo() || f.solo);

  /* ---------- DOM ---------- */
  host.innerHTML = '';
  const tracksBox = el('div', 'mx-tracks');
  const trackList = el('div', 'mx-list'), fxList = el('div', 'mx-list');   // strip track, lalu strip channel FX (keduanya ikut menggulung)
  tracksBox.append(trackList, fxList);
  const fixedBox = el('div', 'mx-fixed');
  host.append(tracksBox, fixedBox);

  interface StripReg { node: HTMLElement; refresh: () => void; audible: () => boolean; }
  const strips = new Map<string, StripReg>();
  const meters = new Map<string, Meter>();

  function refreshAll(): void {
    for (const s of strips.values()) { s.refresh(); s.node.classList.toggle('dim', !s.audible()); }
  }
  function changed(): void { refreshAll(); for (const cb of listeners) cb(); }

  /* ---------- meter loop ---------- */
  let raf = 0, lastT = 0;
  function paintMeter(m: Meter): void {
    m.fl.style.clipPath = `inset(${((1 - m.l) * 100).toFixed(1)}% 0 0 0)`;
    m.fr.style.clipPath = `inset(${((1 - m.r) * 100).toFixed(1)}% 0 0 0)`;
  }
  function tick(t: number): void {
    const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
    let active = false;
    for (const m of meters.values()) {
      m.l = m.tl >= m.l ? m.tl : Math.max(m.tl, m.l - dt * 0.9);   // naik langsung, turun ~1 detik skala penuh
      m.r = m.tr >= m.r ? m.tr : Math.max(m.tr, m.r - dt * 0.9);
      paintMeter(m);
      if (m.l > 0.001 || m.r > 0.001 || m.tl > 0 || m.tr > 0) active = true;
      else { m.l = m.r = 0; paintMeter(m); }
    }
    raf = active ? requestAnimationFrame(tick) : 0;
  }

  function makeMeter(key: string): { node: HTMLElement; meter: Meter } {
    const node = el('div', 'mx-meter');
    node.setAttribute('aria-hidden', 'true');
    const bl = el('div', 'mx-bar'), br = el('div', 'mx-bar');
    const fl = el('div', 'mx-fill'), fr = el('div', 'mx-fill');
    bl.appendChild(fl); br.appendChild(fr);
    node.append(bl, br);
    const pk = el('button', 'mx-rd mx-pk', '-inf');
    pk.title = 'Puncak level (ketuk untuk reset)';
    const meter: Meter = { fl, fr, l: 0, r: 0, tl: 0, tr: 0, peak: -Infinity, pk };
    pk.onclick = () => { meter.peak = -Infinity; pk.textContent = '-inf'; pk.classList.remove('clip'); };
    paintMeter(meter);
    meters.set(key, meter);
    return { node, meter };
  }

  /* ---------- tombol toggle ---------- */
  function toggleBtn(cls: string, label: string, title: string, get: () => boolean, onClick: (e: MouseEvent) => void): { node: HTMLButtonElement; paint: () => void } {
    const b = el('button', 'mx-btn ' + cls);
    b.title = title;
    b.setAttribute('aria-label', title);
    if (cls === 'mx-arm') b.appendChild(el('span', 'mx-dot')); else b.textContent = label;
    const paint = (): void => b.setAttribute('aria-pressed', String(get()));
    b.onclick = e => onClick(e);
    paint();
    return { node: b, paint };
  }

  /* ---------- strip ---------- */
  interface StripCfg {
    key: string; name: string; color?: string;
    getVol(): number; setVol(v: number): void;
    knobs: KnobDef[];
    btns: { on?: { label: string; title: string; get(): boolean; click(e: MouseEvent): void };
            solo?: { get(): boolean; click(e: MouseEvent): void };
            arm?: { get(): boolean; click(e: MouseEvent): void } };
    audible(): boolean;
    more?: { title: string; open(anchor: HTMLElement): void; routed?(): string | null };   // tombol titik tiga di kepala strip
  }
  function buildStrip(c: StripCfg): HTMLElement {
    const node = el('div', 'mx-strip');
    node.dataset.key = c.key;
    const head = el('div', 'mx-head');
    if (c.color) { head.style.setProperty('--c', c.color); head.style.setProperty('--ink', inkOn(c.color)); }
    head.title = c.name;
    head.appendChild(el('span', 'mx-name', c.name));

    const repaint: (() => void)[] = [];
    if (c.more) {
      const mb = el('button', 'mx-more', '\u22EE');
      mb.setAttribute('aria-haspopup', 'menu');
      const cfgMore = c.more;
      mb.onclick = e => { e.stopPropagation(); cfgMore.open(mb); };
      head.appendChild(mb);
      repaint.push(() => {
        const r = cfgMore.routed?.() ?? null;
        mb.classList.toggle('routed', r != null);
        mb.title = r != null ? `${cfgMore.title} (${r})` : cfgMore.title;
        mb.setAttribute('aria-label', mb.title);
      });
    }
    const knobs = el('div', 'mx-knobs');
    for (const k of c.knobs) { const kn = makeKnob(k); knobs.appendChild(kn.node); repaint.push(kn.paint); }

    const btns = el('div', 'mx-btns');
    if (c.btns.on) { const b = toggleBtn('mx-on', c.btns.on.label, c.btns.on.title, c.btns.on.get, c.btns.on.click); btns.appendChild(b.node); repaint.push(b.paint); }
    if (c.btns.solo) { const b = toggleBtn('mx-solo', 'S', 'Solo (Shift+ketuk: solo eksklusif)', c.btns.solo.get, c.btns.solo.click); btns.appendChild(b.node); repaint.push(b.paint); }
    if (c.btns.arm) { const b = toggleBtn('mx-arm', '', 'Arm rekam', c.btns.arm.get, c.btns.arm.click); btns.appendChild(b.node); repaint.push(b.paint); }

    const fader = makeFader(c.name, c.getVol, v => { c.setVol(v); vol.textContent = fmtDb(v); for (const cb of listeners) cb(); });
    repaint.push(fader.paint);
    const { node: meterNode, meter } = makeMeter(c.key);
    fader.node.appendChild(meterNode);

    const reads = el('div', 'mx-reads');
    const vol = el('div', 'mx-rd mx-vol', fmtDb(c.getVol()));
    vol.title = 'Volume (dB)';
    reads.append(vol, meter.pk);
    repaint.push(() => { vol.textContent = fmtDb(c.getVol()); });

    node.append(head, knobs, btns, fader.node, reads);
    const reg: StripReg = { node, refresh: () => { for (const f of repaint) f(); }, audible: c.audible };
    reg.refresh();
    strips.set(c.key, reg);
    node.classList.toggle('dim', !c.audible());
    return node;
  }

  /* ---------- menu popup kecil (titik tiga) ---------- */
  interface MenuItem { label: string; checked?: boolean; disabled?: boolean; run?: () => void; }
  let menuEl: HTMLElement | null = null, menuAnchor: HTMLElement | null = null;
  const onDocDown = (e: PointerEvent): void => { const t = e.target as Node; if (menuEl && !menuEl.contains(t) && !menuAnchor?.contains(t)) closeMenu(); };
  const onDocKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') closeMenu(); };
  function closeMenu(): void {
    menuEl?.remove(); menuEl = null; menuAnchor = null;
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
  }
  function openMenu(anchor: HTMLElement, heading: string, items: MenuItem[]): void {
    if (menuEl && menuAnchor === anchor) { closeMenu(); return; }   // ketuk titik tiga yang sama lagi: tutup
    closeMenu();
    const m = el('div', 'mx-menu');
    m.setAttribute('role', 'menu');
    m.appendChild(el('div', 'mx-menu-h', heading));
    for (const it of items) {
      const b = el('button', 'mx-menu-i', it.label);
      b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemradio');
      if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked));
      b.disabled = !!it.disabled;
      b.onclick = () => { closeMenu(); it.run?.(); };
      m.appendChild(b);
    }
    mountMenu(anchor, m);
  }
  function mountMenu(anchor: HTMLElement, m: HTMLElement): void {   // pasang menu di dekat titik tiga-nya + tutup saat ketuk di luar / Escape
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = clamp(r.right - w, 4, Math.max(4, window.innerWidth - w - 4)) + 'px';
    m.style.top = clamp(r.bottom + 2 + h > window.innerHeight - 4 ? r.top - h - 2 : r.bottom + 2, 4, Math.max(4, window.innerHeight - h - 4)) + 'px';
    menuEl = m; menuAnchor = anchor;
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
  }
  // menu Color: kotak-kotak warna (20 warna track); warna yang sedang dipakai ditandai bingkai putih
  function openColors(anchor: HTMLElement, heading: string, cur: string, pick: (color: string) => void): void {
    closeMenu();
    const m = el('div', 'mx-menu mx-menu-colors');
    m.setAttribute('role', 'menu');
    m.appendChild(el('div', 'mx-menu-h', heading));
    const grid = el('div', 'mx-menu-sw');
    for (const col of TRACK_COLORS) {
      const b = el('button', 'mx-sw');
      b.style.background = col; b.setAttribute('aria-label', col);
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(col.toUpperCase() === cur.toUpperCase()));
      b.onclick = () => { closeMenu(); pick(col); };
      grid.appendChild(b);
    }
    m.appendChild(grid);
    mountMenu(anchor, m);
  }

  /* ---------- channel FX (bus): ditambah lewat tombol +, dihapus lewat titik tiga di kepalanya ---------- */
  function renderFx(): void {
    closeMenu();
    for (const key of [...strips.keys()]) if (key.startsWith('f:')) strips.delete(key);
    for (const key of [...meters.keys()]) if (key.startsWith('f:')) meters.delete(key);
    fxList.innerHTML = '';
    for (const f of S.fx) {
      fxList.appendChild(buildStrip({
        key: 'f:' + f.id, name: f.name, color: FX_COLOR,
        getVol: () => f.vol, setVol: v => { f.vol = v; },
        knobs: [{ label: 'Pan', title: `Pan ${f.name}`, min: -50, max: 50, def: 0, bipolar: true, get: () => f.pan, set: v => { f.pan = v; changed(); }, fmt: fmtPan }],
        btns: {
          on: { label: 'FX', title: `Aktifkan ${f.name}`, get: () => f.on, click: () => { f.on = !f.on; changed(); } },
          solo: { get: () => f.solo, click: e => {
            let next = !f.solo;
            if (e.shiftKey || e.ctrlKey || e.metaKey) {
              next = !(f.solo && S.fx.every(o => o === f || !o.solo));
              for (const o of S.fx) o.solo = false;
            }
            f.solo = next; changed();
          } }
        },
        audible: () => fxAudible(f),
        more: { title: `Menu ${f.name}`, open: a => openMenu(a, f.name, [
          { label: 'Effect', run: () => { for (const cb of effectListeners) cb(f.id); } },   // buka panel Efek: deretan efek khusus channel FX ini
          { label: 'Hapus channel ini', run: () => removeFx(f.id) }
        ]) }
      }));
    }
  }
  function addFx(): void {
    const used = new Set(S.fx.map(f => f.name));
    let n = 1; while (used.has('FX ' + n)) n++;
    const id = S.fx.reduce((mx, f) => Math.max(mx, f.id), 0) + 1;
    S.fx.push({ id, name: 'FX ' + n, vol: POS0DB, pan: 0, on: true, solo: false });
    renderFx(); changed();
    requestAnimationFrame(() => tracksBox.scrollTo({ left: tracksBox.scrollWidth, behavior: 'smooth' }));   // strip baru langsung terlihat
  }
  function removeFx(id: number): void {
    S.fx = S.fx.filter(f => f.id !== id);
    for (const k of Object.keys(S.chans)) if (S.chans[+k].out === id) S.chans[+k].out = null;   // track yang mengarah ke sini kembali ke Master
    renderFx(); changed();
    for (const cb of removedListeners) cb(id);   // efek milik channel ini ikut dibuang
  }
  const fxNameOf = (id: number | null): string | null => (id == null ? null : S.fx.find(f => f.id === id)?.name ?? null);

  /* ---------- strip track (dibangun ulang saat daftar track berubah) ---------- */
  function renderTracks(): void {
    for (const key of [...strips.keys()]) if (key.startsWith('t:')) strips.delete(key);
    for (const key of [...meters.keys()]) if (key.startsWith('t:')) meters.delete(key);
    closeMenu();
    trackList.innerHTML = '';
    if (!tracks.length) {
      trackList.appendChild(el('div', 'mx-empty', 'Belum ada track. Tambah track dari playlist, strip mixer muncul otomatis di sini.'));
      return;
    }
    tracks.forEach((t, i) => {
      const c = S.chans[t.id];
      const strip = buildStrip({
        key: 't:' + t.id, name: t.name, color: t.color,
        getVol: () => c.vol, setVol: v => { c.vol = v; },
        knobs: [
          { label: 'Pan', title: `Pan ${t.name}`, min: -50, max: 50, def: 0, bipolar: true, get: () => c.pan, set: v => { c.pan = v; changed(); }, fmt: fmtPan },
          { label: 'A', title: `Send A ${t.name}`, min: 0, max: 1, def: 0, get: () => c.a, set: v => { c.a = v; changed(); }, fmt: v => fmtDb(v) + ' dB' },
          { label: 'B', title: `Send B ${t.name}`, min: 0, max: 1, def: 0, get: () => c.b, set: v => { c.b = v; changed(); }, fmt: v => fmtDb(v) + ' dB' }
        ],
        btns: {
          on: { label: String(i + 1), title: `Aktifkan track ${t.name}`, get: () => c.on, click: () => { c.on = !c.on; changed(); } },
          solo: { get: () => c.solo, click: e => {
            let next = !c.solo;
            if (e.shiftKey || e.ctrlKey || e.metaKey) {   // eksklusif: jadi satu-satunya yang solo (kalau memang sudah sendirian, matikan)
              next = !(c.solo && tracks.every(o => o.id === t.id || !S.chans[o.id].solo));
              for (const o of tracks) S.chans[o.id].solo = false;
            }
            c.solo = next; changed();
          } },
          arm: { get: () => c.arm, click: () => {
            const next = !c.arm;
            for (const o of tracks) S.chans[o.id].arm = false;   // arm eksklusif seperti default Ableton
            c.arm = next; changed();
          } }
        },
        audible: () => trackAudible(t.id),
        more: {
          title: `Menu ${t.name}`,
          routed: () => fxNameOf(c.out),
          open: a => openMenu(a, t.name, [   // titik tiga track: Color (warna seluruh track) atau Routing (output ke Master / channel FX)
            { label: 'Color', run: () => openColors(a, `Color ${t.name}`, t.color, col => { for (const cb of colorListeners) cb(t.id, col); }) },
            { label: 'Routing', run: () => openMenu(a, `Output ${t.name}`, [
              { label: 'Master', checked: fxNameOf(c.out) == null, run: () => { c.out = null; changed(); } },
              ...S.fx.map(f => ({ label: f.name, checked: c.out === f.id, run: () => { c.out = f.id; changed(); } })),
              ...(S.fx.length ? [] : [{ label: 'Tekan + untuk menambah channel FX', disabled: true }])
            ]) }
          ])
        }
      });
      trackList.appendChild(strip);
    });
  }

  /* ---------- strip return & master (tetap) ---------- */
  const addBtn = el('button', 'mx-add', '+');
  addBtn.title = 'Tambah channel FX';
  addBtn.setAttribute('aria-label', 'Tambah channel FX');
  addBtn.onclick = addFx;
  fixedBox.appendChild(addBtn);
  for (const k of ['A', 'B'] as const) {
    const r = S.ret[k];
    fixedBox.appendChild(buildStrip({
      key: 'r:' + k, name: 'Return ' + k,
      getVol: () => r.vol, setVol: v => { r.vol = v; },
      knobs: [{ label: 'Pan', title: `Pan Return ${k}`, min: -50, max: 50, def: 0, bipolar: true, get: () => r.pan, set: v => { r.pan = v; changed(); }, fmt: fmtPan }],
      btns: {
        on: { label: k, title: `Aktifkan Return ${k}`, get: () => r.on, click: () => { r.on = !r.on; changed(); } },
        solo: { get: () => r.solo, click: e => {
          let next = !r.solo;
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            const other = S.ret[k === 'A' ? 'B' : 'A'];
            next = !(r.solo && !other.solo);
            S.ret.A.solo = false; S.ret.B.solo = false;
          }
          r.solo = next; changed();
        } }
      },
      audible: () => retAudible(k)
    }));
  }
  const m = S.master;
  fixedBox.appendChild(buildStrip({
    key: 'master', name: 'Master',
    getVol: () => m.vol, setVol: v => { m.vol = v; },
    knobs: [
      { label: 'Pan', title: 'Pan Master', min: -50, max: 50, def: 0, bipolar: true, get: () => m.pan, set: v => { m.pan = v; changed(); }, fmt: fmtPan },
      { label: 'Cue', title: 'Volume Cue (headphone)', min: 0, max: 1, def: POS0DB, get: () => m.cue, set: v => { m.cue = v; changed(); }, fmt: v => fmtDb(v) + ' dB' }
    ],
    btns: {},
    audible: () => true
  }));
  fixedBox.lastElementChild?.classList.add('master');
  renderTracks();

  /* ---------- handle ---------- */
  return {
    getState: () => S,
    setTracks(list: MixTrack[]): void {
      const next = list.map(t => ({ id: t.id, name: t.name, color: t.color }));
      const s = JSON.stringify(next);
      if (s === sig) return;   // tidak ada perubahan track: jangan bangun ulang (sering dipanggil)
      sig = s;
      tracks = next;
      const ids = new Set(tracks.map(t => t.id));
      for (const t of tracks) if (!S.chans[t.id]) { S.chans[t.id] = pending[t.id] ?? newChan(); delete pending[t.id]; }
      for (const k of Object.keys(S.chans)) if (!ids.has(+k)) delete S.chans[+k];   // track dihapus: buang setelannya
      renderTracks();
      refreshAll();
      for (const cb of listeners) cb();
    },
    exportState(): MixExport {
      const chans: Record<string, Chan> = {};
      for (const t of tracks) { const c = S.chans[t.id]; if (c) chans[String(t.id)] = { ...c }; }
      return { v: 1, chans, fx: S.fx.map(f => ({ ...f })), ret: { A: { ...S.ret.A }, B: { ...S.ret.B } }, master: { ...S.master } };
    },
    importState(raw: unknown): void {
      const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
      const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : d);
      const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
      const o = isObj(raw) ? raw : {};
      // channel FX
      const fx: FxCh[] = [], ids = new Set<number>();
      for (const f of Array.isArray(o.fx) ? o.fx : []) {
        if (!isObj(f)) continue;
        const id = typeof f.id === 'number' && Number.isInteger(f.id) && f.id > 0 ? f.id : 0;
        if (!id || ids.has(id)) continue;
        ids.add(id);
        const name = typeof f.name === 'string' && f.name.trim() ? f.name.trim().slice(0, 24) : 'FX ' + (fx.length + 1);
        fx.push({ id, name, vol: num(f.vol, 0, 1, POS0DB), pan: num(f.pan, -50, 50, 0), on: bool(f.on, true), solo: bool(f.solo, false) });
      }
      S.fx = fx;
      // channel track (diubah di tempat: strip yang sudah tampil memegang objek yang sama)
      const parse = (c: unknown): Chan => {
        const r = isObj(c) ? c : {};
        const out = typeof r.out === 'number' && ids.has(r.out) ? r.out : null;
        return { vol: num(r.vol, 0, 1, POS0DB), pan: num(r.pan, -50, 50, 0), a: num(r.a, 0, 1, 0), b: num(r.b, 0, 1, 0), on: bool(r.on, true), solo: bool(r.solo, false), arm: bool(r.arm, false), out };
      };
      const src = isObj(o.chans) ? o.chans : {};
      pending = {};
      for (const k of Object.keys(src)) { const id = Number(k); if (Number.isInteger(id) && !(id in S.chans)) pending[id] = parse(src[k]); }
      for (const k of Object.keys(S.chans)) Object.assign(S.chans[+k], parse(src[k]));
      // Return A/B + Master
      const ret = isObj(o.ret) ? o.ret : {};
      for (const k of ['A', 'B'] as const) {
        const r = isObj(ret[k]) ? ret[k] as Record<string, unknown> : {};
        Object.assign(S.ret[k], { vol: num(r.vol, 0, 1, POS0DB), pan: num(r.pan, -50, 50, 0), on: bool(r.on, true), solo: bool(r.solo, false) });
      }
      const ms = isObj(o.master) ? o.master : {};
      Object.assign(S.master, { vol: num(ms.vol, 0, 1, POS0DB), pan: num(ms.pan, -50, 50, 0), cue: num(ms.cue, 0, 1, POS0DB) });
      renderFx();
      changed();
    },
    getChannel(id: number): ChannelOut | null {
      const c = S.chans[id];
      if (!c) return null;
      const audible = trackAudible(id);
      return { audible, gain: audible ? posToGain(c.vol) : 0, pan: c.pan / 50, sendA: posToGain(c.a), sendB: posToGain(c.b), armed: c.arm, out: c.out != null && S.fx.some(f => f.id === c.out) ? c.out : null };
    },
    getReturn(k: 'A' | 'B'): ReturnOut {
      const audible = retAudible(k);
      return { audible, gain: audible ? posToGain(S.ret[k].vol) : 0, pan: S.ret[k].pan / 50 };
    },
    getFx(id: number): ReturnOut | null {
      const f = S.fx.find(x => x.id === id);
      if (!f) return null;
      const audible = fxAudible(f);
      return { audible, gain: audible ? posToGain(f.vol) : 0, pan: f.pan / 50 };
    },
    getMaster: () => ({ gain: posToGain(S.master.vol), pan: S.master.pan / 50, cue: posToGain(S.master.cue) }),
    anySolo: () => anyTrackSolo() || anyRetSolo() || anyFxSolo(),
    setMeter(target: MixTarget, l: number, r: number): void {
      const key = typeof target === 'number' ? 't:' + target : target === 'master' ? 'master' : target.startsWith('fx:') ? 'f:' + target.slice(3) : 'r:' + target;
      const mt = meters.get(key);
      if (!mt) return;
      mt.tl = ampToPos(l); mt.tr = ampToPos(r);
      const db = Math.max(ampToDb(l), ampToDb(r));
      if (db > mt.peak) { mt.peak = db; mt.pk.textContent = fmtPeak(db); mt.pk.classList.toggle('clip', db > 0); }
      if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tick); }
    },
    onChange(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; },
    onFxEffect(cb: (id: number) => void): () => void { effectListeners.add(cb); return () => { effectListeners.delete(cb); }; },
    onFxRemoved(cb: (id: number) => void): () => void { removedListeners.add(cb); return () => { removedListeners.delete(cb); }; },
    onTrackColor(cb: (trackId: number, color: string) => void): () => void { colorListeners.add(cb); return () => { colorListeners.delete(cb); }; }
  };
}
