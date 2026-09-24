import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	DisplayInfo,
	MouseButton,
	Point,
	ScrollDirection,
} from '@namzu/sdk'
import { hasExecutable, runCommandOrThrow } from '../util/spawn.js'
import { type Adapter, AdapterUnavailableError } from './types.js'
import { type WslProbes, isWsl, realWslProbes, wslChildEnv, wslPowerShellPath } from './wsl.js'

/**
 * The Windows fallback: one `powershell.exe` per action, as this package has
 * always done. It is used when cua-driver cannot be (see `./win32.ts`), so it
 * keeps the host contract — physical pixels, the captured display described
 * — and nothing more: no window list, and a new process (about 0.3–0.8 s)
 * for every action.
 */

// ---------------------------------------------------------------------------
// Key translation: our input ("ctrl+c") → PowerShell SendKeys format ("^c").
// ---------------------------------------------------------------------------

const SENDKEYS_MODIFIER: Readonly<Record<string, string>> = {
	cmd: '^',
	command: '^',
	ctrl: '^',
	control: '^',
	meta: '^',
	super: '^',
	win: '^',
	alt: '%',
	option: '%',
	opt: '%',
	shift: '+',
}

const SENDKEYS_SPECIAL: Readonly<Record<string, string>> = {
	enter: '{ENTER}',
	return: '{ENTER}',
	escape: '{ESC}',
	esc: '{ESC}',
	tab: '{TAB}',
	backspace: '{BACKSPACE}',
	delete: '{DELETE}',
	forward_delete: '{DELETE}',
	space: ' ',
	up: '{UP}',
	down: '{DOWN}',
	left: '{LEFT}',
	right: '{RIGHT}',
	home: '{HOME}',
	end: '{END}',
	page_up: '{PGUP}',
	page_down: '{PGDN}',
	f1: '{F1}',
	f2: '{F2}',
	f3: '{F3}',
	f4: '{F4}',
	f5: '{F5}',
	f6: '{F6}',
	f7: '{F7}',
	f8: '{F8}',
	f9: '{F9}',
	f10: '{F10}',
	f11: '{F11}',
	f12: '{F12}',
}

export function translateKeyToSendKeys(combo: string): string {
	const parts = combo
		.split('+')
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
	if (parts.length === 0) throw new Error('translateKeyToSendKeys: empty key combo')
	const main = parts[parts.length - 1] ?? ''
	const mods = parts.slice(0, -1)
	const modifierPrefix = mods
		.map((m) => {
			const prefix = SENDKEYS_MODIFIER[m.toLowerCase()]
			if (!prefix) throw new Error(`translateKeyToSendKeys: unknown modifier "${m}"`)
			return prefix
		})
		.join('')
	const special = SENDKEYS_SPECIAL[main.toLowerCase()]
	if (special) return modifierPrefix + special
	// Single printable chars pass through as-is; longer names stay literal and
	// SendKeys will fall back to per-character typing.
	return modifierPrefix + main
}

// ---------------------------------------------------------------------------
// One PowerShell invocation per action. The script travels as
// `-EncodedCommand` (UTF-16LE base64), so no character of it — and none of
// the text being typed — reaches a command-line parser.
// ---------------------------------------------------------------------------

/** PowerShell's `-EncodedCommand` form: the script as UTF-16LE, base64. */
export function encodePowerShellCommand(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64')
}

export function powerShellArguments(script: string): string[] {
	return [
		'-NoLogo',
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		encodePowerShellCommand(`$ProgressPreference = 'SilentlyContinue'\n${script}`),
	]
}

/**
 * Compiled into every invocation, and the first thing each one runs: the
 * process becomes per-monitor DPI aware (V2, then the Windows 8.1 API, then
 * the Vista one) before it reads a bound, captures or moves anything, so
 * all of those are physical pixels. Without it a display at 150 % reported
 * two thirds of its size and the capture showed only its top-left part.
 */
