---
"@namzu/openai": major
---

Declare exact `gpt-6-astra` reasoning effort menus so hosts can offer effort
selection. The ChatGPT subscription provider advertises low, medium, high, xhigh,
max and ultra, with catalogue default medium. The API provider advertises low,
medium, high, xhigh and max. Selected efforts are forwarded unchanged.

Astra is now a recognized model rather than an unknown pass-through identifier:
both drivers reject none and minimal before transport, and the API driver also
rejects ultra. Callers sending those levels must choose a supported level or omit
effort to retain the backend default. The subscription ultra level does not imply
API ultra support or introduce an ultracode alias.
