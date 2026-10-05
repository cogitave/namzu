---
"@namzu/cli": patch
---

Clarify Godot input timing in the installed bridge's tool description. Put a
bounded hold duration on the press event's `delay_after_ms`, or on the release
event's `delay_before_ms`; a delay after release waits with the input already
released. Show a 250 ms press-hold-release example and distinguish empty key
events from waits and composite click's internal `click_delay_ms`.

Argument types, defaults, dispatch behavior and pinned upstream source remain
unchanged. Update an existing guest bridge from the shipped asset while idle,
then reconfigure normally to load its updated description.