const DESKTOP_TYPE = `
if (-not ([System.Management.Automation.PSTypeName]'Namzu.Desktop').Type) {
	Add-Type -TypeDefinition @"
	using System;
	using System.Runtime.InteropServices;
	namespace Namzu {
		public static class Desktop {
			[DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
			[DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
			[DllImport("user32.dll")] static extern bool SetProcessDPIAware();
			[DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
			[DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
			[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
			[StructLayout(LayoutKind.Sequential)]
			public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
			[StructLayout(LayoutKind.Sequential)]
			public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
			[StructLayout(LayoutKind.Explicit)]
			public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
			[StructLayout(LayoutKind.Sequential)]
			public struct INPUT { public uint type; public INPUTUNION u; }
			[DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
			[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
			public static void MakeDpiAware() {
				try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (Exception) {}
				try { if (SetProcessDpiAwareness(2) == 0) return; } catch (Exception) {}
				try { SetProcessDPIAware(); } catch (Exception) {}
			}
			public static double PrimaryScale() {
				try {
					uint x, y;
					IntPtr monitor = MonitorFromPoint(new POINT(), 1);
					if (GetDpiForMonitor(monitor, 0, out x, out y) == 0 && x > 0) return x / 96.0;
				} catch (Exception) {}
				return 1.0;
			}
			static INPUT Mouse(uint flags, uint data) {
				INPUT input = new INPUT(); input.type = 0; input.u.mi.dwFlags = flags; input.u.mi.mouseData = data; return input;
			}
			static INPUT Key(ushort vk, ushort scan, uint flags) {
				INPUT input = new INPUT(); input.type = 1; input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags; return input;
			}
			static void Send(params INPUT[] inputs) {
				SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
			}
			public static void MouseEvent(uint flags, uint data) { Send(Mouse(flags, data)); }
			public static void Click(uint down, uint up) { Send(Mouse(down, 0), Mouse(up, 0)); }
			public static void TypeText(string text) {
				for (int i = 0; i < text.Length; i++) {
					char c = text[i];
					if (c == '\\r' && i + 1 < text.Length && text[i + 1] == '\\n') continue;
					if (c == '\\r' || c == '\\n') { Send(Key(0x0D, 0, 0), Key(0x0D, 0, 2)); continue; }
					if (c == '\\t') { Send(Key(0x09, 0, 0), Key(0x09, 0, 2)); continue; }
					// KEYEVENTF_UNICODE: the character itself, whatever the keyboard layout.
					Send(Key(0, c, 4), Key(0, c, 4 | 2));
				}
			}
		}
	}
"@
}
[Namzu.Desktop]::MakeDpiAware()
`.trim()

const MOUSEEVENTF = {
	leftDown: 0x0002,
	leftUp: 0x0004,
	rightDown: 0x0008,
	rightUp: 0x0010,
	middleDown: 0x0020,
	middleUp: 0x0040,
	wheel: 0x0800,
	hwheel: 0x01000,
} as const

const MOUSE_DOWN_UP: Readonly<Record<MouseButton, readonly [number, number]>> = {
	left: [MOUSEEVENTF.leftDown, MOUSEEVENTF.leftUp],
	right: [MOUSEEVENTF.rightDown, MOUSEEVENTF.rightUp],
	middle: [MOUSEEVENTF.middleDown, MOUSEEVENTF.middleUp],
}

/** The primary display, physical. The primary display's origin is (0, 0) by definition. */
const DISPLAY_JSON = `
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$display = @{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height; scaleFactor = [Namzu.Desktop]::PrimaryScale() }
`.trim()

const GEOMETRY_SCRIPT = `
${DESKTOP_TYPE}
${DISPLAY_JSON}
[Console]::Out.Write(($display | ConvertTo-Json -Compress))
`.trim()

const SCREENSHOT_SCRIPT = `
${DESKTOP_TYPE}
${DISPLAY_JSON}
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$display.png = [Convert]::ToBase64String($ms.ToArray())
[Console]::Out.Write(($display | ConvertTo-Json -Compress))
`.trim()

