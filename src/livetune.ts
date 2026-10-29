// LIVETUNE: jendela plugin. Mesinnya (deteksi pitch + penggeser pitch, AudioWorklet) ada di livetune-dsp.ts dan dipasang oleh audio-engine.ts;
//   state jendela ini disimpan di kartu efek track (fx.v) lewat bindLivetune(), jadi tiap track punya setelan sendiri dan ikut tersimpan di project.
// PLUGIN BERDIRI SENDIRI: tidak mengimpor autotune*.ts. Tampilannya piano roll live: lajur warna per nada, keyboard di kiri yang menyala, garis putih = pitch suara asli,
//   garis kuning = pitch hasil koreksi (tangga kalau Speed tinggi). Klik tuts / jalur untuk mengizinkan atau melarang sebuah nada (kelas nada, semua oktaf).
// Kontrol: knob Amount, Speed, Humanize (memperlambat retune), Mix, Input (dB), Output (dB); pilihan Key + Scale; tombol MIC (nyanyi langsung) dan Bypass.
// MIC: minta izin mikrofon (getUserMedia). Pakai headset = DENGAR langsung hasil koreksi; tanpa headset = REKAM lalu preview (tidak ke speaker, anti dengung). Mode otomatis dari perangkat keluaran, bisa diganti manual. Mic mati saat jendela ditutup.
// Kartunya (ringkas) ada di panel efek; jendelanya terpisah dan dibuka dari kartu itu, seperti BPMTUNE / CUTE.

import { bringFront, dragWindow } from './win-drag';
import { createLivetune, loadLivetune } from './livetune-dsp';   // dipakai tombol MIC: jalur mic -> mesin LIVETUNE -> headphone, di AudioContext sendiri

export interface LivetuneState {
  amount: number;    // 0..100 (%): seberapa kuat nada ditarik ke nada yang diizinkan
  speed: number;     // 0..100: Slow (0) .. Fast (100); waktu retune = 400 ms x ((100 - speed) / 100)^2, lihat retuneMs; sekitar 93+ = robotik
  bypass: boolean;
  key: number;       // 0..11 (C = 0)
  scale: string;     // nilai opsi skala, mis. "0,2,3,5,7,8,10"
  allowed: number[]; // kelas nada (0..11) yang boleh dituju
  human: number;     // 0..100 (%): retune makin lambat (alami)
  gin: number;       // dB, penguat input (-12..12)
  out: number;       // dB, penguat output (-12..12)
  mix: number;       // 0..100 (%): campuran hasil dengan suara asli
}

const NN = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const SCALES: [string, string][] = [
  ['Major', '0,2,4,5,7,9,11'], ['Minor', '0,2,3,5,7,8,10'], ['Pentatonic', '0,2,4,7,9'], ['Chromatic', '0,1,2,3,4,5,6,7,8,9,10,11']
];
const BLACK = new Set([1, 3, 6, 8, 10]);
const pcOf = (m: number): number => ((m % 12) + 12) % 12;
const noteName = (m: number): string => NN[pcOf(Math.round(m))] + (Math.floor(Math.round(m) / 12) - 1);

const st: LivetuneState = { amount: 100, speed: 90, bypass: false, key: 0, scale: SCALES[0][1], allowed: [], human: 0, gin: 0, out: 0, mix: 100 };
const allowedOf = (scale: string, key: number): number[] => scale.split(',').map(x => (+x + key) % 12);
st.allowed = allowedOf(st.scale, st.key);

/** Penghubung jendela <-> kartu efek: dibuat fx-rack untuk track yang sedang dipilih. */
export interface LivetuneHost {
  get(): LivetuneState; set(s: LivetuneState): void;
  pitch(): { raw: number; out: number } | null;   // nada MIDI (pecahan) suara asli dan hasil; null = tak-bernada
}
const mask12 = (a: number[]): number => a.reduce((m, c) => m | (1 << c), 0);
const r1 = (x: number): number => Math.round(x * 10) / 10;
/** Waktu retune (ms) dari knob Speed. */
export const retuneMs = (speed: number): number => 400 * Math.pow((100 - speed) / 100, 2);   // kurva kuadrat: 90 = 4 ms, 95 = 1 ms (<= 2 ms = lompat seketika / robotik)

