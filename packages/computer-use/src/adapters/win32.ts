import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseResult,
	DisplayGeometry,
	MouseButton,
	Point,
	ScrollDirection,
} from '@namzu/sdk'
import { hasExecutable, runCommand, runCommandOrThrow } from '../util/spawn.js'
import { type Adapter, AdapterUnavailableError } from './types.js'

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
// Single PowerShell invocation wrapper. We pass the script via `-Command`
// (argv array, not shell) and the action body as a -File-like heredoc. All
// data crosses the boundary as JSON where possible.
// ---------------------------------------------------------------------------

const POWERSHELL_BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

async function runPowerShell(script: string): Promise<Buffer> {
	// Prefer pwsh (PowerShell Core), fall back to powershell.exe
	const [hasPwsh, hasPs] = await Promise.all([hasExecutable('pwsh'), hasExecutable('powershell')])
	const exe = hasPwsh ? 'pwsh' : hasPs ? 'powershell' : null
	if (!exe) {
		throw new AdapterUnavailableError(
			'Win32Adapter: neither pwsh nor powershell is available on PATH',
			['pwsh', 'powershell'],
		)
	}
	const result = await runCommandOrThrow(exe, [...POWERSHELL_BASE_ARGS, '-Command', script])
	return result.stdout
}

// ---------------------------------------------------------------------------
// Script fragments — loaded once, stamped into each invocation.
// ---------------------------------------------------------------------------

const GEOMETRY_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[Console]::Out.Write((@{ width = $b.Width; height = $b.Height; scaleFactor = 1 } | ConvertTo-Json -Compress))
`.trim()

const SCREENSHOT_SCRIPT = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
[Console]::OpenStandardOutput().Write($ms.ToArray(), 0, $ms.Length)
`.trim()

const CURSOR_POSITION_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.Cursor]::Position
[Console]::Out.Write((@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress))
`.trim()

/**
 * Inline C# P/Invoke block for SendInput. Loaded via Add-Type inside each
 * PowerShell invocation. Defines SendInput, INPUT, MOUSEINPUT, KEYBDINPUT;
 * exposes static helpers for mouse down/up, move, scroll, and key press.
 */
const USER32_TYPE = `
if (-not ([System.Management.Automation.PSTypeName]'Namzu.User32').Type) {
	Add-Type -TypeDefinition @"
	using System;
	using System.Runtime.InteropServices;
	namespace Namzu {
		public static class User32 {
			[StructLayout(LayoutKind.Sequential)]
			public struct MOUSEINPUT {
				public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
			}
			[StructLayout(LayoutKind.Sequential)]
			public struct KEYBDINPUT {
				public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
			}
			[StructLayout(LayoutKind.Explicit)]
			public struct INPUTUNION {
				[FieldOffset(0)] public MOUSEINPUT mi;
				[FieldOffset(0)] public KEYBDINPUT ki;
			}
			[StructLayout(LayoutKind.Sequential)]
			public struct INPUT { public uint type; public INPUTUNION u; }
			[DllImport("user32.dll", SetLastError = true)]
			public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
			[DllImport("user32.dll")]
			public static extern bool SetCursorPos(int X, int Y);
			public const uint INPUT_MOUSE = 0;
			public const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
			public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
			public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
			public const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x01000;
		}
	}
"@
}
`.trim()

function mouseClickScript(at: Point, button: MouseButton): string {
	const [downFlag, upFlag] = MOUSE_DOWN_UP_FLAGS[button]
	return `
${USER32_TYPE}
[Namzu.User32]::SetCursorPos(${at.x}, ${at.y}) | Out-Null
$down = New-Object Namzu.User32+INPUT
$down.type = [Namzu.User32]::INPUT_MOUSE
$down.u.mi.dwFlags = ${downFlag}
$up = New-Object Namzu.User32+INPUT
$up.type = [Namzu.User32]::INPUT_MOUSE
$up.u.mi.dwFlags = ${upFlag}
[Namzu.User32]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf($down)) | Out-Null
`.trim()
}

function mouseMoveScript(to: Point): string {
	return `
${USER32_TYPE}
[Namzu.User32]::SetCursorPos(${to.x}, ${to.y}) | Out-Null
`.trim()
}

function mouseDragScript(from: Point, to: Point, button: MouseButton): string {
	const [downFlag, upFlag] = MOUSE_DOWN_UP_FLAGS[button]
	return `
${USER32_TYPE}
[Namzu.User32]::SetCursorPos(${from.x}, ${from.y}) | Out-Null
$down = New-Object Namzu.User32+INPUT
$down.type = [Namzu.User32]::INPUT_MOUSE
$down.u.mi.dwFlags = ${downFlag}
[Namzu.User32]::SendInput(1, @($down), [System.Runtime.InteropServices.Marshal]::SizeOf($down)) | Out-Null
[Namzu.User32]::SetCursorPos(${to.x}, ${to.y}) | Out-Null
$up = New-Object Namzu.User32+INPUT
$up.type = [Namzu.User32]::INPUT_MOUSE
$up.u.mi.dwFlags = ${upFlag}
[Namzu.User32]::SendInput(1, @($up), [System.Runtime.InteropServices.Marshal]::SizeOf($up)) | Out-Null
`.trim()
}

function scrollScript(at: Point, direction: ScrollDirection, amount: number): string {
	const wheelFlag =
		direction === 'up' || direction === 'down' ? 'MOUSEEVENTF_WHEEL' : 'MOUSEEVENTF_HWHEEL'
	const sign = direction === 'up' || direction === 'right' ? 1 : -1
	const mouseData = sign * 120 * amount // WHEEL_DELTA * amount
	return `
