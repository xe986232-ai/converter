// Debug Audio (Pengaturan > Debug Audio): panel kecil yang mengambang saat Play, untuk MEMBUKTIKAN penyebab glitch DERIZ di HP.
// Tidak mengubah suara. Mati = tidak ada kerja tambahan (worklet hanya cek satu boolean per blok, sisi main thread langsung return).
//
// Yang diukur:
//   Beban DERIZ     waktu kerja semua plugin DERIZ per blok audio (128 sampel) dibanding jatahnya (~2,67 ms di 48 kHz). Blok > jatah = telat.
//   Nada telat      nada terjadwal yang baru diproses worklet > 6 ms setelah waktunya (ini yang bikin melodi "tiba-tiba ngebut"). Ada dua sisi:
//                   di worklet (terlambat berapa ms) dan di main thread (sisa waktu sebelum nada mulai, saat nada dijadwalkan).
//   Nada dipotong   batas 12 nada per plugin: H = nada yang masih ditahan terpotong (terdengar "tidak bunyi"), E = ekor nada yang sudah dilepas.
//   Nada hilang     tanpa sample (worklet belum menerima audio) atau jadwal dihapus saat sample baru masuk.
//   Main thread     timer 25 ms yang molor > 50 ms (tab sibuk / render DOM); lead min = jarak terdekat antara jadwal nada dan waktunya.
//   Underrun        angka dari browser sendiri (AudioContext.playbackStats) kalau browser mendukung: bukti langsung suara putus, dari penyebab APA PUN.
import { derizHooks, setDerizDebug, type DerizStat } from './deriz-synth';

declare const __BUILD__: string;
const BUILD = typeof __BUILD__ === 'undefined' ? 'dev' : __BUILD__;
const KEY = 'derizmp3.audioDebug';
const EVENT_MAX = 6;

interface Agg {
  n: number; sum: number; max: number; maxAt: number; late: number; vmax: number; iamax: number;
  full: number; light: number; hit: number;
  nOn: number; nLate: number; ltSum: number; ltMax: number;
  stealH: number; stealT: number; noBuf: number; penDrop: number;
  gl: number; gc: number; gs: number;   // pengaman beban (governor): beban puncak, batas nada terendah, nada dibuang
  trN: number; trSlow: number; trMax: number; lateSkip: number; spK: number; spO: number; pcK: number; pcO: number; spFrom: number; spTo: number;   // pesan nada main thread -> worklet
  wait: number; waitMax: number; clamp: number; clampMax: number;           // sisi main thread: menunggu sampler siap, nada yang jadwalnya sudah lewat saat benar-benar dikirim
  tr: number; bud: number;
  sched: number; schedMin: number; schedTight: number; schedLate: number;   // sisi main thread (jadwal nada)
  stall: number; stallMax: number;                                         // timer main thread molor
  loaf: number; loafScript: number; loafRender: number; loafMax: number;   // frame lambat (> 50 ms) dari browser: jumlah, total ms di skrip, total ms render, terlama
  spec: number; specMs: number;                                            // irisan analisis spektrogram yang jalan sejak Play (ms total)
  zm: Map<string, { n: number; ms: number; max: number }>;                 // tahap-tahap zoom (setZoom / lepas jari)
  loafForced: number;                                                      // total ms layout/gaya yang DIPAKSA oleh skrip (bagian dari 'skrip' di frame lambat)
  cul: Map<string, { n: number; ms: number; max: number }>;                // skrip penyebab frame lambat
}
const fresh = (): Agg => ({ n: 0, sum: 0, max: 0, maxAt: 0, late: 0, vmax: 0, iamax: 0, full: 0, light: 0, hit: 0, nOn: 0, nLate: 0, ltSum: 0, ltMax: 0,
  stealH: 0, stealT: 0, noBuf: 0, penDrop: 0, gl: 0, gc: Infinity, gs: 0, trN: 0, trSlow: 0, trMax: 0, lateSkip: 0, spK: 0, spO: 0, pcK: 0, pcO: 0, spFrom: 0, spTo: 0, wait: 0, waitMax: 0, clamp: 0, clampMax: 0, tr: -1, bud: 0, sched: 0, schedMin: Infinity, schedTight: 0, schedLate: 0, stall: 0, stallMax: 0, loaf: 0, loafScript: 0, loafRender: 0, loafMax: 0, spec: 0, specMs: 0, zm: new Map(), loafForced: 0, cul: new Map() });

