---
'@namzu/cli': patch
---

The review screen reads a browser call in words. It was titled `browser` and asked "Do you want to run browser?" over `action: "navigate"`; it now says `Open a web page` / `Do you want to open this page?`, `Go back in the browser`, or `Click on https://shop.example` / `Do you want to do this on https://shop.example?`. An address opens with its path as a person writes it (`/wiki/İstanbul`) and, when that differs, the address actually sent (`/wiki/%C4%B0stanbul`) below it; the host stays in its punycode form.
