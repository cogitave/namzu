# Documentation update log

## 2026-09-02
* **Migration**: `docs/` became an OKF v0.2 bundle. Every page lost the estate-standard keys (`uid`, `diataxis`, `owner`, `timestamp`, `lastReviewed`) and gained `generated`; `status: active` became `stable`; the `meta.json` navigation files became `index.md` listings; the two `README.md` pages became [Defining tools](/sdk/tools/defining-tools.md) and the integrations index.
* **Creation**: [Shell hooks](/sdk/integrations/shell-hooks.md), [Agents defined in files](/sdk/tools/file-defined-agents.md), [The ask_user_question tool](/sdk/tools/ask-user-question.md), [The coding-agent doctrine](/sdk/runtime/coding-agent-doctrine.md).
* **Update**: [The kernel in depth](/sdk/architecture.md) caught up with the runtime barrel: shell hooks, file-defined agents, the doctrine contribution, the standalone question tool.
