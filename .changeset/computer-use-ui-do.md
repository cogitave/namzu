---
'@namzu/sdk': minor
---

`createComputerUseTool` takes an optional `advisor` (`ComputerUseAdvisor`), a fast second opinion on which control an intent names. With one, `ui_act` accepts an optional `intent`; with one whose `acts` is true, the tool also offers `ui_do { target, action, value, window_id }`, which names a control in words and acts only when the advisor's best control has a confidence of 0.85 or more and leads the next by 0.4 or more, else acts on nothing and lists the closest controls. Without an advisor the tool, its description and its schema are exactly what they were. New exports: `ComputerUseAdvisor`, `ComputerUseAdvice`, `ComputerUseAdvisorCandidate`, `ComputerUseAdvisorRequest`.
