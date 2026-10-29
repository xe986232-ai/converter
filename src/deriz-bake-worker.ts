// Worker render DERIZ: menerima sample sekali per worker, lalu job (daftar nada satu pattern) -> audio jadi L/R. Logika di deriz-bake.ts.
import { bakeDeriz, type BakeJob } from './deriz-bake';
import type { PreparedSample } from './deriz-synth';

const samples = new Map<number, PreparedSample>();
type In = ({ t: 'sample' } & PreparedSample) | { t: 'job'; jid: number; sid: number; job: BakeJob };
const post = (self as unknown as { postMessage(m: unknown, tr?: Transferable[]): void }).postMessage.bind(self);

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.t === 'sample') { samples.set(m.sid, m); return; }
  const s = samples.get(m.sid);
  if (!s) { post({ t: 'fail', jid: m.jid, why: 'sample hilang' }); return; }
  try {
    const r = bakeDeriz(s, m.job);
    post({ t: 'done', jid: m.jid, l: r.l, r: r.r, frames: r.frames }, [r.l.buffer, r.r.buffer]);
  } catch (err) { post({ t: 'fail', jid: m.jid, why: String(err) }); }
};
