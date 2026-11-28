import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
	desktopCapturer: {},
	nativeImage: {},
	screen: {},
}))
vi.mock('@namzu/computer-use', () => ({ NativeWatch: class {} }))

const { helperPath, isWsl } = await import('./sources.js')

describe('finding the native helper', () => {
	it('uses the path in NAMZU_NATIVE_HELPER when the file is there, before the old variable', () => {
		expect(
			helperPath(
				{
					NAMZU_NATIVE_HELPER: 'C:\\tools\\namzu-native.exe',
					NAMZU_WIN_HELPER: 'C:\\old\\namzu-win.exe',
				},
				undefined,
				() => true,
			),
		).toBe('C:\\tools\\namzu-native.exe')
	})

	it('still reads the deprecated NAMZU_WIN_HELPER when the new variable is absent', () => {
		expect(
			helperPath({ NAMZU_WIN_HELPER: 'C:\\tools\\namzu-win.exe' }, undefined, () => true),
		).toBe('C:\\tools\\namzu-win.exe')
	})

	it('falls back to the one beside the app’s resources', () => {
		const seen: string[] = []
		const found = helperPath({}, '/opt/namzu/resources', (path) => {
			seen.push(path)
			return path.endsWith('namzu-native.exe')
		})
		expect(found?.endsWith('namzu-native.exe')).toBe(true)
		expect(seen).toHaveLength(1)
	})

	it('says there is none when neither exists', () => {
		expect(helperPath({ NAMZU_WIN_HELPER: '/missing' }, '/opt/res', () => false)).toBeUndefined()
		expect(helperPath({}, undefined, () => true)).toBeUndefined()
	})

	it('ignores a blank variable', () => {
		expect(helperPath({ NAMZU_WIN_HELPER: '   ' }, undefined, () => true)).toBeUndefined()
	})
})

describe('WSL', () => {
	it('is never true off Linux', () => {
		expect(isWsl('win32')).toBe(false)
		expect(isWsl('darwin')).toBe(false)
	})
})
