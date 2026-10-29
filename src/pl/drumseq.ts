// UI plugin "Drum Sequence" (tab Module): canvas audio kecil + deretan slot sample + tombol Mix.
// Slot awalnya kosong ("Empty"). Saat file audio dijatuhkan ke canvas, sample masuk ke slot yang sedang dipilih dan nama slot
// berubah jadi nama sample. File dari panel browser dijatuhkan di canvas = masuk ke slot yang sedang dipilih.
// Ketuk slot = pilih + bunyikan sample-nya (setiap ketukan membunyikan ulang dari awal). Saat bunyi, canvas beranimasi
// (outline bagian yang sudah terputar jadi terang + garis playhead) dan slotnya berdenyut.
// Waveform di canvas: outline saja (tanpa isi solid) berwarna pattern, dari piramid peak min/max (lihat waveform.ts), tanpa judul dan tanpa warna latar.
// Bentuknya mengikuti Attack slot (depan gelombang menurun) dan ikut berubah real-time saat knob digeser.
// Tombol Mix membuka halaman mixing (halaman utama disembunyikan): canvas tetap, EQ2 lima slider vertikal di kanan canvas, knob Volume + Attack di bawah canvas.
// Semuanya milik SLOT YANG DIPILIH saat Mix dibuka (tiap slot punya mixing sendiri); tutup Mix untuk memilih slot lain.
// Tombol Roll membuka piano roll pattern: tuts C4..G4 = slot 1..8 diberi nama sample-nya, dan note memainkan sample ASLI (utuh, tanpa pitch/stretch, level seperti pratinjau browser).
// Sequencer (pola step) belum ada; baru kartu, canvas, slot sample, dan tombol menuju mixing.
import { el, SVGNS, polar, arc } from './ui-util';
import { buildPyramid, getPeaks, type Pyramid } from './waveform';
import { EQ2_BANDS } from './audio-engine';

export interface SampleRef { id: string; name: string }
export const DRUM_SLOTS = 8;
// Pemetaan slot -> tuts piano roll: slot 1 = C4 (60), slot 2 = C#4, ... slot 8 = G4 (67). Satu slot = satu tuts berurutan (semiton).
export const DRUM_BASE = 60;
const EMPTY = 'Empty';

const displayName = (name: string): string => name.replace(/\.[^./\\]+$/, '') || name;   // buang ekstensi file (.wav, .mp3, ...)

// rapikan data slot dari file project: panjang tetap DRUM_SLOTS, isi tidak valid jadi kosong; semua kosong = tidak disimpan
export function cleanSamples(raw: unknown): (SampleRef | null)[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = Array.from({ length: DRUM_SLOTS }, (_, i): SampleRef | null => {
    const s = raw[i] as Partial<SampleRef> | null | undefined;
    return s && typeof s.id === 'string' && s.id ? { id: s.id, name: typeof s.name === 'string' ? s.name : s.id } : null;
  });
  return out.some(Boolean) ? out : undefined;
}

// Mixing per slot: EQ2 lima band (frekuensi tetap sama dengan EQ2 di tab Efek: EQ2_BANDS), gain dB -18..+18, 0 = netral.
// dev.eq[slot][band]; tiap slot punya EQ sendiri, bukan satu untuk semua.
export const EQ_RANGE = 18;
const EQ_LABELS = ['60 Hz', '250 Hz', '1 kHz', '4 kHz', '12 kHz'], EQ_SHORT = ['60', '250', '1k', '4k', '12k'];   // SHORT = label sempit di bawah slider (kartu tidak boleh melebar)
export function cleanEq(raw: unknown): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = Array.from({ length: DRUM_SLOTS }, (_, i) => EQ2_BANDS.map((_b, b) => {
    const v = (raw[i] as unknown[] | undefined)?.[b];
    return typeof v === 'number' && isFinite(v) ? Math.min(EQ_RANGE, Math.max(-EQ_RANGE, v)) : 0;
  }));
  return out.some(r => r.some(v => v !== 0)) ? out : undefined;   // semua netral = tidak disimpan
}

// Volume + Attack + Pitch per slot: vol 0..100 % (100 = level asli sample), atk 0..200 ms (fade-in awal sample; 0 = langsung, sample mentah),
// pitch -12..+12 semiton (0 = nada asli; naik/turun lewat kecepatan putar seperti sampler, jadi durasi ikut berubah).
export interface SlotMix { vol: number; atk: number; pitch: number }
export const VOL_DEF = 100, ATK_DEF = 0, ATK_MAX = 200, PITCH_DEF = 0, PITCH_MAX = 12;
export function cleanMix(raw: unknown): SlotMix[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const num = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const out = Array.from({ length: DRUM_SLOTS }, (_, i): SlotMix => {
    const m = raw[i] as Partial<SlotMix> | null | undefined;
    return { vol: num(m?.vol, 0, 100, VOL_DEF), atk: num(m?.atk, 0, ATK_MAX, ATK_DEF), pitch: Math.round(num(m?.pitch, -PITCH_MAX, PITCH_MAX, PITCH_DEF)) };
  });
  return out.some(m => m.vol !== VOL_DEF || m.atk !== ATK_DEF || m.pitch !== PITCH_DEF) ? out : undefined;   // semua default = tidak disimpan
}

