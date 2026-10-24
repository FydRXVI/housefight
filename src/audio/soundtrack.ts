export type SoundtrackNote = number | null;

export interface Soundtrack {
  name: string;
  subtitle: string;
  bpm: number;
  swing: number;
  leadWave: OscillatorType;
  lead: SoundtrackNote[];
  harmony: SoundtrackNote[];
  bass: SoundtrackNote[];
  arp: SoundtrackNote[];
  drums: number[];
}

interface Motif {
  lead: SoundtrackNote[];
  chords: Array<readonly [root: number, third: 3 | 4]>;
}

interface BarPlan {
  motif: number;
  shape?: 'full' | 'sparse' | 'lift' | 'answer' | 'climax';
  transpose?: number;
  intensity?: 1 | 2 | 3;
}

interface TrackSource {
  name: string;
  subtitle: string;
  bpm: number;
  swing: number;
  leadWave: OscillatorType;
  motifs: Motif[];
  plan: BarPlan[];
}

const KICK = 1;
const SNARE = 2;
const HAT = 4;
const OPEN_HAT = 8;

const DEFAULT_PLAN: BarPlan[] = [
  { motif: 0, shape: 'sparse', intensity: 1 }, { motif: 1, shape: 'sparse', intensity: 1 },
  { motif: 0, intensity: 2 }, { motif: 1, intensity: 2 },
  { motif: 2, intensity: 2 }, { motif: 3, shape: 'answer', intensity: 2 },
  { motif: 0, shape: 'lift', intensity: 2 }, { motif: 1, shape: 'lift', intensity: 3 },
  { motif: 2, intensity: 2 }, { motif: 3, intensity: 3 },
  { motif: 0, transpose: 2, intensity: 3 }, { motif: 1, transpose: 2, shape: 'answer', intensity: 3 },
  { motif: 2, shape: 'sparse', intensity: 1 }, { motif: 3, shape: 'sparse', intensity: 1 },
  { motif: 0, intensity: 2 }, { motif: 1, shape: 'answer', intensity: 2 },
  { motif: 2, shape: 'lift', intensity: 3 }, { motif: 3, shape: 'lift', intensity: 3 },
  { motif: 0, shape: 'climax', intensity: 3 }, { motif: 1, shape: 'climax', intensity: 3 },
  { motif: 2, shape: 'climax', intensity: 3 }, { motif: 3, shape: 'climax', intensity: 3 },
  { motif: 0, intensity: 2 }, { motif: 1, shape: 'answer', intensity: 2 },
];

function motif(lead: SoundtrackNote[], roots: number[], minor: number[] = []): Motif {
  if (lead.length !== 16 || roots.length !== 4) throw new Error('Soundtrack motifs must contain one four-beat bar.');
  return {
    lead,
    chords: roots.map((root, index) => [root, minor.includes(index) ? 3 : 4] as const),
  };
}

function shapeLead(note: SoundtrackNote, step: number, shape: BarPlan['shape']): SoundtrackNote {
  if (note === null) return null;
  if (shape === 'sparse' && step % 4 !== 0 && step % 4 !== 2) return null;
  if (shape === 'lift' && step >= 8) return note + 12;
  if (shape === 'answer' && step >= 8) return note + (step % 4 === 0 ? 12 : 0);
  if (shape === 'climax' && (step >= 8 || step % 4 === 0)) return note + 12;
  return note;
}

function fitMidi(note: number): number {
  let fitted = note;
  while (fitted > 96) fitted -= 12;
  while (fitted < 24) fitted += 12;
  return fitted;
}

function buildTrack(source: TrackSource): Soundtrack {
  const lead: SoundtrackNote[] = [];
  const harmony: SoundtrackNote[] = [];
  const bass: SoundtrackNote[] = [];
  const arp: SoundtrackNote[] = [];
  const drums: number[] = [];

  source.plan.forEach((bar, barIndex) => {
    const selected = source.motifs[bar.motif];
    if (!selected) throw new Error(`Missing soundtrack motif ${bar.motif}.`);
    const intensity = bar.intensity ?? 2;
    for (let step = 0; step < 16; step += 1) {
      const beat = Math.floor(step / 4);
      const chord = selected.chords[beat] as readonly [number, 3 | 4];
      const transposition = bar.transpose ?? 0;
      const melody = shapeLead(selected.lead[step] ?? null, step, bar.shape ?? 'full');
      const root = chord[0] + transposition;
      const third = chord[1];
      lead.push(melody === null ? null : fitMidi(melody + transposition));
      harmony.push(melody !== null && (step % 4 === 0 || (intensity === 3 && step % 4 === 2)) ? fitMidi(melody + transposition - third) : null);
      bass.push(step % 4 === 0 ? fitMidi(root) : intensity === 3 && step % 4 === 3 ? fitMidi(root + 7) : null);
      arp.push(step % 2 === 0 ? fitMidi(root + 12 + [0, third, 7, 12][(step / 2) % 4]!) : null);

      let drum = 0;
      if (step % 2 === 0 || intensity === 3) drum |= HAT;
      if (step === 0 || step === 8 || (intensity >= 2 && (step === 6 || step === 14))) drum |= KICK;
      if (step === 4 || step === 12) drum |= SNARE;
      if (intensity === 3 && step === 14) drum |= OPEN_HAT;
      if (barIndex === source.plan.length - 1 && step >= 12 && step % 2 === 0) drum |= SNARE;
      drums.push(drum);
    }
  });

  return { name: source.name, subtitle: source.subtitle, bpm: source.bpm, swing: source.swing, leadWave: source.leadWave, lead, harmony, bass, arp, drums };
}