/** State -> nilai angka (fx.v) yang disimpan di project. */
export const livetuneToV = (s: LivetuneState): Record<string, number> => ({
  amount: Math.round(s.amount), speed: Math.round(s.speed), bypass: s.bypass ? 1 : 0, key: s.key,
  scale: Math.max(0, SCALES.findIndex(x => x[1] === s.scale)), mask: mask12(s.allowed),
  human: Math.round(s.human), gin: r1(s.gin), out: r1(s.out), mix: Math.round(s.mix)
});
/** fx.v -> state (nilai yang belum ada memakai bawaan, jadi project lama / kartu baru aman). */
export function livetuneFromV(v: Record<string, number>): LivetuneState {
  const key = Number.isFinite(v.key) ? ((v.key % 12) + 12) % 12 : 0, scale = SCALES[Number.isFinite(v.scale) && SCALES[v.scale] ? v.scale : 0][1];
  const allowed = Number.isFinite(v.mask) ? [...Array(12).keys()].filter(c => (v.mask >> c) & 1) : allowedOf(scale, key);
  const n = (x: number, d: number): number => (Number.isFinite(x) ? x : d);
  return { amount: n(v.amount, 100), speed: n(v.speed, 90), bypass: !!v.bypass, key, scale, allowed, human: n(v.human, 0), gin: n(v.gin, 0), out: n(v.out, 0), mix: n(v.mix, 100) };
}
/** Parameter mesin dari state: amount 0..1, tc (ms), mask 12 bit, on, gain input / output (linear), mix 0..1. */
export const livetuneEngine = (s: LivetuneState): { amount: number; tc: number; mask: number; on: boolean; gi: number; go: number; mix: number } =>
  ({ amount: s.amount / 100, tc: retuneMs(s.speed) * (1 + 2 * s.human / 100), mask: mask12(s.allowed), on: !s.bypass, gi: Math.pow(10, s.gin / 20), go: Math.pow(10, s.out / 20), mix: s.mix / 100 });

const subs = new Set<(s: LivetuneState) => void>();
let host: LivetuneHost | null = null, loadUi: (() => void) | null = null, loading = false;
let root: HTMLElement | null = null, openFn: (() => void) | null = null;
export const livetuneState = (): LivetuneState => ({ ...st, allowed: [...st.allowed] });
export const onLivetune = (f: (s: LivetuneState) => void): void => { subs.add(f); };
const emit = (): void => { if (loading) return; host?.set(livetuneState()); subs.forEach(f => f(livetuneState())); };

/** Arahkan jendela ke efek LIVETUNE sebuah track (null = tidak ada). Panggil sebelum openLivetune(). */
export function bindLivetune(h: LivetuneHost | null): void {
  host = h;
  if (h) { Object.assign(st, h.get()); st.allowed = [...st.allowed]; }
  if (root) { loading = true; try { loadUi?.(); } finally { loading = false; } }
}
export function openLivetune(): void {
  if (!root) build();
  if (host) { loading = true; try { loadUi?.(); } finally { loading = false; } }
  openFn?.();
}

// ---------- kontrol ----------
interface Ctl { id: 'amount' | 'speed' | 'human' | 'mix' | 'gin' | 'out'; label: string; min: number; max: number; def: number; fmt: (v: number) => string }
const pct = (v: number): string => Math.round(v) + '%';
const dBf = (v: number): string => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
const msf = (v: number): string => { const m = retuneMs(v); return (m < 10 ? m.toFixed(1) : String(Math.round(m))) + ' ms'; };
const CTLS: Ctl[] = [
  { id: 'amount', label: 'Amount', min: 0, max: 100, def: 100, fmt: pct },
  { id: 'speed', label: 'Speed', min: 0, max: 100, def: 90, fmt: msf },
  { id: 'human', label: 'Humanize', min: 0, max: 100, def: 0, fmt: pct },
  { id: 'mix', label: 'Mix', min: 0, max: 100, def: 100, fmt: pct },
  { id: 'gin', label: 'Input', min: -12, max: 12, def: 0, fmt: dBf },
  { id: 'out', label: 'Output', min: -12, max: 12, def: 0, fmt: dBf }
];
const svg = (p: string, s = 16): string => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICO = {
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 16),
  pwr: svg('<path d="M12 3v9M6.3 6.8a8 8 0 1 0 11.4 0"/>', 15),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>', 17),
  play: svg('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>', 16),
  pause: svg('<path d="M8 5v14M16 5v14" stroke-width="3"/>', 16)
};