let on = false, a = fresh(), t0 = 0, ctxRef: BaseAudioContext | null = null, ctxBase: { dur: number; ev: number } | null = null;
let events: string[] = [];
let ui: { root: HTMLElement; body: HTMLElement; log: HTMLElement; sum: HTMLElement } | null = null;
let renderTimer = 0, stallTimer = 0, lastTick = 0, collapsed = false;

const f1 = (v: number): string => v.toFixed(1);
const ms = (v: number): string => (v < 10 ? v.toFixed(1) : Math.round(v).toString()) + ' ms';
const pct = (x: number, y: number): string => (y ? (100 * x / y).toFixed(y > 400 ? 2 : 1) : '0') + '%';

// ---------- data dari worklet ----------
function ingest(m: DerizStat, ctx: BaseAudioContext): void {
  if (!on) return;
  ctxRef = ctx; rcHook(ctx);
  a.tr = m.tr; a.bud = m.bud;
  a.n += m.n; a.sum += m.sum; a.late += m.late; a.full += m.full; a.light += m.light; a.hit += m.hit;
  a.nOn += m.nOn; a.nLate += m.nLate; a.ltSum += m.ltSum;
  a.stealH += m.stealH; a.stealT += m.stealT; a.noBuf += m.noBuf; a.penDrop += m.penDrop; a.trN += m.trN; a.trSlow += m.trSlow; a.lateSkip += m.lateSkip; a.spK += m.spK; a.spO += m.spO; a.pcK += m.pcK; a.pcO += m.pcO; if (m.spO || m.spK) { a.spFrom = m.spFrom; a.spTo = m.spTo; }
  a.gs += m.gs; if (m.gl > a.gl) a.gl = m.gl; if (m.gc < a.gc) a.gc = m.gc;
  if (m.trMax > a.trMax) a.trMax = m.trMax;
  if (m.max > a.max) { a.max = m.max; a.maxAt = m.maxAt - t0; }
  if (m.vmax > a.vmax) a.vmax = m.vmax;
  if (m.iamax > a.iamax) a.iamax = m.iamax;
  if (m.ltMax > a.ltMax) a.ltMax = m.ltMax;
  // jendela 0,5 detik yang bermasalah dicatat sebagai kejadian (waktu relatif terhadap awal lagu), supaya bisa dicocokkan dengan bagian melodinya
  const bits: string[] = [];
  if (m.late) bits.push(m.late + ' blok telat (maks ' + ms(m.max) + ')');
  if (m.nLate) bits.push(m.nLate + ' nada telat (maks ' + ms(m.ltMax) + ')');
  if (m.trSlow) bits.push(m.trSlow + ' pesan nada tertunda (maks ' + ms(m.trMax) + ')');
  if (m.lateSkip) bits.push(m.lateSkip + ' nada dilewati (telat > panjangnya)');
  if (m.spO) bits.push('SPEED berubah lewat nada ' + m.spO + 'x (terakhir ' + m.spFrom.toFixed(2) + ' -> ' + m.spTo.toFixed(2) + ')');
  if (m.pcO) bits.push('PITCH berubah lewat nada ' + m.pcO + 'x');
  if (m.spK) bits.push('speed lewat knob ' + m.spK + 'x (' + m.spFrom.toFixed(2) + ' -> ' + m.spTo.toFixed(2) + ')');
  if (m.stealH) bits.push(m.stealH + ' nada terpotong');
  if (m.gs) bits.push(m.gs + ' nada dibuang pengaman beban (batas ' + m.gc + ', beban ' + Math.round(100 * m.gl) + '%)');
  if (m.noBuf) bits.push(m.noBuf + ' nada tanpa sample');
  if (m.penDrop) bits.push(m.penDrop + ' jadwal terhapus');
  if (bits.length) { events.push('@' + f1(Math.max(0, m.ct - t0)) + 's  ' + bits.join(', ')); if (events.length > EVENT_MAX) events.shift(); }
}

