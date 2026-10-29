// AUTOTUNE FX MIXER (tampilan): papan mixer yang MENGGANTIKAN tampilan knob jendela AUTOTUNE saat ikon Effect di header ditekan (lihat autotune.ts).
//   Satu strip per lapisan (Lead, Harmony 1, Harmony 2, Pitch, Double, Reverb) + Master: fader vertikal dengan meter, pan, mute, solo, dan parameter khusus tiap strip.
//   Mesinnya ada di autotune-fx.ts (tahap efek setelah autotune); file ini hanya membaca / menulis nilai (kunci MX_DEF) lewat MixerHost.
//   Semua kontrol memakai pecahan dari getBoundingClientRect, jadi tetap pas walau jendela diskalakan (properti `scale`).

import { MX_STRIPS, MX_DEF, faderDb, DEGREE_NAMES, INTERVAL_NAMES, type MxDef } from './autotune-fx';

export interface MixerHost {
  get(): Record<string, number>;
  set(patch: Record<string, number>): void;
  locked(): boolean;
  levels(): number[] | null;   // puncak tiap strip (urutan MX_STRIPS), null = tahap belum jalan
}

const MAJ_SEMI = [0, 2, 4, 5, 7, 9, 11, 12];
const sgn = (v: number): string => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
const cl = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const dbTxt = (f: number): string => { const d = faderDb(f); return d === -Infinity ? '−∞' : (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d).toFixed(1); };
const panTxt = (v: number): string => Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);

interface SliderOpt { el: HTMLElement; vertical: boolean; min: number; max: number; def: number; get(): number; set(v: number): void; locked(): boolean; fmt(v: number): string; bipolar?: boolean; name: string }
/** Slider seret (vertikal / mendatar): klik = lompat, seret = ikut, dobel klik = bawaan, roda / panah = geser halus. Mengembalikan fungsi paint untuk menyegarkan tampilan. */
function slider(o: SliderOpt): () => void {
  const { el } = o;
  el.tabIndex = 0; el.setAttribute('role', 'slider'); el.setAttribute('aria-label', o.name);
  el.setAttribute('aria-orientation', o.vertical ? 'vertical' : 'horizontal'); el.setAttribute('aria-valuemin', String(o.min)); el.setAttribute('aria-valuemax', String(o.max));
  const paint = (): void => {
    const v = o.get(), p = (v - o.min) / (o.max - o.min), p0 = o.bipolar ? (0 - o.min) / (o.max - o.min) : 0;
    el.style.setProperty('--p', p.toFixed(4)); el.style.setProperty('--lo', Math.min(p, p0).toFixed(4)); el.style.setProperty('--hi', Math.max(p, p0).toFixed(4));
    el.setAttribute('aria-valuenow', String(v)); el.setAttribute('aria-valuetext', o.fmt(v));
  };
  const put = (v: number): void => { const nv = cl(v, o.min, o.max); if (nv !== o.get()) o.set(nv); paint(); };
  const at = (e: PointerEvent): number => {
    const r = el.getBoundingClientRect(), f = o.vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    let v = o.min + cl(f, 0, 1) * (o.max - o.min);
    if (o.bipolar && Math.abs(v) < (o.max - o.min) * 0.025) v = 0;   // magnet di tengah
    return v;
  };
  el.addEventListener('pointerdown', e => { if (o.locked() || e.button > 0) return; el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true }); put(at(e)); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId) && !o.locked()) put(at(e)); });
  el.addEventListener('dblclick', () => { if (!o.locked()) put(o.def); });
  el.addEventListener('wheel', e => { e.preventDefault(); if (!o.locked()) put(o.get() - Math.sign(e.deltaY) * (o.max - o.min) / 50); }, { passive: false });
  el.addEventListener('keydown', e => {
    if (o.locked()) return; const s = (o.max - o.min) / (e.shiftKey ? 100 : 25);
    if (/Up|Right/.test(e.key)) { put(o.get() + s); e.preventDefault(); } else if (/Down|Left/.test(e.key)) { put(o.get() - s); e.preventDefault(); }
    else if (e.key === 'Home') { put(o.min); e.preventDefault(); } else if (e.key === 'End') { put(o.max); e.preventDefault(); }
  });
  paint();
  return paint;
}

