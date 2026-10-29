// Pengelola bake DERIZ di main thread: kumpulan Worker (fork/join seperti rack FL), cache hasil per pattern, dan antrean.
// Cache kunci = hash(isi nada pattern + parameter plugin + id sample): pattern yang sama diulang N kali = SATU render; edit satu pattern hanya
// merender ulang pattern itu. Memori dibatasi (LRU): yang terbuang akan dirender ulang saat perlu, atau dimainkan lewat worklet realtime sebagai cadangan.

import { prepareSample, sampleId } from './deriz-synth';
import type { BakeJob } from './deriz-bake';

export interface BakeReq { key: string; sample: AudioBuffer; job: BakeJob; }

const MAX_BYTES = 128 * 1024 * 1024;   // batas total audio jadi di memori (HP: cukup untuk puluhan pattern pendek)
const cache = new Map<string, AudioBuffer>();   // urutan sisip = urutan pakai (LRU)
let bytes = 0;
const bytesOf = (b: AudioBuffer): number => b.length * b.numberOfChannels * 4;

export function bakedGet(key: string): AudioBuffer | undefined {
  const b = cache.get(key); if (!b) return undefined;
  cache.delete(key); cache.set(key, b);   // dipakai: pindah ke ujung (paling baru)
  return b;
}
export const bakedHas = (key: string): boolean => cache.has(key);
function put(key: string, b: AudioBuffer): void {
  const old = cache.get(key); if (old) bytes -= bytesOf(old);
  cache.set(key, b); bytes += bytesOf(b);
  for (const [k, v] of cache) { if (bytes <= MAX_BYTES || k === key) break; cache.delete(k); bytes -= bytesOf(v); }
}
export function bakeClear(): void { cache.clear(); bytes = 0; }
export const bakeStats = (): { items: number; mb: number; workers: number; broken: boolean } => ({ items: cache.size, mb: bytes / 1048576, workers: pool.length, broken });

// FNV-1a 32-bit atas string (cukup untuk kunci cache; kolisi + panjang string digabung ke kunci)
function hash(s: string): string { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
const q = (x: number): number => Math.round(x * 1e5) / 1e5;
export function bakeKey(sample: AudioBuffer, job: BakeJob): string {
  const s = JSON.stringify([job.sampleRate, q(job.length), job.notes.map(n => [n.semis, n.start, q(n.speed), q(n.pitch), q(n.vol), q(n.at), q(n.dur), q(n.vel), n.glides?.map(g => [g.semis, q(g.at), q(g.dur)])])]);
  return sampleId(sample) + ':' + hash(s) + ':' + s.length;   // id nada tidak ikut (urutan id tidak memengaruhi suara)
}

interface W { w: Worker; sent: Set<number>; busy: string | null; }
interface Task { req: BakeReq; res: Array<(ok: boolean) => void>; }
const pool: W[] = [], queue: Task[] = [], running = new Map<string, Task>(), waiting = new Map<string, Task>();
let broken = false, fails = 0, jid = 0;
const jobs = new Map<number, { w: W; task: Task }>();

const maxWorkers = (): number => Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));

function spawn(): W | null {
  if (broken) return null;
  try {
    const w = new Worker(new URL('./deriz-bake-worker.ts', import.meta.url), { type: 'module' }), rec: W = { w, sent: new Set(), busy: null };
    w.onmessage = (e: MessageEvent) => onMsg(rec, e.data);
    w.onerror = () => fail(rec);
    pool.push(rec); return rec;
  } catch { broken = true; return null; }
}
function fail(rec: W): void {
  // worker mati / error: tugas yang sedang jalan dianggap gagal (pemanggil memakai worklet realtime sebagai cadangan)
  for (const [id, j] of jobs) if (j.w === rec) { jobs.delete(id); finish(j.task, false); }
  rec.w.terminate(); const i = pool.indexOf(rec); if (i >= 0) pool.splice(i, 1);
  if (++fails >= 3) { broken = true; for (const t of queue.splice(0)) finish(t, false); }
  pump();
}
function finish(t: Task, ok: boolean): void { running.delete(t.req.key); waiting.delete(t.req.key); for (const r of t.res) r(ok); }
function onMsg(rec: W, m: { t: string; jid: number; l?: Float32Array; r?: Float32Array; frames?: number }): void {
  const j = jobs.get(m.jid); if (!j) return;
  jobs.delete(m.jid); rec.busy = null;
  if (m.t === 'done' && m.l && m.r && m.frames) {
    const sr = j.task.req.job.sampleRate, b = new AudioBuffer({ numberOfChannels: 2, length: m.frames, sampleRate: sr });
    b.copyToChannel(m.l as Float32Array<ArrayBuffer>, 0); b.copyToChannel(m.r as Float32Array<ArrayBuffer>, 1);
    put(j.task.req.key, b); finish(j.task, true);
  } else finish(j.task, m.t === 'done');   // 'done' dengan 0 frame = pattern senyap (dianggap berhasil, tidak ada buffer)
  pump();
}
function pump(): void {
  while (queue.length) {
    let rec = pool.find(p => !p.busy) ?? null;
    if (!rec && pool.length < maxWorkers()) rec = spawn();
    if (!rec) { if (broken) for (const t of queue.splice(0)) finish(t, false); return; }
    const task = queue.shift()!, { req } = task, id = ++jid;
    rec.busy = req.key; jobs.set(id, { w: rec, task }); running.set(req.key, task); waiting.delete(req.key);
    if (!rec.sent.has(sampleId(req.sample))) {
      const p = prepareSample(req.sample); rec.sent.add(p.sid);
      rec.w.postMessage({ t: 'sample', ...p }, [...p.ch.map(a => a.buffer), p.mono.buffer]);
    }
    rec.w.postMessage({ t: 'job', jid: id, sid: sampleId(req.sample), job: req.job });
  }
}

// Minta render; hasil true = tersedia di cache (atau pattern senyap). urgent: didahulukan (dipakai Play yang sedang menunggu).
export function bakeRequest(reqs: BakeReq[], urgent = false): Promise<boolean> {
  const ps: Array<Promise<boolean>> = [];
  for (const req of reqs) {
    if (cache.has(req.key)) continue;
    const have = running.get(req.key) ?? waiting.get(req.key);
    if (have) { ps.push(new Promise(r => have.res.push(r))); if (urgent) { const i = queue.indexOf(have); if (i > 0) { queue.splice(i, 1); queue.unshift(have); } } continue; }
    const task: Task = { req, res: [] };
    ps.push(new Promise(r => task.res.push(r)));
    waiting.set(req.key, task);
    if (urgent) queue.unshift(task); else queue.push(task);
  }
  if (broken) { for (const t of queue.splice(0)) finish(t, false); }
  else pump();
  return Promise.all(ps).then(r => r.every(Boolean));
}

// Buang antrean yang belum jalan (job yang sedang dikerjakan worker tetap selesai). Dipakai prebake latar saat isi project berubah.
export function bakeCancelQueued(): void { for (const t of queue.splice(0)) finish(t, false); }
export const bakeBroken = (): boolean => broken;
