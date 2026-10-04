---
"@namzu/sandbox": patch
---

Remove Chromium's separate stock New Tab footer and its Customize Chromium
button from the local Pal browser home. The guest-only launcher disables
`NtpFooter`; the native blank home omnibox, installed application launchers,
normal website address bars and existing browser profile are preserved.
The home header uses the same block-letter wordmark as the desktop and CLI,
bundled as font-independent SVG geometry.

Rebuild the installed local computer image and restart its owning computer to
apply the change. Running containers keep their previous image; the persistent
workspace and browser profile volume survives the restart.