export function buildMixer(root: HTMLElement, h: MixerHost): { load(): void; tick(): void; setLock(b: boolean): void } {
  root.classList.add('mx');
  const strips: MxDef[] = MX_STRIPS;
  root.innerHTML =
    '<div class="mx__top"><button type="button" class="mx__back" aria-label="Back to Autotune knobs">‹ AUTOTUNE</button><span class="mx__ttl">EFFECT MIXER</span>' +
      '<span class="mx__hint"></span><button type="button" class="mx__rst" title="Reset all mixer settings">RESET</button></div>' +
    '<div class="mx__strips">' + strips.map(s => `<div class="mx__st mx__st--${s.kind}" data-st="${s.id}"><div class="mx__nm">${s.name}</div>` +
      '<div class="mx__pa" data-row="a"></div><div class="mx__pa" data-row="b"></div><div class="mx__pa" data-row="c"></div>' +
      '<div class="mx__fd"><div class="mx__met"><i></i></div><div class="mx__trk"><b></b><u></u><s></s></div><div class="mx__scl"><span style="--f:1">+6</span><span style="--f:.75">0</span><span style="--f:.4">−12</span><span style="--f:.21">−24</span><span style="--f:0">−∞</span></div></div>' +
      '<div class="mx__db">−∞</div>' +
      `<div class="mx__ms"><button type="button" class="mx__m" aria-pressed="false" aria-label="Mute ${s.name}">M</button>${s.kind === 'mst' ? '' : `<button type="button" class="mx__s" aria-pressed="false" aria-label="Solo ${s.name}">S</button>`}</div></div>`).join('') + '</div>';
  const q = <T extends HTMLElement>(sel: string, from: ParentNode = root): T => from.querySelector<T>(sel)!;
  const painters: Array<() => void> = [];
  const refresh: Array<() => void> = [];   // penyegar kontrol yang bentuknya bergantung pada nilai lain (mis. mode Harmony)
  const lockOk = (): boolean => h.locked();
  const val = (k: string): number => h.get()[k] ?? MX_DEF[k];
  const put = (patch: Record<string, number>): void => { h.set(patch); refresh.forEach(f => f()); painters.forEach(f => f()); };

  // ----- stepper (‹ nilai ›) -----
  interface StepOpt { label: string; key: string; min: () => number; max: () => number; fmt: (v: number) => string; sub?: (v: number) => string; def: number | (() => number) }
  function stepper(host: HTMLElement, o: StepOpt): void {
    host.innerHTML = `<label>${o.label}</label><div class="mx__step"><button type="button" aria-label="${o.label} −">‹</button><output role="spinbutton" tabindex="0" aria-label="${o.label}"></output><button type="button" aria-label="${o.label} +">›</button></div><small></small>`;
    const out = q('output', host), sub = q('small', host), [dn, up] = [...host.querySelectorAll<HTMLButtonElement>('button')];
    const paint = (): void => { const v = val(o.key); out.textContent = o.fmt(v); sub.textContent = o.sub ? o.sub(v) : ''; out.setAttribute('aria-valuenow', String(v)); dn.disabled = v <= o.min(); up.disabled = v >= o.max(); };
    const go = (d: number): void => { if (!lockOk()) put({ [o.key]: cl(Math.round(val(o.key)) + d, o.min(), o.max()) }); };
    let tm = 0, iv = 0; const stop = (): void => { clearTimeout(tm); clearInterval(iv); };
    const hold = (b: HTMLElement, d: number): void => {
      b.addEventListener('pointerdown', e => { if (e.button > 0) return; go(d); stop(); tm = window.setTimeout(() => { iv = window.setInterval(() => go(d), 70); }, 380); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, stop));
      b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { go(d); e.preventDefault(); } });
    };
    hold(dn, -1); hold(up, 1);
    out.addEventListener('wheel', e => { e.preventDefault(); go(-Math.sign(e.deltaY)); }, { passive: false });
    out.addEventListener('dblclick', () => { if (!lockOk()) put({ [o.key]: typeof o.def === 'function' ? o.def() : o.def }); });
    out.addEventListener('keydown', e => { if (/Up|Right/.test(e.key)) { go(1); e.preventDefault(); } else if (/Down|Left/.test(e.key)) { go(-1); e.preventDefault(); } });
    refresh.push(paint); painters.push(paint); paint();
  }
  // ----- pilihan dua tombol (SCALE | FIXED) -----
  function toggle2(host: HTMLElement, label: string, key: string, a: string, b: string, onChange: (v: number) => Record<string, number>): void {
    host.innerHTML = `<label>${label}</label><div class="mx__seg"><button type="button" data-v="1">${a}</button><button type="button" data-v="0">${b}</button></div>`;
    const bs = [...host.querySelectorAll<HTMLButtonElement>('button')];
    const paint = (): void => bs.forEach(x => x.setAttribute('aria-pressed', String(+x.dataset.v! === (val(key) > 0 ? 1 : 0))));
    bs.forEach(x => x.addEventListener('click', () => { const v = +x.dataset.v!; if (lockOk() || v === (val(key) > 0 ? 1 : 0)) return; put({ [key]: v, ...onChange(v) }); }));
    painters.push(paint); paint();
  }

  const semiToDeg = (s: number): number => { const a = Math.abs(s); let best = 0, bd = 99; MAJ_SEMI.forEach((m, i) => { if (Math.abs(m - a) < bd) { bd = Math.abs(m - a); best = i; } }); return Math.sign(s) * best; };
  for (const s of strips) {
    const el = q(`[data-st="${s.id}"]`), A = q('[data-row="a"]', el), B = q('[data-row="b"]', el), C = q('[data-row="c"]', el);
    if (s.kind === 'harm') {
      const sc = (): boolean => val(s.id + 'Sc') > 0;
      stepper(A, { label: 'INTERVAL', key: s.id + 'Int', min: () => (sc() ? -7 : -12), max: () => (sc() ? 7 : 12), def: () => (sc() ? (s.id === 'h1' ? 2 : 4) : (s.id === 'h1' ? 4 : 7)),
        fmt: v => sc() ? (v === 0 ? 'Unison' : DEGREE_NAMES[Math.abs(v)] + (v > 0 ? ' ↑' : ' ↓')) : sgn(v) + ' st',
        sub: v => sc() ? 'in key' : (INTERVAL_NAMES[Math.abs(v)] + (v > 0 ? ' ↑' : v < 0 ? ' ↓' : '')) });
      toggle2(B, 'MODE', s.id + 'Sc', 'SCALE', 'FIXED', v => ({ [s.id + 'Int']: v ? semiToDeg(val(s.id + 'Int')) : Math.sign(val(s.id + 'Int')) * MAJ_SEMI[Math.abs(val(s.id + 'Int'))] }));
    } else if (s.kind === 'pitch') {
      stepper(A, { label: 'SEMITONES', key: 'pitInt', min: () => -12, max: () => 12, def: -12, fmt: v => sgn(v) + ' st', sub: v => INTERVAL_NAMES[Math.abs(v)] + (v > 0 ? ' ↑' : v < 0 ? ' ↓' : '') });
      stepper(B, { label: 'FINE', key: 'pitFine', min: () => -50, max: () => 50, def: 0, fmt: v => sgn(v) + ' ¢' });
    } else if (s.kind === 'dbl') {
      stepper(A, { label: 'DETUNE', key: 'dblAmt', min: () => 0, max: () => 40, def: 14, fmt: v => v + ' ¢', sub: () => 'two voices, L / R' });
    } else if (s.kind === 'rev') {
      stepper(A, { label: 'SIZE', key: 'revSize', min: () => 0, max: () => 100, def: 45, fmt: v => v + '%', sub: v => (0.5 + v / 100 * 3).toFixed(1) + ' s' });
    } else if (s.kind === 'lead') {
      A.innerHTML = '<label>SOURCE</label><div class="mx__txt">Autotune out</div><small>corrected voice</small>';
    } else A.innerHTML = '<label>OUTPUT</label><div class="mx__txt">Mixer bus</div><small>all layers + reverb</small>';
    // pan / lebar / tone
    if (s.kind === 'mst') C.classList.add('mx__pa--empty');
    else {
      const key = s.id + 'Pan', uni = s.kind === 'dbl' || s.kind === 'rev', lab = s.kind === 'dbl' ? 'WIDTH' : s.kind === 'rev' ? 'TONE' : 'PAN';
      C.innerHTML = `<label>${lab}</label><div class="mx__pan"><b></b><u></u><s></s></div><output></output>`;
      const out = q('output', C), trk = q('.mx__pan', C);
      const fmt = (v: number): string => uni ? Math.round(v * 100) + '%' : panTxt(v);
      painters.push(slider({ el: trk, vertical: false, min: uni ? 0 : -1, max: 1, def: MX_DEF[key], bipolar: !uni, name: s.name + ' ' + lab, get: () => val(key), set: v => { h.set({ [key]: Math.round(v * 100) / 100 }); out.textContent = fmt(v); }, locked: lockOk, fmt }));
      painters.push(() => { out.textContent = fmt(val(key)); });
    }
    // fader
    const lk = s.id + 'Lvl', db = q('.mx__db', el);
    painters.push(slider({ el: q('.mx__trk', q('.mx__fd', el)), vertical: true, min: 0, max: 1, def: MX_DEF[lk], name: s.name + ' level', get: () => val(lk),
      set: v => { h.set({ [lk]: Math.round(v * 1000) / 1000 }); db.textContent = dbTxt(v); status(); }, locked: lockOk, fmt: v => dbTxt(v) + ' dB' }));
    painters.push(() => { db.textContent = dbTxt(val(lk)); });
    // mute / solo
    const mb = q<HTMLButtonElement>('.mx__m', el), sb = el.querySelector<HTMLButtonElement>('.mx__s');
    const flip = (k: string) => (): void => { if (!lockOk()) put({ [k]: val(k) > 0 ? 0 : 1 }); };
    mb.addEventListener('click', flip(s.id + 'Mute')); sb?.addEventListener('click', flip(s.id + 'Solo'));
    painters.push(() => {
      const m = val(s.id + 'Mute') > 0, so = val(s.id + 'Solo') > 0;
      mb.setAttribute('aria-pressed', String(m)); sb?.setAttribute('aria-pressed', String(so));
      el.classList.toggle('is-mute', m);
    });
  }
  const hint = q('.mx__hint'), top = q('.mx__top');
  const status = (): void => {
    const m = h.get(), on = ['h1', 'h2', 'pit', 'dbl', 'rev'].some(id => m[id + 'Lvl'] > 0.002 && !(m[id + 'Mute'] > 0));
    hint.textContent = on ? 'LAYERS ON — after Autotune' : 'Raise a fader to add a layer after Autotune';
    top.classList.toggle('is-on', on);
  };
  painters.push(status);
  q('.mx__rst').addEventListener('click', () => { if (!lockOk()) put({ ...MX_DEF }); });
  q('.mx__back').addEventListener('click', () => root.dispatchEvent(new CustomEvent('mx-back')));
  const metEl = [...root.querySelectorAll<HTMLElement>('.mx__met i')], mv = metEl.map(() => 0);
  return {
    load() { refresh.forEach(f => f()); painters.forEach(f => f()); },
    setLock(b) { root.classList.toggle('is-lock', b); },
    tick() {
      const lv = h.levels();
      metEl.forEach((m, i) => {
        const p = lv ? lv[i] ?? 0 : 0, d = p < 1e-4 ? 0 : cl((20 * Math.log10(p) + 60) / 66, 0, 1);
        mv[i] = Math.max(d, mv[i] - 0.03); m.style.transform = `scaleY(${mv[i].toFixed(3)})`;
      });
    }
  };
}
