#!/bin/sh
set -eu

width=${NAMZU_SANDBOX_SCREEN_WIDTH:-1280}
height=${NAMZU_SANDBOX_SCREEN_HEIGHT:-800}
browser_width=$((width - 64))
browser_height=$((height - 140))
if [ "$browser_width" -lt 256 ]; then browser_width=256; fi
if [ "$browser_height" -lt 200 ]; then browser_height=200; fi

launch_browser() {
    # Container confinement remains the boundary. Its no-new-privileges and
    # capability policy cannot provide Chromium's namespace/suid setup.
    # The controlled guest uses Chromium's test mode to avoid startup infobars;
    # it does not alter the host browser, profile or sandbox configuration.
    exec chromium --no-sandbox --test-type --disable-dev-shm-usage --no-first-run \
        --no-default-browser-check --password-store=basic --force-dark-mode \
        --user-data-dir=/home/namzu/.config/chromium \
        --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
        --window-position=32,24 --window-size="${browser_width},${browser_height}" "$@"
}
# A dock launch joins the existing browser profile rather than starting another
# X server or any worker. The dock can also reopen a closed browser window.
if [ "${1:-}" = '--browser' ]; then
    shift
    if [ "$#" -eq 0 ]; then set -- file:///opt/namzu-computer/home.html; fi
    launch_browser "$@"
fi

mkdir -p /home/namzu/workspace /home/namzu/.config/chromium \
    /home/namzu/.local/share/applications
cat > /home/namzu/.local/share/applications/namzu-browser.desktop <<'APP'
[Desktop Entry]
Type=Application
Name=Browser
Icon=chromium
Exec=/bin/sh /opt/namzu-computer/entrypoint.sh --browser
Path=/home/namzu/workspace
Terminal=false
APP
cat > /home/namzu/.local/share/applications/namzu-terminal.desktop <<'APP'
[Desktop Entry]
Type=Application
Name=Terminal
Icon=utilities-terminal
Exec=xterm -fa "DejaVu Sans Mono" -fs 11 -bg "#171c18" -fg "#e7eee8" -cr "#76d77d" -title Terminal
Path=/home/namzu/workspace
Terminal=false
APP
cat > /home/namzu/.local/share/applications/namzu-files.desktop <<'APP'
[Desktop Entry]
Type=Application
Name=Files
Icon=system-file-manager
Exec=pcmanfm /home/namzu/workspace
Path=/home/namzu/workspace
Terminal=false
APP
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
browser_pid=
openbox_pid=
dock_pid=
vnc_pid=
desktop_pid=

shutdown() {
    # The profile lock tracks the current main process, including a dock reopen.
    # Pin its guest-owned PID before asking it to flush while X remains alive.
    python3 - <<'FLUSH' || true
import os, select, signal

descriptor = None
try:
    lock = os.readlink('/home/namzu/.config/chromium/SingletonLock')
    pid = int(lock.rsplit('-', 1)[1])
    descriptor = os.pidfd_open(pid)
    process = f'/proc/{pid}'
    with open(f'{process}/comm') as command:
        owned_browser = command.read().strip() == 'chromium'
    if owned_browser and os.stat(process).st_uid == os.geteuid():
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        select.select([descriptor], [], [], 5)
except (OSError, ValueError, IndexError):
    pass
finally:
    if descriptor is not None:
        os.close(descriptor)
FLUSH
    if [ -n "$browser_pid" ]; then
        kill "$browser_pid" 2>/dev/null || true
        wait "$browser_pid" 2>/dev/null || true
    fi
    for pid in "$desktop_pid" "$vnc_pid" "$dock_pid" "$openbox_pid" "$execution_pid"; do
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
    done
    kill "$xvfb_pid" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap shutdown EXIT
trap 'exit 0' TERM INT

# The window manager and dock belong to this allocation, just like its workers.
until xdotool getdisplaygeometry >/dev/null 2>&1; do
    kill -0 "$xvfb_pid" 2>/dev/null || exit 1
    sleep 0.1
done
openbox --config-file /opt/namzu-computer/openbox-rc.xml >/tmp/openbox.log 2>&1 &
openbox_pid=$!
until xdotool get_desktop >/dev/null 2>&1; do
    kill -0 "$openbox_pid" "$xvfb_pid" 2>/dev/null || exit 1
    sleep 0.1
done
hsetroot -add '#234732' -add '#17251d' -add '#121614' -gradient 45 >/tmp/wallpaper.log 2>&1
tint2 -c /opt/namzu-computer/tint2rc >/tmp/tint2.log 2>&1 &
dock_pid=$!
launch_browser file:///opt/namzu-computer/home.html >/tmp/chromium.log 2>&1 &
browser_pid=$!

# VNC is a guest-loopback, view-only framebuffer source. It never receives
# operator input authority and cannot synchronize either selection direction.
x11vnc -display :99 -rfbport 5900 -listen 127.0.0.1 -no6 \
        -forever -shared -viewonly -nopw -norc -noremote -novncconnect \
        -noclipboard -noprimary -nosetclipboard -nosetprimary \
        -nolookup -quiet >/tmp/x11vnc.log 2>&1 &
vnc_pid=$!

node /opt/namzu-computer/desktop-worker.cjs &
desktop_pid=$!

# A dead critical service invalidates this whole allocation. dumb-init owns
# the shell; the shell shuts services down in order before PID 1 exits.
# A browser window is an application, so closing it leaves the desktop alive.
while kill -0 "$desktop_pid" "$vnc_pid" "$execution_pid" \
    "$openbox_pid" "$dock_pid" "$xvfb_pid" 2>/dev/null; do
    sleep 1
done
exit 1
