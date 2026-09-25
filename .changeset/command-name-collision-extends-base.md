---
"@namzu/cli": patch
---

`CommandNameCollisionError` (`tui/slashCommands.ts`, thrown when a kernel command and a CLI-local one claim the same name) now extends `@namzu/sdk`'s `RegistryCollisionError`, matching every SDK `*CollisionError` after its registry-collision convergence. Name, message and behavior are unchanged; a catch block naming `CommandNameCollisionError` still works, and one that wants "some registry collided" without naming every class can now catch `RegistryCollisionError` instead. See [docs/sdk/registries.md](../docs/sdk/registries.md).
