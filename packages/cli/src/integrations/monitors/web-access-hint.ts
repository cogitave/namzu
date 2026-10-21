/**
 * What the CLI adds to the monitor tool's refusal of a WebSocket while web
 * access is off. The switch is the config key `web.fetch` (the same one that
 * mounts `web_fetch`); it is read from the config file only, and
 * `NAMZU_WEB_FETCH` does not set it, so the sentence does not offer that.
 */
export const MONITOR_WEB_ACCESS_HINT =
	'To allow it, set `web.fetch: true` in the Namzu config file (~/.namzu/config.yaml); it cannot be switched on from the environment.'
