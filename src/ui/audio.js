// Soft chimes that cut through a show's audio without being annoying.

const PATTERNS = {
  stepSoon: [[660, 0], [660, 0.2]],
  stepChange: [[880, 0]],
  done: [[523, 0], [659, 0.14], [784, 0.28], [1046, 0.42]],
};

export class Chimes {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  /** Must be called from a click or key press, before the first sound. */
  unlock() {
    try {
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  play(name) {
    if (this.muted || !this.ctx || !PATTERNS[name]) return;
    const now = this.ctx.currentTime;
    for (const [freq, at] of PATTERNS[name]) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + at);
      gain.gain.linearRampToValueAtTime(0.14, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.35);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.4);
    }
  }
}

/** Spoken cues, using the browser's built-in voices. Off unless switched on. */
export class Voice {
  static supported() {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  constructor() {
    this.enabled = false;
  }

  say(text) {
    if (!this.enabled || !Voice.supported()) return;
    speechSynthesis.cancel(); // a new step replaces anything still being said
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  stop() {
    if (Voice.supported()) speechSynthesis.cancel();
  }
}