export interface DrumDev { id: number; samples?: (SampleRef | null)[]; eq?: number[][]; mix?: SlotMix[] }
export interface DrumVoice { start: number; stop(at?: number): void }
// Instrumen drum untuk piano roll / playlist: nama sample di tiap tuts + pemutar sample ASLI (mentah, tanpa pitch / stretch / fade).
export interface DrumInstrument {
  topKey: number;                                      // tuts tertinggi yang terpakai (untuk menggulung tampilan piano roll)
  label(key: number): string | null;                   // nama sample di tuts ini (null = bukan tuts drum)
  play(key: number, vel: number, when: number | null, dest: AudioNode): DrumVoice;
}
export interface DrumDeps {
  getCtx(): AudioContext;
  getBlob(fileId: string): Blob | null;                                                            // file dari panel browser
  registerDrop(box: HTMLElement, load: (file: SampleRef, blob: Blob) => Promise<void>): void;      // jadikan box target drop file audio
  onChange(): void;                                                                                // sample slot berubah: ikut project
  openPianoRoll(): void;                                                                           // tombol Roll: buka piano roll pattern ini
  begin(key?: string): () => void;                                                                 // riwayat Undo / Redo: panggil sebelum mengubah dev, lalu panggil hasilnya setelah gestur selesai (key sama berurutan = satu langkah)
}
export interface DrumSeqView { main: HTMLElement; mixBtn: HTMLElement; rollBtn: HTMLElement }

interface State {
  bufs: (AudioBuffer | null)[];
  ids: (string | null)[];                   // id file sample yang sedang dimuat di bufs per slot (Undo / Redo membandingkan ini dengan dev.samples)
  pyrs: (Pyramid | null)[];                 // piramid peak untuk waveform, dibangun di belakang layar setelah buffer siap
  sel: number;
  voices: (AudioBufferSourceNode | null)[];
  t0: number[];                             // waktu (performance.now) pemicu terakhir per slot; -1 = belum pernah bunyi
  loading: Set<number>;
  ui: (() => void) | null;                  // penggambar ulang kartu plugin (kalau kartunya sedang tampil)
  chains: Map<AudioNode, EqChain>[];        // rantai EQ per slot, per tujuan output (pratinjau kartu = speaker, pattern = chain efek pattern)
}
interface EqChain { in: GainNode; fs: BiquadFilterNode[]; ctx: BaseAudioContext }

let wMax = new Float32Array(0), wMin = new Float32Array(0);

