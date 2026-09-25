/** A short, quiet two-note cue. Audio is unlocked by interaction, never queued for later. */
export class CompletionSound {
  private context: AudioContext | undefined;
  private lastPlayed = -Infinity;
  private voices = new Map<OscillatorNode, () => void>();
  private stopVoices() {
    for (const [oscillator, dispose] of this.voices) {
      try {
        oscillator.stop();
      } catch {
        /* The oscillator may not have started. */
      }
      dispose();
    }
  }
  arm() {
    try {
      if (!this.context || this.context.state === 'closed') {
        this.stopVoices();
        this.context = new AudioContext();
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
    try {
      for (const [offset, frequency] of [
        [0, 659.25],
        [0.12, 880],
      ] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + offset;
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.4, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
        oscillator.connect(gain);
        gain.connect(context.destination);
        const dispose = () => {
          if (!this.voices.delete(oscillator)) return;
          oscillator.disconnect();
          gain.disconnect();
        };
        this.voices.set(oscillator, dispose);
        oscillator.onended = dispose;
        oscillator.start(start);
        oscillator.stop(start + 0.24);
      }
      return true;
    } catch {
      this.stopVoices();
      this.lastPlayed = -Infinity;
      return false;
    }
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
    this.lastPlayed = -Infinity;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
  }
}