// ---------- data dari main thread ----------
export function dbgSched(leadSec: number): void {   // dipanggil tiap nada terjadwal dikirim ke worklet; leadSec = waktu nada - jam AudioContext
  if (!on) return;
  a.sched++;
  const l = leadSec * 1000;
  if (l < a.schedMin) a.schedMin = l;
  if (l < 50) a.schedTight++;
  if (l < 0) a.schedLate++;
}
export function dbgSent(waitMs: number, lateSec: number): void {   // dipanggil saat nada benar-benar dikirim ke worklet: waitMs = menunggu sampler siap; lateSec > 0 = jadwal nada sudah lewat sebesar itu
  if (!on) return;
  a.wait++; if (waitMs > a.waitMax) a.waitMax = waitMs;
  if (lateSec > 0.005) { a.clamp++; if (lateSec * 1000 > a.clampMax) a.clampMax = lateSec * 1000; }
}
export function dbgZoom(stage: string, ms: number): void {   // dipanggil dari zoom timeline: waktu tiap tahap (tidak berefek kalau debug mati)
  if (!on) return;
  const c = a.zm.get(stage) ?? { n: 0, ms: 0, max: 0 };
  c.n++; c.ms += ms; if (ms > c.max) c.max = ms; a.zm.set(stage, c);
}
export function dbgSpec(sliceMs: number, held: boolean): void {   // dipanggil tiap irisan analisis spektrogram; held = sedang Play (ditahan setelah irisan ini)
  if (!on) return;
  a.spec++; a.specMs += sliceMs;
  void held;
}
export function dbgRun(startCtx: number, ctx?: BaseAudioContext): void {   // tiap Play: hitungan mulai dari nol, waktu kejadian relatif terhadap awal lagu
  if (!on) return;
  a = fresh(); x = freshX(); events = []; t0 = startCtx; ctxBase = null;
  if (ctx) { ctxRef = ctx; rcHook(ctx); }
  underrun();   // ambil dasar hitungan underrun SEKARANG (bukan menunggu laporan pertama), supaya underrun di awal Play ikut terhitung
  render();
}
// Frame lambat (Long Animation Frames, Chrome 123+): browser sendiri menyebut skrip mana yang menahan main thread, jadi macet 700 ms bisa dicari asalnya.
interface LoafScript { duration: number; forcedStyleAndLayoutDuration?: number; invoker?: string; sourceFunctionName?: string; sourceURL?: string; sourceCharPosition?: number; type?: string }
interface Loaf extends PerformanceEntry { renderStart: number; scripts: LoafScript[]; blockingDuration?: number }
let loafObs: PerformanceObserver | null = null;
function onLoaf(list: PerformanceObserverEntryList): void {
  if (!on) return;
  for (const e of list.getEntries() as Loaf[]) {
    if (e.duration < 50) continue;
    const sc = e.scripts ?? [], sum = sc.reduce((x, y) => x + y.duration, 0), render = e.renderStart ? Math.max(0, e.startTime + e.duration - e.renderStart) : 0;
    a.loafForced += sc.reduce((x, y) => x + (y.forcedStyleAndLayoutDuration || 0), 0);
    a.loaf++; a.loafScript += sum; a.loafRender += render; if (e.duration > a.loafMax) a.loafMax = e.duration;
    const top = [...sc].sort((x, y) => y.duration - x.duration)[0];
    const name = top ? ((top.invoker || top.sourceFunctionName || top.type || '?') + ' @' + (top.sourceURL ?? '').split('/').pop()?.slice(0, 24) + ':' + (top.sourceCharPosition ?? '')) : 'tanpa skrip (layout / render)';
    const c = a.cul.get(name) ?? { n: 0, ms: 0, max: 0 }; c.n++; c.ms += top ? top.duration : e.duration; c.max = Math.max(c.max, e.duration); a.cul.set(name, c);
    events.push('@' + f1(Math.max(0, (ctxRef ? ctxRef.currentTime : 0) - t0)) + 's  frame lambat ' + ms(e.duration) + ' (skrip ' + ms(sum) + ', render ' + ms(render) + ') ' + name.slice(0, 60));
    if (events.length > EVENT_MAX + 4) events.shift();
  }
}
function stallTick(): void {
  const now = performance.now();
  if (lastTick && document.visibilityState === 'visible') {
    const over = now - lastTick - 25;
    if (over > 50) { a.stall++; if (over > a.stallMax) a.stallMax = over; }
  }
  lastTick = now;
  clkSample();
}

