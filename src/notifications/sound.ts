// Two kalimba notes, E4 then A4, panned apart and trailed by a ping-pong echo.
const NOTES = [
  { offset: 0, frequency: 329.63, pan: -0.3 },
  { offset: 0.1, frequency: 440, pan: 0.2 },
] as const;
/** A tine's partials: frequency ratio, level, and decay relative to the fundamental. */
const PARTIALS = [
  [1, 1, 1],
  [5.4, 0.16, 0.07],
  [2, 0.08, 0.3],
] as const;
const PEAK = 0.3;
const ATTACK = 0.003;
const RING = 0.8;
const ECHO = { delay: 0.13, feedback: 0.28, mix: 0.24 };
/** Seconds until the echo is inaudible and the graph can be released. */
const TAIL = 2;

interface Voice {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
}
function envelope(param: AudioParam, start: number, peak: number, attack: number, decay: number) {
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.exponentialRampToValueAtTime(0.0001, start + attack + decay);
}

/** A short, quiet two-note cue. Audio is unlocked by interaction, never queued for later. */
export class CompletionSound {
  private context: AudioContext | undefined;
  private noise: AudioBuffer | undefined;
  private lastPlayed = -Infinity;
  private voices = new Set<Voice>();
  private release(voice: Voice) {
    if (!this.voices.delete(voice)) return;
    for (const source of voice.sources)
      try {
        source.stop();
      } catch {
        /* The source may not have started. */
      }
    // Disconnecting also breaks the echo's feedback loop.
    for (const node of voice.nodes) node.disconnect();
  }
  private stopVoices() {
    for (const voice of this.voices) this.release(voice);
  }
  arm() {
    try {
      if (!this.context || this.context.state === 'closed') {
        this.stopVoices();
        this.context = new AudioContext();
        this.noise = undefined;
      }
      if (this.context.state !== 'running') void this.context.resume().catch(() => {});
    } catch {
      // Unsupported audio or autoplay restrictions must not affect the conversation.
    }
  }
  play(force = false) {
    const context = this.context;
    if (!context || context.state !== 'running') return false;
    // A batch of completions should sound like one alert.
    if (!force && context.currentTime - this.lastPlayed < 0.8) return true;
    if (force) this.stopVoices();
    this.lastPlayed = context.currentTime;
    const voice: Voice = { sources: [], nodes: [] };
    this.voices.add(voice);
    const node = <T extends AudioNode>(created: T) => {
      voice.nodes.push(created);
      return created;
    };
    const source = <T extends AudioScheduledSourceNode>(created: T) => {
      voice.sources.push(created);
      return node(created);
    };
    try {
      const now = context.currentTime;
      const output = node(context.createGain());
      output.connect(context.destination);
      const echo = this.echo(context, output, node);
      this.noise ??= this.createNoise(context);
      for (const note of NOTES) {
        const start = now + note.offset;
        const panner = node(context.createStereoPanner());
        panner.pan.value = note.pan;
        panner.connect(echo);
        for (const [ratio, level, decay] of PARTIALS) {
          const oscillator = source(context.createOscillator());
          const gain = node(context.createGain());
          oscillator.type = 'sine';
          oscillator.frequency.value = note.frequency * ratio;
          envelope(gain.gain, start, PEAK * level, ATTACK, RING * decay);
          oscillator.connect(gain).connect(panner);
          oscillator.start(start);
          oscillator.stop(start + ATTACK + RING * decay + 0.05);
        }
        // The tine's click as it is struck.
        const click = source(context.createBufferSource());
        const gain = node(context.createGain());
        const band = node(context.createBiquadFilter());
        click.buffer = this.noise;
        envelope(gain.gain, start, PEAK * 0.2, 0.001, 0.012);
        band.type = 'bandpass';
        band.frequency.value = 2500;
        band.Q.value = 2;
        click.connect(gain).connect(band).connect(panner);
        click.start(start);
        click.stop(start + 0.02);
      }
      // A silent source whose end marks when the echo has died away.
      const timer = source(context.createConstantSource());
      timer.onended = () => this.release(voice);
      timer.start(now);
      timer.stop(now + TAIL);
      return true;
    } catch {
      this.release(voice);
      this.lastPlayed = -Infinity;
      return false;
    }
  }
  /** A stereo ping-pong delay that darkens on each repeat; returns its input. */
  private echo(context: AudioContext, output: AudioNode, node: <T extends AudioNode>(n: T) => T) {
    const input = node(context.createGain());
    const send = node(context.createGain());
    const damp = node(context.createBiquadFilter());
    const left = node(context.createDelay(1));
    const right = node(context.createDelay(1));
    const feedback = node(context.createGain());
    const merger = node(context.createChannelMerger(2));
    send.gain.value = ECHO.mix;
    damp.type = 'lowpass';
    damp.frequency.value = 2000;
    damp.Q.value = 0.5;
    left.delayTime.value = ECHO.delay;
    right.delayTime.value = ECHO.delay;
    feedback.gain.value = ECHO.feedback;
    input.connect(output);
    input.connect(send).connect(damp).connect(left).connect(right).connect(feedback).connect(damp);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(output);
    return input;
  }
  private createNoise(context: AudioContext) {
    const buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * 0.02),
      context.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
  async preview() {
    this.arm();
    const context = this.context;
    // resume() can remain pending when autoplay is blocked. Do not leave Test stuck waiting.
    if (context && context.state !== 'running') {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          context.resume().catch(() => {}),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 300);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    return context === this.context && this.play(true);
  }
  stop() {
    this.stopVoices();
    const context = this.context;
    this.context = undefined;
    this.noise = undefined;
    this.lastPlayed = -Infinity;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
}
