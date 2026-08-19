#!/usr/bin/python3
"""Read all Venus temperature services in one D-Bus process.

The previous shell implementation launched the Python based ``dbus`` CLI once
for discovery and eight more times per sensor. On older Cerbo hardware those
processes outlived Node-RED's exec timeout and eventually tripped the watchdog.
"""

import os

import dbus


PATHS = (
    "/Temperature",
    "/CustomName",
    "/ProductName",
    "/Mgmt/Connection",
    "/Humidity",
    "/Pressure",
    "/BatteryVoltage",
    "/DeviceInstance",
)


def clean(value):
    if value is None:
        return ""
    return str(value).replace("\t", " ").replace("\r", " ").replace("\n", " ")


def get_value(bus, service, path):
    try:
        proxy = bus.get_object(service, path, introspect=False)
        method = proxy.get_dbus_method("GetValue", "com.victronenergy.BusItem")
        return method(timeout=1.5)
    except Exception:
        return ""


def main():
    bus = dbus.SystemBus()
    services = sorted(
        str(name)
        for name in bus.list_names()
        if str(name).startswith("com.victronenergy.temperature")
    )
    lines = []
    for service in services:
        values = [clean(get_value(bus, service, path)) for path in PATHS]
        line = "\t".join([service] + values)
        lines.append(line)
        print(line, flush=True)

    cache = "/tmp/camper-temperature-sensors.cache"
    temporary = cache + ".new"
    try:
        with open(temporary, "w", encoding="utf-8") as handle:
            if lines:
                handle.write("\n".join(lines) + "\n")
        os.replace(temporary, cache)
    except OSError:
        try:
            os.unlink(temporary)
        except OSError:
            pass


if __name__ == "__main__":
    main()