// ---------- underrun dari browser (kalau ada) ----------
function underrun(): { ev: number; dur: number } | null {
  try {
    const ps = (ctxRef as unknown as { playbackStats?: { underrunEvents?: number; underrunDuration?: number } } | null)?.playbackStats;
    if (!ps || typeof ps.underrunEvents !== 'number') return null;
    const cur = { ev: ps.underrunEvents, dur: (ps.underrunDuration ?? 0) * 1000 };
    if (!ctxBase) ctxBase = { ev: cur.ev, dur: cur.dur };   // dasar saat Play dimulai: yang dihitung hanya selama sesi ini
    return { ev: cur.ev - ctxBase.ev, dur: cur.dur - ctxBase.dur };
  } catch { return null; }
}

// ---------- beban SELURUH graf audio + jam audio vs jam dinding ----------
// "Beban DERIZ" hanya mengukur worklet DERIZ. Yang di bawah ini mengukur sisanya (master chain, convolver, analyser, clip, worklet lain):
//   renderCapacity  (Chrome 120+) beban render SELURUH graf per jendela 0,5 detik: rata-rata, puncak, dan rasio underrun yang dilaporkan browser.
//                   Kalau puncaknya tinggi padahal beban DERIZ kecil, penyebabnya ada di graf (efek / master), bukan di DERIZ.
//                   Kalau puncaknya rendah tapi underrun tetap ada, thread audio kekurangan CPU karena hal lain (render UI / sistem).
//   jam audio       selisih jam dinding - jam audio (getOutputTimestamp). Loncatan = output sempat tersendat lalu mengejar (bisa terdengar \"speed up\").
interface RcStat { n: number; sum: number; peak: number; hi: number; urN: number; ur: number }
interface ClkStat { jumpN: number; jumpMax: number; dev: number; base: number | null; last: number | null; olMin: number; olMax: number }
const freshX = (): { rc: RcStat; clk: ClkStat } => ({ rc: { n: 0, sum: 0, peak: 0, hi: 0, urN: 0, ur: 0 }, clk: { jumpN: 0, jumpMax: 0, dev: 0, base: null, last: null, olMin: Infinity, olMax: 0 } });
let x = freshX();
interface RcApi { start(o?: { updateInterval?: number }): void; stop(): void; onupdate: ((e: { averageLoad: number; peakLoad: number; underrunRatio: number }) => void) | null }
let rcCtx: BaseAudioContext | null = null, rcApi: RcApi | null = null;
function rcStop(): void { try { if (rcApi) { rcApi.onupdate = null; rcApi.stop(); } } catch { /* abaikan */ } rcApi = null; rcCtx = null; }
function rcHook(ctx: BaseAudioContext): void {
  if (!on || rcCtx === ctx) return;
  rcStop();
  const api = (ctx as unknown as { renderCapacity?: RcApi }).renderCapacity;
  if (!api || typeof api.start !== 'function') return;
  api.onupdate = e => {
    if (!on) return;
    const r = x.rc; r.n++; r.sum += e.averageLoad; if (e.peakLoad > r.peak) r.peak = e.peakLoad;
    if (e.peakLoad >= 0.9) r.hi++;
    if (e.underrunRatio > 0) { r.urN++; if (e.underrunRatio > r.ur) r.ur = e.underrunRatio; }
    if (e.peakLoad >= 0.9 || e.underrunRatio > 0) {
      events.push('@' + f1(Math.max(0, (rcCtx ? rcCtx.currentTime : 0) - t0)) + 's  graf audio: beban puncak ' + Math.round(100 * e.peakLoad) + '%, rata ' + Math.round(100 * e.averageLoad) + '%' + (e.underrunRatio > 0 ? ', underrun ' + (100 * e.underrunRatio).toFixed(1) + '%' : ''));
      if (events.length > EVENT_MAX + 4) events.shift();
    }
  };
  try { api.start({ updateInterval: 0.5 }); rcApi = api; rcCtx = ctx; } catch { rcApi = null; rcCtx = null; }
}
function clkSample(): void {
  const c = ctxRef as AudioContext | null;
  if (!c || c.state !== 'running' || !('getOutputTimestamp' in c)) return;
  const k = x.clk;
  try {
    const ol = (c.outputLatency || 0) * 1000; if (ol > 0) { if (ol < k.olMin) k.olMin = ol; if (ol > k.olMax) k.olMax = ol; }
    const ts = c.getOutputTimestamp();
    if (!ts.performanceTime || !ts.contextTime) return;
    const off = ts.performanceTime / 1000 - ts.contextTime;
    if (k.base === null) { k.base = off; k.last = off; return; }
    const j = Math.abs(off - (k.last as number)) * 1000;
    if (j > 30) {
      k.jumpN++; if (j > k.jumpMax) k.jumpMax = j;
      events.push('@' + f1(Math.max(0, c.currentTime - t0)) + 's  jam audio loncat ' + (off > (k.last as number) ? 'tertinggal' : 'mengejar') + ' ' + ms(j));
      if (events.length > EVENT_MAX + 4) events.shift();
    }
    k.dev = Math.max(k.dev, Math.abs(off - k.base) * 1000); k.last = off;
  } catch { /* belum tersedia */ }
}

