// Panel Tools (tab keempat di bilah bawah, kanan Play): deretan kartu, satu kartu per tool di registry TOOLS (src/tools.ts).
// Kartu memakai gaya yang sama dengan kartu efek / module (.fx-dev: kepala bernama + badan), tanpa tombol power / hapus.
import './tools-panel.css';
import { el } from './ui-util';
import { TOOLS, type ToolContext } from './tools';

export type ToolsPanelOptions = ToolContext;

export function mountToolsPanel(host: HTMLElement, opts: ToolsPanelOptions): void {
  host.innerHTML = '';
  host.setAttribute('role', 'list');
  for (const def of TOOLS) {
    const card = el('div', 'fx-dev tl-card');
    card.setAttribute('role', 'listitem');
    card.dataset.type = def.type;
    const head = el('div', 'fx-dev-head');
    head.appendChild(el('span', 'fx-dev-name', def.name));
    const body = el('div', 'fx-knobs tl-body');
    def.mount(body, opts);
    card.append(head, body);
    host.appendChild(card);
  }
}