export function createDrumSeq(deps: DrumDeps): { build(dev: DrumDev): DrumSeqView; instrument(dev: DrumDev): DrumInstrument; sync(dev: DrumDev): void } {
  const states = new Map<number, State>();   // sementara (sesi ini), per device; buffer tidak ikut project, hanya id file-nya

  const mixOf = (dev: DrumDev, i: number): SlotMix => dev.mix?.[i] ?? { vol: VOL_DEF, atk: ATK_DEF, pitch: PITCH_DEF };
  const rateOf = (dev: DrumDev, i: number): number => Math.pow(2, mixOf(dev, i).pitch / 12);   // kecepatan putar dari Pitch slot
  // gain satu suara slot i: level = velocity (peak) x Volume slot; Attack = fade-in dari 0 (kosong = langsung penuh, tanpa ramp)
  function voiceGain(ctx: BaseAudioContext, dev: DrumDev, i: number, t: number, peak: number): GainNode {
    const g = ctx.createGain(), m = mixOf(dev, i), lv = peak * m.vol / 100;
    if (m.atk > 0.5) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(lv, t + m.atk / 1000); }
    else g.gain.setValueAtTime(lv, t);
    return g;
  }
  const eqGain = (dev: DrumDev, i: number, b: number): number => dev.eq?.[i]?.[b] ?? 0;
  const eqActive = (dev: DrumDev, i: number): boolean => !!dev.eq?.[i]?.some(v => Math.abs(v) > 0.05);
  function setEqGains(c: EqChain, dev: DrumDev, i: number): void {
    c.fs.forEach((f, b) => f.gain.setTargetAtTime(Math.min(EQ_RANGE, Math.max(-EQ_RANGE, eqGain(dev, i, b))), c.ctx.currentTime, 0.02));
  }
  // EQ slot i berubah: perbarui rantai yang sudah ada (suara yang sedang berbunyi ikut berubah langsung)
  function applyEq(dev: DrumDev, S: State, i: number): void { for (const c of S.chains[i].values()) setEqGains(c, dev, i); }
  // tujuan sambungan suara slot i: EQ netral = langsung ke dest (sample tetap mentah, tanpa filter); ada EQ = lewat rantai 5 band milik slot itu
  function targetFor(dev: DrumDev, S: State, i: number, ctx: BaseAudioContext, dest: AudioNode): AudioNode {
    if (!eqActive(dev, i)) return dest;
    let c = S.chains[i].get(dest);
    if (!c) {
      const input = ctx.createGain();
      const fs = EQ2_BANDS.map((f, b) => {
        const n = ctx.createBiquadFilter();
        n.type = b === 0 ? 'lowshelf' : b === EQ2_BANDS.length - 1 ? 'highshelf' : 'peaking';
        n.frequency.value = f; n.Q.value = 1;
        return n;
      });
      let prev: AudioNode = input;
      for (const n of fs) { prev.connect(n); prev = n; }
      prev.connect(dest);
      c = { in: input, fs, ctx };
      S.chains[i].set(dest, c);
      setEqGains(c, dev, i);
    }
    return c.in;
  }

  function stateOf(dev: DrumDev): State {
    let st = states.get(dev.id);
    if (!st) {
      st = {
        bufs: Array(DRUM_SLOTS).fill(null), ids: Array(DRUM_SLOTS).fill(null), pyrs: Array(DRUM_SLOTS).fill(null), sel: 0,
        voices: Array(DRUM_SLOTS).fill(null), t0: Array(DRUM_SLOTS).fill(-1), loading: new Set(), ui: null, chains: Array.from({ length: DRUM_SLOTS }, () => new Map()),
      };
      states.set(dev.id, st);
    }
    return st;
  }

  // buffer slot i siap: bangun piramid peak-nya di belakang layar lalu gambar waveform (kalau kartunya tampil)
  function setBuffer(S: State, i: number, buf: AudioBuffer): void {
    S.bufs[i] = buf; S.pyrs[i] = null;
    S.ui?.();
    void buildPyramid(buf).then(p => {
      if (S.bufs[i] !== buf) return;   // slot sudah diganti sample lain selama piramid dibangun
      S.pyrs[i] = p; S.ui?.();
    }).catch(() => { /* waveform gagal: sample tetap bisa dibunyikan */ });
  }

  // sample dari file project / impor: panel browser memuat IndexedDB-nya async, jadi dicoba beberapa kali
  async function restore(dev: DrumDev, S: State, i: number): Promise<void> {
    const ref = dev.samples?.[i];
    if (!ref || S.bufs[i] || S.loading.has(i)) return;
    S.loading.add(i);
    try {
      let blob = deps.getBlob(ref.id);
      for (let k = 0; !blob && k < 20; k++) { await new Promise(r => setTimeout(r, 500)); blob = deps.getBlob(ref.id); }
      if (!blob) return;
      const buf = await deps.getCtx().decodeAudioData(await blob.arrayBuffer());
      if (dev.samples?.[i]?.id !== ref.id) return;   // slot sudah diganti (Undo / Redo / sample lain) selama file dimuat
      S.ids[i] = ref.id;
      setBuffer(S, i, buf);
    } catch { /* file tidak terbaca: slot tetap kosong */ } finally { S.loading.delete(i); }
  }

  // state + pemuatan sample, TANPA perlu kartu plugin tampil (piano roll / playlist memutar drum dari pattern yang kartunya tidak dibuka)
  function ensure(dev: DrumDev): State {
    const S = stateOf(dev);
    for (let i = 0; i < DRUM_SLOTS; i++) if (dev.samples?.[i] && !S.bufs[i] && !S.loading.has(i)) void restore(dev, S, i);
    return S;
  }

  // dev diubah dari luar (Undo / Redo): samakan buffer tiap slot dengan sample yang tercatat di dev, terapkan EQ baru, lalu gambar ulang kartunya
  function sync(dev: DrumDev): void {
    const S = stateOf(dev);
    for (let i = 0; i < DRUM_SLOTS; i++) {
      const want = dev.samples?.[i]?.id ?? null;
      if (S.ids[i] !== want) {
        S.bufs[i] = null; S.pyrs[i] = null; S.ids[i] = null; S.loading.delete(i);
        try { S.voices[i]?.stop(); } catch { /* sudah berhenti */ }
      }
      applyEq(dev, S, i);
    }
    ensure(dev);   // slot yang bufnya dikosongkan dimuat ulang dari file panel browser
    S.ui?.();
  }

  const instruments = new Map<number, DrumInstrument>();
  function instrument(dev: DrumDev): DrumInstrument {
    ensure(dev);
    let inst = instruments.get(dev.id);
    if (inst) return inst;
    inst = {
      topKey: DRUM_BASE + DRUM_SLOTS - 1,
      label(key) {
        const i = key - DRUM_BASE;
        if (i < 0 || i >= DRUM_SLOTS) return null;
        const ref = dev.samples?.[i];
        return ref ? displayName(ref.name) : EMPTY;
      },
      // Sample dimainkan ASLI: utuh dari awal sampai habis, kecepatan + nada asli (tanpa pitch / stretch / reverse / fade),
      // level sama seperti pratinjau di panel browser (gain 1). Panjang note tidak memotong sample (one-shot, seperti drum).
      // Velocity hanya mengecilkan kalau note sengaja dibuat lembut (< 0,5); pratinjau tuts selalu level penuh.
      play(key, vel, when, dest) {
        const ctx = dest.context as AudioContext;
        const i = key - DRUM_BASE, t = when == null ? ctx.currentTime : when;
        const silent: DrumVoice = { start: t, stop(): void { /* tidak ada yang berbunyi */ } };
        if (i < 0 || i >= DRUM_SLOTS) return silent;      // tuts di luar slot drum: diam
        const S = stateOf(dev), b = S.bufs[i];
        if (!b) { ensure(dev); return silent; }           // sample masih dimuat / slot kosong
        const src = ctx.createBufferSource(), g = voiceGain(ctx, dev, i, t, when == null ? 1 : Math.min(1, Math.max(0.05, vel / 0.5)));
        src.buffer = b; src.playbackRate.value = rateOf(dev, i);
        src.connect(g); g.connect(targetFor(dev, S, i, ctx, dest));   // EQ slot ini (kalau diubah), lalu ke pattern
        src.start(t);
        src.onended = () => { src.disconnect(); g.disconnect(); };
        return {
          start: t,
          stop(at?: number): void {
            if (when == null) return;                      // pratinjau tuts: lepas jari tidak memotong sample, bunyi sampai habis
            const te = at ?? ctx.currentTime;              // Stop / geser playhead: potong dengan fade sangat pendek
            if (te <= t) { try { src.stop(t); } catch { /* sudah berhenti */ } return; }
            g.gain.cancelScheduledValues(te); g.gain.setTargetAtTime(0, te, 0.004);
            try { src.stop(te + 0.03); } catch { /* sudah berhenti */ }
          }
        };
      }
    };
    instruments.set(dev.id, inst);
    return inst;
  }

  function build(dev: DrumDev): DrumSeqView {
    const S = ensure(dev);
    const samples = (): (SampleRef | null)[] => (dev.samples ??= Array(DRUM_SLOTS).fill(null));

    const main = el('div', 'ds-box');
    const view = el('div', 'fx-canvas ds-canvas');   // class fx-canvas = target drop file dari panel browser
    view.setAttribute('aria-label', 'Canvas audio drum');
    const cv = document.createElement('canvas');
    cv.className = 'fx-canvas-cv'; cv.width = 300; cv.height = 100; cv.hidden = true;
    const hint = el('span', 'fx-canvas-hint');
    view.append(cv, hint);
    // ketuk / klik canvas = putar sample slot yang dipilih (di halaman mixing slot disembunyikan, jadi ini cara pratinjaunya)
    view.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button !== 0) return; preview(S.sel); });
    const base = document.createElement('canvas');   // waveform statis (di luar layar); animasi hanya menempelkan ini lalu menambah efek di atasnya

    // Halaman mixing di dalam plugin: EQ2 (lima slider vertikal) milik SLOT YANG DIPILIH. Ketuk slot lain di bawah = mixing slot itu.
    // Tampilan slider sama dengan EQ2 di tab Efek (kelas fx-vs); ketuk dua kali = kembali ke 0 dB.
    const mixView = el('div', 'ds-mix');
    const eqRow = el('div', 'ds-eq');
    const eqUi = EQ2_BANDS.map((_f, b) => {
      const wrap = el('div', 'fx-vs');
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'slider');
      wrap.setAttribute('aria-orientation', 'vertical');
      wrap.setAttribute('aria-valuemin', String(-EQ_RANGE));
      wrap.setAttribute('aria-valuemax', String(EQ_RANGE));
      const read = el('span', 'k-read'), track = el('div', 'vs-track'), zero = el('i', 'vs-zero'), fill = el('i', 'vs-fill'), thumb = el('i', 'vs-thumb');
      zero.style.bottom = '50%';
      track.append(zero, fill, thumb);
      wrap.append(read, track, el('span', 'k-label', EQ_SHORT[b]));
      const get = (): number => eqGain(dev, S.sel, b);
      const paintOne = (): void => {
        const v = get(), n = (v + EQ_RANGE) / (2 * EQ_RANGE);
        thumb.style.bottom = (n * 100) + '%';
        fill.style.bottom = (Math.min(n, 0.5) * 100) + '%';
        fill.style.height = (Math.abs(n - 0.5) * 100) + '%';
        read.textContent = (v > 0.049 ? '+' : '') + (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));
        wrap.setAttribute('aria-label', `${EQ_LABELS[b]}, slot ${S.sel + 1}`);
        wrap.setAttribute('aria-valuenow', v.toFixed(1));
        wrap.setAttribute('aria-valuetext', `${v.toFixed(1)} dB`);
      };
      const setDb = (v: number): void => {
        const row = ((dev.eq ??= Array.from({ length: DRUM_SLOTS }, () => EQ2_BANDS.map(() => 0)))[S.sel]);
        row[b] = Math.round(Math.min(EQ_RANGE, Math.max(-EQ_RANGE, v)) * 10) / 10;
        paintOne(); applyEq(dev, S, S.sel); deps.onChange();
      };
      const fromY = (y: number): number => { const r = track.getBoundingClientRect(); return r.height > 0 ? (1 - (y - r.top) / r.height) * 2 * EQ_RANGE - EQ_RANGE : 0; };
      let lastTap = 0, commit: (() => void) | null = null;   // commit = langkah Undo untuk satu gestur (dari pointerdown sampai dilepas)
      wrap.addEventListener('pointerdown', e => {
        e.preventDefault();
        wrap.setPointerCapture(e.pointerId);
        wrap.classList.add('drag');
        commit = deps.begin();
        const now = performance.now();
        if (now - lastTap < 300) { setDb(0); lastTap = 0; return; }   // ketuk dua kali: kembali ke 0 dB
        lastTap = now;
        setDb(fromY(e.clientY));
      });
      wrap.addEventListener('pointermove', e => { if (wrap.hasPointerCapture(e.pointerId) && wrap.classList.contains('drag') && lastTap) setDb(fromY(e.clientY)); });
      const end = (e: PointerEvent): void => { wrap.classList.remove('drag'); if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId); commit?.(); commit = null; };
      wrap.addEventListener('pointerup', end);
      wrap.addEventListener('pointercancel', end);
      wrap.addEventListener('keydown', e => {
        const step = e.shiftKey ? 3 : 0.5;
        let to: number | null = null;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') to = get() + step;
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') to = get() - step;
        else if (e.key === 'Home') to = -EQ_RANGE;
        else if (e.key === 'End') to = EQ_RANGE;
        if (to == null) return;
        e.preventDefault();
        const c = deps.begin(`eq${dev.id}.${S.sel}.${b}`); setDb(to); c();
      });
      eqRow.appendChild(wrap);
      return paintOne;
    });
    function paintEq(): void {   // posisi slider + knob mengikuti slot yang dipilih
      for (const f of eqUi) f();
      for (const f of knobUi) f();
    }
    mixView.append(eqRow);

    // Knob Volume + Attack slot yang dipilih (di bawah canvas pada halaman mixing). Tampilan busur sama dengan knob plugin lain.
    function makeSlotKnob(label: string, min: number, max: number, def: number, dec: number, unit: string, key: 'vol' | 'atk' | 'pitch', bipolar = false): () => void {
      const wrap = el('div', 'fx-knob ds-k');
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'slider');
      wrap.setAttribute('aria-valuemin', String(min)); wrap.setAttribute('aria-valuemax', String(max));
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', '0 0 40 40');
      const track = document.createElementNS(SVGNS, 'path'); track.setAttribute('class', 'k-track'); track.setAttribute('d', arc(15, -135, 135));
      const val = document.createElementNS(SVGNS, 'path'); val.setAttribute('class', 'k-val');
      const tick = document.createElementNS(SVGNS, 'line'); tick.setAttribute('class', 'k-tick');
      svg.append(track, val, tick);
      const read = el('span', 'k-read');
      const txt = el('div', 'ds-k-txt');
      txt.append(el('span', 'k-label', label), read);
      wrap.append(svg, txt);
      const get = (): number => mixOf(dev, S.sel)[key];
      const fmtV = (v: number): string => (bipolar && v > 0.049 ? '+' : '') + v.toFixed(dec) + (unit ? ' ' + unit : '');
      const paintOne = (): void => {
        const v = get(), n = (v - min) / (max - min), a = -135 + n * 270, a0 = bipolar ? -135 + (0 - min) / (max - min) * 270 : -135;   // bipolar: busur mulai dari titik 0
        val.setAttribute('d', Math.abs(a - a0) > 0.6 ? arc(15, a0, a) : '');
        const [x0, y0] = polar(6, a), [x1, y1] = polar(13, a);
        tick.setAttribute('x1', x0.toFixed(2)); tick.setAttribute('y1', y0.toFixed(2)); tick.setAttribute('x2', x1.toFixed(2)); tick.setAttribute('y2', y1.toFixed(2));
        read.textContent = fmtV(v);
        wrap.setAttribute('aria-label', `${label}, slot ${S.sel + 1}`);
        wrap.setAttribute('aria-valuenow', v.toFixed(dec)); wrap.setAttribute('aria-valuetext', fmtV(v));
      };
      const setV = (v: number): void => {
        const list = (dev.mix ??= Array.from({ length: DRUM_SLOTS }, () => ({ vol: VOL_DEF, atk: ATK_DEF, pitch: PITCH_DEF })));
        list[S.sel] = { ...list[S.sel], [key]: Math.round(Math.min(max, Math.max(min, v))) };
        paintOne(); scheduleWave(); deps.onChange();
      };
      let startY = 0, startV = 0, lastTap = 0, commit: (() => void) | null = null;   // commit = langkah Undo untuk satu gestur
      wrap.addEventListener('pointerdown', e => {
        e.preventDefault();
        wrap.setPointerCapture(e.pointerId); wrap.classList.add('drag');
        commit = deps.begin();
        const now = performance.now();
        if (now - lastTap < 300) setV(def);   // ketuk dua kali: kembali ke default
        lastTap = now; startY = e.clientY; startV = get();
      });
      wrap.addEventListener('pointermove', e => { if (wrap.hasPointerCapture(e.pointerId)) setV(startV + (startY - e.clientY) / 140 * (max - min)); });
      const end = (e: PointerEvent): void => { wrap.classList.remove('drag'); if (wrap.hasPointerCapture(e.pointerId)) wrap.releasePointerCapture(e.pointerId); commit?.(); commit = null; };
      wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
      wrap.addEventListener('keydown', e => {
        const st = (max - min) * (e.shiftKey ? 0.1 : 0.02);
        let to: number | null = null;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') to = get() + st;
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') to = get() - st;
        if (to == null) return;
        e.preventDefault();
        const c = deps.begin(`mx${dev.id}.${S.sel}.${key}`); setV(to); c();
      });
      knobsRow.appendChild(wrap);
      return paintOne;
    }
    const knobsRow = el('div', 'ds-knobs');
    const knobUi = [makeSlotKnob('Volume', 0, 100, VOL_DEF, 0, '%', 'vol'), makeSlotKnob('Attack', 0, ATK_MAX, ATK_DEF, 0, 'ms', 'atk'), makeSlotKnob('Pitch', -PITCH_MAX, PITCH_MAX, PITCH_DEF, 0, 'st', 'pitch', true)];

    const slots = el('div', 'ds-slots');
    slots.setAttribute('role', 'group'); slots.setAttribute('aria-label', 'Slot sample drum');
    const chips = Array.from({ length: DRUM_SLOTS }, (_, i) => {
      const b = el('button', 'ds-slot', EMPTY);
      b.type = 'button';
      b.setAttribute('aria-label', `Slot ${i + 1}: ${EMPTY}`);
      b.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button !== 0) return; select(i); preview(i); });
      b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); preview(i); } });
      return b;
    });
    slots.append(...chips);
    main.append(view, mixView, knobsRow, slots);

    const mixBtn = el('div', 'fx-tgl ds-mixbtn');
    const mb = el('button', 'fx-tgl-btn', 'Mix');
    mb.type = 'button';
    mb.setAttribute('aria-label', 'Buka bagian mixing');
    mb.setAttribute('aria-pressed', 'false');
    mb.onclick = () => {
      const on = !main.classList.contains('mixing');
      const card = main.closest<HTMLElement>('.fx-dev');
      if (card) {   // kartu tidak boleh melebar: ukuran halaman utama dikunci selama halaman mixing terbuka
        if (on) { card.style.boxSizing = 'border-box'; card.style.width = card.offsetWidth + 'px'; }
        else { card.style.boxSizing = ''; card.style.width = ''; }
      }
      main.classList.toggle('mixing', on);
      main.parentElement?.classList.toggle('ds-mixing', on);   // halaman utama plugin (Volume plugin + Roll) disembunyikan; hanya halaman mixing + tombol Mix
      mb.classList.toggle('on', on);
      mb.setAttribute('aria-pressed', String(on));
      mb.setAttribute('aria-label', on ? 'Kembali ke canvas audio' : 'Buka bagian mixing');
    };
    mixBtn.append(mb, el('span', 'k-label', 'Mixing'));

    // tombol Roll: buka piano roll pattern ini. Tuts C4..G4 berlabel nama sample tiap slot, dan note memainkan sample aslinya.
    const rollBtn = el('div', 'fx-tgl');
    const rb = el('button', 'fx-tgl-btn', 'Roll');
    rb.type = 'button';
    rb.setAttribute('aria-label', 'Buka di piano roll');
    rb.title = 'Buka di piano roll (tuts C4 sampai G4 = slot 1 sampai 8)';
    rb.onclick = () => deps.openPianoRoll();
    rollBtn.append(rb, el('span', 'k-label', 'Piano Roll'));

    // gambar ulang waveform saat Attack / Pitch berubah: real-time selama knob digeser (digabung per frame), tanpa menunggu knob dilepas
    let wavePending = false;
    function scheduleWave(): void {
      if (wavePending) return;
      wavePending = true;
      requestAnimationFrame(() => { wavePending = false; paint(); });
    }

    function select(i: number): void { S.sel = i; err = ''; paint(); }   // paint() juga memperbarui halaman mixing ke slot ini

    // bunyikan sample slot i dari awal (memotong bunyi sebelumnya di slot yang sama) + jalankan animasi canvas dan denyut slot
    function preview(i: number): void {
      const b = S.bufs[i];
      if (!b) return;
      const ctx = deps.getCtx(); void ctx.resume();
      try { S.voices[i]?.stop(); } catch { /* sudah berhenti */ }
      const src = ctx.createBufferSource();
      const g = voiceGain(ctx, dev, i, ctx.currentTime, 1);
      src.buffer = b; src.playbackRate.value = rateOf(dev, i); src.connect(g); g.connect(targetFor(dev, S, i, ctx, ctx.destination)); src.start();
      src.addEventListener('ended', () => { src.disconnect(); g.disconnect(); });
      S.voices[i] = src;
      src.onended = () => { if (S.voices[i] === src) S.voices[i] = null; };
      S.t0[i] = performance.now();
      chips[i].animate(
        [{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(1.08)', filter: 'brightness(1.5)', offset: 0.25 }, { transform: 'scale(1)', filter: 'brightness(1)' }],
        { duration: 260, easing: 'ease-out' },
      );
      animate();
    }

    let err = '';

    // waveform statis: SATU GARIS gelombang (tanpa isi solid), warna mengikuti warna pattern (--fx-accent kartu).
    // Bentuknya mengikuti Attack slot: di bagian depan gelombang menurun (fade-in linear, sama dengan yang dibunyikan voiceGain) sepanjang Attack.
    // Panjang Attack di sumber = Attack x kecepatan putar (Pitch). Satu garis (mono, stereo digabung), skala linear tanpa normalisasi.
    function drawBase(w: number, h: number, dpr: number, buf: AudioBuffer, pyr: Pyramid): void {
      if (base.width !== w || base.height !== h) { base.width = w; base.height = h; }
      const g = base.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, w, h);   // transparan: latar gelap dari canvas
      waveColor = getComputedStyle(view).getPropertyValue('--fx-accent').trim() || '#F5A12A';
      g.strokeStyle = waveColor; g.lineWidth = Math.max(1, Math.round(1.25 * dpr)); g.lineJoin = 'round';
      const bodyY = Math.round(2 * dpr), bodyH = h - 2 * bodyY;
      if (bodyH < 4) return;
      const ch = pyr.ch, cols = w;
      if (wMax.length < cols * ch) { wMax = new Float32Array(cols * ch); wMin = new Float32Array(cols * ch); }
      getPeaks(pyr, buf, 0, buf.length / w, cols, wMax, wMin);   // seluruh sample dipas ke lebar canvas
      const atkSrc = mixOf(dev, S.sel).atk / 1000 * rateOf(dev, S.sel), dur = buf.duration;
      const env = (i: number): number => (atkSrc > 0.0005 ? Math.min(1, (i + 0.5) / cols * dur / atkSrc) : 1);
      // SATU garis gelombang (mono, seperti kick): per kolom diambil puncak terbesar (positif atau negatif) dari semua kanal, lalu disambung jadi
      // satu garis dari awal sampai akhir sample. Bukan outline dua tepi, jadi sample stereo / ramai tidak tampil sebagai dua batang; ekor tidak dipotong.
      const mid = bodyY + bodyH / 2, amp = bodyH / 2 - 0.5;
      const val = (i: number): number => {
        let best = 0;
        for (let c = 0; c < ch; c++) {
          const hi = wMax[i * ch + c], lo = wMin[i * ch + c], v = Math.abs(hi) >= Math.abs(lo) ? hi : lo;
          if (Math.abs(v) > Math.abs(best)) best = v;
        }
        return best;
      };
      g.beginPath();
      for (let i = 0; i < cols; i++) { const y = mid - val(i) * env(i) * amp; if (i === 0) g.moveTo(i + 0.5, y); else g.lineTo(i + 0.5, y); }
      g.stroke();
    }

    // tempel outline waveform; saat sample berbunyi: bagian yang belum terputar redup, bagian yang sudah terputar terang, ditambah garis playhead
    // (semuanya garis dengan warna pattern, tanpa isi putih / kilat). Mengembalikan true selama efek masih berjalan.
    function compose(): boolean {
      if (cv.hidden) return false;
      const g = cv.getContext('2d');
      const buf = S.bufs[S.sel];
      if (!g || !buf || base.width !== cv.width || base.height !== cv.height) return false;
      const w = cv.width, h = cv.height, dpr = window.devicePixelRatio || 1;
      g.clearRect(0, 0, w, h);
      const t0 = S.t0[S.sel], dur = buf.duration / rateOf(dev, S.sel);   // Pitch mengubah lama bunyi
      const t = t0 < 0 ? Infinity : (performance.now() - t0) / 1000;
      if (t >= dur) { g.drawImage(base, 0, 0); return false; }
      const x = Math.min(w, t / dur * w), lw = Math.max(2, Math.round(1.5 * dpr));
      g.globalAlpha = 0.4; g.drawImage(base, 0, 0); g.globalAlpha = 1;
      g.save(); g.beginPath(); g.rect(0, 0, x, h); g.clip(); g.drawImage(base, 0, 0); g.restore();
      g.fillStyle = waveColor; g.fillRect(x - lw / 2, 0, lw, h);   // playhead: garis tipis
      return true;
    }
    let raf = 0, waveColor = '#F5A12A';
    function animate(): void {
      if (raf) return;
      const step = (): void => { raf = 0; if (compose()) raf = requestAnimationFrame(step); };
      raf = requestAnimationFrame(step);
    }

    function paint(): void {
      paintEq();
      const list = samples();
      chips.forEach((c, i) => {
        const ref = list[i], name = ref ? displayName(ref.name) : EMPTY;
        if (c.textContent !== name) c.textContent = name;
        c.title = name;
        c.setAttribute('aria-label', `Slot ${i + 1}: ${name}`);
        c.classList.toggle('sel', i === S.sel);
        c.classList.toggle('has', !!ref);
        c.setAttribute('aria-pressed', String(i === S.sel));
      });
      const buf = S.bufs[S.sel], pyr = S.pyrs[S.sel], ref = list[S.sel];
      if (!buf || !pyr) {
        cv.hidden = true; hint.hidden = false;
        hint.textContent = err || (ref ? 'Memuat…' : `Slot ${S.sel + 1} masih Empty. Seret file audio ke sini`);
        view.setAttribute('aria-label', `Canvas audio drum, slot ${S.sel + 1} ${ref ? displayName(ref.name) : EMPTY}`);
        return;
      }
      cv.hidden = false; hint.hidden = true;
      view.setAttribute('aria-label', `Canvas audio drum, slot ${S.sel + 1} ${displayName(ref?.name ?? '')}`);
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(view.clientWidth * dpr), h = Math.round(view.clientHeight * dpr);
      if (!w || !h) return;
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      drawBase(w, h, dpr, buf, pyr);
      if (compose()) animate();   // sample baru dipicu saat waveform belum siap: efek lanjut begitu waveform tergambar
    }
    new ResizeObserver(() => paint()).observe(view);

    // file dijatuhkan di canvas = masuk ke slot yang sedang dipilih (mengganti isi lama); nama slot jadi nama file
    deps.registerDrop(view, async (file, blob) => {
      const i = S.sel;
      view.classList.add('busy');
      try {
        const buf = await deps.getCtx().decodeAudioData(await blob.arrayBuffer());
        const commit = deps.begin();   // langkah Undo: sample slot ini diganti
        samples()[i] = { id: file.id, name: file.name };
        S.ids[i] = file.id;
        err = '';
        setBuffer(S, i, buf);
        deps.onChange();
        commit();
        preview(i);
      } catch { err = 'Gagal membaca file audio'; }
      finally { view.classList.remove('busy'); paint(); }
    });

    S.ui = paint;
    paint();
    return { main, mixBtn, rollBtn };
  }
  return { build, instrument, sync };
}