// ---------- laporan ----------
function lines(): string[] {
  const bud = a.bud || 2.67, avg = a.n ? a.sum / a.n : 0, L: string[] = [];
  const coarse = a.tr > 0 ? ' (timer kasar ' + a.tr + ' ms)' : '';
  L.push('Beban DERIZ: rata ' + Math.round(100 * avg / bud) + '% dari jatah, puncak ' + ms(a.max) + (a.n ? ' @' + f1(Math.max(0, a.maxAt)) + 's' : '') + coarse);
  L.push('Blok telat: ' + a.late + ' / ' + a.n + ' (' + pct(a.late, a.n) + '), jatah ' + bud.toFixed(2) + ' ms');
  L.push('Nada telat (worklet): ' + a.nLate + ' / ' + a.nOn + ', terlama ' + ms(a.ltMax) + (a.nLate ? ', rata ' + ms(a.ltSum / a.nLate) : ''));
  L.push('Nada dijadwalkan: ' + a.sched + ', sisa waktu terpendek ' + (a.sched ? ms(a.schedMin) : '-') + ', < 50 ms: ' + a.schedTight + ', sudah lewat: ' + a.schedLate);
  L.push('Pesan nada di jalan (main -> worklet): terlama ' + ms(a.trMax) + ', > 100 ms: ' + a.trSlow + ' / ' + a.trN);
  L.push('Di main thread: tunggu sampler terlama ' + ms(a.waitMax) + ', jadwal sudah lewat saat dikirim: ' + a.clamp + (a.clamp ? ' (maks ' + ms(a.clampMax) + ')' : ''));
  L.push('Nada dipotong (batas 12/plugin): ditahan ' + a.stealH + ', ekor ' + a.stealT);
  L.push('Pengaman beban: beban puncak ' + Math.round(100 * a.gl) + '% dari jatah, batas nada total terendah ' + (a.gc === Infinity ? '-' : a.gc) + ', nada dibuang ' + a.gs + (a.gs ? ' (ekor pelan dulu, baru nada tertahan tertua)' : ''));
  L.push('Nada hilang: tanpa sample ' + a.noBuf + ', jadwal terhapus ' + a.penDrop + ', dilewati karena telat ' + a.lateSkip);
  L.push('Speed / Pitch di worklet: lewat knob ' + a.spK + 'x / ' + a.pcK + 'x, lewat nada ' + a.spO + 'x / ' + a.pcO + 'x' + (a.spO || a.spK ? ' (terakhir speed ' + a.spFrom.toFixed(2) + ' -> ' + a.spTo.toFixed(2) + ')' : ''));
  L.push('Beban puncak: ' + a.vmax + ' voice di ' + a.iamax + ' DERIZ sekaligus');
  const fr = a.full + a.light + a.hit;
  L.push('Frame WSOLA: penuh ' + a.full + ', ringan ' + a.light + ', cache ' + a.hit + (fr ? ' (cache ' + pct(a.hit, fr) + ')' : ''));
  L.push('Main thread: macet > 50 ms ' + a.stall + 'x' + (a.stall ? ' (maks ' + ms(a.stallMax) + ')' : ''));
  if (loafObs || a.loaf) {
    L.push('Frame lambat > 50 ms: ' + a.loaf + 'x' + (a.loaf ? ' (terlama ' + ms(a.loafMax) + ', total skrip ' + ms(a.loafScript) + ', render ' + ms(a.loafRender) + ')' : ''));
    for (const [k, c] of [...a.cul].sort((x, y) => y[1].ms - x[1].ms).slice(0, 3)) L.push('  ' + k.slice(0, 70) + ': ' + c.n + 'x, total ' + ms(c.ms) + ', maks ' + ms(c.max));
  } else L.push('Frame lambat: tidak didukung di browser ini');
  if (a.loafForced) L.push('  dari skrip frame lambat, layout/gaya yang dipaksa: ' + ms(a.loafForced));
  L.push('DOM: ' + document.getElementsByTagName('*').length + ' elemen, ' + (document.getElementById('lanes')?.getElementsByTagName('*').length ?? 0) + ' di timeline');
  if (a.zm.size) {
    L.push('Zoom, tahap (jumlah, total, maks):');
    for (const [k, c] of [...a.zm].sort((x, y) => (x[0] < y[0] ? -1 : 1))) L.push('  ' + k + ': ' + c.n + 'x, ' + ms(c.ms) + ', maks ' + ms(c.max));
  }
  L.push('Analisis spektrogram sejak Play: ' + a.spec + ' irisan (' + ms(a.specMs) + ')');
  if (rcCtx) L.push('Beban SELURUH graf audio (renderCapacity): rata ' + (x.rc.n ? Math.round(100 * x.rc.sum / x.rc.n) : 0) + '%, puncak ' + Math.round(100 * x.rc.peak) + '%, jendela >= 90%: ' + x.rc.hi + ' / ' + x.rc.n + ', jendela underrun: ' + x.rc.urN + (x.rc.urN ? ' (maks ' + (100 * x.rc.ur).toFixed(1) + '%)' : ''));
  else L.push('Beban SELURUH graf audio (renderCapacity): tidak didukung / belum ada data');
  L.push('Jam audio vs jam dinding: loncatan > 30 ms ' + x.clk.jumpN + 'x' + (x.clk.jumpN ? ' (maks ' + ms(x.clk.jumpMax) + ')' : '') + ', simpangan maks ' + ms(x.clk.dev) + ', output latency ' + (x.clk.olMax ? f1(x.clk.olMin) + '-' + f1(x.clk.olMax) + ' ms' : '-'));
  const u = underrun();
  L.push(u ? 'Underrun browser: ' + u.ev + 'x (' + ms(u.dur) + ' senyap)' : 'Underrun browser: tidak didukung di browser ini');
  return L;
}
function deviceLine(): string {
  const c = ctxRef as AudioContext | null;
  return [c ? c.sampleRate + ' Hz' : '?', c && 'baseLatency' in c ? 'base ' + f1(c.baseLatency * 1000) + ' ms' : '', c && 'outputLatency' in c ? 'output ' + f1((c as AudioContext).outputLatency * 1000) + ' ms' : '',
    (navigator.hardwareConcurrency || '?') + ' core', navigator.userAgent].filter(Boolean).join(' | ');
}
export function dbgReport(): string {
  return ['DERIZ audio debug | versi ' + BUILD, deviceLine(), ...lines(), ...(events.length ? ['Kejadian terakhir:', ...events] : ['Kejadian: tidak ada'])].join('\n');
}

