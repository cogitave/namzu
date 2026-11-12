/**
 * `NO_COLOR` asks for output without colour. The terminal renderer's colour library does not read it: it
 * reads `FORCE_COLOR` once, when it is first loaded, and `FORCE_COLOR=0` is the setting it knows for "none".
 * So the request is turned into that setting before the renderer is loaded (`bin.ts` imports this ahead of
 * everything that loads it). An explicit `FORCE_COLOR` of any value is the person's later word and stays.
 */

/** Sets `FORCE_COLOR=0` in `env` when `NO_COLOR` is set and non-empty and `FORCE_COLOR` is not set. */
export function applyNoColor(env: NodeJS.ProcessEnv = process.env): void {
	if ((env.NO_COLOR ?? '') !== '' && (env.FORCE_COLOR ?? '') === '') env.FORCE_COLOR = '0'
}

applyNoColor()
