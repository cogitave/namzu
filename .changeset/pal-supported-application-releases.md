---
"@namzu/sandbox": major
---

Update the bundled local Pal computer's normal Blender launcher from the
distribution Blender 3.4 to checksum-pinned Blender 5.2.2 LTS and its Godot
launcher from Godot 3.2 to checksum-pinned Godot 4.7.2. Godot 3 projects must be
converted and tested before opening with the new default. Preserve the original
project and use `/usr/bin/godot3` for explicit legacy work; `/usr/bin/blender`
also remains available. A custom older image retains its own application versions.

Normal Godot launches use the guest's OpenGL compatibility renderer. Blender MCP
startup addon update checks and telemetry are disabled for guest launches. These
settings do not install a server or addon automatically. Rebuild the local image
explicitly, then stop and reopen an idle Pal computer to select it; rebuilding a
tag does not replace a running allocation or change saved guest files.