const CURSOR_POSITION_SCRIPT = `
${DESKTOP_TYPE}
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
[Console]::Out.Write((@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress))
`.trim()

function mouseClickScript(at: Point, button: MouseButton): string {
	const [down, up] = MOUSE_DOWN_UP[button]
	return `
${DESKTOP_TYPE}
[Namzu.Desktop]::SetCursorPos(${at.x}, ${at.y}) | Out-Null
[Namzu.Desktop]::Click(${down}, ${up})
`.trim()
}

function mouseMoveScript(to: Point): string {
	return `
${DESKTOP_TYPE}
[Namzu.Desktop]::SetCursorPos(${to.x}, ${to.y}) | Out-Null
`.trim()
}

/** Press, move through intermediate points, release: many targets ignore a drag that teleports. */
export function dragPath(from: Point, to: Point, steps = 12): Point[] {
	const path: Point[] = []
	for (let i = 1; i <= steps; i++) {
		path.push({
			x: Math.round(from.x + ((to.x - from.x) * i) / steps),
			y: Math.round(from.y + ((to.y - from.y) * i) / steps),
		})
	}
	return path
}

function mouseDragScript(from: Point, to: Point, button: MouseButton): string {
	const [down, up] = MOUSE_DOWN_UP[button]
	const moves = dragPath(from, to)
		.map(
			(p) =>
				`[Namzu.Desktop]::SetCursorPos(${p.x}, ${p.y}) | Out-Null; Start-Sleep -Milliseconds 15`,
		)
		.join('\n')
	return `
${DESKTOP_TYPE}
[Namzu.Desktop]::SetCursorPos(${from.x}, ${from.y}) | Out-Null
[Namzu.Desktop]::MouseEvent(${down}, 0)
${moves}
[Namzu.Desktop]::MouseEvent(${up}, 0)
`.trim()
}

function scrollScript(at: Point, direction: ScrollDirection, amount: number): string {
	const flag = direction === 'up' || direction === 'down' ? MOUSEEVENTF.wheel : MOUSEEVENTF.hwheel
	const sign = direction === 'up' || direction === 'right' ? 1 : -1
	const mouseData = (sign * 120 * amount) >>> 0 // WHEEL_DELTA * amount, as a DWORD
	return `
${DESKTOP_TYPE}
[Namzu.Desktop]::SetCursorPos(${at.x}, ${at.y}) | Out-Null
[Namzu.Desktop]::MouseEvent(${flag}, ${mouseData})
`.trim()
}

/** The text crosses as base64 UTF-8 and is typed as Unicode key events, so layout and quoting cannot change it. */
function typeTextScript(text: string): string {
	const encoded = Buffer.from(text, 'utf8').toString('base64')
	return `
${DESKTOP_TYPE}
[Namzu.Desktop]::TypeText([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))
`.trim()
}

