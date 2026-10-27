---
"@namzu/cli": minor
---

Namzu now reads `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (either case) and sends model-provider, tool-server and web requests through that proxy; before, the variables were ignored and every request went direct. `localhost`, `127.0.0.1` and `[::1]` always skip the proxy, so a local engine keeps working. `NAMZU_CLIENT_CERT`, `NAMZU_CLIENT_KEY` and `NAMZU_CLIENT_KEY_PASSPHRASE` present a client certificate, and `NODE_EXTRA_CA_CERTS` (read by Node) is documented as the way to trust a company certificate authority. `namzu doctor` has a network row. If you have these variables set and rely on direct connections, add the hosts to `NO_PROXY` or unset the proxy variables. Amazon Bedrock and LM Studio are not routed through the proxy. Adds the `undici` dependency.
