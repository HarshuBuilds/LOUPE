/**
 * Procedural mechanical audio. No files, no network, no samples.
 * Everything is synthesised from oscillators and shaped noise bursts.
 */

type Ctx = AudioContext

class SoundEngine {
  private ctx: Ctx | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private enabled = true

  setEnabled(value: boolean) {
    this.enabled = value
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(value ? 0.32 : 0, this.ctx.currentTime, 0.01)
    }
  }

  isEnabled() {
    return this.enabled
  }

  /** Called from a user gesture so the context is allowed to start. */
  unlock() {
    if (!this.ctx) this.init()
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume()
  }

  private init() {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    this.ctx = new AC()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.enabled ? 0.32 : 0
    this.master.connect(this.ctx.destination)
    this.noise = this.makeNoise(0.4)
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    return buffer
  }

  private get now() {
    return this.ctx ? this.ctx.currentTime : 0
  }

  private noiseBurst(at: number, duration: number, freq: number, q: number, gain: number) {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    src.playbackRate.value = 1
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(freq, at)
    filter.Q.value = q
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, at)
    env.gain.exponentialRampToValueAtTime(gain, at + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    src.connect(filter).connect(env).connect(this.master!)
    src.start(at, Math.random() * 0.2, duration + 0.02)
    src.stop(at + duration + 0.03)
  }

  /** Mechanical switch: 900Hz → 200Hz triangle over 18ms plus a noise transient. */
  click() {
    if (!this.enabled) return
    if (!this.ctx) this.init()
    if (!this.ctx || !this.master) return
    const at = this.now
    const osc = this.ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(900, at)
    osc.frequency.exponentialRampToValueAtTime(200, at + 0.018)
    const env = this.ctx.createGain()
    env.gain.setValueAtTime(0.0001, at)
    env.gain.exponentialRampToValueAtTime(0.5, at + 0.001)
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.035)
    osc.connect(env).connect(this.master)
    osc.start(at)
    osc.stop(at + 0.05)
    this.noiseBurst(at, 0.03, 2400, 0.9, 0.12)
  }

  /** Aperture detent: a 1200Hz sine impulse of 6ms. */
  detent() {
    if (!this.enabled) return
    if (!this.ctx) this.init()
    if (!this.ctx || !this.master) return
    const at = this.now
    const osc = this.ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1200, at)
    const env = this.ctx.createGain()
    env.gain.setValueAtTime(0.0001, at)
    env.gain.exponentialRampToValueAtTime(0.22, at + 0.001)
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.006)
    osc.connect(env).connect(this.master)
    osc.start(at)
    osc.stop(at + 0.012)
    this.noiseBurst(at, 0.012, 3200, 1.2, 0.05)
  }

  /** Polaroid eject: dual shutter click 15ms apart, then a 140ms paper feed sweep. */
  shutter() {
    if (!this.enabled) return
    if (!this.ctx) this.init()
    if (!this.ctx || !this.master) return
    const at = this.now
    for (const [offset, gain] of [
      [0, 0.42],
      [0.015, 0.3],
    ] as const) {
      const osc = this.ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.setValueAtTime(1400, at + offset)
      osc.frequency.exponentialRampToValueAtTime(320, at + offset + 0.016)
      const env = this.ctx.createGain()
      env.gain.setValueAtTime(0.0001, at + offset)
      env.gain.exponentialRampToValueAtTime(gain, at + offset + 0.001)
      env.gain.exponentialRampToValueAtTime(0.0001, at + offset + 0.022)
      osc.connect(env).connect(this.master)
      osc.start(at + offset)
      osc.stop(at + offset + 0.03)
      this.noiseBurst(at + offset, 0.02, 2600, 1.4, 0.14)
    }

    // Paper feed: band-passed noise sweeping 800Hz → 2200Hz.
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.Q.value = 1.1
    filter.frequency.setValueAtTime(800, at + 0.045)
    filter.frequency.exponentialRampToValueAtTime(2200, at + 0.185)
    const env = this.ctx.createGain()
    env.gain.setValueAtTime(0.0001, at + 0.045)
    env.gain.exponentialRampToValueAtTime(0.16, at + 0.06)
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.185)
    src.connect(filter).connect(env).connect(this.master)
    src.start(at + 0.045, Math.random() * 0.1, 0.16)
    src.stop(at + 0.21)
  }
}

export const sound = new SoundEngine()