// Every melody and arrangement below was written for House Fight. Audio is synthesized
// in the browser: there are no recordings, samples, external files, or borrowed tunes.
export const SOUNDTRACKS: Soundtrack[] = [
  buildTrack({
    name: 'NEON ROUTE', subtitle: 'BRIGHT / RESTLESS / OPENING RUN', bpm: 142, swing: 0.04, leadWave: 'square', plan: DEFAULT_PLAN,
    motifs: [
      motif([72, null, 76, 79, 81, 79, 76, null, 74, null, 77, 81, 83, 81, 77, 74], [48, 45, 50, 43], [1, 3]),
      motif([72, 76, 79, null, 84, 81, 79, 76, 74, 77, 81, 77, 76, 74, 72, null], [48, 45, 50, 47], [1]),
      motif([79, null, 81, 83, 86, 83, 81, 79, 77, null, 81, 84, 83, 81, 77, 76], [43, 50, 45, 48], [0, 2]),
      motif([76, 77, 79, 84, 83, 81, 79, 76, 74, 76, 77, 81, 79, 77, 76, 72], [45, 50, 43, 48], [0, 2]),
    ],
  }),
  buildTrack({
    name: 'RIVAL AT THE DOOR', subtitle: 'TENSE / BOLD / NO TURNING BACK', bpm: 156, swing: 0.015, leadWave: 'sawtooth', plan: DEFAULT_PLAN,
    motifs: [
      motif([69, 72, null, 76, 75, 72, 69, null, 70, 74, 77, null, 74, 70, 67, null], [45, 48, 43, 46], [0, 2]),
      motif([69, null, 81, 79, 76, 72, 75, null, 74, 70, 67, 70, 72, 75, 76, null], [45, 48, 43, 50], [0, 1]),
      motif([76, 75, 72, 69, 67, 69, 70, 74, 77, 76, 74, 70, 69, null, 67, null], [41, 43, 46, 45], [0, 1, 3]),
      motif([69, 72, 76, 75, 72, 76, 81, 79, 77, 74, 70, 67, 69, 70, 72, 76], [45, 48, 50, 45], [0, 3]),
    ],
  }),
  buildTrack({
    name: 'VICTORY SNACKS', subtitle: 'BOUNCY / TRIUMPHANT / EXTRA CRUNCH', bpm: 132, swing: 0.09, leadWave: 'square', plan: DEFAULT_PLAN,
    motifs: [
      motif([76, 79, 83, null, 81, 79, 76, 72, 74, 77, 81, null, 79, 77, 74, null], [48, 45, 50, 43], [1]),
      motif([76, 79, 84, 83, 81, 79, 77, 76, 74, 76, 77, 81, 79, 77, 76, null], [48, 55, 45, 47], [2]),
      motif([72, 76, 79, 81, 83, null, 81, 79, 77, 74, 77, 81, 84, 81, 79, 76], [48, 52, 50, 55], [2]),
      motif([84, 83, 81, 79, 76, 77, 79, 81, 83, 79, 76, 74, 72, 74, 76, 79], [45, 50, 43, 48], [0, 2]),
    ],
  }),
  buildTrack({
    name: 'MIDNIGHT SOUQ', subtitle: 'MYSTERIOUS / QUICK / LANTERN-LIT', bpm: 118, swing: 0.12, leadWave: 'triangle', plan: DEFAULT_PLAN,
    motifs: [
      motif([69, null, 72, 73, 76, 73, 72, 69, 68, null, 71, 72, 76, 72, 71, null], [45, 41, 44, 40], [0, 1, 2, 3]),
      motif([69, 72, 76, 77, 76, 73, 72, 68, 69, null, 81, 80, 76, 73, 72, null], [45, 48, 44, 40], [0, 2, 3]),
      motif([76, 73, 72, 69, 68, 69, 71, 72, 73, 76, 80, 76, 73, 72, 68, null], [41, 44, 45, 40], [0, 1, 3]),
      motif([69, 71, 72, 76, 73, 72, 69, 68, 64, 68, 69, 72, 71, 68, 69, null], [45, 44, 40, 45], [0, 1, 2, 3]),
    ],
  }),
  buildTrack({
    name: 'ROOFTOP REMATCH', subtitle: 'AIRY / DETERMINED / SECOND WIND', bpm: 146, swing: 0.035, leadWave: 'square', plan: DEFAULT_PLAN,
    motifs: [
      motif([74, 78, 81, null, 83, 81, 78, 74, 76, 79, 83, null, 86, 83, 79, 76], [50, 47, 52, 45], [1, 3]),
      motif([74, null, 81, 83, 86, 88, 86, 83, 81, 78, 74, 76, 78, 81, 83, null], [50, 52, 47, 45], [2, 3]),
      motif([81, 83, 86, 83, 81, 78, 76, 74, 71, 74, 78, 81, 79, 76, 74, null], [47, 50, 43, 45], [0, 2]),
      motif([74, 76, 78, 81, 83, 86, 88, 86, 83, 81, 79, 76, 74, 78, 81, null], [50, 45, 47, 50], [1]),
    ],
  }),
  buildTrack({
    name: 'CEDAR CIRCUIT', subtitle: 'DRIVING / WARM / MOUNTAIN STATIC', bpm: 128, swing: 0.07, leadWave: 'sawtooth', plan: DEFAULT_PLAN,
    motifs: [
      motif([67, 71, 74, 76, 74, 71, 67, null, 69, 72, 76, 79, 76, 72, 69, null], [43, 40, 45, 38], [1, 3]),
      motif([67, null, 79, 78, 74, 71, 72, 74, 76, 72, 69, 67, 66, 67, 71, null], [43, 47, 45, 38], [1, 2]),
      motif([74, 76, 79, 83, 79, 76, 74, 71, 72, 76, 78, 81, 78, 76, 72, null], [40, 43, 45, 47], [0, 2]),
      motif([71, 74, 76, 79, 78, 74, 71, 69, 67, 69, 71, 74, 72, 71, 67, null], [43, 45, 38, 43], [2]),
    ],
  }),
  buildTrack({
    name: 'LAST BUS HOME', subtitle: 'DREAMY / HOPEFUL / WINDOWS GLOWING', bpm: 104, swing: 0.1, leadWave: 'triangle', plan: DEFAULT_PLAN,
    motifs: [
      motif([72, null, 76, 79, 83, null, 81, 79, 76, null, 74, 72, 69, 72, 74, null], [48, 45, 41, 43], [1, 2]),
      motif([76, 79, 81, 84, 83, 79, 76, null, 74, 76, 79, 81, 79, 76, 72, null], [45, 48, 43, 41], [0, 2, 3]),
      motif([69, 72, 76, 79, 81, 79, 76, 72, 67, 71, 74, 76, 79, 76, 74, null], [41, 45, 43, 48], [0, 2]),
      motif([84, 83, 79, 76, 74, 72, 69, 67, 69, 72, 74, 76, 72, 74, 76, null], [45, 41, 43, 48], [0, 1, 2]),
    ],
  }),
  buildTrack({
    name: 'FAMILY FINAL', subtitle: 'EPIC / CHAOTIC / EVERYONE IS YELLING', bpm: 164, swing: 0.02, leadWave: 'square', plan: DEFAULT_PLAN,
    motifs: [
      motif([71, 74, 78, 83, 81, 78, 74, 71, 72, 76, 79, 84, 83, 79, 76, 72], [47, 43, 48, 45], [0, 1, 3]),
      motif([71, null, 83, 81, 78, 76, 74, 71, 69, 72, 76, 79, 78, 74, 71, null], [47, 50, 45, 43], [0, 2, 3]),
      motif([78, 81, 83, 86, 90, 86, 83, 81, 79, 76, 72, 74, 76, 78, 81, null], [43, 47, 48, 50], [0, 1]),
      motif([83, 81, 78, 74, 71, 74, 78, 81, 84, 83, 79, 76, 72, 74, 71, null], [47, 45, 43, 47], [1, 2]),
    ],
  }),
];

function frequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function soundtrackDuration(track: Soundtrack): number {
  return track.lead.length * (60 / track.bpm / 4);
}

export class SoundtrackEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private echoInput: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private timer: number | null = null;
  private nextStepAt = 0;
  private step = 0;
  private trackIndex = 0;
  private volume = 0.3;

  async start(trackIndex: number, volume: number): Promise<void> {
    this.trackIndex = ((trackIndex % SOUNDTRACKS.length) + SOUNDTRACKS.length) % SOUNDTRACKS.length;
    this.volume = volume;
    if (!this.context) this.createAudioGraph();
    if (!this.context || !this.master) return;
    await this.context.resume();
    this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.035);
    this.step = 0;
    this.nextStepAt = this.context.currentTime + 0.04;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), 45);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (this.context && this.master) this.master.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.025);
  }

  setTrack(trackIndex: number): void {
    this.trackIndex = ((trackIndex % SOUNDTRACKS.length) + SOUNDTRACKS.length) % SOUNDTRACKS.length;
    this.step = 0;
    if (this.context) this.nextStepAt = this.context.currentTime + 0.04;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.context && this.master) this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.035);
  }

  destroy(): void {
    this.stop();
    if (this.context) void this.context.close();
    this.context = null;
    this.master = null;
    this.echoInput = null;
    this.noiseBuffer = null;
  }

  private createAudioGraph(): void {
    const context = new AudioContext();
    const master = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const echoInput = context.createGain();
    const delay = context.createDelay(1);
    const feedback = context.createGain();
    const wet = context.createGain();
    master.gain.value = 0.0001;
    compressor.threshold.value = -18;
    compressor.knee.value = 16;
    compressor.ratio.value = 5;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.18;
    echoInput.gain.value = 0.16;
    delay.delayTime.value = 0.185;
    feedback.gain.value = 0.22;
    wet.gain.value = 0.22;
    echoInput.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(wet).connect(master);
    master.connect(compressor).connect(context.destination);
    const noiseBuffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.18), context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    this.context = context;
    this.master = master;
    this.echoInput = echoInput;
    this.noiseBuffer = noiseBuffer;
  }

  private schedule(): void {
    const context = this.context;
    if (!context || !this.master) return;
    const track = SOUNDTRACKS[this.trackIndex] as Soundtrack;
    const baseStepDuration = 60 / track.bpm / 4;
    while (this.nextStepAt < context.currentTime + 0.16) {
      const index = this.step % track.lead.length;
      const lead = track.lead[index];
      const harmony = track.harmony[index];
      const bass = track.bass[index];
      const arp = track.arp[index];
      if (typeof lead === 'number') this.note(lead, this.nextStepAt, baseStepDuration * 0.86, track.leadWave, 0.058, 3_100, -0.16, true);
      if (typeof harmony === 'number') this.note(harmony, this.nextStepAt, baseStepDuration * 1.55, 'triangle', 0.025, 1_850, 0.2, false);
      if (typeof bass === 'number') this.note(bass, this.nextStepAt, baseStepDuration * 1.55, 'triangle', 0.1, 900, 0, false);
      if (typeof arp === 'number') this.note(arp, this.nextStepAt, baseStepDuration * 1.35, 'sine', 0.031, 2_600, index % 4 === 0 ? -0.38 : 0.38, true);
      const drum = track.drums[index] ?? 0;
      if (drum & KICK) this.kick(this.nextStepAt);
      if (drum & SNARE) this.noiseHit(this.nextStepAt, false);
      if (drum & HAT) this.noiseHit(this.nextStepAt, true, Boolean(drum & OPEN_HAT));
      const swingScale = this.step % 2 === 0 ? 1 + track.swing : 1 - track.swing;
      this.nextStepAt += baseStepDuration * swingScale;
      this.step += 1;
    }
  }

  private note(midi: number, startsAt: number, duration: number, type: OscillatorType, level: number, cutoff: number, pan: number, echo: boolean): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const filter = context.createBiquadFilter();
    const panner = context.createStereoPanner();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency(midi), startsAt);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, startsAt);
    panner.pan.value = pan;
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(level, startsAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
    oscillator.connect(filter).connect(gain).connect(panner).connect(master);
    if (echo && this.echoInput) panner.connect(this.echoInput);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration + 0.03);
  }

  private kick(startsAt: number): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(130, startsAt);
    oscillator.frequency.exponentialRampToValueAtTime(46, startsAt + 0.11);
    gain.gain.setValueAtTime(0.13, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.13);
    oscillator.connect(gain).connect(master);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + 0.14);
  }

  private noiseHit(startsAt: number, hat: boolean, open = false): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || !this.noiseBuffer) return;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const duration = hat ? (open ? 0.15 : 0.035) : 0.09;
    source.buffer = this.noiseBuffer;
    filter.type = 'highpass';
    filter.frequency.value = hat ? 5_400 : 1_450;
    gain.gain.setValueAtTime(hat ? 0.022 : 0.048, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
    source.connect(filter).connect(gain).connect(master);
    source.start(startsAt);
    source.stop(startsAt + duration);
  }
}
