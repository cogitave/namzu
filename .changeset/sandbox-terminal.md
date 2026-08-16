---
'@namzu/sdk': minor
---

An optional pseudo-terminal in the local sandbox, refused rather than faked when the binding is absent.

`exec` runs a command and hands back what it printed. A large class of work does not fit that shape: an interactive installer waiting on a prompt, a REPL, `git rebase -i`, anything that draws with escape codes, anything that asks for a password.

**The refusal is the design.** A pseudo-terminal needs a native binding this kernel deliberately does not depend on — it would make every install build C++ for a capability most runs never use. So `Sandbox.openTerminal` is optional, and where the binding is unavailable it **throws** rather than substituting a pipe. A pipe would appear to work: bytes flow, `spawn` succeeds, and every program that calls `isatty` takes its non-interactive branch. The prompt never appears, the REPL exits immediately, the progress bar prints ten thousand lines, and nothing says why. Same rule `Sandbox.setNetworkPolicy` already states, for a sharper reason.

The refusal names the package, tells `absent` from `broken` (the second is almost always a native build compiled against a different Node version, and telling somebody to install a thing they already installed is the least useful message available), and points at `exec` while saying `exec` is not a terminal.

`TERM` is set to `xterm-256color`, which is not cosmetic: it is how a program decides which escape sequences it may emit, and unset makes well-behaved programs fall back to no colour and no cursor movement — a terminal that works and looks broken. `size` is required rather than defaulted, because a program asks the terminal how big it is before it draws anything.

**The local implementation is deliberately not confined by the isolation tier**, and says so at the site: `exec` wraps every command in `unshare`/`sandbox-exec`, and wrapping an interactive session would put the tier's own shell between the operator's keystrokes and the program. It runs in the sandbox's root directory and nothing more. A host that needs the tier uses `exec`, or a backend whose terminals are confined by construction.
