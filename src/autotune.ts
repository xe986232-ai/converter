// AUTOTUNE: jendela plugin. Mesinnya (deteksi pitch + penggeser pitch, AudioWorklet) ada di autotune-dsp.ts dan dipasang oleh audio-engine.ts;
//   state jendela ini disimpan di kartu efek track (fx.v) lewat bindAutotune(), jadi tiap track punya setelan sendiri dan ikut tersimpan di project.
//   Tampilan: panel silver brushed + knob teal/emas, orb kaca di tengah = KUNCI NADA TERDETEKSI (deteksi Krumhansl-Schmuckler dari pitch yang dilaporkan mesin)
//   dengan cairan yang bergerak real-time mengikuti pitch / level suara. Jendela berukuran tetap 1080x612 dan diskalakan agar muat di layar.
//   Knob: Amount, Speed, Humanize (memperlambat retune), Key (AUTO / C..B, klik = daftar pilihan), Scale (Minor / Major, klik = daftar pilihan), Output (dB), Input (dB), Mix. Keyboard mini: nada yang diizinkan.
// Plugin ini DISEMBUNYIKAN: tidak ada di daftar tombol "+"; dimunculkan dengan tekan-tahan tombol "+" di panel efek (lihat fx-rack.ts, LONG_PRESS_MS).
// Skin: tombol gerigi di header memilih tampilan (Default / Graphite / Frost); pilihan disimpan di localStorage. Semua skin memakai DOM + logika yang sama, bedanya di CSS (data-skin pada .at__win).
// EFFECT MIXER: ikon mixer di header menukar tampilan knob dengan papan mixer (Harmony 1/2, Pitch, Double, Reverb + Lead & Master). Tampilannya autotune-mixer.ts, mesinnya autotune-fx.ts
//   (tahap TERPISAH setelah node autotune; algoritma autotune-dsp.ts tidak diubah, dan tahap ini tidak dipasang selama semua fader efek di 0). Nilainya ikut tersimpan di fx.v (kunci m_*) dan ikut A/B.
// Kartunya (ringkas) ada di panel efek; jendelanya terpisah dan dibuka dari kartu itu, seperti BPMTUNE / CUTE.

import { bringFront, dragWindow } from './win-drag';
import { mxClean } from './autotune-fx';
import { buildMixer } from './autotune-mixer';

export interface AutotuneState {
  amount: number;    // 0..100 (%): seberapa kuat nada ditarik ke nada yang diizinkan
  speed: number;     // 0..100: Slow (0) .. Fast (100); waktu retune = 400 ms x ((100 - speed) / 100)^2, lihat retuneMs; sekitar 93+ = robotik
  bypass: boolean;
  key: number;       // 0..11 (C = 0)
  scale: string;     // nilai opsi skala, mis. "0,2,3,5,7,8,10"
  allowed: number[]; // kelas nada (0..11) yang boleh dituju
  auto: boolean;     // true = kunci mengikuti hasil deteksi (knob Key = AUTO)
  human: number;     // 0..100 (%): retune makin lambat (alami)
  gin: number;       // dB, penguat input (-12..12)
  out: number;       // dB, penguat output (-12..12)
  mix: number;       // 0..100 (%): campuran hasil autotune dengan suara asli
  mx: Record<string, number>;   // setelan EFFECT MIXER (tahap efek setelah autotune; kunci & bawaan: MX_DEF di autotune-fx.ts)
}

const NN = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const SCALES: [string, string][] = [
  ['Major', '0,2,4,5,7,9,11'], ['Minor', '0,2,3,5,7,8,10'], ['Pentatonic', '0,2,4,7,9'], ['Chromatic', '0,1,2,3,4,5,6,7,8,9,10,11']
];
const WH = [0, 2, 4, 5, 7, 9, 11];                          // tuts putih (kelas nada)
const BL: [number, number][] = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]];   // tuts hitam: [kelas nada, garis batas di antara tuts putih]
// preset: [nama, amount, speed, human, indeks skala, knob Key (0 = AUTO)]
const PRESETS: [string, number, number, number, number, number][] = [
  ['Natural Vocal', 55, 35, 70, 1, 0], ['Soft Correction', 70, 55, 50, 1, 0], ['Modern Pop', 85, 78, 35, 0, 0], ['Hard Tune', 100, 100, 0, 1, 0], ['Robot Lock', 100, 100, 0, 1, 0]
];

const st: AutotuneState = { amount: 100, speed: 90, bypass: false, key: 9, scale: SCALES[1][1], allowed: [], auto: false, human: 0, gin: 0, out: 0, mix: 100, mx: mxClean(null) };
const subs = new Set<(s: AutotuneState) => void>();
const allowedOf = (scale: string, key: number): number[] => scale.split(',').map(x => (+x + key) % 12);
st.allowed = allowedOf(st.scale, st.key);

