import { describe, expect, it } from 'vitest'
import { loadImageFiles, parsePastedImagePaths } from './image-paths.js'

const linux = { wsl: false, mountRoot: '/mnt/' }
const wsl = { wsl: true, distro: 'Ubuntu', mountRoot: '/mnt/' }

describe('parsing a paste that names image files', () => {
	it('takes plain, quoted and escaped paths', () => {
		expect(parsePastedImagePaths('/home/a/x.png', linux)).toEqual(['/home/a/x.png'])
		expect(parsePastedImagePaths("'/home/a/my shot.PNG'", linux)).toEqual(['/home/a/my shot.PNG'])
		expect(parsePastedImagePaths('/home/a/my\\ shot.jpg', linux)).toEqual(['/home/a/my shot.jpg'])
	})

	it('splits several paths on newlines and on path starts', () => {
		expect(parsePastedImagePaths('/a/1.png\n/a/2.webp', linux)).toEqual(['/a/1.png', '/a/2.webp'])
		expect(parsePastedImagePaths("'/a/1.png' '/a/2.gif'", linux)).toEqual(['/a/1.png', '/a/2.gif'])
	})

	it('converts Windows forms on WSL and refuses them elsewhere', () => {
		expect(parsePastedImagePaths('"C:\\Users\\a\\shot.png"', wsl)).toEqual([
			'/mnt/c/Users/a/shot.png',
		])
		expect(parsePastedImagePaths('C:\\a\\1.png D:\\b\\2.jpg', wsl)).toEqual([
			'/mnt/c/a/1.png',
			'/mnt/d/b/2.jpg',
		])
		expect(parsePastedImagePaths('\\\\wsl$\\Ubuntu\\home\\a\\x.png', wsl)).toEqual([
			'/home/a/x.png',
		])
		expect(parsePastedImagePaths('\\\\wsl.localhost\\Ubuntu\\tmp\\x.png', wsl)).toEqual([
			'/tmp/x.png',
		])
		expect(parsePastedImagePaths('C:\\a\\1.png', linux)).toBeNull()
	})

	it('leaves a path in another distribution, a non-image and ordinary text alone', () => {
		expect(parsePastedImagePaths('\\\\wsl$\\Debian\\tmp\\x.png', wsl)).toBeNull()
		expect(parsePastedImagePaths('\\\\server\\share\\x.png', wsl)).toBeNull()
		expect(parsePastedImagePaths('/a/notes.txt', linux)).toBeNull()
		expect(parsePastedImagePaths('see /a/1.png please', linux)).toBeNull()
		expect(parsePastedImagePaths('relative/1.png', linux)).toBeNull()
		expect(parsePastedImagePaths('/a/1.png\n/a/notes.txt', linux)).toBeNull()
	})

	it('refuses more pieces than a person drops', () => {
		const many = Array.from({ length: 17 }, (_, i) => `/a/${i}.png`).join('\n')
		expect(parsePastedImagePaths(many, linux)).toBeNull()
	})
})

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(8),
])

describe('reading the named files', () => {
	const files = new Map<string, Buffer>([
		['/a/ok.png', PNG],
		['/a/fake.png', Buffer.from('this is not an image at all')],
		['/a/empty.png', Buffer.alloc(0)],
	])
	const deps = {
		stat: async (path: string) => {
			const bytes = files.get(path)
			if (!bytes) throw new Error('ENOENT')
			return { size: bytes.length, isFile: () => true }
		},
		readFile: async (path: string) => files.get(path) ?? Buffer.alloc(0),
	}

	it('returns each image with its media type and file name', async () => {
		const images = await loadImageFiles(['/a/ok.png'], deps)
		expect(images).toEqual([
			{ data: PNG.toString('base64'), mediaType: 'image/png', filename: 'ok.png' },
		])
	})

	it('gives nothing when any file is missing, empty or not an image by its bytes', async () => {
		expect(await loadImageFiles(['/a/ok.png', '/a/missing.png'], deps)).toBeNull()
		expect(await loadImageFiles(['/a/fake.png'], deps)).toBeNull()
		expect(await loadImageFiles(['/a/empty.png'], deps)).toBeNull()
	})

	it('honours a refusal to read', async () => {
		expect(await loadImageFiles(['/a/ok.png'], { ...deps, mayRead: () => false })).toBeNull()
	})
})
