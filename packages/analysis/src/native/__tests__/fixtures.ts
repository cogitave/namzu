/**
 * Builders for the synthetic binaries the integration tests analyse. They
 * write the smallest valid shapes by hand, so a test never depends on a
 * toolchain and a hostile variant is one byte-patch away.
 */

import { createHash } from 'node:crypto'

const u32 = (n: number): Buffer => {
	const b = Buffer.alloc(4)
	b.writeUInt32LE(n >>> 0)
	return b
}
const u64 = (n: number | bigint): Buffer => {
	const b = Buffer.alloc(8)
	b.writeBigUInt64LE(BigInt(n))
	return b
}

export const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n')

export interface BunModule {
	name: string
	contents: string | Buffer
	/** Bun loader number: 1 is js, 6 json, 9 napi. */
	loader?: number
}

/** A `.bun` section body in the 52-byte-record layout. */
export function bunPayload(modules: BunModule[]): Buffer {
	const parts: Buffer[] = []
	let length = 0
	const put = (data: Buffer): [number, number] => {
		const at = length
		parts.push(data)
		length += data.length
		return [at, data.length]
	}
	const records: Buffer[] = []
	for (const m of modules) {
		const name = put(Buffer.from(m.name, 'utf8'))
		const contents = put(Buffer.isBuffer(m.contents) ? m.contents : Buffer.from(m.contents))
		const empty: [number, number] = [length, 0]
		const rec = Buffer.alloc(52)
		let o = 0
		for (const [off, len] of [name, contents, empty, empty, empty, empty]) {
			rec.writeUInt32LE(off, o)
			rec.writeUInt32LE(len, o + 4)
			o += 8
		}
		rec[49] = m.loader ?? 1
		records.push(rec)
	}
	const table = put(Buffer.concat(records))
	const offsets = Buffer.alloc(32)
	offsets.writeBigUInt64LE(BigInt(length), 0)
	offsets.writeUInt32LE(table[0], 8)
	offsets.writeUInt32LE(table[1], 12)
	const body = Buffer.concat([...parts, offsets, BUN_TRAILER])
	return Buffer.concat([u64(body.length), body])
}

/** A Node 24 SEA blob. */
export function seaBlob(path: string, code: string, assets: Record<string, string> = {}): Buffer {
	const flags = Object.keys(assets).length > 0 ? 8 : 0
	const str = (s: Buffer) => Buffer.concat([u64(s.length), s])
	const parts = [
		u32(0x0143da20),
		u32(flags),
		Buffer.from([1]),
		str(Buffer.from(path)),
		str(Buffer.from(code)),
	]
	if (flags) {
		parts.push(u64(Object.keys(assets).length))
		for (const [k, v] of Object.entries(assets))
			parts.push(str(Buffer.from(k)), str(Buffer.from(v)))
	}
	return Buffer.concat(parts)
}

/** One ELF note record: name `\0`-terminated and padded, then the descriptor. */
export function noteRecord(name: string, desc: Buffer): Buffer {
	const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
	const nm = Buffer.concat([Buffer.from(name), Buffer.from([0])])
	return Buffer.concat([u32(nm.length), u32(desc.length), u32(0), pad(nm), pad(desc)])
}

export interface ElfSection {
	name: string
	/** 1 PROGBITS, 7 NOTE. */
	type?: number
	data: Buffer
	flags?: number
}

/** A little-endian ELF64 relocatable file with the given sections and a few symbols. */
export function elf(sections: ElfSection[]): Buffer {
	// Section name string table.
	const names: Buffer[] = [Buffer.from([0])]
	const nameOffset = new Map<string, number>()
	let nameLen = 1
	const addName = (n: string): number => {
		const at = nameOffset.get(n)
		if (at !== undefined) return at
		nameOffset.set(n, nameLen)
		const b = Buffer.from(`${n}\0`)
		names.push(b)
		const off = nameLen
		nameLen += b.length
		return off
	}
	const all: ElfSection[] = [...sections]
	// Symbol string table and symbol table.
	const strtab: Buffer[] = [Buffer.from([0])]
	let strLen = 1
	const sym = (name: string): number => {
		const off = strLen
		const b = Buffer.from(`${name}\0`)
		strtab.push(b)
		strLen += b.length
		return off
	}
	const symbols = ['main', '_ZN3foo3barEi', 'puts']
	const symEntries: Buffer[] = [Buffer.alloc(24)]
	for (const s of symbols) {
		const e = Buffer.alloc(24)
		e.writeUInt32LE(sym(s), 0)
		e[4] = 0x12 // global function
		e.writeUInt16LE(s === 'puts' ? 0 : 1, 6)
		e.writeBigUInt64LE(0n, 8)
		symEntries.push(e)
	}
	all.push({ name: '.strtab', type: 3, data: Buffer.concat(strtab) })
	all.push({ name: '.symtab', type: 2, data: Buffer.concat(symEntries) })
	all.push({ name: '.shstrtab', type: 3, data: Buffer.alloc(0) })
	const shstrIndex = all.length // index including the null section at 0
	for (const s of all) addName(s.name)
	all[all.length - 1] = { name: '.shstrtab', type: 3, data: Buffer.concat(names) }

	const header = Buffer.alloc(64)
	header.write('\x7fELF', 0, 'latin1')
	header[4] = 2
	header[5] = 1
	header[6] = 1
	header.writeUInt16LE(1, 16) // ET_REL
	header.writeUInt16LE(62, 18) // x86-64
	header.writeUInt32LE(1, 20)
	header.writeUInt16LE(64, 52)
	header.writeUInt16LE(64, 58)
	header.writeUInt16LE(all.length + 1, 60)
	header.writeUInt16LE(shstrIndex, 62)

	const chunks: Buffer[] = [header]
	let offset = 64
	const place: Array<{ off: number; size: number }> = []
	for (const s of all) {
		const pad = (8 - (offset % 8)) % 8
		if (pad) chunks.push(Buffer.alloc(pad))
		offset += pad
		place.push({ off: offset, size: s.data.length })
		chunks.push(s.data)
		offset += s.data.length
	}
	const pad = (8 - (offset % 8)) % 8
	if (pad) chunks.push(Buffer.alloc(pad))
	offset += pad
	header.writeBigUInt64LE(BigInt(offset), 40) // e_shoff
	chunks.push(Buffer.alloc(64)) // null section
	const symtabIndex = all.findIndex((s) => s.name === '.symtab') + 1
	const strtabIndex = all.findIndex((s) => s.name === '.strtab') + 1
	all.forEach((s, i) => {
		const sh = Buffer.alloc(64)
		sh.writeUInt32LE(nameOffset.get(s.name) ?? 0, 0)
		sh.writeUInt32LE(s.type ?? 1, 4)
		sh.writeBigUInt64LE(BigInt(s.flags ?? (s.type === 7 ? 2 : 0)), 8)
		sh.writeBigUInt64LE(BigInt(place[i]?.off ?? 0), 24)
		sh.writeBigUInt64LE(BigInt(place[i]?.size ?? 0), 32)
		if (i + 1 === symtabIndex) {
			sh.writeUInt32LE(strtabIndex, 40)
			sh.writeUInt32LE(1, 44)
			sh.writeBigUInt64LE(24n, 56)
		}
		sh.writeBigUInt64LE(1n, 48)
		chunks.push(sh)
	})
	return Buffer.concat(chunks)
}

export function sha256(data: Buffer | Uint8Array): string {
	return createHash('sha256').update(data).digest('hex')
}
