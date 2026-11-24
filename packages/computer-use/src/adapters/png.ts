/** The pixel size in a PNG's header, or undefined when the bytes are not one. */
export function decodePngSize(data: Buffer): { width: number; height: number } | undefined {
	if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return undefined
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
}
