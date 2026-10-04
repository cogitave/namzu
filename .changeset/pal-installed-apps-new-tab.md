---
"@namzu/sandbox": minor
---

The optional local computer image now includes 15 real application launchers,
including Blender, FreeCAD, GIMP, Inkscape and LibreOffice Draw. Normal Chromium
home and new tabs use the bundled Namzu New Tab page with a blank omnibox;
navigated sites retain their normal address bar. Launchers use a guest-only
native messaging host with a fixed extension origin and fixed application commands.
The image activates its bundled New Tab extension and waits for its own startup
tab to become ready, without rewriting browser policies or the saved profile.
Application launches discard Chromium's disabled D-Bus session address.
Kdenlive includes its video effects and uses a virtual audio driver so its editor
can start without a host sound device.

Rebuild the optional local image and restart the owning computer to use the new
applications and New Tab page. Existing running images are unchanged, and the
persistent home volume and browser profile are retained. The bundled Godot is
Debian's Godot 3; no unavailable reference apps are advertised.