${USER32_TYPE}
[Namzu.User32]::SetCursorPos(${at.x}, ${at.y}) | Out-Null
$scroll = New-Object Namzu.User32+INPUT
$scroll.type = [Namzu.User32]::INPUT_MOUSE
$scroll.u.mi.dwFlags = [Namzu.User32]::${wheelFlag}
$scroll.u.mi.mouseData = ${mouseData >>> 0}
[Namzu.User32]::SendInput(1, @($scroll), [System.Runtime.InteropServices.Marshal]::SizeOf($scroll)) | Out-Null
`.trim()
}

function typeTextScript(text: string): string {
	const escaped = escapePowerShellString(text)
	return `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${quoted(escaped)})
`.trim()
}

function pressKeyScript(combo: string): string {
	const sendKeys = translateKeyToSendKeys(combo)
	return `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${quoted(sendKeys)})
`.trim()
}

function escapePowerShellString(s: string): string {
	// For SendKeys we must also escape its control chars: + ^ % ~ ( ) { }.
	// Those are only interpreted when not inside SendKeys — for literal text
	// they need to be wrapped in braces.
	return s.replace(/([+^%~(){}])/g, '{$1}')
}

function quoted(s: string): string {
	return `'${s.replace(/'/g, "''")}'`
}

const MOUSE_DOWN_UP_FLAGS: Readonly<Record<MouseButton, readonly [string, string]>> = {
	left: ['[Namzu.User32]::MOUSEEVENTF_LEFTDOWN', '[Namzu.User32]::MOUSEEVENTF_LEFTUP'],
	right: ['[Namzu.User32]::MOUSEEVENTF_RIGHTDOWN', '[Namzu.User32]::MOUSEEVENTF_RIGHTUP'],
	middle: ['[Namzu.User32]::MOUSEEVENTF_MIDDLEDOWN', '[Namzu.User32]::MOUSEEVENTF_MIDDLEUP'],
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface ProbeResult {
	readonly hasPwsh: boolean
	readonly hasPowerShell: boolean
}

async function probe(): Promise<ProbeResult> {
	const [hasPwsh, hasPowerShell] = await Promise.all([
		hasExecutable('pwsh'),
		hasExecutable('powershell'),
	])
	return { hasPwsh, hasPowerShell }
}

export class Win32Adapter implements Adapter {
	readonly capabilities: ComputerUseCapabilities

	private constructor() {
		this.capabilities = Object.freeze({
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: true,
		})
	}

	static async create(): Promise<Win32Adapter> {
		const probeResult = await probe()
		if (!probeResult.hasPwsh && !probeResult.hasPowerShell) {
			throw new AdapterUnavailableError(
				'Win32Adapter: neither pwsh (PowerShell 7+) nor powershell.exe are available on PATH',
				['pwsh', 'powershell'],
			)
		}
		return new Win32Adapter()
	}

	async getDisplayGeometry(): Promise<DisplayGeometry> {
		const stdout = await runPowerShell(GEOMETRY_SCRIPT)
		const parsed = JSON.parse(stdout.toString('utf8')) as {
			width: number
			height: number
			scaleFactor: number
		}
		return { width: parsed.width, height: parsed.height, scaleFactor: parsed.scaleFactor }
	}

	async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
		switch (action.type) {
			case 'screenshot': {
				const data = await runPowerShell(SCREENSHOT_SCRIPT)
				const dims = decodePngDims(data)
				return {
					type: 'screenshot',
					result: {
						data,
						mimeType: 'image/png',
						width: dims.width,
						height: dims.height,
					},
				}
			}
			case 'cursor_position': {
				const stdout = await runPowerShell(CURSOR_POSITION_SCRIPT)
				const parsed = JSON.parse(stdout.toString('utf8')) as { x: number; y: number }
				return { type: 'cursor_position', point: parsed }
			}
			case 'mouse_move':
				await runPowerShell(mouseMoveScript(action.to))
				return { type: 'ok' }
			case 'mouse_click':
				await runPowerShell(mouseClickScript(action.at, action.button))
				return { type: 'ok' }
			case 'mouse_drag':
				await runPowerShell(mouseDragScript(action.from, action.to, action.button))
				return { type: 'ok' }
			case 'scroll':
				await runPowerShell(scrollScript(action.at, action.direction, action.amount))
				return { type: 'ok' }
			case 'type_text':
				await runPowerShell(typeTextScript(action.text))
				return { type: 'ok' }
			case 'key':
				await runPowerShell(pressKeyScript(action.keys))
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

export { runCommand as _runCommand }
