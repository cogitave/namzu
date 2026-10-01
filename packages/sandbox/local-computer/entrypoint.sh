#!/bin/sh
set -eu

width=${NAMZU_SANDBOX_SCREEN_WIDTH:-1280}
height=${NAMZU_SANDBOX_SCREEN_HEIGHT:-800}
mkdir -p /home/namzu/workspace /home/namzu/.config/chromium
# Only stale links from the previous exclusive allocation are removed.
for lock in SingletonLock SingletonSocket SingletonCookie; do
    path="/home/namzu/.config/chromium/$lock"
    if [ -L "$path" ]; then rm -f -- "$path"; fi
done

# A fresh X server belongs only to this guest, never the host DISPLAY/socket.
Xvfb :99 -screen 0 "${width}x${height}x24" -nolisten tcp &
xvfb_pid=$!
node /opt/namzu-computer/execution-worker.cjs &
execution_pid=$!

# Wait for the display, then launch visible applications. Readiness remains
# false until the browser process, the display and PNG capture actually work.
(
    until xdotool getdisplaygeometry >/dev/null 2>&1; do sleep 0.1; done
    openbox >/tmp/openbox.log 2>&1 &
    xterm -title 'Pal terminal' >/tmp/xterm.log 2>&1 &
    # Docker confinement is this image's boundary. Chromium's inner process
    # sandbox is disabled because Docker's no-new-privileges/capability policy
    # cannot provide its required namespace/suid setup. No host desktop or
    # host profile is mounted; do not present this as VM isolation.
    exec chromium --no-sandbox --disable-dev-shm-usage --no-first-run \
        --no-default-browser-check --password-store=basic \
        --user-data-dir=/home/namzu/.config/chromium \
        --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
        --window-size="${width},${height}" about:blank >/tmp/chromium.log 2>&1
) &
browser_pid=$!

node /opt/namzu-computer/desktop-worker.cjs &
desktop_pid=$!

shutdown() {
    # Chromium must flush its profile while its X server is still available.
    kill "$browser_pid" 2>/dev/null || true
    wait "$browser_pid" 2>/dev/null || true
    kill "$desktop_pid" "$execution_pid" "$xvfb_pid" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap shutdown EXIT
trap 'exit 0' TERM INT

# A dead critical service invalidates this whole allocation. dumb-init owns
# the shell; the shell shuts services down in order before PID 1 exits.
while kill -0 "$desktop_pid" "$execution_pid" "$browser_pid" "$xvfb_pid" 2>/dev/null; do
    sleep 1
done
exit 1
