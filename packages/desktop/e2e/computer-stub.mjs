// A stand-in for the two programs the engine drives an X11 screen with, so a flow can run the real
// `computer_use` tool on a machine with no real desktop to control. `maim` prints a fixed picture and
// `xdotool` answers the questions the engine asks and does nothing else. Nothing reaches a display.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
const crc = (buffer) => {
	let c = 0xffffffff;
	for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const body = Buffer.concat([Buffer.from(type), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(crc(body), body.length + 4);
	return out;
};

/** A plain RGB picture: a blue field with a lighter window-shaped block. */
export function screenPng(width = 320, height = 200) {
	const rows = [];
	for (let y = 0; y < height; y++) {
		const row = Buffer.alloc(1 + width * 3);
		for (let x = 0; x < width; x++) {
			const inside = x > 40 && x < width - 40 && y > 30 && y < height - 30;
			row[1 + x * 3] = inside ? 235 : 20;
			row[2 + x * 3] = inside ? 235 : 70;
			row[3 + x * 3] = inside ? 240 : 150;
		}
		rows.push(row);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(rows))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A folder to put first on PATH: `maim` and `xdotool` that touch nothing. */
export function computerStub() {
	const dir = mkdtempSync(join(tmpdir(), "namzu-e2e-computer-"));
	const picture = join(dir, "screen.png");
	writeFileSync(picture, screenPng());
	writeFileSync(join(dir, "maim"), `#!/bin/sh\ncat '${picture}'\n`);
	writeFileSync(
		join(dir, "xdotool"),
		`#!/bin/sh
case "$1" in
	getdisplaygeometry) echo "320 200" ;;
	getmouselocation) printf 'X=1\\nY=1\\nSCREEN=0\\nWINDOW=0\\n' ;;
esac
exit 0
`,
	);
	chmodSync(join(dir, "maim"), 0o755);
	chmodSync(join(dir, "xdotool"), 0o755);
	return dir;
}
