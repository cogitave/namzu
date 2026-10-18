import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	UtteranceEndpointer,
	endpointDelayMs,
	endsWithConnective,
	foldSpoken,
	isInventedTranscript,
	isStopCommand,
} from './voice-endpointing.js'

describe('invented transcripts', () => {
	it.each([
		'Altyazı M.K.',
		'ALTYAZI M.K',
		'Abone olmayı unutmayın.',
		'İzlediğiniz için teşekkürler!',
		'Bu videoyu izlediğiniz için teşekkür ederim.',
	])('%s is dropped', (text) => expect(isInventedTranscript(text)).toBe(true))
	it.each(['Teşekkürler, şimdi testleri çalıştır.', 'Masaüstündeki rapor dosyasını aç', '', '...'])(
		'%s is kept',
		(text) => expect(isInventedTranscript(text)).toBe(false),
	)
})

describe('stop words', () => {
	it.each([
		'dur',
		'Dur.',
		'DURDUR!',
		'İptal',
		'IPTAL',
		'iptal.',
		'Vazgeç',
		'vazgec',
		'stop',
		'Stop!',
	])('%s is a stop command', (text) => expect(isStopCommand(text)).toBe(true))
	it('accepts a repeated stop word and nothing else mixed in', () => {
		expect(isStopCommand('Dur, dur!')).toBe(true)
		expect(isStopCommand('dur biraz bekle')).toBe(false)
		expect(isStopCommand('lütfen dur')).toBe(false)
		expect(isStopCommand('iptal et')).toBe(false)
		expect(isStopCommand('')).toBe(false)
		expect(isStopCommand('...')).toBe(false)
	})
	it('lowercases Turkish letters by Turkish rules', () => {
		expect(foldSpoken('IŞIK Çok')).toBe('isik cok')
		expect(foldSpoken('İPTAL')).toBe('iptal')
	})
})

describe('connectives', () => {
	it.each([
		'bunu yap ve',
		'Bunu yap, ama',
		'önce şunu sonra',
		'bunu bununla ya da',
		'çünkü',
		'ben de',
		'tamam ki',
	])('%s ends on a connective', (text) => expect(endsWithConnective(text)).toBe(true))
	it('does not treat the end of a longer word as a connective', () => {
		expect(endsWithConnective('dosyayı bul')).toBe(false)
		expect(endsWithConnective('bunu kapat')).toBe(false)
		expect(endsWithConnective('')).toBe(false)
	})
	it('waits 800 ms normally and 1600 ms after a connective, both adjustable', () => {
		expect(endpointDelayMs('bunu yap')).toBe(800)
		expect(endpointDelayMs('bunu yap ve')).toBe(1600)
		expect(endpointDelayMs('x', { endpointMs: 10 })).toBe(10)
		expect(endpointDelayMs('x ve', { connectiveEndpointMs: 20 })).toBe(20)
	})
})

