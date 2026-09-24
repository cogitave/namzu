import { createRequire, syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

/**
 * Vitest setup file: no test reaches the real desktop.
 *
 * The packages that drive a desktop — `@namzu/computer-use`, the CLI that
 * mounts it and opens pages in the browser, `@namzu/browser` — do it by
 * starting programs: `cua-driver.exe`, `powershell.exe` (the computer-use
 * fallback, the WSL browser opener, Windows toasts), `xdg-open`, `open`,
 * `osascript`, `cliclick`, `xdotool`. Under WSL every one of them acts on
 * the Windows desktop of the person running the tests. Measured before this
 * file existed, on WSL: a CLI test that opened a session started
 * `powershell.exe` to read the display for computer use, and another opened
 * a sign-in page in the real browser through `Start-Process`.
 *
 * So in every test worker of those packages, starting one of these programs
 * through `node:child_process` starts a path that does not exist instead:
 * the caller sees exactly what it sees when the program is missing (ENOENT,
 * as an `error` event, a thrown error or `result.error`), and nothing runs.
 * A test that needs one of these programs injects its own spawner, as the
 * adapter tests do. Every refused launch is kept in
 * `globalThis.__namzuRefusedDesktopLaunches` so a test can prove the refusal.
 *
 * `NAMZU_CUA_DRIVER=off` keeps the Windows backend from downloading
 * cua-driver in the first place.
 */

const DESKTOP_PROGRAMS = new Set([
	// Windows, reached natively or through WSL interop.
	"powershell",
	"pwsh",
	"cua-driver",
	"cua-driver-uia",
	"explorer",
	"rundll32",
	"mshta",
	"wscript",
	"cscript",
	// Opening a URL or a file on a Linux or macOS desktop.
	"xdg-open",
	"wslview",
	"open",
	"osascript",
	// Pointer, keyboard and screen tools the adapters drive.
	"cliclick",
	"screencapture",
	"xdotool",
	"ydotool",
	"wtype",
	"maim",
	"grim",
	"scrot",
]);

const REFUSED_PATH = "/nonexistent/namzu-test-desktop-guard";

/** `C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` → `powershell`. */
function programName(command) {
	const base = String(command).trim().split(/[\\/]/).pop() ?? "";
	return base.toLowerCase().replace(/\.(exe|com|bat|cmd)$/, "");
}

function isDesktopProgram(command) {
	return typeof command === "string" && DESKTOP_PROGRAMS.has(programName(command));
}

/** The first word of a shell command line, unquoted. */
function firstWord(line) {
	const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(String(line));
	return match ? (match[1] ?? match[2] ?? match[3]) : "";
}

const refused = [];
globalThis.__namzuRefusedDesktopLaunches = refused;

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");

function guard(name, commandOf) {
	const original = childProcess[name];
	if (typeof original !== "function") return;
	const wrapped = function (command, ...rest) {
		const program = commandOf(command, rest);
		if (isDesktopProgram(program)) {
			refused.push({ api: name, program: programName(program), command: String(command) });
			// The program is replaced by one that does not exist; for a shell
			// line, the whole line is, so nothing of it runs.
			return original.call(this, `${REFUSED_PATH}/${programName(program)}`, ...rest);
		}
		return original.call(this, command, ...rest);
	};
	const descriptors = Object.getOwnPropertyDescriptors(original);
	delete descriptors[promisify.custom];
	Object.defineProperties(wrapped, descriptors);
	// `promisify(execFile)` and `promisify(exec)` resolve through this symbol,
	// whose original closes over the unguarded function; it is rebuilt over
	// the guarded one, with the same { stdout, stderr } shape.
	if (original[promisify.custom]) {
		Object.defineProperty(wrapped, promisify.custom, {
			configurable: true,
			value: (...args) =>
				new Promise((resolve, reject) => {
					wrapped(...args, (error, stdout, stderr) => {
						if (error) reject(Object.assign(error, { stdout, stderr }));
						else resolve({ stdout, stderr });
					});
				}),
		});
	}
	childProcess[name] = wrapped;
}

// Programs named directly.
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
	guard(name, (command, rest) => {
		const options = rest.find((value) => value && typeof value === "object" && !Array.isArray(value));
		// With `shell: true` the command is a line; its first word is the program.
		return options?.shell ? firstWord(command) : command;
	});
}
// Shell command lines.
for (const name of ["exec", "execSync"]) guard(name, (command) => firstWord(command));

syncBuiltinESMExports();

if (process.env.NAMZU_CUA_DRIVER === undefined) process.env.NAMZU_CUA_DRIVER = "off";