function pressKeyScript(combo: string): string {
	const sendKeys = translateKeyToSendKeys(combo)
	return `
${DESKTOP_TYPE}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sendKeys.replace(/'/g, "''")}')
`.trim()
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const POWERSHELL_CANDIDATES = ['pwsh', 'powershell', 'pwsh.exe', 'powershell.exe'] as const

export interface Win32PowerShellAdapterOptions {
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	/** Why cua-driver is not being used, when this adapter stands in for it. */
	readonly fallbackReason?: string
	/** For tests. */
	readonly wslProbes?: WslProbes
}

async function findPowerShell(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
	probes: WslProbes,
): Promise<string | null> {
	// Under WSL the Windows side's absolute path: PATH may not carry the
	// Windows directories (appendWindowsPath=false, a systemd service).
	if (isWsl(env, platform, probes)) {
		const absolute = wslPowerShellPath(probes)
		if (absolute) return absolute
	}
	const present = await Promise.all(POWERSHELL_CANDIDATES.map((name) => hasExecutable(name)))
	return POWERSHELL_CANDIDATES.find((_name, index) => present[index]) ?? null
}

export class Win32PowerShellAdapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities
	readonly backend = 'powershell'

	private constructor(
		private readonly powershell: string,
		private readonly env: NodeJS.ProcessEnv | undefined,
		readonly fallbackReason: string | undefined,
	) {
		this.capabilities = Object.freeze({
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: true,
			supportedActions: Object.freeze([
				'screenshot' as const,
				'cursor_position' as const,
				'mouse_move' as const,
				'mouse_click' as const,
				'mouse_drag' as const,
				'scroll' as const,
				'type_text' as const,
				'key' as const,
			]),
		})
	}

	static async create(
		options: Win32PowerShellAdapterOptions = {},
	): Promise<Win32PowerShellAdapter> {
		const env = options.env ?? process.env
		const platform = options.platform ?? process.platform
		const probes = options.wslProbes ?? realWslProbes
		const powershell = await findPowerShell(env, platform, probes)
		if (!powershell) {
			throw new AdapterUnavailableError(
				`Win32Adapter: neither PowerShell Core nor Windows PowerShell is available on PATH${options.fallbackReason ? `, and cua-driver was not usable: ${options.fallbackReason}` : ''}`,
				[...POWERSHELL_CANDIDATES],
			)
		}
		// Under WSL a systemd service has no working WSL_INTEROP; give it one.
		const childEnv = isWsl(env, platform, probes) ? wslChildEnv(env, [], probes) : undefined
		return new Win32PowerShellAdapter(powershell, childEnv, options.fallbackReason)
	}

	private async run(script: string): Promise<Buffer> {
		const result = await runCommandOrThrow(
			this.powershell,
			powerShellArguments(script),
			this.env ? { env: this.env } : {},
		)
		return result.stdout
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const parsed = JSON.parse((await this.run(GEOMETRY_SCRIPT)).toString('utf8')) as {
			width: number
			height: number
			scaleFactor: number
		}
		return { width: parsed.width, height: parsed.height, scaleFactor: parsed.scaleFactor }
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case 'screenshot': {
				const parsed = JSON.parse((await this.run(SCREENSHOT_SCRIPT)).toString('utf8')) as {
					x: number
					y: number
					width: number
					height: number
					scaleFactor: number
					png: string
				}
				const data = Buffer.from(parsed.png, 'base64')
				const dims = decodePngDims(data)
				const display: DisplayInfo = {
					id: 'primary',
					x: parsed.x,
					y: parsed.y,
					width: parsed.width,
					height: parsed.height,
					scaleFactor: parsed.scaleFactor,
					primary: true,
				}
				return {
					type: 'screenshot',
					result: { data, mimeType: 'image/png', width: dims.width, height: dims.height, display },
				}
			}
			case 'cursor_position': {
				const parsed = JSON.parse((await this.run(CURSOR_POSITION_SCRIPT)).toString('utf8')) as {
					x: number
					y: number
				}
				return { type: 'cursor_position', point: { x: parsed.x, y: parsed.y } }
			}
			case 'mouse_move':
				await this.run(mouseMoveScript(action.to))
				return { type: 'ok' }
			case 'mouse_click':
				await this.run(mouseClickScript(action.at, action.button))
				return { type: 'ok' }
			case 'mouse_drag':
				await this.run(mouseDragScript(action.from, action.to, action.button))
				return { type: 'ok' }
			case 'scroll':
				await this.run(scrollScript(action.at, action.direction, action.amount))
				return { type: 'ok' }
			case 'type_text':
				await this.run(typeTextScript(action.text))
				return { type: 'ok' }
			case 'key':
				await this.run(pressKeyScript(action.keys))
				return { type: 'ok' }
		}
	}
}

function decodePngDims(buffer: Buffer): { width: number; height: number } {
	if (buffer.length < 24) {
		throw new Error('Win32Adapter: screenshot buffer too small to contain PNG header')
	}
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
	}
}

/** For tests: the scripts as they are sent. */
export const _scripts = {
	typeText: typeTextScript,
	mouseDrag: mouseDragScript,
	screenshot: SCREENSHOT_SCRIPT,
	geometry: GEOMETRY_SCRIPT,
}