// ---------- knob (busur 270°, seret vertikal / roda / panah, dobel klik = reset) ----------
const KP = (a: number, r: number): [number, number] => [50 + r * Math.cos(a * Math.PI / 180), 50 + r * Math.sin(a * Math.PI / 180)];
const KARC = (a0: number, a1: number): string => { const [p, q] = KP(a0, 38), [r, s] = KP(a1, 38); return `M${p} ${q}A38 38 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${r} ${s}`; };
type KnobSet = (v: number, quiet?: boolean) => void;
function knob(el: HTMLElement, c: Ctl, val: number, cb: (v: number) => void): KnobSet {
  el.tabIndex = 0; el.setAttribute('role', 'slider'); el.setAttribute('aria-label', c.label);
  el.setAttribute('aria-valuemin', String(c.min)); el.setAttribute('aria-valuemax', String(c.max));
  el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" class="lt__kb"/><path class="lt__ktr" d="${KARC(135, 405)}"/><path class="lt__kva"/><circle class="lt__kdt" r="3.4"/></svg><span class="lt__kv"></span>`;
  const va = el.querySelector('.lt__kva')!, dt = el.querySelector('.lt__kdt')!, vt = el.querySelector('.lt__kv')!;
  let cur = val, shown = val;
  const set: KnobSet = (x, quiet) => {
    cur = Math.min(c.max, Math.max(c.min, x));
    const nv = c.min < 0 ? r1(cur) : Math.round(cur), ch = nv !== shown; shown = nv;
    const a = 135 + 270 * (shown - c.min) / (c.max - c.min), a0 = c.min < 0 ? 270 : 135;   // knob dB: busur mulai dari tengah (0 dB)
    va.setAttribute('d', Math.abs(a - a0) > 0.5 ? (a >= a0 ? KARC(a0, a) : KARC(a, a0)) : '');
    const [dx, dy] = KP(a, 38); dt.setAttribute('cx', String(dx)); dt.setAttribute('cy', String(dy));
    vt.textContent = c.fmt(shown); el.setAttribute('aria-valuenow', String(shown)); el.setAttribute('aria-valuetext', c.fmt(shown));
    if (!quiet && ch) cb(shown);
  };
  let y0 = 0, v0 = 0;
  el.addEventListener('pointerdown', e => { el.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = cur; el.classList.add('is-drag'); });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) set(v0 + (y0 - e.clientY) / 160 * (c.max - c.min)); });
  const up = (): void => el.classList.remove('is-drag');
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', e => { e.preventDefault(); set(cur - Math.sign(e.deltaY) * (c.max - c.min) / 40); }, { passive: false });
  el.addEventListener('keydown', e => {
    const s = (c.max - c.min) / 40;
    if (/Up|Right/.test(e.key)) { set(cur + s); e.preventDefault(); }
    if (/Down|Left/.test(e.key)) { set(cur - s); e.preventDefault(); }
  });
  el.addEventListener('dblclick', () => set(c.def));
  set(cur, true);
  return set;
}