// ---------- panel ----------
function ensureUI(): NonNullable<typeof ui> {
  if (ui) return ui;
  const root = document.createElement('div');
  root.className = 'adbg'; root.setAttribute('role', 'status');
  root.innerHTML = '<div class="adbg__bar"><b>DEBUG AUDIO</b><small style="opacity:.6;margin-left:6px">' + BUILD.split(' ')[0] + '</small><span class="adbg__sum"></span><span class="adbg__btns">' +
    '<button type="button" data-a="reset">Reset</button><button type="button" data-a="copy">Salin</button><button type="button" data-a="min" aria-label="Kecilkan">–</button></span></div>' +
    '<div class="adbg__body"></div><div class="adbg__log"></div>';
  document.body.appendChild(root);
  const k = {
    root, body: root.querySelector('.adbg__body') as HTMLElement, log: root.querySelector('.adbg__log') as HTMLElement, sum: root.querySelector('.adbg__sum') as HTMLElement,
  };
  root.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest('button'); if (!b) return;
    const act = b.dataset.a;
    if (act === 'reset') { const c = ctxRef; a = fresh(); x = freshX(); events = []; ctxBase = null; t0 = c ? c.currentTime : 0; underrun(); render(); }
    else if (act === 'min') { collapsed = !collapsed; root.classList.toggle('is-min', collapsed); }
    else if (act === 'copy') void copyText(dbgReport()).then(ok => { b.textContent = ok ? 'Tersalin' : 'Gagal'; setTimeout(() => { b.textContent = 'Salin'; }, 1200); });
  });
  ui = k; return k;
}
async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* lanjut ke cadangan */ }
  try {
    const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0;left:0;top:0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
function render(): void {
  if (!on) return;
  const k = ensureUI(), L = lines();
  k.body.textContent = L.join('\n');
  k.log.textContent = events.length ? events.join('\n') : 'Belum ada kejadian bermasalah.';
  const bad = a.late + a.nLate + a.trSlow + a.stealH + a.gs + a.noBuf + a.penDrop + a.lateSkip + a.spO + a.pcO + a.stall + x.rc.urN + x.clk.jumpN + (underrun()?.ev ?? 0);
  k.sum.textContent = bad ? bad + ' masalah' : 'aman';
  k.root.classList.toggle('is-bad', bad > 0);
}

export function setAudioDebug(v: boolean, save = true): void {
  if (v === on) return;
  on = v;
  if (save) { try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* penyimpanan diblokir: tetap berlaku sampai halaman ditutup */ } }
  derizHooks.stat = v ? ingest : null;
  try { loafObs?.disconnect(); loafObs = null; if (v && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) { loafObs = new PerformanceObserver(onLoaf); loafObs.observe({ type: 'long-animation-frame' }); } } catch { loafObs = null; }
  setDerizDebug(v);
  clearInterval(renderTimer); clearInterval(stallTimer); renderTimer = stallTimer = 0;
  if (v) {
    a = fresh(); x = freshX(); events = []; ctxBase = null; lastTick = 0;
    render();
    renderTimer = window.setInterval(render, 400);
    stallTimer = window.setInterval(stallTick, 25);
  } else { rcStop(); if (ui) { ui.root.remove(); ui = null; } }
}
export function loadAudioDebug(): boolean { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }
