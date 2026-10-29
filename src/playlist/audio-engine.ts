// Engine audio minimal untuk playlist canvas: satu AudioContext + satu master gain.
// Sengaja belum tersambung ke mixer / efek / engine lama (src/audio-engine.ts); tiap clip langsung ke master.
// Kalau nanti fungsi disambungkan, ganti isi pattern(clipId) dengan chain efek clip itu.

class PlaylistEngine {
  private a: AudioContext | null = null;
  private m: GainNode | null = null;

  context(): AudioContext {
    if (!this.a) {
      this.a = new AudioContext({ latencyHint: 'interactive' });
      this.m = this.a.createGain();
      this.m.connect(this.a.destination);
    }
    if (this.a.state === 'suspended') void this.a.resume();
    return this.a;
  }

  master(): AudioNode { this.context(); return this.m as GainNode; }

  pattern(_clipId: number): AudioNode { return this.master(); }
}

export const engine = new PlaylistEngine();
