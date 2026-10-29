// Tes kesehatan audio lintas perangkat: node --experimental-transform-types tools/audio-health-test.ts
// Semua waktu PALSU (kita yang menggerakkan jam dinding dan jam audio), jadi hasilnya deterministik di mesin mana pun.
//   (1) ClockWatch: jam sehat tidak pernah dituduh; buffer keluaran besar (kuantisasi) tidak dianggap lambat; gangguan sesaat tidak menurunkan kualitas;
//       gangguan terus-menerus / underrun berulang = 'slow'; context tidak running = 'suspended'; jam beku = 'stalled'; timer yang ikut beku diabaikan
//   (2) QualityGovernor: turun bertahap, tidak turun karena suspended, pulih pelan setelah lama sehat, terkunci kalau kambuh
//   (3) clipWindow: clip telat melompati bagian yang sudah lewat (tetap sejajar timeline)
//   (4) nextLead: jeda awal Play menyesuaikan diri dengan waktu kerja penjadwalan
import { ClockWatch, QualityGovernor, LEVELS, RECOVER_AFTER_SEC, RELAPSE_SEC, clipWindow, nextLead, settleLead, LEAD_MAX, LEAD_MIN, type Verdict, type ClockSample } from '../src/audio-health.ts';

let fail = 0;
const ok = (c: boolean, msg: string): void => { console.log((c ? 'OK   ' : 'GAGAL ') + msg); if (!c) fail++; };
const near = (a: number, b: number, e = 1e-9): boolean => Math.abs(a - b) <= e;

// Jalankan pemantau selama `secs` detik jam dinding, sampel tiap `every` detik. audioAt(wall) = jam audio pada waktu dinding itu.
function drive(w: ClockWatch, secs: number, audioAt: (wall: number) => number, opt: { every?: number; running?: (wall: number) => boolean; underruns?: (wall: number) => number; from?: number } = {}): Verdict[] {
  const every = opt.every ?? 0.25, from = opt.from ?? 0, out: Verdict[] = [];
  for (let t = from; t <= from + secs + 1e-9; t += every) {
    const s: ClockSample = { audio: audioAt(t), wall: t, running: opt.running ? opt.running(t) : true };
    if (opt.underruns) s.underruns = opt.underruns(t);
    const v = w.push(s); if (v) out.push(v);
  }
  return out;
}
const count = (a: Verdict[], v: Verdict): number => a.filter(x => x === v).length;

