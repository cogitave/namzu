"""WSL invocation of the bounded Windows guard; mode and fresh private receipt are explicit."""
import subprocess
import sys
desktop_only = "--desktop-only" in sys.argv
sys.argv = [arg for arg in sys.argv if arg != "--desktop-only"]
mode, receipt = sys.argv[1:3]
assert mode in ("--prepare-only", "--apply-reviewed", "--verify-current")
assert receipt.endswith(".json") and receipt.replace("-", "").replace(".", "").isalnum()
repo = r"\\wsl.localhost\archlinux\home\arda\workspaces\@cogitave\cogitave\namzu"
private_root = r"C:\Users\Arda\AppData\Local\Namzu\Development"
args = [r"/mnt/c/Program Files/nodejs/node.exe", repo + r"\research\transcript-search-timing-20261007\native-search-speech-activation.cjs", repo + r"\packages\desktop\dist", private_root + "\\" + receipt]
for flag, file in [
    ("cli-history", r"packages\cli\dist\commands\desktop-host.js"),
    ("cli-store", r"packages\cli\dist\pals\store.js"),
    ("cli-environment", r"packages\cli\dist\pals\environment.js"),
    ("cli-codex", r"packages\cli\dist\integrations\harness\codex-adapter.js"),
    ("cli-native-archive", r"packages\cli\dist\commands\acp-harness.js"),
    ("cli-pal-scope", r"packages\cli\dist\integrations\sessions\store.js"),
    ("cli-claude-protocol", r"packages\cli\dist\integrations\harness\claude-protocol.js"),
    ("sdk-pal-store", r"packages\sdk\dist\pals\store.js"),
    ("sdk-web-activity", r"packages\sdk\dist\bridge\acp\update.js"),
]:
    args.append("--" + flag + "-source=" + repo + "\\" + file)
args.append(mode)
if desktop_only:
    args.append("--desktop-only")
if len(sys.argv) > 3:
    assert mode == "--verify-current" and len(sys.argv) == 4
    original = sys.argv[3]
    assert original.endswith(".json") and original.replace("-", "").replace(".", "").isalnum()
    args.append("--verify-from=" + private_root + "\\" + original)
result = subprocess.run(args)
raise SystemExit(result.returncode)
