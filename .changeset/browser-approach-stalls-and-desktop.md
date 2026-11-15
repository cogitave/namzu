---
'@namzu/sdk': patch
'@namzu/browser': minor
'@namzu/cli': minor
---

Web tasks now start from a short paragraph in the system prompt (go to the named address or the site's own search, one action then read the result, change approach after two no-effect tries, never fetch with the shell what the browser reads, finish by confirming on the page), and the `browser-automation` skill is a shorter reference for awkward cases. The browser tools refuse a call repeated five times with nothing changing on the page (a note at three, and a second note after twelve page-changing calls with no new address, content or tab). No default changes for existing setups.

New, off by default: `browser.signInDetection: page` (CLI config) and `signInDetection: 'page'` (`@namzu/browser` host option, with the new `signInNotice` and `BrowserSignInDetection` exports). The default `address` keeps today's behaviour, where any `/login`-style path stops the turn. With `page`, only the known sign-in hosts, your `signInAddresses`, a challenge or a bare 401 page with a password field stop it; a public page at such a path loads, and the model is told once that it cannot type a password or code, which stays refused. A project config file cannot set the key. Set it in your own config to try it.

`namzu acp --desktop` (the Namzu Desktop application) now mounts `browser` and `browser_act` in each conversation with the terminal's profile, site rules and lifecycle; a bare ACP client, `exec`, `drain` and Pal conversations are unchanged. Nothing is released to Desktop by this change.
