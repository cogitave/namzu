---
type: Reference
title: Proxies and certificates
description: HTTPS_PROXY, HTTP_PROXY and NO_PROXY for model providers, tool servers and the web tools, NODE_EXTRA_CA_CERTS for a company certificate authority, a client certificate for mutual TLS, the doctor row, and what is not covered.
resource: packages/cli/src/network/install.ts
tags: [cli, network, proxy, tls]
status: stable
generated: { by: human:bahadirarda, at: 2026-10-27T00:00:00Z }
---

# Proxies and certificates

On a network that sends web traffic through a proxy, or inspects it with its own certificate authority, Namzu follows the same environment variables other command-line tools do. Nothing is configured per provider: one setting covers every model provider that talks over the platform's `fetch`, the tool servers (MCP) reached by URL, the web tools, sign-in calls and the model catalogue refresh.

| Variable | Means |
| --- | --- |
| `HTTPS_PROXY`, `https_proxy` | the proxy for `https://` addresses |
| `HTTP_PROXY`, `http_proxy` | the proxy for `http://` addresses, and for `https://` ones when `HTTPS_PROXY` is not set |
| `NO_PROXY`, `no_proxy` | hosts that skip the proxy |
| `NODE_EXTRA_CA_CERTS` | a file of extra certificate authorities to trust (read by Node itself) |
| `NAMZU_CLIENT_CERT`, `NAMZU_CLIENT_KEY`, `NAMZU_CLIENT_KEY_PASSPHRASE` | a client certificate, its key and the key's passphrase |

```sh
export HTTPS_PROXY=http://user:password@proxy.corp:3128
export NO_PROXY=localhost,127.0.0.1,.corp
export NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root.pem
namzu
```

## The proxy

The address is `http://host:port` or `https://host:port`; credentials go in front of the host (`http://user:password@host:port`) and are sent to the proxy. A bare `host:port` is read as `http://host:port`. The upper-case spelling wins when both are set. A SOCKS address is not supported yet: Namzu says so, ignores it and connects directly rather than half-using it. An address Namzu cannot read is ignored the same way, with one line on stderr naming the variable (never its value, which can hold a password).

`NO_PROXY` is a comma- or space-separated list of hosts that skip the proxy. A name matches itself and its subdomains (`example.com` covers `api.example.com`; a leading dot or `*.` is allowed), `host:port` limits an entry to one port, and `*` skips the proxy for everything. If both spellings are set they are joined. `localhost`, `127.0.0.1` and `[::1]` always skip the proxy, whatever the list says, so a local engine keeps working on a machine that sets `HTTP_PROXY` for everything else. The proxy, the list and the certificate apply to the whole process, including a resident runner started in the background.

A proxy that wants a sign-in answers the first request with a refusal. Namzu reads that and says `The network proxy asked for a sign-in before it would pass the request on.` with the fix: put the user name and password in the proxy address, or ask whoever runs the proxy. It does not retry, since the same request meets the same refusal. A proxy that refuses for another reason is reported as `The network proxy refused to pass the request on.` with a pointer to the address and `NO_PROXY`.

## A company certificate authority

When a proxy or firewall inspects encrypted traffic it re-signs it with its own authority, which Node does not know. The request fails and Namzu says `The connection was refused because its certificate is not trusted.` Point `NODE_EXTRA_CA_CERTS` at the PEM file holding that authority and start Namzu again. Node reads the variable once, when the process starts, so it has to be set in the environment Namzu is started from. It adds to the trusted authorities; it does not replace them.

## A client certificate

Some gateways only accept a connection that presents a certificate. Set `NAMZU_CLIENT_CERT` to a PEM file holding the certificate and `NAMZU_CLIENT_KEY` to the file holding its private key (the key may be in the certificate file, in which case leave it out). A key with a passphrase needs `NAMZU_CLIENT_KEY_PASSPHRASE`. The certificate is presented to the servers Namzu connects to, through the proxy's tunnel when there is one; it is not sent to the proxy itself. A file that is missing, over 1 MiB or without a PEM block is reported once on stderr and no certificate is sent. These are environment variables on purpose: a project's config file must not decide which key leaves your machine.

## Checking it

`namzu doctor` has a row for the network (category `runtime`): it says whether requests go through a proxy (the host and port, never the credentials), names the `NO_PROXY` hosts, says that Amazon Bedrock and LM Studio requests do not use the proxy (see below), and warns about an address it cannot use, an authority file or certificate file that cannot be read, and a key set without its certificate.

## What is not covered

The setting reaches everything that uses the platform's `fetch`. It does not reach:

- **Amazon Bedrock**, which uses Amazon's own HTTP client.
- **LM Studio**, whose client keeps its own socket to the local app, and the **browser** the browser tool drives, which has its own network settings.
- The web fetch tool resolves a name itself before it asks for the page, to refuse addresses inside your own network; on a network where only the proxy can resolve outside names, that lookup fails.