function build(): void {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const el = document.createElement('div');
  el.className = 'lt'; el.hidden = true;
  el.innerHTML =
    '<div class="lt__win" role="dialog" aria-label="LIVETUNE" tabindex="-1">' +
      `<div class="lt__tb"><span>LiveTune</span><button type="button" class="lt__close" aria-label="Tutup LIVETUNE" title="Tutup (Esc)">${ICO.x}</button></div>` +
      '<div class="lt__hd"><div class="lt__logo">LIVE<b>TUNE</b></div>' +
        `<button type="button" class="lt__mic" aria-pressed="false" title="Nyalakan mikrofon untuk menyanyi langsung">${ICO.mic}<span>MIC</span></button>` +
        `<button type="button" class="lt__byp" aria-pressed="false" title="Matikan koreksi sementara">${ICO.pwr}<span>BYPASS</span></button></div>` +
      '<div class="lt__rd"><div><small>Suara asli</small><b data-r="raw">–</b></div><div class="lt__t"><small>Hasil</small><b data-r="out">–</b></div><div><small>Ditarik</small><b data-r="shift">–</b></div></div>' +
      '<div class="lt__roll"><canvas aria-label="Piano roll pitch suara"></canvas><div class="lt__tag"><span>Asli</span><span class="lt__tagt">LiveTune</span></div></div>' +
      '<p class="lt__st" role="status" aria-live="polite">Tekan MIC lalu nyanyi.</p>' +
      '<div class="lt__mode"><button type="button" class="lt__chip" title="Ganti mode: Otomatis / Dengar langsung / Rekam"></button>' +
        `<div class="lt__pv" hidden><button type="button" class="lt__pp" aria-label="Putar preview">${ICO.play}</button><span class="lt__pt">0:00</span><button type="button" class="lt__rs" title="Buang rekaman">Ulang</button></div></div>` +
      '<div class="lt__ctl">' + CTLS.map(c => `<div class="lt__kn"><div class="lt__k" data-k="${c.id}"></div><label>${c.label}</label></div>`).join('') + '</div>' +
      '<div class="lt__sel">' +
        '<label class="lt__sl"><span>Key</span><select data-s="key" aria-label="Key">' + NN.map((n, i) => `<option value="${i}">${n}</option>`).join('') + '</select></label>' +
        '<label class="lt__sl"><span>Scale</span><select data-s="scale" aria-label="Scale">' + SCALES.map(([n], i) => `<option value="${i}">${n}</option>`).join('') + '</select></label>' +
      '</div>' +
      '<p class="lt__hint">Klik tuts atau jalur di piano roll untuk mengizinkan / melarang sebuah nada. Putar knob dengan seret ke atas atau bawah, klik dua kali untuk reset.</p>' +
    '</div>';
  document.body.appendChild(el);
  dragWindow({ root: el, move: el.querySelector<HTMLElement>('.lt__win')!, handle: '.lt__tb' });
  root = el;

  const q = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s)!;
  const win = q('.lt__win'), cv = q<HTMLCanvasElement>('canvas'), g = cv.getContext('2d')!;
  const keySel = q<HTMLSelectElement>('[data-s="key"]'), scaleSel = q<HTMLSelectElement>('[data-s="scale"]');
  const sIdx = (): number => Math.max(0, SCALES.findIndex(x => x[1] === st.scale));
  const rRaw = q('[data-r="raw"]'), rOut = q('[data-r="out"]'), rShift = q('[data-r="shift"]');
  const bypBtn = q('.lt__byp'), micBtn = q('.lt__mic'), stat = q('.lt__st');
  const STAT_IDLE = stat.textContent || '';

  // ----- mikrofon. Dua mode:
  //   DENGAR  (pakai headset): mic -> mesin LIVETUNE -> headset, suara hasil koreksi terdengar langsung. Tidak direkam.
  //   REKAM   (tanpa headset): mic -> mesin LIVETUNE -> direkam, TIDAK ke speaker (anti dengung). Setelah Stop bisa diputar sebagai preview.
  //   Mode dipilih otomatis dari perangkat keluaran (headset / earphone / bluetooth), bisa diganti manual lewat chip mode. Jalur sendiri di AudioContext sendiri. -----
  type Pref = 'auto' | 'monitor' | 'record';
  let micOn = false, micBusy = false, mctx: AudioContext | null = null, mstream: MediaStream | null = null, mnode: AudioWorkletNode | null = null, micPitch: { raw: number; out: number } | null = null;
  let pref: Pref = 'auto', mode: 'monitor' | 'record' = 'record', hsKnown: boolean | null = null;
  let rec: MediaRecorder | null = null, chunks: Blob[] = [], recLog: { t: number; raw: number; out: number }[] = [], recT0 = 0, recTimer = 0, recSecs = 0, prevUrl = '', prevAudio: HTMLAudioElement | null = null;
  const modeBtn = q<HTMLButtonElement>('.lt__chip'), pvBox = q('.lt__pv'), ppBtn = q('.lt__pp'), ptEl = q('.lt__pt'), rsBtn = q('.lt__rs'), micLab = micBtn.querySelector('span')!;
  const say = (t: string): void => { stat.textContent = t; };
  const pushMic = (): void => { if (mnode) mnode.port.postMessage({ t: 'p', ...livetuneEngine(livetuneState()) }); };
  const fmtT = (t: number): string => { const x = Math.max(0, Math.floor(t)); return Math.floor(x / 60) + ':' + String(x % 60).padStart(2, '0'); };
  const eff = (): 'monitor' | 'record' => (pref === 'auto' ? (hsKnown ? 'monitor' : 'record') : pref);   // mode yang akan dipakai kalau MIC ditekan sekarang
  function paintMode(): void {
    const e = eff();
    modeBtn.textContent = pref === 'auto'
      ? (hsKnown === true ? 'Headset terdeteksi: dengar langsung' : hsKnown === false ? 'Tanpa headset: rekam + preview' : 'Otomatis: headset = dengar, tanpa = rekam')
      : (pref === 'monitor' ? 'Mode: dengar langsung (wajib headset)' : 'Mode: rekam + preview');
    modeBtn.classList.toggle('is-rec', e === 'record');
    micLab.textContent = micOn ? (mode === 'record' ? 'STOP' : 'MIC') : (e === 'record' && !(pref === 'auto' && hsKnown == null) ? 'REC' : 'MIC');
  }
  // Headset terpasang? Baca perangkat keluaran bawaan + mikrofon (label baru terbaca setelah izin mic diberikan). null = tidak bisa dipastikan.
  async function detectHeadset(): Promise<boolean | null> {
    try {
      const ds = await navigator.mediaDevices.enumerateDevices(), HS = /head(set|phone)|earphone|earbud|airpod|buds|bluetooth|hands-?free|\bbt\b|wired/i;
      const outs = ds.filter(d => d.kind === 'audiooutput'), ins = ds.filter(d => d.kind === 'audioinput');
      if (!outs.length) return ins.some(d => HS.test(d.label)) ? true : null;   // browser tanpa daftar keluaran (iOS Safari): hanya bisa menebak dari mic
      const def = outs.find(d => d.deviceId === 'default') ?? outs[0];
      if (!def.label) return null;
      return HS.test(def.label) || (def.deviceId === 'default' && ins.some(d => d.deviceId === 'default' && HS.test(d.label)));
    } catch { return null; }
  }
  const micErr = (err: unknown): string => {
    const n = (err as DOMException)?.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Izin mikrofon ditolak. Klik ikon gembok di address bar, izinkan Mikrofon, lalu tekan MIC lagi.';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Mikrofon tidak ditemukan. Colok mic / headset lalu coba lagi.';
    if (n === 'NotReadableError') return 'Mikrofon sedang dipakai aplikasi lain.';
    return 'Mikrofon tidak bisa dibuka.';
  };
  // ----- preview rekaman -----
  function dropPreview(): void {
    if (prevAudio) { prevAudio.pause(); prevAudio.src = ''; prevAudio = null; }
    if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = ''; }
    recLog = []; pvBox.hidden = true; ppBtn.innerHTML = ICO.play; ppBtn.setAttribute('aria-label', 'Putar preview'); ptEl.textContent = '0:00';
  }
  function showPreview(blob: Blob): void {
    const log = recLog; dropPreview(); recLog = log;   // dropPreview mengosongkan catatan pitch; yang baru direkam harus tetap ada untuk gambar piano roll
    prevUrl = URL.createObjectURL(blob); const a = new Audio(prevUrl); prevAudio = a;
    const tt = (): void => { ptEl.textContent = fmtT(a.currentTime) + ' / ' + fmtT(recSecs); };
    a.addEventListener('timeupdate', tt);
    a.addEventListener('ended', () => { ppBtn.innerHTML = ICO.play; ppBtn.setAttribute('aria-label', 'Putar preview'); ptEl.textContent = '0:00 / ' + fmtT(recSecs); });
    ptEl.textContent = '0:00 / ' + fmtT(recSecs); pvBox.hidden = false;
  }
  const PV_LAT = 0.04;   // suara hasil tertunda ~37 ms oleh mesin: pitch dicocokkan ke waktu putar dikurangi selisih itu
  const previewing = (): boolean => !!prevAudio && !prevAudio.paused && !prevAudio.ended;
  function previewPitch(): { raw: number; out: number } | null {   // pitch yang tercatat pada posisi putar preview
    if (!prevAudio || !recLog.length) return null;
    const ct = prevAudio.currentTime - PV_LAT; let lo = 0, hi = recLog.length - 1, i = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (recLog[mid].t <= ct) { i = mid; lo = mid + 1; } else hi = mid - 1; }
    if (i < 0 || ct - recLog[i].t > 0.15 || recLog[i].raw < 0) return null;
    return { raw: recLog[i].raw, out: recLog[i].out };
  }
  ppBtn.addEventListener('click', () => {
    const a = prevAudio; if (!a) return;
    if (a.paused) { void a.play().then(() => { ppBtn.innerHTML = ICO.pause; ppBtn.setAttribute('aria-label', 'Jeda preview'); }).catch(() => say('Preview tidak bisa diputar.')); }
    else { a.pause(); ppBtn.innerHTML = ICO.play; ppBtn.setAttribute('aria-label', 'Putar preview'); }
  });
  rsBtn.addEventListener('click', () => { dropPreview(); say('Rekaman dibuang. Tekan REC untuk merekam lagi.'); });

  /** keep = true: rekaman (mode REKAM) disimpan jadi preview; false: dibuang (mis. jendela ditutup). */
  function stopMic(msg?: string, keep = false): void {
    clearInterval(recTimer); recTimer = 0;
    const r = rec; rec = null;
    if (r && r.state !== 'inactive') {
      if (keep && mode === 'record') {
        recSecs = (performance.now() - recT0) / 1000; const parts = chunks, type = r.mimeType || 'audio/webm';
        r.onstop = () => { if (parts.length) showPreview(new Blob(parts, { type })); };
      } else r.onstop = null;
      try { r.stop(); } catch { /* sudah berhenti */ }
    }
    chunks = [];
    mstream?.getTracks().forEach(t => t.stop()); mstream = null;
    if (mnode) { mnode.port.onmessage = null; mnode.disconnect(); mnode = null; }
    void mctx?.close().catch(() => undefined); mctx = null; micPitch = null;
    if (micOn) { micOn = false; micBtn.classList.remove('is-on'); micBtn.setAttribute('aria-pressed', 'false'); win.classList.remove('is-mic'); }
    modeBtn.disabled = false; paintMode();
    say(msg ?? (keep && mode === 'record' ? 'Rekaman selesai. Tekan ▶ untuk dengar preview.' : STAT_IDLE));
  }
  async function startMic(): Promise<void> {
    if (micOn || micBusy) return;
    if (!navigator.mediaDevices?.getUserMedia) { say('Browser ini tidak mendukung mikrofon (butuh HTTPS).'); return; }
    micBusy = true; say('Meminta izin mikrofon…');
    try {
      mstream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });   // mentah: koreksi pitch butuh sinyal asli
      hsKnown = await detectHeadset();   // label perangkat baru terbaca setelah izin
      mode = pref === 'auto' ? (hsKnown ? 'monitor' : 'record') : pref;
      if (mode === 'record' && typeof MediaRecorder === 'undefined') throw Object.assign(new Error('norec'), { name: 'NoRecorder' });
      mctx = new AudioContext({ latencyHint: 'interactive' });
      if (mctx.state === 'suspended') await mctx.resume();
      await loadLivetune(mctx);
      const ln = createLivetune(mctx, livetuneEngine(livetuneState()));
      ln.port.onmessage = e => { const m = e.data; if (m && m.t === 'f') { micPitch = m.raw >= 0 ? { raw: m.raw, out: m.out } : null; if (rec) recLog.push({ t: (performance.now() - recT0) / 1000, raw: m.raw, out: m.out }); } };   // mode rekam: pitch dicatat per waktu supaya preview bisa menggambar ulang piano roll
      mctx.createMediaStreamSource(mstream).connect(ln);
      dropPreview();
      if (mode === 'monitor') ln.connect(mctx.destination);   // headset: suara hasil koreksi terdengar langsung
      else {   // tanpa headset: hanya direkam, tidak ke speaker
        const dst = mctx.createMediaStreamDestination(), mute = mctx.createGain(); mute.gain.value = 0;
        ln.connect(dst); ln.connect(mute); mute.connect(mctx.destination);   // jalur senyap menjaga mesin tetap jalan
        const mt = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t));
        rec = mt ? new MediaRecorder(dst.stream, { mimeType: mt }) : new MediaRecorder(dst.stream);
        chunks = []; recLog = []; recT0 = performance.now(); rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start(250);
        recTimer = window.setInterval(() => say('Merekam ' + fmtT((performance.now() - recT0) / 1000) + ' · tekan STOP kalau sudah selesai.'), 250);
      }
      mnode = ln; micOn = true; history.length = 0; modeBtn.disabled = true;
      micBtn.classList.add('is-on'); micBtn.setAttribute('aria-pressed', 'true'); win.classList.add('is-mic');
      say(mode === 'monitor' ? 'Mic aktif: nyanyi, suara hasil koreksi terdengar di headset. Lepas headset = suara berdengung.' : 'Merekam 0:00 · tekan STOP kalau sudah selesai.');
      paintMode();
    } catch (err) { stopMic((err as Error)?.name === 'NoRecorder' ? 'Browser ini tidak bisa merekam. Pakai headset + mode dengar langsung.' : micErr(err)); }
    finally { micBusy = false; }
  }
  micBtn.addEventListener('click', () => { if (micOn) stopMic(undefined, true); else void startMic(); });
  modeBtn.addEventListener('click', () => { if (micOn) return; pref = pref === 'auto' ? 'monitor' : pref === 'monitor' ? 'record' : 'auto'; paintMode(); });
  const onVis = (): void => { if (document.hidden && micOn) stopMic('Mic dimatikan karena halaman disembunyikan.', true); };
  document.addEventListener('visibilitychange', onVis);
  navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (!micOn) void detectHeadset().then(h => { hsKnown = h; paintMode(); }); });   // colok / cabut headset
  void detectHeadset().then(h => { hsKnown = h; paintMode(); });
  paintMode();

  // ----- kontrol -> state -----
  const setters: Partial<Record<Ctl['id'], KnobSet>> = {};
  CTLS.forEach(c => {
    setters[c.id] = knob(q(`[data-k="${c.id}"]`), c, st[c.id], v => { st[c.id] = v; pushMic(); emit(); });
  });
  const applyKey = (): void => { st.allowed = allowedOf(SCALES[sIdx()][1], st.key); };
  keySel.addEventListener('change', () => { st.key = +keySel.value; applyKey(); pushMic(); emit(); });
  scaleSel.addEventListener('change', () => { st.scale = SCALES[+scaleSel.value][1]; applyKey(); pushMic(); emit(); });
  const setByp = (): void => { bypBtn.setAttribute('aria-pressed', String(st.bypass)); bypBtn.classList.toggle('on', st.bypass); win.classList.toggle('is-byp', st.bypass); };
  bypBtn.addEventListener('click', () => { st.bypass = !st.bypass; setByp(); pushMic(); emit(); });
  function loadAll(): void {   // tampilkan seluruh state tanpa menulis balik
    CTLS.forEach(c => setters[c.id]!(st[c.id], true));
    keySel.value = String(st.key); scaleSel.value = String(sIdx()); setByp();
    history.length = 0; pushMic();
  }
  loadUi = loadAll;

  // ----- piano roll -----
  const WIN = 7, SPAN = 24;                 // detik riwayat terlihat; semitone terlihat
  const history: { t: number; raw: number | null; out: number | null }[] = [];
  const glow = new Float32Array(160);       // kilau tiap nada MIDI (meluruh)
  let W = 0, H = 0, viewC = 52, lastT = 0, vbyp = false;   // vbyp: Bypass yang berlaku untuk tampilan (tidak berlaku saat preview)
  const resize = (): void => {
    const r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height; cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr)); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv); else window.addEventListener('resize', resize);
  const yOf = (m: number): number => H * (0.5 - (m - viewC) / SPAN);

  cv.addEventListener('click', e => {   // klik tuts / jalur: izinkan atau larang kelas nada itu
    const r = cv.getBoundingClientRect(), m = Math.round(viewC + SPAN * (0.5 - (e.clientY - r.top) / r.height));
    const s = new Set(st.allowed), pc = pcOf(m); if (s.has(pc)) s.delete(pc); else s.add(pc);
    st.allowed = [...s].sort((a, b) => a - b); pushMic(); emit();
  });

  function line(now: number, key: 'raw' | 'out', color: string, width: number, blur: number, rw: number): void {
    g.beginPath(); let prev = false, lx = 0, ly = 0, any = false;
    for (const p of history) {
      const v = p[key]; if (v == null) { prev = false; continue; }
      const x = W - 18 - (now - p.t) / WIN * (rw - 18), y = yOf(v);
      if (!prev) g.moveTo(x, y); else g.lineTo(x, y);
      prev = true; lx = x; ly = y; any = true;
    }
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'round'; g.shadowColor = color; g.shadowBlur = blur; g.stroke(); g.shadowBlur = 0;
    const last = history[history.length - 1];
    if (any && last && last[key] != null) { g.beginPath(); g.arc(lx, ly, width + 1.5, 0, Math.PI * 2); g.fillStyle = color; g.fill(); }
  }

  function draw(now: number): void {
    g.clearRect(0, 0, W, H); g.fillStyle = '#0d0f15'; g.fillRect(0, 0, W, H);
    const kw = Math.round(Math.min(52, W * 0.11)), rx = kw, rw = W - kw, ok = new Set(st.allowed);
    const lo = Math.floor(viewC - SPAN / 2) - 1, hi = Math.ceil(viewC + SPAN / 2) + 1;
    g.font = "500 10px 'IBM Plex Mono', ui-monospace, monospace"; g.textBaseline = 'middle';
    for (let m = lo; m <= hi; m++) {
      if (m < 0 || m >= glow.length) continue;
      const y0 = yOf(m + 0.5), y1 = yOf(m - 0.5), pc = pcOf(m), inS = ok.has(pc), gl = glow[m], hue = pc * 30, blk = BLACK.has(pc);
      g.fillStyle = `hsla(${hue},65%,${inS ? 52 : 38}%,${(inS ? 0.24 : 0.06) + gl * 0.5})`; g.fillRect(rx, y0, rw, y1 - y0 - 1);
      g.fillStyle = blk ? '#1b1e29' : '#e6e7ee'; g.fillRect(0, y0, blk ? kw * 0.62 : kw - 1, y1 - y0 - 1);
      if (blk) { g.fillStyle = '#12141b'; g.fillRect(kw * 0.62, y0, kw * 0.38 - 1, y1 - y0 - 1); }
      if (gl > 0.02) { g.fillStyle = `hsla(${hue},85%,58%,${gl})`; g.fillRect(0, y0, kw - 1, y1 - y0 - 1); }
      if (pc === 0) { g.fillStyle = gl > 0.5 ? '#10121a' : '#555a6e'; g.fillText('C' + (Math.floor(m / 12) - 1), kw - 24, (y0 + y1) / 2); }
    }
    g.save(); g.beginPath(); g.rect(rx, 0, rw, H); g.clip();
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    for (let s = 0; s <= WIN; s++) { const gx = Math.round(W - 18 - ((now % 1) + s) / WIN * (rw - 18)) + 0.5; if (gx > rx) { g.beginPath(); g.moveTo(gx, 0); g.lineTo(gx, H); g.stroke(); } }
    line(now, 'raw', vbyp ? '#f4f5fa' : 'rgba(244,245,250,.55)', vbyp ? 3 : 2, 0, rw);
    if (!vbyp) line(now, 'out', '#ffb938', 3.5, 12, rw);
    g.restore();
  }

  let raf = 0;
  const tick = (ms: number): void => {
    raf = 0; if (el.hidden) return;
    const now = ms / 1000, dt = Math.min(0.1, Math.max(0.001, now - (lastT || now))); lastT = now;
    const pv = previewing();   // preview diputar = gambar ulang pitch yang tercatat saat merekam (suara rekaman sudah terkoreksi, jadi Bypass tidak berlaku)
    const p = pv ? previewPitch() : micOn ? micPitch : (host?.pitch() ?? null);   // lainnya: mic menyala = pitch dari mic; kalau tidak = pitch track yang sedang diputar
    vbyp = st.bypass && !pv;
    history.push({ t: now, raw: p ? p.raw : null, out: p && !vbyp ? p.out : null });
    while (history.length && history[0].t < now - WIN - 0.5) history.shift();
    for (let i = 0; i < glow.length; i++) if (glow[i] > 0) glow[i] = Math.max(0, glow[i] - dt * 2.4);
    if (p) {
      const lit = Math.round(vbyp ? p.raw : p.out); if (lit >= 0 && lit < glow.length) glow[lit] = 1;
      viewC += (p.raw - viewC) * Math.min(1, dt * 0.9);   // tampilan pelan mengikuti suara
      const c = Math.round((p.raw - Math.round(p.raw)) * 100);
      rRaw.textContent = noteName(p.raw) + ' ' + (c >= 0 ? '+' : '−') + Math.abs(c) + '¢';
      if (vbyp) { rOut.textContent = 'bypass'; rShift.textContent = '0¢'; }
      else { const sh = Math.round((p.out - p.raw) * 100); rOut.textContent = noteName(p.out) + ' · ' + Math.round(440 * Math.pow(2, (p.out - 69) / 12)) + ' Hz'; rShift.textContent = (sh >= 0 ? '+' : '−') + Math.abs(sh) + '¢'; }
    } else { rRaw.textContent = '–'; rOut.textContent = '–'; rShift.textContent = '–'; }
    draw(now);
    raf = requestAnimationFrame(tick);
  };
  const start = (): void => { if (!raf) raf = requestAnimationFrame(tick); };

  // ---------- buka / tutup ----------
  el.addEventListener('keydown', e => {
    e.stopPropagation();   // pintasan DAW (Space, tuts keyboard) tidak ikut jalan selagi LIVETUNE terbuka
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  el.addEventListener('keyup', e => e.stopPropagation());
  q('.lt__close').addEventListener('click', () => close());
  win.addEventListener('pointerdown', () => bringFront(el));

  function close(): void {
    stopMic(); dropPreview();   // jendela ditutup = mikrofon mati, rekaman / preview dibuang
    const done = (): void => { el.hidden = true; };
    if (reduce) { done(); return; }
    win.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(10px) scale(.96)' }], { duration: 170, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' })
      .onfinish = () => { done(); el.getAnimations({ subtree: true }).forEach(a => a.cancel()); };
  }
  openFn = () => {
    if (!el.hidden) return;
    el.getAnimations({ subtree: true }).forEach(a => a.cancel());
    el.hidden = false; resize(); bringFront(el); start();
    if (!reduce) win.animate([{ opacity: 0, transform: 'translateY(14px) scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.34,1.3,.64,1)' });
    win.focus({ preventScroll: true });
  };
  loadAll();
}
