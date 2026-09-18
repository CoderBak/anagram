#!/bin/sh
# test/lab/entrypoint.sh — bring up the lab's screen and keep it up.
#
#   Xvnc       the X display (:99) and its VNC server in one process; only the container
#              itself may connect to it (-localhost)
#   fluxbox    a small window manager, so windows have title bars and can be moved
#   websockify serves the noVNC page on :6080 and bridges it to the VNC server
#
# LAB_SCREEN=WxH sets the screen size; LAB_SCALE=2 renders everything at 2x (crisp on a
# Retina display — the screen is then 2·W × 2·H device pixels).
set -eu
: "${LAB_SCREEN:=1920x1080}"
: "${LAB_SCALE:=1}"
W="${LAB_SCREEN%x*}"; H="${LAB_SCREEN#*x}"
GEOMETRY="$((W * LAB_SCALE))x$((H * LAB_SCALE))"
export DISPLAY=:99

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
Xvnc :99 -geometry "$GEOMETRY" -depth 24 -dpi $((96 * LAB_SCALE)) \
     -SecurityTypes None -localhost -rfbport 5900 -AlwaysShared \
     -AcceptSetDesktopSize=0 >/tmp/xvnc.log 2>&1 &
XVNC=$!

i=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  i=$((i + 1)); [ "$i" -gt 100 ] && { echo "lab: X display did not come up"; cat /tmp/xvnc.log; exit 1; }
  sleep 0.1
done

mkdir -p "$HOME/.fluxbox"
cat > "$HOME/.fluxbox/init" <<'FLUX'
session.screen0.toolbar.visible: true
session.screen0.toolbar.placement: BottomCenter
session.screen0.toolbar.widthPercent: 100
session.screen0.toolbar.tools: iconbar, clock
session.screen0.workspaces: 1
session.screen0.focusModel: ClickFocus
session.screen0.focusNewWindows: true
session.styleFile: /usr/share/fluxbox/styles/bora_black
FLUX
# At 2x the window manager's own chrome would be half-size: double its fonts and bars too.
if [ "$LAB_SCALE" -gt 1 ]; then
  cat > "$HOME/.fluxbox/overlay" <<FLUX
*font: sans-$((9 * LAB_SCALE))
window.title.height: $((22 * LAB_SCALE))
toolbar.height: $((22 * LAB_SCALE))
window.handleWidth: $((4 * LAB_SCALE))
window.borderWidth: $LAB_SCALE
FLUX
  echo "session.styleOverlay: $HOME/.fluxbox/overlay" >> "$HOME/.fluxbox/init"
fi
xsetroot -solid "#262626" 2>/dev/null || true
fluxbox >/tmp/fluxbox.log 2>&1 &

websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &

echo "lab: screen $GEOMETRY (scale $LAB_SCALE) is up"
wait "$XVNC"
