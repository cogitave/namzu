// Runs on the audio thread. Hands the microphone's samples to the window in blocks of about
// 20 ms; the window does the rest. Loaded as a module file, never from a string or a blob.
class NamzuVoiceCapture extends AudioWorkletProcessor {
	constructor() {
		super()
		this.block = new Float32Array(Math.max(128, Math.round(sampleRate / 50)))
		this.filled = 0
	}
	process(inputs) {
		const channel = inputs[0] && inputs[0][0]
		if (!channel) return true
		let at = 0
		while (at < channel.length) {
			const take = Math.min(this.block.length - this.filled, channel.length - at)
			this.block.set(channel.subarray(at, at + take), this.filled)
			this.filled += take
			at += take
			if (this.filled === this.block.length) {
				const out = this.block
				this.block = new Float32Array(out.length)
				this.filled = 0
				this.port.postMessage(out, [out.buffer])
			}
		}
		return true
	}
}
registerProcessor('namzu-voice-capture', NamzuVoiceCapture)
