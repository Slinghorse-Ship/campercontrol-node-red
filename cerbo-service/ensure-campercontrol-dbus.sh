#!/bin/sh
set -eu

SERVICE_NAME=campercontrol-dbus
SERVICE_DIR=/data/campercontrol/service/campercontrol-dbus-service
SERVICE_LINK=/service/$SERVICE_NAME
DISCOVERY_SERVICE_NAME=vanturtle-discovery
DISCOVERY_SERVICE_DIR=/data/campercontrol/service/vanturtle-discovery-service
DISCOVERY_SERVICE_LINK=/service/$DISCOVERY_SERVICE_NAME
PYTHON_BRIDGE=/data/campercontrol/service/campercontrol-dbus.py
WEATHER_PROVIDER=/data/campercontrol/service/campercontrol_weather.py
DEVICE_HTTP=/data/campercontrol/service/device-http-bounded.py
VANTURTLE_DISCOVERY=/data/campercontrol/service/vanturtle-discovery.py

[ -x "$PYTHON_BRIDGE" ] || exit 1
[ -r "$WEATHER_PROVIDER" ] || exit 1
[ -x "$DEVICE_HTTP" ] || exit 1
[ -x "$VANTURTLE_DISCOVERY" ] || exit 1
[ -x "$SERVICE_DIR/run" ] || exit 1
[ -x "$DISCOVERY_SERVICE_DIR/run" ] || exit 1

ensure_service_link() {
    link=$1
    directory=$2
    if [ -L "$link" ]; then
        [ "$(readlink "$link")" = "$directory" ] || exit 1
    elif [ -e "$link" ]; then
        exit 1
    else
        ln -s "$directory" "$link"
    fi
}

ensure_service_link "$SERVICE_LINK" "$SERVICE_DIR"
ensure_service_link "$DISCOVERY_SERVICE_LINK" "$DISCOVERY_SERVICE_DIR"

svc -u "$SERVICE_LINK" >/dev/null 2>&1 || true
svc -u "$DISCOVERY_SERVICE_LINK" >/dev/null 2>&1 || true
exit 0