// (1) ClockWatch
{
  const v = drive(new ClockWatch(), 30, t => t);
  ok(v.length > 0 && count(v, 'ok') === v.length, `jam sehat 30 dtk: ${v.length} vonis, semuanya ok`);
}
{
  // buffer keluaran besar: jam audio hanya naik per 85 ms (mode 'playback' di HP lambat / Bluetooth); rasio sebenarnya tetap 1
  const Q = 0.085;
  const v = drive(new ClockWatch(), 60, t => Math.floor(t / Q) * Q);
  ok(count(v, 'ok') === v.length, `kuantisasi buffer 85 ms tidak dianggap lambat (${v.length} jendela, semua ok)`);
}
{
  // Bluetooth: jam audio maju per potongan 200 ms. Rasio sebenarnya 1, jadi TIDAK boleh dianggap lambat (kalau iya, kualitas turun sia-sia).
  for (const Q of [0.2, 0.17]) {
    const v = drive(new ClockWatch(), 120, t => Math.floor(t / Q) * Q);
    ok(count(v, 'ok') === v.length, `kuantisasi buffer ${Q * 1000} ms (Bluetooth) selama 120 dtk tidak dianggap lambat (${v.length} jendela, semua ok)`);
  }
  // sampel tidak selaras dengan potongan buffer (timer 250 ms vs buffer 200 ms): galat terburuk
  const v2 = drive(new ClockWatch(), 120, t => Math.floor(t / 0.2) * 0.2, { every: 0.2 + 0.013 });
  ok(count(v2, 'ok') === v2.length, 'sampel tidak selaras dengan buffer 200 ms: tetap tidak dituduh');
}
{
  const v = drive(new ClockWatch(), 12, t => t * 0.7);
  ok(count(v, 'slow') >= 1 && v[0] === 'ok', `jam audio hanya 70% dari jam dinding: vonis 'slow' muncul setelah jendela buruk kedua (urutan: ${v.slice(0, 4).join(',')})`);
}
{
  // satu gangguan sesaat (jam audio tersendat 0,6 dtk lalu normal) tidak boleh menurunkan kualitas
  const v = drive(new ClockWatch(), 30, t => t < 5 ? t : t < 5.6 ? 5 : t - 0.6);
  ok(count(v, 'slow') === 0 && count(v, 'stalled') === 0, 'satu gangguan sesaat (0,6 dtk) tidak memicu vonis apa pun');
}
{
  const v = drive(new ClockWatch(), 12, t => t, { underruns: t => Math.floor(t / 1.5) * 4 });   // 4 per 1,5 dtk ~ 6-7 per jendela
  ok(count(v, 'slow') >= 1, `rasio normal tapi underrun browser 4 per jendela berulang: tetap 'slow' (${v.join(',')})`);
}
{
  const w = new ClockWatch();
  const v = drive(w, 6, t => Math.min(t, 2), { running: t => t < 2 });   // context berhenti di detik 2
  ok(count(v, 'suspended') >= 1, "context tidak 'running' > 1,5 dtk: vonis 'suspended'");
  const v2 = drive(w, 10, t => 2 + (t - 8), { from: 8.25, running: () => true });
  ok(count(v2, 'slow') === 0 && count(v2, 'stalled') === 0, "setelah context kembali running tidak ada vonis salah (jam audio berhenti lama tidak dihitung lambat)");
}
{
  const v = drive(new ClockWatch(), 8, t => Math.min(t, 3));   // state running tapi jam audio beku di detik 3
  ok(count(v, 'stalled') >= 1, "context running tapi jam audio beku: vonis 'stalled'");
}
{
  // thread utama / tab beku 5 detik: sampel berikutnya datang terlambat. Selang itu tidak boleh dihitung (bisa tampak seperti rasio aneh).
  const w = new ClockWatch();
  const a = drive(w, 3, t => t);
  const b: Verdict[] = []; for (let t = 9; t <= 16; t += 0.25) { const x = w.push({ audio: t, wall: t, running: true }); if (x) b.push(x); }
  ok(count(a, 'ok') === a.length && count(b, 'ok') === b.length, 'selang sampel 5 dtk (timer beku) diabaikan, tidak ada vonis salah');
}
{
  const w = new ClockWatch();
  w.calm(2);
  const v = drive(w, 20, t => t * 0.5);   // buruk terus, tapi 2 jendela pertama dikecualikan (napas setelah tindakan)
  const firstBad = v.findIndex(x => x !== 'ok');
  ok(firstBad >= 3, `calm(2): dua jendela pertama tidak dihitung, vonis baru muncul di jendela ke-${firstBad + 1}`);
}

