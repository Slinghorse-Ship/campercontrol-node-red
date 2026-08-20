#!/bin/sh

GRPCURL=/data/campercontrol/starlink/grpcurl
DISH=192.168.100.1:9200

# Zweite, hardwareseitige Freigabe direkt vor jeder Abfrage. Node-RED allein
# darf bei ausgeschaltetem STAR-Power-Kanal 5 keinen Starlink-Prozess starten.
switch_service="$(dbus -y 2>/dev/null | grep '^com.victronenergy.switch' | head -n 1)"
channel_state=""
if [ -n "$switch_service" ]; then
    channel_state="$(dbus -y "$switch_service" /SwitchableOutput/4/State GetValue 2>/dev/null | awk '/value =/ {print $3}' | tail -n 1)"
fi

if [ "$channel_state" = "0" ]; then
    printf '%s\n' '{"powered":false,"online":false,"status":"Ausgeschaltet"}'
    exit 0
fi
if [ "$channel_state" != "1" ]; then
    printf '%s\n' '{"powered":null,"online":false,"status":"Kanalrückmeldung nicht verfügbar","error":"channel_feedback_unavailable"}'
    exit 2
fi
if [ ! -x "$GRPCURL" ]; then
    printf '%s\n' '{"powered":true,"online":false,"status":"Starlink-Client fehlt","error":"grpcurl_missing"}'
    exit 3
fi

# Ein zusätzliches Byte ist ein absichtlicher Overflow-Marker: Der nachfolgende
# Node-RED-Parser akzeptiert höchstens 64 KiB und verwirft 65.537 Bytes sicher.
"$GRPCURL" -max-time 5 -plaintext -d '{"get_diagnostics":{}}' "$DISH" SpaceX.API.Device.Device/Handle 2>&1 \
    | dd bs=65537 count=1 2>/dev/null
