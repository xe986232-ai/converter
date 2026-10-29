// Registry tools (panel "Tools"), polanya sama seperti MODULES di modules.ts: satu entri = satu tool = satu kartu.
// Menambah tool baru = buat src/tool-<nama>.ts yang mengekspor fungsi mount(body, ctx), lalu tambahkan satu entri di TOOLS.
import { mountBpmFind } from './tool-bpmfind';

/** Yang boleh disentuh sebuah tool di luar kartunya sendiri (diisi dari main.ts). */
export interface ToolContext { getBpm(): number; setBpm(bpm: number): void }
export interface ToolDef { type: string; name: string; mount(body: HTMLElement, ctx: ToolContext): void }

export const TOOLS: ToolDef[] = [
  { type: 'bpmfind', name: 'bpmfind', mount: mountBpmFind }
];
