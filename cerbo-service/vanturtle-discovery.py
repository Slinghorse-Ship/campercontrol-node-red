#!/usr/bin/env python3
"""Keep the stable VanTurtle hostname mapped to its current Cerbo AP lease."""

from __future__ import annotations

import ipaddress
import os
import pathlib
import re
import tempfile
import time


LEASES_PATH = pathlib.Path("/run/dnsmasq.leases")
HOSTS_PATH = pathlib.Path("/etc/hosts")
AP_NETWORK = ipaddress.IPv4Network("172.24.24.0/24")
POLL_SECONDS = 5.0
HOSTNAME_PATTERN = re.compile(r"^vanturtle-fan(?:-[a-z0-9-]+)?$", re.IGNORECASE)
BEGIN_MARKER = "# campercontrol-vanturtle-begin"
END_MARKER = "# campercontrol-vanturtle-end"
ALIASES = "vanturtle-fan.local vanturtle-fan"


def discover_address(leases: str, now: int | None = None) -> str | None:
    current_time = int(time.time()) if now is None else int(now)
    candidates: list[tuple[int, str]] = []
    for raw_line in leases.splitlines():
        fields = raw_line.split()
        if len(fields) < 4 or not HOSTNAME_PATTERN.fullmatch(fields[3]):
            continue
        try:
            expires = int(fields[0])
            address = ipaddress.IPv4Address(fields[2])
        except (ValueError, ipaddress.AddressValueError):
            continue
        if address not in AP_NETWORK or (expires != 0 and expires <= current_time):
            continue
        candidates.append((expires if expires != 0 else 2**63 - 1, str(address)))
    if not candidates:
        return None
    return max(candidates)[1]


def render_hosts(hosts: str, address: str | None) -> str:
    kept: list[str] = []
    managed = False
    for line in hosts.splitlines():
        if line == BEGIN_MARKER:
            managed = True
            continue
        if line == END_MARKER:
            managed = False
            continue
        if not managed:
            kept.append(line)
    while kept and not kept[-1]:
        kept.pop()
    if address:
        kept.extend(("", BEGIN_MARKER, f"{address} {ALIASES}", END_MARKER))
    return "\n".join(kept) + "\n"


def sync_once(
    leases_path: pathlib.Path = LEASES_PATH,
    hosts_path: pathlib.Path = HOSTS_PATH,
) -> str | None:
    try:
        leases = leases_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        leases = ""
    address = discover_address(leases)
    current = hosts_path.read_text(encoding="utf-8")
    updated = render_hosts(current, address)
    if updated == current:
        return address

    mode = hosts_path.stat().st_mode & 0o777
    temporary_name = ""
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=hosts_path.parent,
            prefix=".hosts.campercontrol.",
            delete=False,
        ) as temporary:
            temporary.write(updated)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_name = temporary.name
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, hosts_path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return address


def main() -> int:
    last_status: tuple[str, str] | None = None
    while True:
        try:
            address = sync_once()
            status = ("address", address or "offline")
        except (OSError, ValueError) as error:
            status = ("error", str(error)[:160])
        if status != last_status:
            print(f"vanturtle-discovery: {status[0]}={status[1]}", flush=True)
            last_status = status
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
