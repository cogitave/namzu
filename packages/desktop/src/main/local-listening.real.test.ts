import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LISTENING_ASSETS } from './local-listening-assets.js'
import { WorkerListeningEngine } from './local-listening-engine.js'
import type { ListeningFrame } from './local-listening-stream.js'
import {
	LocalListeningService,
	LocalSpeechRecognizer,
	LocalVoiceActivityDetector,
} from './local-listening.js'

/**
 * Opt-in: loads the real models through the real worker threads.
 *   NAMZU_LOCAL_LISTENING_MODELS  a folder holding the four pinned model files
 *   NAMZU_LOCAL_LISTENING_WAVS    a folder holding cmd02.wav and cmd06.wav (16 kHz mono PCM)
 */
const models = process.env.NAMZU_LOCAL_LISTENING_MODELS
const wavs = process.env.NAMZU_LOCAL_LISTENING_WAVS
const run = models && wavs ? it : it.skip

const REFERENCES: Record<string, string> = {
	cmd02: 'Bugünkü toplantılarımı listele',
	cmd06: 'Yeni bir pull request oluştur ve açıklamasını yaz',
}

function normalize(text: string): string {
	return text
		.replaceAll('İ', 'i')
		.replaceAll('I', 'ı')
		.toLocaleLowerCase('tr')
		.replace(/[^\p{L}\p{N} ]/gu, '')
		.replace(/\s+/g, ' ')
		.trim()
}
function characterErrorRate(reference: string, hypothesis: string): number {
	const a = normalize(reference)
	const b = normalize(hypothesis)
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
	for (let i = 1; i <= a.length; i++) {
		const row = [i]
		for (let j = 1; j <= b.length; j++)
			row[j] = Math.min(
				(previous[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			)
		previous = row
	}
	return (previous[b.length] as number) / Math.max(1, a.length)
}
async function readWav(path: string): Promise<Int16Array> {
	const bytes = await readFile(path)
	let at = 12
	while (at + 8 <= bytes.length) {
		const id = bytes.toString('ascii', at, at + 4)
		const size = bytes.readUInt32LE(at + 4)
		if (id === 'data') {
			const body = bytes.subarray(at + 8, at + 8 + size)
			return new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength))
		}
		at += 8 + size + (size % 2)
	}
	throw new Error('No audio in the file.')
}
function framesOf(speech: Int16Array): ListeningFrame[] {
	const lead = 8_000
	const tail = 16_000
	const all = new Int16Array(lead + speech.length + tail)
	all.set(speech, lead)
	const frames: ListeningFrame[] = []
	for (let at = 0; at < all.length; at += 1_600) {
		const piece = all.subarray(at, Math.min(all.length, at + 1_600))
		frames.push({
			channels: 1,
			data: new Uint8Array(
				piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength),
			),
			format: 'pcm_s16le',
			sampleRateHz: 16_000,
			samplesPerChannel: piece.length,
			...(at === 0 ? { timestampMs: 0 } : {}),
		})
	}
	return frames
}
async function* source(frames: ListeningFrame[]): AsyncGenerator<ListeningFrame> {
	for (const frame of frames) yield frame
}

// Loading a 1 GB model and decoding on CPU is real subprocess-grade work, so the default 5 s test
// timeout does not apply; a hang is still caught by this bound rather than by racing a clock.
run(
	'transcribes real Turkish commands through the real worker threads',
	{ timeout: 180_000 },
	async () => {
		const dir = models as string
		const paths = {
			encoder: join(dir, LISTENING_ASSETS[0]?.name as string),
			decoder: join(dir, LISTENING_ASSETS[1]?.name as string),
			tokens: join(dir, LISTENING_ASSETS[2]?.name as string),
			voiceActivity: join(dir, LISTENING_ASSETS[3]?.name as string),
		}
		const service = new LocalListeningService({
			directory: dir,
			readInstallation: async () => ({
				v: 1,
				modelRevision: 'test',
				files: [],
				diskBytes: 0,
				installedAt: new Date().toISOString(),
			}),
			createEngine: () =>
				new WorkerListeningEngine({
					paths,
					workerUrl: new URL('./local-listening-worker.mts', import.meta.url),
				}),
		})
		try {
			for (const name of ['cmd02', 'cmd06']) {
				const frames = framesOf(await readWav(join(wavs as string, `${name}.wav`)))
				const controller = new AbortController()
				const started = performance.now()
				const detected: { type: string; timestampMs: number }[] = []
				for await (const event of new LocalVoiceActivityDetector(service).detect(source(frames), {
					signal: controller.signal,
				}))
					detected.push(event)
				const vadMs = performance.now() - started
				const decodeStarted = performance.now()
				const finals: { text: string; timestampMs: number }[] = []
				for await (const event of new LocalSpeechRecognizer(service).transcribe(source(frames), {
					signal: controller.signal,
				}))
					finals.push(event)
				const total = performance.now() - decodeStarted
				console.log(
					`${name}: ${JSON.stringify(finals.map((f) => f.text))} vad=${JSON.stringify(detected)} vadPassMs=${Math.round(vadMs)} recognizePassMs=${Math.round(total)}`,
				)
				expect(detected.map((event) => event.type)).toEqual(['speech_start', 'speech_end'])
				expect(finals).toHaveLength(1)
				const final = finals[0] as { text: string; timestampMs: number }
				expect(final.timestampMs).toBeGreaterThanOrEqual(detected[0]?.timestampMs as number)
				expect(final.timestampMs).toBeLessThanOrEqual(detected[1]?.timestampMs as number)
				expect(characterErrorRate(REFERENCES[name] as string, final.text)).toBeLessThan(0.25)
			}
		} finally {
			await service.dispose()
		}
	},
)