/** Penghubung jendela <-> kartu efek: dibuat fx-rack untuk track yang sedang dipilih. */
export interface AutotuneHost {
  get(): AutotuneState; set(s: AutotuneState): void;
  pitch(): { raw: number; out: number } | null;
  levels?(): { li: number; lo: number } | null;   // level puncak 0..1 sebelum / sesudah AUTOTUNE (meter)
  mxLevels?(): number[] | null;                   // puncak tiap strip EFFECT MIXER
}
const mask12 = (a: number[]): number => a.reduce((m, c) => m | (1 << c), 0);
const r1 = (x: number): number => Math.round(x * 10) / 10;
/** State -> nilai angka (fx.v) yang disimpan di project. */
export const autotuneToV = (s: AutotuneState): Record<string, number> => ({
  amount: Math.round(s.amount), speed: Math.round(s.speed), bypass: s.bypass ? 1 : 0, key: s.key,
  scale: Math.max(0, SCALES.findIndex(x => x[1] === s.scale)), mask: mask12(s.allowed),
  auto: s.auto ? 1 : 0, human: Math.round(s.human), gin: r1(s.gin), out: r1(s.out), mix: Math.round(s.mix),
  ...Object.fromEntries(Object.entries(s.mx).map(([k, x]) => ['m_' + k, Math.round(x * 1000) / 1000]))   // mixer efek: kunci berawalan m_
});
/** fx.v -> state (nilai yang belum ada memakai bawaan, jadi project lama / kartu baru aman). */
export function autotuneFromV(v: Record<string, number>): AutotuneState {
  const key = Number.isFinite(v.key) ? ((v.key % 12) + 12) % 12 : 9, scale = SCALES[Number.isFinite(v.scale) && SCALES[v.scale] ? v.scale : 1][1];
  const allowed = Number.isFinite(v.mask) ? [...Array(12).keys()].filter(c => (v.mask >> c) & 1) : allowedOf(scale, key);
  const n = (x: number, d: number): number => (Number.isFinite(x) ? x : d);
  return { amount: n(v.amount, 100), speed: n(v.speed, 90), bypass: !!v.bypass, key, scale, allowed, auto: !!v.auto, human: n(v.human, 0), gin: n(v.gin, 0), out: n(v.out, 0), mix: n(v.mix, 100),
    mx: mxClean(Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith('m_')).map(([k, x]) => [k.slice(2), x]))) };
}
/** Parameter mesin dari state: amount 0..1, tc (ms), mask 12 bit, on, gain input / output (linear), mix 0..1. */
export const autotuneEngine = (s: AutotuneState): { amount: number; tc: number; mask: number; on: boolean; gi: number; go: number; mix: number; mx: Record<string, number> } =>
  ({ amount: s.amount / 100, tc: retuneMs(s.speed) * (1 + 2 * s.human / 100), mask: mask12(s.allowed), on: !s.bypass, gi: Math.pow(10, s.gin / 20), go: Math.pow(10, s.out / 20), mix: s.mix / 100, mx: { ...s.mx } });

const det = { ok: false, pc: 9, mode: 1, conf: 0 };   // hasil deteksi kunci
const hist: number[] = new Array(12).fill(0);          // histogram kelas nada (meluruh pelan)
let host: AutotuneHost | null = null, loadUi: (() => void) | null = null, loading = false, detUi: (() => void) | null = null;
/** Arahkan jendela ke efek AUTOTUNE sebuah track (null = tidak ada). Panggil sebelum openAutotune(). */
export function bindAutotune(h: AutotuneHost | null): void {
  host = h;
  hist.fill(0); det.ok = false; det.conf = 0;
  if (h) { Object.assign(st, h.get()); st.allowed = [...st.allowed]; st.mx = mxClean(st.mx); }
  if (root) { loading = true; try { loadUi?.(); detUi?.(); } finally { loading = false; } }
}
export const autotuneState = (): AutotuneState => ({ ...st, allowed: [...st.allowed], mx: { ...st.mx } });
export const onAutotune = (f: (s: AutotuneState) => void): void => { subs.add(f); };
const emit = (): void => { if (loading) return; host?.set(autotuneState()); subs.forEach(f => f(autotuneState())); };
/** Waktu retune (ms) dari knob Speed. */
export const retuneMs = (speed: number): number => 400 * Math.pow((100 - speed) / 100, 2);   // kurva kuadrat: ujung Fast makin rapat (90 = 4 ms, 95 = 1 ms = ≤ 2 ms = lompat seketika / robotik)
/** Dulu menggerakkan titik strip tuner; sekarang orb membaca pitch sendiri. Dibiarkan agar pemanggil lama tetap jalan. */
export const setTunerDots = (_raw: number | null, _out: number | null): void => { /* tidak dipakai lagi */ };

let root: HTMLElement | null = null, openFn: (() => void) | null = null;
export function openAutotune(): void {
  if (!root) build();
  if (host) { loading = true; try { loadUi?.(); } finally { loading = false; } }
  openFn?.();
}

// ---------- knob (busur 270°, seret vertikal / roda / panah, dobel klik = reset) ----------
const pt = (a: number, r: number): [number, number] => [50 + r * Math.cos(a * Math.PI / 180), 50 + r * Math.sin(a * Math.PI / 180)];
const arc = (a0: number, a1: number): string => { const [p, q] = pt(a0, 36), [r, s] = pt(a1, 36); return `M${p} ${q}A36 36 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${r} ${s}`; };
interface KnobOpt { name: string; min: number; max: number; val: number; def: number; fs?: number; steps?: boolean; pick?: (el: HTMLElement) => void; fmt: (v: number) => string; cb: (v: number) => void }
type KnobSet = (v: number, quiet?: boolean) => void;
let locked = false;

