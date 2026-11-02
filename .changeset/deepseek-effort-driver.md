---
'@namzu/deepseek': minor
---

Reasoning effort now works on the native driver: it is sent as `reasoning_effort` (the vendor's documented field), so `NAMZU_EFFORT_LEVEL=max` no longer errors. `minimal` goes to `low`, `medium` and `xhigh` to `high`, `ultra` to `max` (the vendor's own mapping), and a level the model's `effort.supported_levels` lacks falls to the nearest offered one. `none` turns thinking off; `reasoningEffortLevelsFor` and `reasoningEffortDefaultFor` publish the menu and default. New export `resolveDeepSeekEffort`; `assertEffortUnsupported` is deprecated and no longer called. A call that sets `temperature` and friends with an effort other than `none` is still refused.
