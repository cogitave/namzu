/**
 * The way into making a plugin from the window: Add, Create with Namzu opens a new conversation
 * with this request in the box, unsent. The model writes the files with its normal tools and
 * approvals; nothing is installed.
 */

/** The Plugins list asks the window for a new conversation that starts a plugin. */
export const NEW_PLUGIN_EVENT = 'namzu:new-plugin'

/** A plugin was added, changed or removed: an open Plugins list reads the plugins again. */
export const PLUGINS_CHANGED_EVENT = 'namzu:plugins-changed'

export const NEW_PLUGIN_PROMPT =
	'Help me create a new Namzu plugin. Ask me what it should do, put it in a new folder, check it with namzu plugin validate, and tell me how to try it with --plugin-dir.'