describe('endpointing', () => {
	const utterances: string[] = []
	let endpointer: UtteranceEndpointer
	beforeEach(() => {
		vi.useFakeTimers()
		utterances.length = 0
		endpointer = new UtteranceEndpointer({ onUtterance: (text) => utterances.push(text) })
	})
	afterEach(() => {
		endpointer.dispose()
		vi.useRealTimers()
	})
	/** One spoken segment: start, end, and its transcript. */
	function segment(text: string, startMs: number, endMs: number) {
		endpointer.speechStart()
		endpointer.speechEnd(startMs, endMs)
		endpointer.transcript(text, (startMs + endMs) / 2)
	}

	it('completes 800 ms after the last segment ends', async () => {
		segment('Merhaba nasılsın', 0, 1000)
		await vi.advanceTimersByTimeAsync(799)
		expect(utterances).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(utterances).toEqual(['Merhaba nasılsın'])
	})

	it('a new speech start inside the delay joins both segments into one message', async () => {
		segment('Bir dosya aç', 0, 1000)
		await vi.advanceTimersByTimeAsync(500)
		segment('ve içindekini oku', 1500, 2500)
		await vi.advanceTimersByTimeAsync(799)
		expect(utterances).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(utterances).toEqual(['Bir dosya aç ve içindekini oku'])
	})

	it('does not complete while the person is still speaking', async () => {
		segment('Bir dosya aç', 0, 1000)
		endpointer.speechStart()
		await vi.advanceTimersByTimeAsync(5000)
		expect(utterances).toEqual([])
		endpointer.speechEnd(1200, 2000)
		endpointer.transcript('oku', 1600)
		await vi.advanceTimersByTimeAsync(800)
		expect(utterances).toEqual(['Bir dosya aç oku'])
	})

	it('waits 1600 ms when the text so far ends with a connective', async () => {
		segment('Önce testleri çalıştır ve', 0, 1500)
		await vi.advanceTimersByTimeAsync(1599)
		expect(utterances).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(utterances).toEqual(['Önce testleri çalıştır ve'])
	})

	it('a continuation inside the extended wait is still joined', async () => {
		segment('Önce testleri çalıştır ve', 0, 1500)
		await vi.advanceTimersByTimeAsync(1200)
		segment('sonra özetle', 2700, 3500)
		await vi.advanceTimersByTimeAsync(800)
		expect(utterances).toEqual(['Önce testleri çalıştır ve sonra özetle'])
	})

	it('the delays are options', async () => {
		endpointer.dispose()
		endpointer = new UtteranceEndpointer({
			endpointMs: 50,
			connectiveEndpointMs: 120,
			onUtterance: (text) => utterances.push(text),
		})
		segment('tamam', 0, 500)
		await vi.advanceTimersByTimeAsync(50)
		expect(utterances).toEqual(['tamam'])
		segment('bunu yap ve', 1000, 1500)
		await vi.advanceTimersByTimeAsync(119)
		expect(utterances).toEqual(['tamam'])
		await vi.advanceTimersByTimeAsync(1)
		expect(utterances).toEqual(['tamam', 'bunu yap ve'])
	})

	it('waits for a transcript that has not arrived yet', async () => {
		endpointer.speechStart()
		endpointer.speechEnd(0, 1000)
		endpointer.recognition(true)
		await vi.advanceTimersByTimeAsync(5000)
		expect(utterances).toEqual([])
		expect(endpointer.busy).toBe(true)
		endpointer.recognition(false)
		endpointer.transcript('geç gelen cevap', 500)
		// The delay has long passed, so the message is complete as soon as nothing is outstanding.
		expect(utterances).toEqual(['geç gelen cevap'])
		expect(endpointer.busy).toBe(false)
	})

	it('gives up on a segment the recognizer never answers, after the grace period', async () => {
		endpointer.speechStart()
		endpointer.speechEnd(0, 300)
		endpointer.transcript('', 150)
		endpointer.speechStart()
		endpointer.speechEnd(2000, 2400)
		await vi.advanceTimersByTimeAsync(999)
		expect(endpointer.busy).toBe(true)
		await vi.advanceTimersByTimeAsync(1)
		expect(endpointer.busy).toBe(false)
		expect(utterances).toEqual([])
	})

	it('a queued second recognition keeps the first message from completing early', async () => {
		segment('birinci', 0, 1000)
		endpointer.recognition(true)
		endpointer.speechStart()
		endpointer.speechEnd(1300, 2300)
		await vi.advanceTimersByTimeAsync(3000)
		expect(utterances).toEqual([])
		// The first recognition ends; the second has not begun yet, but its segment is still expected.
		endpointer.recognition(false)
		await vi.advanceTimersByTimeAsync(400)
		expect(utterances).toEqual([])
		endpointer.recognition(true)
		endpointer.recognition(false)
		endpointer.transcript('ikinci', 1800)
		await vi.advanceTimersByTimeAsync(0)
		expect(utterances).toEqual(['birinci ikinci'])
	})

	it('commits at once past the length of one message', () => {
		const long = 'a'.repeat(8_100)
		segment(long, 0, 1000)
		expect(utterances).toEqual([long])
	})

	it('reports nothing after it is disposed', async () => {
		segment('merhaba', 0, 500)
		endpointer.dispose()
		await vi.advanceTimersByTimeAsync(5000)
		expect(utterances).toEqual([])
	})
})
