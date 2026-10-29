// Registry module (plugin buatan sendiri) untuk tab "Module". Satu entri = satu plugin: nama, parameter (dipakai UI knob),
// dan create() yang membuat node audionya. Menambah plugin baru = menambah satu entri di MODULES.
// Module disimpan per pattern bersama efek (urutan chain = urutan ditambahkan) dan ikut file project (Ekspor/Impor).
import type { DevNode } from './audio-engine';

// kind 'toggle' = tombol nyala/mati (nilai 0 / 1), bukan knob; kind 'slider' = slider vertikal (boleh dicampur dengan knob dalam satu kartu). bipolar = busur knob dimulai dari titik 0 (untuk nilai +/-).
export interface ParamDef { key: string; label: string; min: number; max: number; def: number; unit: string; dec: number; log?: boolean; kind?: 'toggle' | 'slider'; bipolar?: boolean }
// canvas = kartu menampilkan area canvas audio (tempat file audio dari panel browser dijatuhkan)
// layout 'sliders' = parameter ditampilkan sebagai slider vertikal berbaris (mis. EQ2), bukan knob
// drum = kartu Drum Sequence: canvas kecil + slot instrumen + tombol Mix (lihat drumseq.ts)
// sampler = kartu Sampler: slot nama sample di kiri (file dari panel browser dijatuhkan di sini, tanpa canvas audio) + knob / slider (lihat vsynth.ts untuk suaranya)
export interface DeviceDef { type: string; name: string; params: ParamDef[]; canvas?: boolean; drum?: boolean; sampler?: boolean; layout?: 'sliders' }
export interface ModuleDef extends DeviceDef { create(a: AudioContext): DevNode }

export const MODULES: ModuleDef[] = [
  // vsynth: canvas audio (file diseret dari panel browser) + knob Pitch / Volume / Speed + tombol Reverse.
  // MOCK-UP: baru tampilan dan parameternya; fungsi suaranya belakangan. Sementara create() hanya meneruskan sinyal tanpa diubah.
  {
    type: 'vsynth', name: 'vsynth', canvas: true,
    params: [
      { key: 'pitch', label: 'Pitch', min: -24, max: 24, def: 0, unit: 'st', dec: 0, bipolar: true },
      { key: 'volume', label: 'Volume', min: 0, max: 100, def: 100, unit: '%', dec: 0 },
      { key: 'speed', label: 'Speed', min: 0.25, max: 4, def: 1, unit: 'x', dec: 2, log: true },
      { key: 'reverse', label: 'Reverse', min: 0, max: 1, def: 0, unit: '', dec: 0, kind: 'toggle' }
    ],
    create(a) {
      const input = a.createGain(), output = a.createGain();
      input.connect(output);   // pass-through sampai fungsinya dibuat
      return {
        type: 'vsynth', input, output,
        update() { /* belum ada fungsi */ },
        dispose() { input.disconnect(); output.disconnect(); }
      };
    }
  },
  // sampler: satu sample (tanpa canvas) dimainkan langsung pada nada note lewat sampler.ts (TANPA Signalsmith: pitch = kecepatan baca, durasi ikut berubah, semua knob / slider realtime).
  // Attack = fade-in awal note (ms; <= 1,5 = langsung penuh). Release = ekor setelah note berakhir (ms; <= 8 = fade-out pendek bawaan vsynth). Volume = slider.
  {
    type: 'sampler', name: 'Sampler', sampler: true,
    params: [
      { key: 'pitch', label: 'Pitch', min: -24, max: 24, def: 0, unit: 'st', dec: 0, bipolar: true },
      { key: 'attack', label: 'Attack', min: 1, max: 2000, def: 1, unit: 'ms', dec: 0, log: true },
      { key: 'release', label: 'Release', min: 8, max: 5000, def: 8, unit: 'ms', dec: 0, log: true },
      { key: 'volume', label: 'Volume', min: 0, max: 100, def: 100, unit: '%', dec: 0, kind: 'slider' }
    ],
    create(a) {
      const input = a.createGain(), output = a.createGain();
      input.connect(output);   // pass-through: pitch / attack / release / volume diterapkan di suara note (vsynth.ts), bukan di chain
      return {
        type: 'sampler', input, output,
        update() { /* semua parameter dipakai saat note dimainkan */ },
        dispose() { input.disconnect(); output.disconnect(); }
      };
    }
  },
  // drumseq: canvas audio kecil dengan banyak slot instrumen (Kick, Snare, Hihat, ...), tiap slot punya sample sendiri + tombol menuju mixing.
  // BARU TAMPILAN + sample per slot (ketuk slot = bunyi). Sequencer dan mixing per instrumen menyusul; sementara hanya knob Volume yang bekerja.
  {
    type: 'drumseq', name: 'Drum Sequence', drum: true,
    params: [
      { key: 'volume', label: 'Volume', min: 0, max: 100, def: 100, unit: '%', dec: 0 }
    ],
    create(a) {
      const input = a.createGain(), output = a.createGain();
      input.connect(output);
      return {
        type: 'drumseq', input, output,
        update(p) { output.gain.setTargetAtTime(Math.min(100, Math.max(0, p.volume ?? 100)) / 100, a.currentTime, 0.02); },
        dispose() { input.disconnect(); output.disconnect(); }
      };
    }
  }
];
export const moduleDef = (type: string): ModuleDef | undefined => MODULES.find(m => m.type === type);