// (2) QualityGovernor
{
  const g = new QualityGovernor();
  ok(g.level === 0 && g.quality.loud === true && g.quality.voices === LEVELS[0].voices, 'awal: kualitas penuh (level 0)');
  const q1 = g.step('slow', 10);
  ok(!!q1 && q1.level === 1 && q1.voices < LEVELS[0].voices, `slow pertama: turun ke level 1 (voice ${LEVELS[0].voices} -> ${q1?.voices})`);
  const q2 = g.step('slow', 20);
  ok(!!q2 && q2.level === 2 && q2.loud === false && q2.saws < 7, 'slow kedua: level 2 (Master Loudness dilewati, saw per voice dikurangi)');
  ok(g.step('slow', 30) === null && g.level === 2, 'sudah level terendah: tidak turun lagi');
  ok(LEVELS.every((l, i) => i === 0 || (l.voices <= LEVELS[i - 1].voices && l.derizCap <= LEVELS[i - 1].derizCap && l.derizFull <= LEVELS[i - 1].derizFull)), 'tiap level tidak pernah lebih berat dari level sebelumnya');
}
{
  const g = new QualityGovernor();
  ok(g.step('suspended', 5) === null && g.level === 0, "'suspended' (telepon / alarm) tidak menurunkan kualitas");
  ok(g.step('ok', 6) === null, "'ok' di level 0 tidak mengubah apa pun");
}
{
  const g = new QualityGovernor();
  g.step('slow', 0); g.step('slow', 5);
  ok(g.step('ok', 5 + RECOVER_AFTER_SEC - 1) === null && g.level === 2, 'belum cukup lama sehat: tetap di level 2');
  const up = g.step('ok', 5 + RECOVER_AFTER_SEC);
  ok(!!up && up.level === 1, `sehat ${RECOVER_AFTER_SEC} dtk: naik satu tingkat (level 1)`);
  const down = g.step('slow', 5 + RECOVER_AFTER_SEC + RELAPSE_SEC - 1);
  ok(!!down && down.level === 2 && g.isLocked, 'kambuh sesaat setelah naik: turun lagi dan terkunci');
  ok(g.step('ok', 5 + 10 * RECOVER_AFTER_SEC) === null && g.level === 2, 'terkunci: tidak naik lagi di sesi ini (tidak naik-turun terus)');
}

// (3) clipWindow
{
  const a = clipWindow(10, 2, 3, 9, 100);
  ok(!!a && near(a.when, 10) && near(a.off, 2) && near(a.dur, 3), 'clip belum waktunya: tidak diubah');
  const b = clipWindow(10, 2, 3, 10.12, 100, 0);
  ok(!!b && near(b.when, 10.12) && near(b.off, 2.12) && near(b.dur, 2.88), 'clip telat 120 ms: dimulai sekarang tapi lompat 120 ms ke dalam (tetap sejajar timeline)');
  ok(b !== null && near(b.when + b.dur, 13, 1e-9) && near(b.off + b.dur, 5, 1e-9), 'titik akhir di timeline dan di dalam file tetap sama dengan jadwal asli');
  ok(clipWindow(10, 2, 3, 13.5, 100) === null, 'clip yang seluruhnya sudah lewat: dilewati');
  ok(clipWindow(10, -1, 3, 9, 100) === null, 'offset negatif: dilewati');
  const c = clipWindow(10, 8, 5, 9, 10);
  ok(!!c && near(c.dur, 2), 'durasi dipotong sampai ujung file');
}

// (4) nextLead
{
  ok(near(settleLead(0.6, 0.01), 0.02 + 0.08 + 0.01), 'jeda menempel tinggi karena hiccup sesaat: disusutkan ke kerja nyata + bantalan');
  ok(near(settleLead(0.05, 0.3), 0.05), 'settleLead tidak pernah menaikkan jeda (itu tugas nextLead)');
  ok(settleLead(0.3, 0) >= LEAD_MIN && settleLead(0.3, 0) < 0.3, 'kerja sangat cepat: jeda turun mendekati minimum, tidak di bawahnya');
  ok(nextLead(0.05, 0.03) === null, 'sisa jeda cukup: tidak dinaikkan');
  const heavy = 0.12, lead0 = 0.05;
  const l1 = nextLead(lead0, lead0 - heavy);   // kerja penjadwalan 120 ms memakan habis jeda 50 ms
  ok(l1 !== null && l1 > heavy + 0.02, `jeda dinaikkan sampai melebihi waktu kerja (${(lead0 * 1000).toFixed(0)} -> ${((l1 ?? 0) * 1000).toFixed(0)} ms untuk kerja ${heavy * 1000} ms)`);
  let lead = lead0, steps = 0; while (steps < 20) { const n = nextLead(lead, lead - 5); if (n === null) break; lead = n; steps++; }
  ok(lead <= LEAD_MAX + 1e-9 && steps >= 1 && steps <= 10, `kerja sangat berat: jeda berhenti di batas ${LEAD_MAX * 1000} ms (${steps} langkah)`);
}

console.log(fail ? `\n${fail} GAGAL` : '\nsemua lulus');
process.exit(fail ? 1 : 0);
