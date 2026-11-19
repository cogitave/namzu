---
'@namzu/cli': minor
---

Extensions can draw their own pages, use a licence of their own service or none, and start when you sign in.

A manifest may now declare `ui` (an icon, an accent colour, pages in a rail entry, under Extensions or in a panel, and status chips whose every sentence is declared), `background` with the permission `background.signin`, `licensing.kind` of `none`, `key` or `service`, declared `network.hosts` and `contributes.endpoint.actions` (protocol `namzu-ext-query/2`). A page can call only the methods its manifest lists; the install dialog, the permission list, the notice, the licence screens and the running mark stay Namzu's and cannot be drawn by an extension. A service licence is activated and refreshed by Namzu, which keeps the key; an offline grace period keeps the extension running with a visible notice and a signed `revoked` stops it.

`namzu extension daemon` is the one-per-person runner that keeps extensions with the Start when I sign in switch running when Namzu is closed; one sign-in entry per person names Namzu's own launcher, never an extension's file, and is removed with the last such extension. New commands: `namzu extension background <id> on|off|status`, `daemon start|run|stop|status`, `signin remove --all`, and `license <id> --key-stdin|--refresh|--release`. New engine methods for Desktop: `namzu/extensions/background/get`, `background/set`, `ui`, `action` and `runner`.

What breaks: `entry.process.runAtLogin` is removed from the manifest (use `background`), every permission now needs `personalData`, and `licensing` needs a `kind`. No package could be added to a build before (it trusts no publisher key yet), so nothing installed is affected; a developer package built for the first round needs these three changes.