function knob(el: HTMLElement, o: KnobOpt): KnobSet {
  el.tabIndex = 0; el.setAttribute('role', 'slider'); el.setAttribute('aria-label', o.name);
  el.setAttribute('aria-valuemin', String(o.min)); el.setAttribute('aria-valuemax', String(o.max));
  el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="49" fill="url(#at-bz)"/><circle cx="50" cy="50" r="43" fill="url(#at-fc)"/>` +
    `<path class="at__tr" d="${arc(135, 405)}"/><path class="at__va"/><circle class="at__dt" r="2.8"/><ellipse cx="50" cy="27" rx="27" ry="14" fill="url(#at-gl)"/></svg>` +
    `<span class="at__v" style="font-size:${o.fs ?? 13}px"></span>`;
  let cur = o.val, val = cur;
  const va = el.querySelector('.at__va')!, dt = el.querySelector('.at__dt')!, vt = el.querySelector('.at__v')!;
  const set: KnobSet = (x, quiet) => {
    cur = Math.min(o.max, Math.max(o.min, x));
    const nv = o.steps ? Math.round(cur) : cur, ch = nv !== val; val = nv;
    const a = 135 + 270 * (val - o.min) / (o.max - o.min);
    va.setAttribute('d', val > o.min ? arc(135, a) : '');
    const [dx, dy] = pt(a, 36); dt.setAttribute('cx', String(dx)); dt.setAttribute('cy', String(dy));
    el.style.setProperty('--p', ((val - o.min) / (o.max - o.min)).toFixed(4));   // dipakai skin Frost (slider)
    vt.textContent = o.fmt(val); el.setAttribute('aria-valuenow', String(val)); el.setAttribute('aria-valuetext', o.fmt(val));
    if (!quiet && ch) o.cb(val);
  };
  if (o.pick) {   // knob pilihan (Key / Scale): klik membuka daftar pilihan, tidak diseret
    el.classList.add('at__k--pick'); el.setAttribute('aria-haspopup', 'listbox');
    el.addEventListener('click', () => { if (!locked) o.pick!(el); });
    el.addEventListener('keydown', e => { if (!locked && (e.key === 'Enter' || e.key === ' ')) { o.pick!(el); e.preventDefault(); } });
  }
  el.style.setProperty('--p0', String(o.min < 0 ? -o.min / (o.max - o.min) : 0));
  const slider = (): boolean => !!el.closest('.at__win[data-skin="frost"]');   // skin Frost: seret mendatar, klik di jalur = lompat
  let y0 = 0, x0 = 0, v0 = 0;
  el.addEventListener('pointerdown', e => {
    if (locked || o.pick) return; el.setPointerCapture(e.pointerId); y0 = e.clientY; x0 = e.clientX;
    if (slider()) { const r = el.getBoundingClientRect(); set(o.min + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (o.max - o.min)); }
    v0 = cur;
  });
  el.addEventListener('pointermove', e => {
    if (o.pick || !el.hasPointerCapture(e.pointerId) || locked) return;
    if (slider()) set(v0 + (e.clientX - x0) / (el.offsetWidth * kScale()) * (o.max - o.min));
    else set(v0 + (y0 - e.clientY) / (170 * kScale()) * (o.max - o.min));
  });
  el.addEventListener('wheel', e => { e.preventDefault(); if (!locked) set(cur - Math.sign(e.deltaY) * (o.steps ? 1 : (o.max - o.min) / 40)); }, { passive: false });
  el.addEventListener('keydown', e => {
    if (locked) return;
    const s = o.steps ? 1 : (o.max - o.min) / 40;
    if (/Up|Right/.test(e.key)) { set(cur + s); e.preventDefault(); }
    if (/Down|Left/.test(e.key)) { set(cur - s); e.preventDefault(); }
  });
  el.addEventListener('dblclick', () => { if (!locked && !o.pick) set(o.def); });
  set(cur, true);
  return set;
}
let curScale = 1;
const kScale = (): number => curScale;   // jendela diskalakan: jarak seret dikoreksi supaya terasa sama

const SVG_DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
  '<linearGradient id="at-bz" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#a9a8b1"/><stop offset=".6" stop-color="#eeeef3"/><stop offset="1" stop-color="#85848f"/></linearGradient>' +
  '<radialGradient id="at-fc" cx=".5" cy=".7" r=".75"><stop offset="0" stop-color="#1f4252"/><stop offset=".6" stop-color="#0f2230"/><stop offset="1" stop-color="#06111a"/></radialGradient>' +
  '<linearGradient id="at-ar" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#b8893a"/><stop offset="1" stop-color="#f6e2a8"/></linearGradient>' +
  '<linearGradient id="at-gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>' +
  '<linearGradient id="at-lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e2a8"/><stop offset=".5" stop-color="#e2c27a"/><stop offset="1" stop-color="#3fd0c0"/></linearGradient></defs></svg>';
const GEAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>';
const SKINS: [string, string, string][] = [['default', 'Default', 'Silver & teal'], ['graphite', 'Graphite', 'Dark, minimal'], ['frost', 'Frost', 'Light, sliders']];
const SKIN_KEY = 'deriz.autotune.skin';
const ICO = {
  lock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  pwr: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  fx: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
  logo: '<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M3 26 14 3l11 23h-6l-5-11-5 11z" fill="url(#at-lg)"/></svg>'
};
const KLAB: Record<string, string> = { amount: 'Amount', speed: 'Speed', human: 'Humanize', key: 'Key', scale: 'Scale', out: 'Output', gin: 'Input', mix: 'Mix' };
const kn = (id: string, x: number, y: number, s: number, lab: string): string =>
  `<div class="at__kn" data-kn="${id}" data-lab="${KLAB[id] ?? id}" style="left:${x}px;top:${y}px"><div class="at__k" data-k="${id}" style="width:${s}px;height:${s}px"></div>${lab ? `<label>${lab}</label>` : ''}</div>`;

function build(): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'at'; el.hidden = true;
  el.innerHTML = SVG_DEFS +
    '<div class="at__win" role="dialog" aria-label="AUTOTUNE" tabindex="-1">' +
      `<div class="at__tb"><span>Deriz Autotune</span><button type="button" class="at__close" aria-label="Tutup AUTOTUNE">${ICO.x}</button></div>` +
      `<div class="at__hd"><div class="at__logo">${ICO.logo}<span>DERIZ <b>AUTOTUNE</b></span></div>` +
        '<div class="at__pre"><button type="button" class="at__pv" aria-label="Preset sebelumnya">‹</button><span class="at__pname"></span><button type="button" class="at__nx" aria-label="Preset berikutnya">›</button></div>' +
        `<div class="at__rt"><button type="button" class="at__fxb" aria-label="Effect mixer" aria-pressed="false" title="Effects: Harmony, Pitch, Double, Reverb">${ICO.fx}</button><div class="at__ab"><button type="button" class="at__sa on">A</button><button type="button" class="at__sb">B</button></div>` +
        `<button type="button" class="at__ic" aria-label="Kunci kontrol" aria-pressed="false">${ICO.lock}</button>` +
        `<button type="button" class="at__byp" aria-pressed="false">${ICO.pwr}BYPASS</button>` +
        `<button type="button" class="at__gear" aria-label="Pengaturan skin" aria-haspopup="true" aria-expanded="false">${GEAR}</button></div></div>` +
      '<div class="at__panel">' +
        '<div class="at__cards" aria-hidden="true"><i></i><i></i><i></i></div>' +
        '<div class="at__inl"><div class="at__il">Scale</div><div class="at__sg"></div><div class="at__il">Key</div><div class="at__kg"></div></div>' +
        kn('amount', 66, 132, 160, 'AMOUNT') + kn('speed', 255, 66, 108, 'SPEED') + kn('human', 255, 250, 108, 'HUMANIZE') +
        kn('key', 716, 66, 108, 'KEY') + kn('scale', 716, 250, 108, 'SCALE') + kn('out', 854, 132, 160, 'OUTPUT') +
        '<div class="at__orb"><div class="at__rg" aria-hidden="true"></div><div class="at__cd" aria-hidden="true"></div><div class="at__in"><canvas width="560" height="560"></canvas><div class="at__gl"></div>' +
          '<div class="at__tx"><small>DETECTED KEY</small><div class="at__n">–</div><div class="at__m">LISTENING</div><div class="at__c">&nbsp;</div></div></div></div>' +
        '<div class="at__menu" role="listbox" hidden></div>' +
        '<div class="at__kb"><b>NOTES</b><div class="at__pk"></div><output>–</output></div>' +
      '</div>' +
      '<div class="at__ft">' + kn('gin', 15, 9, 54, '') +
        '<div class="at__mt" style="left:88px">INPUT<div class="at__r" style="top:-6px"><i></i></div><div class="at__r" style="top:6px"><i></i></div><em style="top:-8px">-∞ dB</em></div>' +
        '<div class="at__br">DERIZMP3</div>' +
        '<div class="at__mt" style="left:762px">OUTPUT<div class="at__r" style="top:-6px"><i></i></div><div class="at__r" style="top:6px"><i></i></div><em style="top:-8px">-∞ dB</em></div>' +
        kn('mix', 1011, 9, 54, '') + '</div>' +
      '<div class="at__mx" hidden></div>' +
      '<div class="at__set" role="menu" aria-label="Skin" hidden><div class="at__mh">SKIN</div>' +
        SKINS.map(([id, n, d]) => `<button type="button" role="menuitemradio" data-skin="${id}" aria-checked="false"><i class="at__sw at__sw--${id}"></i><span><b>${n}</b><small>${d}</small></span></button>`).join('') + '</div>' +
    '</div>';
  document.body.appendChild(el);
  dragWindow({ root: el, move: el.querySelector<HTMLElement>('.at__win')!, handle: '.at__tb' });
  root = el;

  const q = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s)!;
  const win = q('.at__win'), panel = q('.at__panel'), pk = q('.at__pk'), cv = q<HTMLCanvasElement>('canvas');
  const kEl = (id: string): HTMLElement => q(`[data-k="${id}"]`);
  const dn = q('.at__n'), dm = q('.at__m'), dc = q('.at__c'), ro = q('.at__kb output');
  const bars = [...el.querySelectorAll<HTMLElement>('.at__r i')], dbs = [...el.querySelectorAll<HTMLElement>('.at__mt em')];
  const dB = (v: number): string => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', pct = (v: number): string => Math.round(v) + '%';
  const sIdx = (): number => Math.max(0, SCALES.findIndex(x => x[1] === st.scale));

  // ----- keyboard mini: nada yang diizinkan -----
  const keyEl: Record<number, HTMLButtonElement> = {};
  WH.forEach((pc, i) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'at__w'; b.style.left = `calc(${i} * 100% / 7 + 1px)`; b.setAttribute('aria-label', NN[pc]); pk.append(b); keyEl[pc] = b; });
  BL.forEach(([pc, i]) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'at__bk'; b.style.left = (i * 100 / 7) + '%'; b.setAttribute('aria-label', NN[pc]); pk.append(b); keyEl[pc] = b; });
  // cincin 12 nada (skin Graphite) + pemilih Key / Scale sebaris (skin Frost)
  const ringEl: HTMLElement[] = [];
  NN.forEach((n, i) => {
    const a = (-90 + 30 * i) * Math.PI / 180, b = document.createElement('i'); b.textContent = n;
    b.style.left = (165 + 150 * Math.cos(a)) + 'px'; b.style.top = (165 + 150 * Math.sin(a)) + 'px'; q('.at__rg').append(b); ringEl.push(b);
  });
  const sgEl = q('.at__sg'), kgEl = q('.at__kg');
  sgEl.innerHTML = '<button type="button" data-id="scale" data-v="1">Minor</button><button type="button" data-id="scale" data-v="0">Major</button>';
  kgEl.innerHTML = '<button type="button" class="at__auto" data-id="key" data-v="0">AUTO</button>' + NN.map((n, i) => `<button type="button" data-id="key" data-v="${i + 1}">${n}</button>`).join('');
  q('.at__inl').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-id]'); if (!b || locked) return;
    kSet[b.dataset.id!](+b.dataset.v!);
  });
  function syncInl(): void {
    const kv = st.auto ? 0 : st.key + 1, sv = sIdx();
    q('.at__inl').querySelectorAll<HTMLElement>('button[data-id]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.v! === (b.dataset.id === 'key' ? kv : sv))));
  }
  function paint(): void {
    const on = new Set(st.allowed);
    for (let pc = 0; pc < 12; pc++) { keyEl[pc].setAttribute('aria-pressed', String(on.has(pc))); ringEl[pc].classList.toggle('on', on.has(pc)); }
    syncInl();
  }
  for (let pc = 0; pc < 12; pc++) keyEl[pc].addEventListener('click', () => {
    if (locked) return;
    const s = new Set(st.allowed); if (s.has(pc)) s.delete(pc); else s.add(pc);
    st.allowed = [...s].sort((a, b) => a - b); paint(); emit();
  });

  // kunci + skala -> nada yang diizinkan (AUTO: akar / mode dari deteksi)
  function applyKey(): void {
    let sc = sIdx();
    if (st.auto && det.ok) { st.key = det.pc; if (sc < 2) sc = det.mode; st.scale = SCALES[sc][1]; kSet.scale(sc, true); }
    st.allowed = allowedOf(SCALES[sc][1], st.key); paint();
  }

  // ----- daftar pilihan Key / Scale (muncul saat knob diklik) -----
  const menu = q('.at__menu');
  let menuFor = '';
  const hideMenu = (): void => { menu.hidden = true; menuFor = ''; kEl('key').setAttribute('aria-expanded', 'false'); kEl('scale').setAttribute('aria-expanded', 'false'); };
  const keyItems = (): [number, string][] => [[0, 'AUTO'], ...NN.map((n, i) => [i + 1, n] as [number, string])];
  const scaleItems = (): [number, string][] => [[1, 'Minor'], [0, 'Major']];
  function showMenu(id: 'key' | 'scale', anchor: HTMLElement): void {
    if (menuFor === id) { hideMenu(); return; }
    hideMenu(); menuFor = id;
    const isKey = id === 'key', items = isKey ? keyItems() : scaleItems();
    const curV = isKey ? (st.auto ? 0 : st.key + 1) : sIdx();
    menu.className = 'at__menu at__menu--' + id;
    menu.innerHTML = `<div class="at__mh">${isKey ? 'KEY' : 'SCALE'}</div><div class="at__mg">` +
      items.map(([v, t]) => `<button type="button" role="option" data-v="${v}" aria-selected="${v === curV}"${isKey && v === 0 ? ' class="is-auto"' : ''}>${t}</button>`).join('') + '</div>';
    const host = anchor.parentElement as HTMLElement;
    if (win.dataset.skin === 'graphite') {   // kolom pilihan lebar: daftar muncul tepat di bawahnya
      menu.style.left = host.offsetLeft + 'px'; menu.style.top = (host.offsetTop + anchor.offsetHeight + 8) + 'px';
    } else {
      menu.style.left = (parseFloat(host.style.left) + anchor.offsetWidth + 14) + 'px';
      menu.style.top = (parseFloat(host.style.top) - (isKey ? 14 : 0)) + 'px';
    }
    menu.hidden = false; anchor.setAttribute('aria-expanded', 'true');
    menu.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
  }
  menu.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-v]'); if (!b) return;
    const id = menuFor as 'key' | 'scale', v = +b.dataset.v!;
    hideMenu(); kSet[id](v); kEl(id).focus({ preventScroll: true });
  });
  menu.addEventListener('keydown', e => {   // panah menggeser fokus antar pilihan
    const bs = [...menu.querySelectorAll<HTMLButtonElement>('button[data-v]')], i = bs.indexOf(document.activeElement as HTMLButtonElement);
    const cols = menuFor === 'key' ? 4 : 1, d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' ? cols : e.key === 'ArrowUp' ? -cols : 0;
    if (d && i >= 0) { bs[Math.min(bs.length - 1, Math.max(0, i + d))].focus(); e.preventDefault(); }
  });
  panel.addEventListener('pointerdown', e => { const t = e.target as HTMLElement; if (!menu.hidden && !menu.contains(t) && !t.closest('.at__k--pick')) hideMenu(); });

  // ----- knob -----
  const kSet: Record<string, KnobSet> = {};
  const mk = (id: string, o: Omit<KnobOpt, 'name'> & { name?: string }): void => { kSet[id] = knob(kEl(id), { ...o, name: o.name ?? id }); };
  mk('amount', { name: 'Amount', min: 0, max: 100, val: st.amount, def: 100, fs: 26, fmt: pct, cb: v => { st.amount = v; emit(); } });
  mk('speed', { name: 'Speed', min: 0, max: 100, val: st.speed, def: 90, fmt: pct, cb: v => { st.speed = v; emit(); } });
  mk('human', { name: 'Humanize', min: 0, max: 100, val: st.human, def: 0, fmt: pct, cb: v => { st.human = v; emit(); } });
  mk('key', { name: 'Key', min: 0, max: 12, steps: true, val: st.auto ? 0 : st.key + 1, def: 0, pick: a => showMenu('key', a), fmt: v => (v ? NN[v - 1] : 'AUTO'),
    cb: v => { st.auto = v === 0; if (v) st.key = v - 1; applyKey(); emit(); } });
  mk('scale', { name: 'Scale', min: 0, max: 3, steps: true, val: sIdx(), def: 1, fs: 13, pick: a => showMenu('scale', a), fmt: v => SCALES[v][0].slice(0, 5).toUpperCase(), cb: v => { st.scale = SCALES[v][1]; applyKey(); emit(); } });
  mk('out', { name: 'Output', min: -12, max: 12, val: st.out, def: 0, fs: 24, fmt: dB, cb: v => { st.out = r1(v); emit(); } });
  mk('gin', { name: 'Input', min: -12, max: 12, val: st.gin, def: 0, fs: 9, fmt: v => v.toFixed(1) + ' dB', cb: v => { st.gin = r1(v); emit(); } });
  mk('mix', { name: 'Mix', min: 0, max: 100, val: st.mix, def: 100, fs: 10, fmt: pct, cb: v => { st.mix = v; emit(); } });

  // ----- preset, A/B, kunci kontrol, bypass -----
  let pi = 0;
  const loadPreset = (i: number): void => {
    pi = (i + PRESETS.length) % PRESETS.length; const p = PRESETS[pi]; q('.at__pname').textContent = p[0];
    kSet.amount(p[1]); kSet.speed(p[2]); kSet.human(p[3]); kSet.scale(p[4]); kSet.key(p[5]);
  };
  q('.at__pv').addEventListener('click', () => { if (!locked) loadPreset(pi - 1); });
  q('.at__nx').addEventListener('click', () => { if (!locked) loadPreset(pi + 1); });
  const snap = (): AutotuneState => autotuneState();
  let slot = 0; const sl = [snap(), snap()];
  const setByp = (): void => { q('.at__byp').setAttribute('aria-pressed', String(st.bypass)); q('.at__byp').classList.toggle('on', st.bypass); win.classList.toggle('is-byp', st.bypass); };
  function loadAll(): void {   // tampilkan seluruh state tanpa menulis balik
    kSet.amount(st.amount, true); kSet.speed(st.speed, true); kSet.human(st.human, true); kSet.key(st.auto ? 0 : st.key + 1, true);
    kSet.scale(sIdx(), true); kSet.out(st.out, true); kSet.gin(st.gin, true); kSet.mix(st.mix, true); paint(); setByp(); mixer.load();
  }
  const ab = (n: number): void => {
    if (n === slot) return; sl[slot] = snap(); slot = n; Object.assign(st, sl[n], { allowed: [...sl[n].allowed], mx: { ...sl[n].mx } });
    loadAll(); emit(); q('.at__sa').classList.toggle('on', !n); q('.at__sb').classList.toggle('on', !!n);
  };
  q('.at__sa').addEventListener('click', () => ab(0)); q('.at__sb').addEventListener('click', () => ab(1));
  const lockBtn = q('.at__ic');
  lockBtn.addEventListener('click', () => { locked = !locked; lockBtn.classList.toggle('on', locked); lockBtn.setAttribute('aria-pressed', String(locked)); panel.classList.toggle('is-lock', locked); mixer.setLock(locked); });
  q('.at__byp').addEventListener('click', () => { st.bypass = !st.bypass; setByp(); emit(); });
  loadUi = () => { hideMenu(); hideSet(); loadAll(); };
  paint(); setByp();

  // ----- skin + pengaturan (tombol gerigi) -----
  const setPop = q('.at__set'), gear = q('.at__gear');
  const hideSet = (): void => { setPop.hidden = true; gear.setAttribute('aria-expanded', 'false'); };
  function applySkin(id: string, save = true): void {
    if (!SKINS.some(x => x[0] === id)) id = 'default';
    if (id === 'default') delete win.dataset.skin; else win.dataset.skin = id;
    setPop.querySelectorAll('button[data-skin]').forEach(b => b.setAttribute('aria-checked', String((b as HTMLElement).dataset.skin === id)));
    hideMenu();
    if (save) { try { localStorage.setItem(SKIN_KEY, id); } catch { /* penyimpanan tidak tersedia: skin hanya berlaku sesi ini */ } }
  }
  gear.addEventListener('click', () => { hideMenu(); setPop.hidden = !setPop.hidden; gear.setAttribute('aria-expanded', String(!setPop.hidden)); if (!setPop.hidden) setPop.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true }); });
  setPop.addEventListener('click', e => { const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-skin]'); if (b) { applySkin(b.dataset.skin!); hideSet(); gear.focus({ preventScroll: true }); } });
  win.addEventListener('pointerdown', e => { const t = e.target as HTMLElement; if (!setPop.hidden && !setPop.contains(t) && !t.closest('.at__gear')) hideSet(); });
  let savedSkin = 'default'; try { savedSkin = localStorage.getItem(SKIN_KEY) || 'default'; } catch { /* abaikan */ }
  applySkin(savedSkin, false);
  const cdEl = q('.at__cd');

  // ----- EFFECT MIXER: ikon di header menukar tampilan knob dengan mixer (Harmony / Pitch / Double / Reverb setelah autotune; mesin di autotune-fx.ts) -----
  const mxEl = q('.at__mx'), fxBtn = q('.at__fxb');
  const mixer = buildMixer(mxEl, { get: () => st.mx, set: p => { Object.assign(st.mx, p); emit(); }, locked: () => locked, levels: () => host?.mxLevels?.() ?? null });
  const setFx = (on: boolean): void => {
    hideMenu(); hideSet(); mxEl.hidden = !on; win.classList.toggle('is-fx', on);
    fxBtn.setAttribute('aria-pressed', String(on)); fxBtn.classList.toggle('on', on);
    if (on) mixer.load();
  };
  fxBtn.addEventListener('click', () => setFx(fxBtn.getAttribute('aria-pressed') !== 'true'));
  mxEl.addEventListener('mx-back', () => { setFx(false); fxBtn.focus({ preventScroll: true }); });

  // ----- deteksi kunci (Krumhansl-Schmuckler) dari pitch yang dilaporkan mesin -----
  const PM = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], Pm = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const corr = (a: number[], b: number[]): number => {
    const m = (x: number[]): number => x.reduce((s, v) => s + v, 0) / x.length, ma = m(a), mb = m(b);
    let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db || 1);
  };
  // Orb: saat ada suara, huruf besar = NADA VOKAL yang sedang dinyanyikan (bergerak real-time); sepi = kunci hasil deteksi.
  const dl = q('.at__tx small');
  let liveNote = -1, shownNote = -2, ringNote = -2;   // liveNote: nada vokal terkini (-1 = tidak ada suara); shownNote: yang sedang tertulis di orb
  const detTxt = (): string => det.ok ? NN[det.pc] + ' ' + (det.mode ? 'MINOR' : 'MAJOR') : 'LISTENING';
  const showDet = (): void => {
    if (ringNote !== liveNote) { ringNote = liveNote; ringEl.forEach((r, i) => r.classList.toggle('cur', i === liveNote)); }
    if (liveNote >= 0) {
      if (shownNote !== liveNote) { dn.textContent = NN[liveNote]; dl.textContent = 'VOCAL NOTE'; shownNote = liveNote; }
      dm.textContent = detTxt(); return;
    }
    shownNote = -2; dl.textContent = 'DETECTED KEY';
    if (!det.ok) { dn.textContent = '–'; dm.textContent = 'LISTENING'; return; }
    dn.textContent = NN[det.pc]; dm.textContent = det.mode ? 'MINOR' : 'MAJOR';
  };
  detUi = showDet;
  function detect(): void {
    if (hist.reduce((s, v) => s + v, 0) < 60) return;
    let best = -2, bp = 0, bm = 0;
    for (let r = 0; r < 12; r++) for (let m = 0; m < 2; m++) {
      const prof = m ? Pm : PM, c = corr(hist, prof.map((_, i) => prof[(i - r + 12) % 12]));
      if (c > best) { best = c; bp = r; bm = m; }
    }
    const ch = !det.ok || det.pc !== bp || det.mode !== bm;
    Object.assign(det, { ok: true, pc: bp, mode: bm, conf: Math.max(0, Math.min(1, (best - 0.3) / 0.6)) });
    showDet();
    if (ch && st.auto) { applyKey(); emit(); }
  }

  // ----- orb: cairan + kilau, bergerak real-time mengikuti pitch dan level suara -----
  const g = cv.getContext('2d')!, SZ = 560;
  const spk = Array.from({ length: 46 }, () => ({ x: Math.random() * SZ, y: Math.random(), r: 3 + Math.random() * 7, p: Math.random() * 6, v: 0.1 + Math.random() * 0.25 }));
  const cl = (v: number, a = 0, b = 1): number => Math.max(a, Math.min(b, v));
  const star = (x: number, y: number, r: number, a: number): void => {
    g.save(); g.globalAlpha = a; g.fillStyle = '#fff'; g.beginPath(); g.moveTo(x, y - r); g.quadraticCurveTo(x, y, x + r, y); g.quadraticCurveTo(x, y, x, y + r); g.quadraticCurveTo(x, y, x - r, y); g.quadraticCurveTo(x, y, x, y - r); g.fill(); g.restore();
  };
  let raw = 57, out = 57, lvl = 0, wl = 0.4, wa = 6, pS = 57, tilt = 0, ph = 0;
  function draw(t: number, vo: boolean): void {
    if (vo) pS += (raw - pS) * 0.2;
    const hg = cl((pS - 43) / 32);
    wl += ((0.12 + 0.6 * hg + (det.ok ? 0.2 * det.conf : 0)) - wl) * 0.07; wa += ((5 + lvl * 26) - wa) * 0.12;
    tilt += ((vo ? cl(raw - out, -1, 1) : 0) - tilt) * 0.1; ph += 0.02 + hg * 0.05 + lvl * 0.05;
    const bg = g.createLinearGradient(0, 0, 0, SZ); bg.addColorStop(0, '#92a8ae'); bg.addColorStop(0.55, '#2a3d46'); bg.addColorStop(1, '#0c1a22'); g.fillStyle = bg; g.fillRect(0, 0, SZ, SZ);
    const sf = SZ * (0.78 - 0.42 * wl), f1 = 0.01 + hg * 0.016;
    g.beginPath(); g.moveTo(0, SZ);
    for (let x = 0; x <= SZ; x += 8) g.lineTo(x, sf + tilt * (x - SZ / 2) * 0.2 + Math.sin(x * f1 + ph) * wa + Math.sin(x * f1 * 2.4 - ph * 1.4) * wa * 0.45);
    g.lineTo(SZ, SZ); g.closePath();
    const lq = g.createLinearGradient(0, sf - 20, 0, SZ); lq.addColorStop(0, '#86f2de'); lq.addColorStop(0.25, '#1e9aa0'); lq.addColorStop(1, '#0a3347'); g.fillStyle = lq; g.fill();
    g.lineWidth = 3; g.strokeStyle = '#d6fff5aa'; g.stroke();
    spk.forEach(s => { s.y -= s.v * 0.0016 * (1 + lvl * 3); if (s.y < 0) s.y = 1; star(s.x, sf + 30 + s.y * (SZ - sf - 30), s.r * (1 + lvl * 0.5), 0.25 + 0.55 * Math.abs(Math.sin(t * 1.6 + s.p))); });
  }

  // ----- skala jendela + loop -----
  const fit = (): void => { curScale = Math.min(1, (innerWidth - 16) / 1080, (innerHeight - 16) / 612); win.style.setProperty('--s', String(curScale)); };
  addEventListener('resize', fit);
  const nm = (m: number): string => NN[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
  let raf = 0, fr = 0, lastHit = -1, mi = 0, mo = 0;
  const mtr = (i: number, v: number): void => { const d = 20 * Math.log10(Math.max(v, 1e-4)); bars[i].style.width = cl((d + 60) / 60) * 100 + '%'; bars[i + 1].style.width = bars[i].style.width; dbs[i / 2].textContent = (v < 1e-3 ? '-∞' : d.toFixed(1)) + ' dB'; };
  const tick = (ms: number): void => {
    raf = 0; if (el.hidden) return;
    const p = host?.pitch() ?? null, lv = host?.levels?.() ?? null, vo = !!p;
    if (!vo) liveNote = -1;
    if (p) {
      raw = p.raw; out = p.out;
      const rn = Math.round(raw), cur = liveNote < 0 ? -1 : liveNote;
      const dcur = cur < 0 ? 99 : Math.abs((((raw - cur) % 12) + 18) % 12 - 6);   // jarak (semiton, melingkar) ke nada yang sedang tampil
      liveNote = cur < 0 || dcur > 0.68 ? ((rn % 12) + 12) % 12 : cur;
      for (let i = 0; i < 12; i++) hist[i] *= 0.9993;
      hist[((Math.round(raw) % 12) + 12) % 12] += 1;
      if (++fr % 12 === 0) detect();
    }
    lvl += ((vo ? cl(0.45 + (lv ? lv.li : 0.3) * 1.2) : 0) - lvl) * 0.25;
    mi = Math.max(lv ? lv.li : 0, mi * 0.9); mo = Math.max(lv ? lv.lo : 0, mo * 0.9); mtr(0, mi); mtr(2, mo);
    const pc = vo ? ((Math.round(out) % 12) + 12) % 12 : -1;
    if (pc !== lastHit) { keyEl[lastHit]?.classList.remove('hit'); keyEl[pc]?.classList.add('hit'); lastHit = pc; }
    const c = Math.round((raw - Math.round(out)) * 100), cs = (c >= 0 ? '+' : '') + c + '¢';
    ro.textContent = vo ? nm(out) + ' ' + cs : '–';
    dc.textContent = vo ? 'NOW ' + nm(out) + ' ' + cs : (det.ok ? 'CONFIDENCE ' + Math.round(det.conf * 100) + '%' : '\u00a0');
    showDet();
    cdEl.style.setProperty('--cd', vo ? (cl((raw - Math.round(raw)) * 100, -50, 50) * 0.6).toFixed(1) + 'deg' : '0deg'); cdEl.classList.toggle('is-on', vo);
    if (fxBtn.classList.contains('on')) mixer.tick();                 // tampilan mixer terbuka: meter strip bergerak, orb tidak perlu digambar
    else if (!win.dataset.skin) draw(ms / 1000, vo);   // cairan orb hanya digambar di skin Default
    raf = requestAnimationFrame(tick);
  };
  const start = (): void => { if (!raf) raf = requestAnimationFrame(tick); };

  // ---------- buka / tutup ----------
  el.addEventListener('keydown', e => {
    e.stopPropagation();   // pintasan DAW (Space, tuts keyboard) tidak ikut jalan selagi AUTOTUNE terbuka
    if (e.key === 'Escape') { e.preventDefault(); if (!setPop.hidden) { hideSet(); gear.focus({ preventScroll: true }); } else if (!menu.hidden) { const id = menuFor; hideMenu(); kEl(id as string).focus({ preventScroll: true }); } else close(); }
  });
  el.addEventListener('keyup', e => e.stopPropagation());
  q('.at__close').addEventListener('click', () => close());
  win.addEventListener('pointerdown', () => bringFront(el));

  function close(): void {
    hideMenu(); hideSet();
    const done = (): void => { el.hidden = true; };
    if (reduce) { done(); return; }
    win.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.96)' }], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' })
      .onfinish = () => { done(); el.getAnimations({ subtree: true }).forEach(a => a.cancel()); };
  }
  openFn = () => {
    if (!el.hidden) return;
    el.getAnimations({ subtree: true }).forEach(a => a.cancel());
    el.hidden = false; fit(); bringFront(el); showDet(); start();
    if (!reduce) win.animate([{ opacity: 0, transform: 'translateY(14px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.34,1.3,.64,1)' });
    win.focus({ preventScroll: true });
  };
  q('.at__pname').textContent = 'Custom'; loadAll();
}
