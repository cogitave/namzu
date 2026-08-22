#!/bin/sh
# Reproduce the reported defect end to end, with a stub npm and no network.
#
#   sh scenario.sh <path-to-install.sh>
#
# Simulates a SUCCESSFUL GLOBAL install whose bin directory is not on PATH,
# which is the exact condition that produced the wrong instruction.
set -eu

INSTALLER="$1"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

mkdir -p "$W/fakebin"

# Stub npm: installs into $W/prefix/bin, and reports $W/prefix as the global
# prefix. Handles exactly the two invocations install.sh makes.
cat > "$W/fakebin/npm" <<EOF
#!/bin/sh
case "\$1" in
  install)
    mkdir -p "$W/prefix/bin"
    printf '#!/bin/sh\necho 9.9.9\n' > "$W/prefix/bin/namzu"
    chmod +x "$W/prefix/bin/namzu"
    exit 0 ;;
  prefix)
    printf '%s\n' "$W/prefix"
    exit 0 ;;
esac
exit 1
EOF
chmod +x "$W/fakebin/npm"

# The fallback location the old code hard-coded. Deliberately created and left
# EMPTY, so naming it is visibly wrong rather than merely unproven.
mkdir -p "$W/home/.namzu/bin"

NODE_BIN="$(command -v node)"
ln -s "$NODE_BIN" "$W/fakebin/node"

set +e
OUT="$(PATH="$W/fakebin:/usr/bin:/bin" \
       HOME="$W/home" \
       NAMZU_PREFIX="$W/home/.namzu" \
       sh "$INSTALLER" 2>&1)"
STATUS=$?
set -e

echo "--- installer exit: $STATUS"
echo "--- installer output:"
echo "$OUT"
echo "--- where the binary really is:"
ls -1 "$W/prefix/bin" 2>/dev/null || echo "(nothing)"
echo "--- what the fallback dir holds:"
ls -1A "$W/home/.namzu/bin" 2>/dev/null || echo "(nothing)"

# The assertion: the directory the message names must contain the binary.
# Matches the current wording and the one it replaced, so a regression to the
# old phrasing is reported as "named the wrong directory" rather than as "named
# nothing" — the failure should name the defect, not the rename.
NAMED="$(printf '%s' "$OUT" | sed -n 's/.*\(The binary is in\|The files are in\) \(.*\)\. Add it to your PATH.*/\2/p')"
echo "--- directory the installer named: ${NAMED:-<none>}"

if [ -z "$NAMED" ]; then
	echo "RESULT: FAIL — the installer named no directory"
	exit 1
fi
if [ -e "$NAMED/namzu" ]; then
	echo "RESULT: PASS — named directory contains the binary"
	exit 0
fi
echo "RESULT: FAIL — named directory does NOT contain the binary"
exit 1
