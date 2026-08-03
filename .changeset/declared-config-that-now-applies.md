---
'@namzu/ollama': minor
'@namzu/lmstudio': minor
'@namzu/sdk': patch
---

Two timeouts that did nothing, and a recursion limit that was not the one in force.

**`OllamaConfig.timeout` and `LMStudioConfig.timeout`** were declared with no doc comment and read by nothing — both constructors forwarded the host and the model and never looked at them, so a host that set a timeout waited forever anyway. The wait they exist for is specific to a local server: the process is up, the socket accepts, and the model never answers because it is still loading or the machine is out of memory.

Both are composed with the caller's cancellation rather than replacing it. The caller's signal is how a run stops mid-generation, and dropping it for a deadline would leave a local model generating after the run that asked for it has stopped. Absent means no deadline, exactly as before.

The deadline covers the whole request rather than the time to the first byte, because the failure it exists for is a server that accepts and then never finishes — bounding only the head leaves precisely that case unbounded. A zero or negative value is refused at construction, since it would abort every request rather than bound it.

**`SupervisorAgentConfig.maxDepth` is deprecated** and documented as not consulted. The recursion bound is enforced in `AgentManager.sendMessage` against the manager's own config, and a supervisor receives a manager rather than building one — so a host setting it on the supervisor got the manager's value regardless. For a safety limit that is the worst way to be wrong: the number in front of the reviewer is not the number in force. Set it on `AgentManagerConfig`, where it is read. Tests now pin both halves, so a change that starts consulting the supervisor's copy fails rather than shipping quietly.
