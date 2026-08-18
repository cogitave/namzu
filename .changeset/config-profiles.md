---
'@namzu/cli': minor
---

Config profiles, and a machine-wide file that wins the cascade

**Profiles.** A named bundle of settings *inside* a config file, so the settings
you switch between sit next to each other and can be read as a set — which a
second config file cannot give you, because a second file has to be found before
it can be compared.

```json
{
  "permissions": { "bash": "ask" },
  "profiles": {
    "ci":     { "quiet": true, "permissions": { "bash": "allow" } },
    "review": { "permissions": { "bash": "deny", "read": "allow" } }
  }
}
```

Select with `--profile ci` or `NAMZU_PROFILE=ci`; the flag wins, because a flag
is this run and a variable is this shell. A profile overrides the base values of
the file it was declared in — otherwise selecting it could not change anything —
and loses to the environment, so a variable set for one shell keeps working
after somebody picks a profile.

The same name may appear in both config files. Each is applied as its own layer
in the usual file order, so the project's wins *and* `ConfigProvenance` still
names the file each value actually came from; one merged layer would report both
as "the profile" and send an operator to the wrong file. A profile may set
anything except `profiles`.

**A name no file declares is refused, not ignored**, with the declared names and
the files that declare them in the message. Ignoring it means running under
settings nobody chose and reporting success.

**The managed file.** `/etc/namzu/config.json` (`%ProgramData%\namzu\config.json`
on Windows) is read last and beats the project file and the environment both —
the only ordering that makes such a layer worth having. It exists for the case
where the person running namzu is not the person deciding what it may do.

Its guarantee is the file system's and nothing more: no signature is verified,
no owner is checked, and namzu cannot tell an administrator's file from one a
user wrote there. What stops a user editing it is that the path needs privileges
they do not have. It is absent on almost every machine, which is expected.

`ConfigSource` gains `profile` and `managed` variants. A host switching on it
exhaustively will need the two new arms.
