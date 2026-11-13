---
'@namzu/sdk': minor
---

An agent file can carry a `hooks` key. Nothing is removed or renamed.

What you can now do:

- Write a `hooks` block in an agent file's front matter. The kernel keeps the block as text (`AgentFileDefinition.hooksSource`, read by the same raw-block option the skill reader uses) because it is a list of mappings, which the front matter reader cannot hold, and no other key is read differently. `hooks` joins `AGENT_FILE_KEYS`, so a host that checks agent files against that list no longer reports it as an unknown key.

What to do: if an agent file of yours already has a `hooks:` block written for another tool, it was ignored until now (or the file was refused, if its shape could not be read). A host that runs agent hooks (the CLI does) will run it for each run of the agent, so read it first. A host that does not read `hooksSource` is not affected.
