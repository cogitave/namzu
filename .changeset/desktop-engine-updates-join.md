---
"@namzu/desktop": patch
---

The pieces of the engine delivery now agree with each other and with the published command line, before any build carries a signing key (so nothing changes for a person yet). The app reads the same public key list file as the publisher and the release workflow; its archive and signed-description readers refuse exactly what the publisher's refuse (entries out of order, a file list or a signature file that is not in its exact bytes, a prerelease version, a name Windows cannot hold); a start of a project, a terminal tab or a short command goes on the engine inside the installer whenever the engine folder is damaged, held, full or missing, and never fails because of it; and a release that was cut between uploading the archive and the signed description can be published again.
