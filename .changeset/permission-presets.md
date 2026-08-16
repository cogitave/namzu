---
'@namzu/sdk': minor
---

Named permission presets that bind a gate config to a sandbox isolation requirement and an approval policy.

The three were configured independently and had to agree by hand. `defaultSandboxedGateConfig` auto-approves in-sandbox file mutation, and its own docstring says why: "the FS boundary is enforced by the sandbox layer, not by per-call review". That is a claim about a **different subsystem**, and nothing checked it. Hand that config a `basic` tier, where the spawned process can read and write the whole host filesystem, and the gate keeps auto-approving writes on the strength of a boundary that is not there.

Four presets — `supervised`, `sandboxed`, `sandboxed-shell`, `unattended` — each stating the isolation controls it relies on, plus `resolvePermissionPreset`, which **refuses** when the host cannot meet them and names the missing controls. Refusing is the point: a preset that silently fell back to asking about everything would be safe and unusable, and one that silently kept auto-approving would be neither.

Requirements are controls, not tier names: `SandboxEnvironment` names an implementation — one tier denies the network outright while another leaves the host filesystem visible — and a preset depends on the property, not on which implementation supplies it. A preset requires only what it actually spends, so `sandboxed` does not demand network isolation it never trades on.

`unattended` is the one whose requirement cannot be waived: with an auto-approving policy the sandbox is the only boundary left, so it requires all three controls. It is also the only preset that auto-approves network calls, and those two facts are the same fact — which is what a preset exists to keep together.

`availablePermissionPresets` lists what a given host can honour, loosest first, and always ends with `supervised`, which assumes nothing.
