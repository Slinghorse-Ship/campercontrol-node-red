#!/usr/bin/env python3
"""Cerbo-owned DWD MOSMIX weather and BSH tide acquisition for CamperControl.

The module deliberately has no QML or browser dependency.  It selects a DWD
MOSMIX_L station from the active GX GPS service, downloads the single-station
forecast, normalizes it to a compact transport contract and keeps an atomic
cache under ``/data``.  When the GX is close to a North Sea tide gauge, the
provider also adds the next BSH high and low water predictions. Consumers only
read the resulting D-Bus/MQTT value.
"""

from __future__ import annotations

import ast
import datetime as dt
import io
import json
import math
import os
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SOURCE_NAME = "DWD MOSMIX_L"
SOURCE_ATTRIBUTION = "Quelle: Deutscher Wetterdienst"
TIDE_SOURCE_NAME = "BSH"
TIDE_ATTRIBUTION = "© Bundesamt für Seeschifffahrt und Hydrographie (BSH)"
SCHEMA_VERSION = 1
STATION_CATALOG_URLS = (
    "https://www.dwd.de/DE/leistungen/met_verfahren_mosmix/"
    "mosmix_stationskatalog.cfg?view=nasPublication&nn=16102",
    "https://www.dwd.de/EN/ourservices/met_application_mosmix/"
    "mosmix_stations.cfg?view=nasPublication&nn=495490",
)
FORECAST_URL = (
    "https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/"
    "single_stations/{station}/kml/MOSMIX_L_LATEST_{station}.kmz"
)
TIDE_CATALOG_URL = "https://gezeiten.bsh.de/data/tides_overview.json"
TIDE_STATION_URL = "https://gezeiten.bsh.de/data/DE_{station}_tides.json"
DEFAULT_CACHE_PATH = Path("/data/campercontrol/cache/weather-v1.json")
DEFAULT_CATALOG_PATH = Path("/data/campercontrol/cache/mosmix-stations-v1.cfg")
DEFAULT_STATION_CONFIG_PATH = Path("/data/campercontrol/weather-station.conf")
DEFAULT_TIDE_CACHE_PATH = Path("/data/campercontrol/cache/bsh-tides-v1.json")
DEFAULT_TIDE_CATALOG_PATH = Path("/data/campercontrol/cache/bsh-tides-overview-v1.json")
MAX_CATALOG_BYTES = 2 * 1024 * 1024
MAX_KMZ_BYTES = 1024 * 1024
MAX_KML_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 16 * 1024
MAX_TIDE_CATALOG_BYTES = 128 * 1024
MAX_TIDE_STATION_BYTES = 2 * 1024 * 1024
MAX_TIDE_CACHE_BYTES = 16 * 1024
STALE_AFTER_SECONDS = 12 * 60 * 60
CATALOG_REFRESH_SECONDS = 30 * 24 * 60 * 60
TIDE_CATALOG_REFRESH_SECONDS = 30 * 24 * 60 * 60
TIDE_REFRESH_SECONDS = 24 * 60 * 60
TIDE_STALE_AFTER_SECONDS = 48 * 60 * 60
TIDE_FAIL_CLOSED_SECONDS = 7 * 24 * 60 * 60
TIDE_RETRY_SECONDS = 6 * 60 * 60
TIDE_EVENT_HORIZON_SECONDS = 9 * 24 * 60 * 60
# A tide prediction is useful near the coast and tidal rivers, but a nearest
# station must not make tides appear across inland Germany. Sixty kilometres
# covers common coastal campsites while failing closed well before that occurs.
TIDE_MAX_DISTANCE_KM = 60.0
TIDE_CACHE_EVENT_LIMIT = 32
# MOSMIX_L has four regular model runs per day. A six-hour success interval is
# sufficient to pick up each run without redundant downloads on the Cerbo.
REFRESH_SECONDS = 6 * 60 * 60
RETRY_SECONDS = (15 * 60, 30 * 60, 60 * 60, 3 * 60 * 60)


@dataclass(frozen=True)
class Station:
    station_id: str
    name: str
    latitude: float
    longitude: float
    elevation: float | None = None


@dataclass(frozen=True)
class TideStation:
    station_id: str
    name: str
    latitude: float
    longitude: float
    gauge_group: int


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_utc(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_time(value: Any) -> dt.datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _cfg_coordinate(value: str) -> float:
    """Convert DWD CFG degree.minute coordinates to decimal degrees."""
    raw = float(value)
    sign = -1.0 if raw < 0 else 1.0
    absolute = abs(raw)
    degrees = math.floor(absolute)
    minutes = (absolute - degrees) * 100.0
    if minutes >= 60.0:
        raise ValueError(f"invalid DWD coordinate {value}")
    return sign * (degrees + minutes / 60.0)


def parse_station_catalog(text: str) -> list[Station]:
    stations: list[Station] = []
    pattern = re.compile(
        r"^\s*([A-Za-z0-9]{5})\s+(\S{4})\s+(.+?)\s+"
        r"(-?\d{1,3}\.\d{2,})\s+(-?\d{1,3}\.\d{2,})\s+"
        r"(-?\d+(?:\.\d+)?)\s*$"
    )
    for raw_line in text.splitlines():
        match = pattern.match(raw_line)
        if not match:
            continue
        station_id, _icao, name, latitude, longitude, elevation = match.groups()
        try:
            station = Station(
                station_id=station_id,
                name=" ".join(name.split()),
                latitude=_cfg_coordinate(latitude),
                longitude=_cfg_coordinate(longitude),
                elevation=float(elevation),
            )
        except ValueError:
            continue
        if -90 <= station.latitude <= 90 and -180 <= station.longitude <= 180:
            stations.append(station)
    if not stations:
        raise ValueError("DWD station catalog contains no usable stations")
    return stations


def haversine_km(latitude_a: float, longitude_a: float, latitude_b: float, longitude_b: float) -> float:
    radius = 6371.0088
    lat_a = math.radians(latitude_a)
    lat_b = math.radians(latitude_b)
    d_lat = lat_b - lat_a
    d_lon = math.radians(longitude_b - longitude_a)
    value = math.sin(d_lat / 2) ** 2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(d_lon / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(value), math.sqrt(max(0.0, 1.0 - value)))


def nearest_station(stations: Iterable[Station], latitude: float, longitude: float) -> tuple[Station, float]:
    candidates = [(station, haversine_km(latitude, longitude, station.latitude, station.longitude)) for station in stations]
    if not candidates:
        raise ValueError("no DWD stations available")
    return min(candidates, key=lambda item: item[1])


def _json_object(payload: bytes, maximum_bytes: int, source: str) -> dict[str, Any]:
    if len(payload) > maximum_bytes:
        raise ValueError(f"{source} JSON exceeds size limit")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid {source} JSON") from error
    if not isinstance(value, dict):
        raise ValueError(f"{source} JSON root must be an object")
    return value


def parse_tide_catalog(payload: bytes) -> tuple[list[TideStation], str]:
    """Parse the public catalog consumed by the official BSH tide website.

    ``gauge_group`` 3 contains Baltic Sea gauges. Groups 1 and 2 are the
    North Sea/tidal-river stations for which the site provides HW/NW events.
    Filtering happens here so an Ostsee gauge can never be selected merely
    because it is geographically close.
    """

    root = _json_object(payload, MAX_TIDE_CATALOG_BYTES, "BSH tide catalog")
    copyright_note = str(root.get("copyright_note") or "").strip()
    if "Bundesamt für Seeschifffahrt und Hydrographie" not in copyright_note:
        raise ValueError("BSH tide catalog attribution is missing")
    stations: list[TideStation] = []
    gauges = root.get("gauges")
    if not isinstance(gauges, list):
        raise ValueError("BSH tide catalog has no gauges")
    for item in gauges:
        if not isinstance(item, dict):
            continue
        station_id = str(item.get("bshnr") or "").strip()
        name = " ".join(str(item.get("station_name") or "").split())
        try:
            latitude = float(item.get("latitude"))
            longitude = float(item.get("longitude"))
            gauge_group = int(item.get("gauge_group"))
        except (TypeError, ValueError):
            continue
        if (
            gauge_group not in (1, 2)
            or not re.fullmatch(r"[A-Za-z0-9]{2,5}", station_id)
            or not name
            or not math.isfinite(latitude)
            or not math.isfinite(longitude)
            or not (-90 <= latitude <= 90 and -180 <= longitude <= 180)
        ):
            continue
        stations.append(TideStation(station_id, name, latitude, longitude, gauge_group))
    if not stations:
        raise ValueError("BSH tide catalog contains no North Sea gauges")
    return stations, copyright_note


def nearest_tide_station(
    stations: Iterable[TideStation], latitude: float, longitude: float
) -> tuple[TideStation, float]:
    candidates = [
        (station, haversine_km(latitude, longitude, station.latitude, station.longitude))
        for station in stations
    ]
    if not candidates:
        raise ValueError("no BSH tide stations available")
    return min(candidates, key=lambda item: item[1])


def tide_station_url(station_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9]{2,5}", station_id):
        raise ValueError("invalid BSH station id")
    return TIDE_STATION_URL.format(station=station_id.rjust(5, "_"))


def parse_bsh_time(value: Any) -> dt.datetime | None:
    """Parse BSH timestamps without inventing a timezone.

    The official JSON uses year-round ``+01:00`` (MEZ), including summer.
    Keeping that explicit offset and converting to UTC means a Berlin client
    will correctly display the legal summer time one hour later.
    """

    text = str(value or "").strip()
    if not text or not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", text):
        return None
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(dt.timezone.utc)


def parse_utc_z(value: Any) -> dt.datetime | None:
    text = str(value or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", text):
        return None
    return parse_time(text)


def parse_tide_station(
    payload: bytes,
    expected_station_id: str,
    now: dt.datetime,
) -> tuple[str, str, list[dict[str, Any]]]:
    """Normalize at most a small future window from the annual BSH file."""

    root = _json_object(payload, MAX_TIDE_STATION_BYTES, "BSH station tide")
    station_id = str(root.get("bshnr") or "").strip()
    if station_id != expected_station_id:
        raise ValueError("BSH station response does not match requested gauge")
    station_name = " ".join(str(root.get("station_name") or "").split())
    years = root.get("years")
    if not station_name or not isinstance(years, list):
        raise ValueError("BSH station tide response is incomplete")

    current = now.astimezone(dt.timezone.utc)
    candidates: list[tuple[dt.datetime, dict[str, Any]]] = []
    reference_levels: set[str] = set()
    for year_item in years:
        if not isinstance(year_item, dict):
            continue
        for year, details in year_item.items():
            if not re.fullmatch(r"\d{4}", str(year)) or not isinstance(details, dict):
                continue
            prediction = details.get("hwnw_prediction")
            if not isinstance(prediction, dict):
                continue
            reference = str(prediction.get("level") or details.get("level_tidalvalues") or "").strip().upper()
            if reference:
                reference_levels.add(reference)
            data = prediction.get("data")
            if not isinstance(data, list):
                continue
            for item in data:
                if not isinstance(item, dict):
                    continue
                event_type = str(item.get("type") or "").strip().upper()
                timestamp = parse_bsh_time(item.get("timestamp"))
                if (
                    event_type not in ("HW", "NW")
                    or timestamp is None
                    or timestamp < current
                    or timestamp > current + dt.timedelta(seconds=TIDE_EVENT_HORIZON_SECONDS)
                ):
                    continue
                height_m: float | None = None
                height = item.get("height")
                if height is not None:
                    try:
                        numeric_height = float(height)
                    except (TypeError, ValueError):
                        numeric_height = math.nan
                    if math.isfinite(numeric_height) and abs(numeric_height) <= 20000:
                        # BSH publishes integer centimetres above the declared
                        # reference level; the transport uses metres.
                        height_m = round(numeric_height / 100.0, 2)
                candidates.append(
                    (
                        timestamp,
                        {
                            "t": iso_utc(timestamp),
                            "type": event_type,
                            "heightM": height_m,
                        },
                    )
                )

    if len(reference_levels) != 1 or reference_levels != {"PNP"}:
        raise ValueError("BSH tide reference level is not unambiguously PNP")
    candidates.sort(key=lambda item: item[0])
    events: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for _timestamp, event in candidates:
        key = (str(event["t"]), str(event["type"]))
        if key in seen:
            continue
        seen.add(key)
        events.append(event)
        if len(events) >= TIDE_CACHE_EVENT_LIMIT:
            break
    if not any(item["type"] == "HW" for item in events) or not any(item["type"] == "NW" for item in events):
        raise ValueError("BSH station tide response has no future HW/NW pair")
    return station_name, "PNP", events


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _element_attribute(element: ET.Element, wanted: str) -> str:
    for name, value in element.attrib.items():
        if _local_name(name).lower() == wanted.lower():
            return value
    return ""


def _first_text(root: ET.Element, name: str) -> str:
    for element in root.iter():
        if _local_name(element.tag) == name and element.text:
            return element.text.strip()
    return ""


def _series_value(token: str) -> float | None:
    text = token.strip()
    if not text or text == "-":
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if not math.isfinite(value) or value <= -999:
        return None
    return value


def _parse_kmz(kmz: bytes) -> ET.Element:
    if len(kmz) > MAX_KMZ_BYTES:
        raise ValueError("DWD KMZ exceeds size limit")
    with zipfile.ZipFile(io.BytesIO(kmz)) as archive:
        members = [item for item in archive.infolist() if not item.is_dir() and item.filename.lower().endswith(".kml")]
        if len(members) != 1:
            raise ValueError("DWD KMZ must contain exactly one KML file")
        member = members[0]
        if Path(member.filename).name != member.filename or member.file_size > MAX_KML_BYTES:
            raise ValueError("unsafe or oversized DWD KML member")
        payload = archive.read(member)
    if len(payload) > MAX_KML_BYTES:
        raise ValueError("DWD KML exceeds size limit")
    upper_prefix = payload[:4096].upper()
    if b"<!DOCTYPE" in upper_prefix or b"<!ENTITY" in upper_prefix:
        raise ValueError("unsafe DWD KML document type")
    return ET.fromstring(payload)


def parse_mosmix_kmz(kmz: bytes) -> tuple[str | None, str, dict[str, list[float | None]], list[dt.datetime]]:
    root = _parse_kmz(kmz)
    times: list[dt.datetime] = []
    for element in root.iter():
        if _local_name(element.tag) != "TimeStep" or not element.text:
            continue
        parsed = parse_time(element.text)
        if parsed is not None:
            times.append(parsed)
    if not times:
        raise ValueError("DWD forecast has no time steps")

    station_name = ""
    for placemark in root.iter():
        if _local_name(placemark.tag) != "Placemark":
            continue
        station_name = _first_text(placemark, "description") or _first_text(placemark, "name")
        break

    series: dict[str, list[float | None]] = {}
    wanted = {"TTT", "R101", "RR1c", "DD", "FF", "FX1", "ww"}
    for element in root.iter():
        if _local_name(element.tag) != "Forecast":
            continue
        element_name = _element_attribute(element, "elementName")
        if element_name not in wanted:
            continue
        value_text = ""
        for child in element.iter():
            if _local_name(child.tag) == "value" and child.text:
                value_text = child.text
                break
        values = [_series_value(token) for token in value_text.split()]
        if len(values) < len(times):
            values.extend([None] * (len(times) - len(values)))
        series[element_name] = values[: len(times)]

    issue_time = parse_time(_first_text(root, "IssueTime"))
    return iso_utc(issue_time), station_name, series, times


def weather_icon(code: float | None) -> str:
    if code is None:
        return "unknown"
    value = int(round(code))
    if value in (95, 96, 97, 98, 99):
        return "storm"
    if value in range(71, 80) or value in (85, 86):
        return "snow"
    if value in range(45, 50):
        return "fog"
    if value in range(50, 70) or value in range(80, 85):
        return "rain"
    if value == 0:
        return "clear"
    if value in (1, 2):
        return "partly-cloudy"
    return "cloudy"


def _normalized_hour(series: dict[str, list[float | None]], times: list[dt.datetime], index: int) -> dict[str, Any]:
    def item(name: str) -> float | None:
        values = series.get(name, [])
        return values[index] if index < len(values) else None

    temperature_k = item("TTT")
    weather_code = item("ww")
    return {
        "t": iso_utc(times[index]),
        "tempC": None if temperature_k is None else round(temperature_k - 273.15, 1),
        "precipProbabilityPct": None if item("R101") is None else round(max(0.0, min(100.0, item("R101") or 0.0))),
        "precipMm": None if item("RR1c") is None else round(max(0.0, item("RR1c") or 0.0), 2),
        "ww": None if weather_code is None else int(round(weather_code)),
        "icon": weather_icon(weather_code),
        "windKmh": None if item("FF") is None else round(max(0.0, item("FF") or 0.0) * 3.6, 1),
        "windDeg": None if item("DD") is None else round((item("DD") or 0.0) % 360.0),
        "gustKmh": None if item("FX1") is None else round(max(0.0, item("FX1") or 0.0) * 3.6, 1),
    }


def _sun_event(date: dt.date, latitude: float, longitude: float, sunrise: bool) -> dt.datetime | None:
    zenith = math.radians(90.833)
    day = date.timetuple().tm_yday
    longitude_hour = longitude / 15.0
    approximate = day + ((6.0 if sunrise else 18.0) - longitude_hour) / 24.0
    mean_anomaly = 0.9856 * approximate - 3.289
    anomaly_rad = math.radians(mean_anomaly)
    true_longitude = (mean_anomaly + 1.916 * math.sin(anomaly_rad) + 0.020 * math.sin(2 * anomaly_rad) + 282.634) % 360.0
    right_ascension = math.degrees(math.atan(0.91764 * math.tan(math.radians(true_longitude)))) % 360.0
    right_ascension += math.floor(true_longitude / 90.0) * 90.0 - math.floor(right_ascension / 90.0) * 90.0
    right_ascension /= 15.0
    sin_declination = 0.39782 * math.sin(math.radians(true_longitude))
    cos_declination = math.cos(math.asin(sin_declination))
    denominator = cos_declination * math.cos(math.radians(latitude))
    if abs(denominator) < 1e-12:
        return None
    cos_hour = (math.cos(zenith) - sin_declination * math.sin(math.radians(latitude))) / denominator
    if cos_hour > 1.0 or cos_hour < -1.0:
        return None
    hour_angle = 360.0 - math.degrees(math.acos(cos_hour)) if sunrise else math.degrees(math.acos(cos_hour))
    local_mean = hour_angle / 15.0 + right_ascension - 0.06571 * approximate - 6.622
    utc_hour = (local_mean - longitude_hour) % 24.0
    midnight = dt.datetime.combine(date, dt.time.min, tzinfo=dt.timezone.utc)
    return midnight + dt.timedelta(hours=utc_hour)


def _safe_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def build_snapshot(
    station: Station,
    distance_km: float | None,
    timezone_name: str,
    model_run_utc: str | None,
    station_name: str,
    series: dict[str, list[float | None]],
    times: list[dt.datetime],
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    now_utc = (now or utc_now()).astimezone(dt.timezone.utc)
    timezone = _safe_timezone(timezone_name)
    all_hours = [_normalized_hour(series, times, index) for index in range(len(times))]
    future_hours = [item for item in all_hours if (parse_time(item["t"]) or now_utc) >= now_utc - dt.timedelta(minutes=30)]
    hourly = future_hours[:48]

    by_date: dict[dt.date, list[dict[str, Any]]] = {}
    for item in future_hours:
        timestamp = parse_time(item["t"])
        if timestamp is None:
            continue
        by_date.setdefault(timestamp.astimezone(timezone).date(), []).append(item)

    today = now_utc.astimezone(timezone).date()
    daily: list[dict[str, Any]] = []
    for offset in range(6):
        date = today + dt.timedelta(days=offset)
        items = by_date.get(date, [])
        temperatures = [item["tempC"] for item in items if item["tempC"] is not None]
        amounts = [item["precipMm"] for item in items if item["precipMm"] is not None]
        probabilities = [item["precipProbabilityPct"] for item in items if item["precipProbabilityPct"] is not None]
        winds = [item["windKmh"] for item in items if item["windKmh"] is not None]
        gusts = [item["gustKmh"] for item in items if item["gustKmh"] is not None]
        codes = [item["ww"] for item in items if item["ww"] is not None]
        representative = max(codes, default=None, key=lambda code: (weather_icon(code) != "clear", code))
        rise = _sun_event(date, station.latitude, station.longitude, True)
        setting = _sun_event(date, station.latitude, station.longitude, False)
        daily.append(
            {
                "date": date.isoformat(),
                "minC": None if not temperatures else round(min(temperatures), 1),
                "maxC": None if not temperatures else round(max(temperatures), 1),
                # A missing DWD hour must not silently become zero in an aggregate.
                "precipMm": None if not items or len(amounts) != len(items) else round(sum(amounts), 1),
                "maxHourlyPrecipProbabilityPct": (
                    None if not items or len(probabilities) != len(items) else round(max(probabilities))
                ),
                "ww": representative,
                "icon": weather_icon(representative),
                "windMaxKmh": None if not winds else round(max(winds), 1),
                "gustMaxKmh": None if not gusts else round(max(gusts), 1),
                "riseUtc": iso_utc(rise),
                "setUtc": iso_utc(setting),
            }
        )

    snapshot: dict[str, Any] = {
        "schema": SCHEMA_VERSION,
        "source": SOURCE_NAME,
        "attribution": SOURCE_ATTRIBUTION,
        "station": {
            "id": station.station_id,
            "name": station_name or station.name,
        },
        "modelRunUtc": model_run_utc,
        "fetchedAtUtc": iso_utc(now_utc),
        "stale": False,
        "timezone": timezone_name or "UTC",
        "sun": {
            "date": today.isoformat(),
            "riseUtc": daily[0]["riseUtc"] if daily else None,
            "setUtc": daily[0]["setUtc"] if daily else None,
            "origin": "calculated",
        },
        "hourly": hourly,
        "daily": daily,
    }
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise ValueError("normalized weather snapshot exceeds size limit")
    return snapshot


def mark_stale(snapshot: dict[str, Any], now: dt.datetime | None = None) -> dict[str, Any]:
    copy = json.loads(json.dumps(snapshot))
    fetched = parse_time(copy.get("fetchedAtUtc"))
    current = (now or utc_now()).astimezone(dt.timezone.utc)
    copy["stale"] = fetched is None or (current - fetched).total_seconds() >= STALE_AFTER_SECONDS
    cutoff = current - dt.timedelta(hours=1)
    copy["hourly"] = [
        item
        for item in copy.get("hourly", [])
        if isinstance(item, dict) and (parse_time(item.get("t")) or dt.datetime.min.replace(tzinfo=dt.timezone.utc)) >= cutoff
    ][:48]
    timezone = _safe_timezone(str(copy.get("timezone") or "UTC"))
    today = current.astimezone(timezone).date()
    copy["daily"] = [
        item
        for item in copy.get("daily", [])
        if isinstance(item, dict)
        and isinstance(item.get("date"), str)
        and item["date"] >= today.isoformat()
    ][:6]
    sun = copy.get("sun")
    if isinstance(sun, dict) and sun.get("date") != today.isoformat():
        copy["sun"] = {"date": today.isoformat(), "riseUtc": None, "setUtc": None, "origin": "calculated"}
    return copy


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def load_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _read_limited(path: Path, maximum_bytes: int) -> bytes:
    with path.open("rb") as handle:
        payload = handle.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise ValueError("cached file exceeds size limit")
    return payload


def load_json_limited(path: Path, maximum_bytes: int) -> dict[str, Any] | None:
    try:
        payload = _read_limited(path, maximum_bytes)
        value = json.loads(payload.decode("utf-8"))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def save_json(path: Path, value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    _atomic_write(path, payload)


def _encoded_json(value: dict[str, Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _valid_tide_cache(value: dict[str, Any], now: dt.datetime) -> dict[str, Any] | None:
    if value.get("schema") != 1 or value.get("referenceLevel") != "PNP":
        return None
    updated = parse_utc_z(value.get("updatedUtc"))
    current = now.astimezone(dt.timezone.utc)
    if updated is None or updated > current + dt.timedelta(minutes=5):
        return None
    age_seconds = (current - updated).total_seconds()
    if age_seconds >= TIDE_FAIL_CLOSED_SECONDS:
        return None
    station = value.get("station")
    if not isinstance(station, dict):
        return None
    station_id = str(station.get("id") or "")
    station_name = " ".join(str(station.get("name") or "").split())
    try:
        distance_km = float(station.get("distanceKm"))
    except (TypeError, ValueError):
        return None
    if (
        not re.fullmatch(r"[A-Za-z0-9]{2,5}", station_id)
        or not station_name
        or not math.isfinite(distance_km)
        or not (0 <= distance_km <= TIDE_MAX_DISTANCE_KM)
    ):
        return None

    normalized_events: list[dict[str, Any]] = []
    events = value.get("events")
    if not isinstance(events, list) or len(events) > TIDE_CACHE_EVENT_LIMIT:
        return None
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or "").upper()
        timestamp = parse_utc_z(event.get("t"))
        if event_type not in ("HW", "NW") or timestamp is None or timestamp < current:
            continue
        height_m = event.get("heightM")
        if height_m is not None:
            try:
                height_m = round(float(height_m), 2)
            except (TypeError, ValueError):
                height_m = None
            if height_m is not None and (not math.isfinite(height_m) or abs(height_m) > 200):
                height_m = None
        normalized_events.append({"t": iso_utc(timestamp), "type": event_type, "heightM": height_m})
    normalized_events.sort(key=lambda item: str(item["t"]))
    next_high = next((item for item in normalized_events if item["type"] == "HW"), None)
    next_low = next((item for item in normalized_events if item["type"] == "NW"), None)
    if next_high is None or next_low is None:
        return None

    return {
        "source": TIDE_SOURCE_NAME,
        "attribution": TIDE_ATTRIBUTION,
        "station": {
            "id": station_id,
            "name": station_name,
            "distanceKm": round(distance_km, 1),
        },
        "updatedUtc": iso_utc(updated),
        "stale": age_seconds >= TIDE_STALE_AFTER_SECONDS,
        "referenceLevel": "PNP",
        "nextHigh": {"t": next_high["t"], "heightM": next_high["heightM"]},
        "nextLow": {"t": next_low["t"], "heightM": next_low["heightM"]},
    }


def _decode_catalog(payload: bytes) -> str:
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        return payload.decode("latin-1")


def _download(url: str, maximum_bytes: int, timeout: float = 30.0) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "*/*",
            "User-Agent": "CamperControl/1.0 (+https://github.com/victronenergy/gui-v2)",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        declared = int(response.headers.get("Content-Length") or 0)
        if declared > maximum_bytes:
            raise ValueError("download exceeds size limit")
        payload = response.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise ValueError("download exceeds size limit")
    return payload


def _parse_dbus_output(output: str) -> Any:
    """Parse both dbus CLI formats used by Venus OS releases.

    Some services print ``value = ...`` while others return the scalar alone.
    Treat empty/oversized output as unavailable and never interpret stderr.
    """
    text = str(output or "").strip()
    if not text or len(text) > 4096:
        return None
    match = re.search(r"^\s*value\s*=\s*(.+?)\s*$", text, re.MULTILINE | re.IGNORECASE)
    raw = (match.group(1) if match else text).strip()
    if not raw or raw.lower().startswith(("error", "failed", "traceback")):
        return None
    try:
        return ast.literal_eval(raw)
    except (SyntaxError, ValueError):
        try:
            return float(raw)
        except ValueError:
            return raw.strip("'\"") or None


def _dbus_value(service: str, path: str) -> Any:
    result = subprocess.run(
        ["dbus", "-y", service, path, "GetValue"],
        capture_output=True,
        text=True,
        timeout=6,
        check=False,
    )
    if result.returncode != 0:
        return None
    return _parse_dbus_output(result.stdout)


def read_gx_position() -> tuple[float, float] | None:
    service = _dbus_value("com.victronenergy.system", "/GpsService")
    if not isinstance(service, str) or not service.startswith("com.victronenergy."):
        return None
    connected = _dbus_value(service, "/Connected")
    fix = _dbus_value(service, "/Fix")
    try:
        if int(connected) != 1 or int(fix) < 1:
            return None
    except (TypeError, ValueError):
        return None
    latitude = _dbus_value(service, "/Position/Latitude")
    longitude = _dbus_value(service, "/Position/Longitude")
    try:
        lat = float(latitude)
        lon = float(longitude)
    except (TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return lat, lon


def read_gx_timezone() -> str:
    value = _dbus_value("com.victronenergy.settings", "/Settings/System/TimeZone")
    candidate = value.strip().lstrip("/") if isinstance(value, str) else ""
    if not candidate:
        return "UTC"
    try:
        ZoneInfo(candidate)
    except (KeyError, ValueError):
        return "UTC"
    return candidate


class WeatherProvider:
    def __init__(
        self,
        cache_path: Path = DEFAULT_CACHE_PATH,
        catalog_path: Path = DEFAULT_CATALOG_PATH,
        station_config_path: Path = DEFAULT_STATION_CONFIG_PATH,
        tide_cache_path: Path = DEFAULT_TIDE_CACHE_PATH,
        tide_catalog_path: Path = DEFAULT_TIDE_CATALOG_PATH,
        download: Callable[[str, int], bytes] = _download,
        position_reader: Callable[[], tuple[float, float] | None] = read_gx_position,
        timezone_reader: Callable[[], str] = read_gx_timezone,
        now: Callable[[], dt.datetime] = utc_now,
    ) -> None:
        self.cache_path = cache_path
        self.catalog_path = catalog_path
        self.station_config_path = station_config_path
        self.tide_cache_path = tide_cache_path
        self.tide_catalog_path = tide_catalog_path
        self.download = download
        self.position_reader = position_reader
        self.timezone_reader = timezone_reader
        self.now = now
        self._tide_next_attempt: dt.datetime | None = None

    def cached(self) -> dict[str, Any] | None:
        value = load_json(self.cache_path)
        if not value:
            return None
        current = self.now()
        snapshot = mark_stale(value, current)
        tides = _valid_tide_cache(
            load_json_limited(self.tide_cache_path, MAX_TIDE_CACHE_BYTES) or {},
            current,
        )
        if tides is None:
            snapshot.pop("tides", None)
        else:
            snapshot["tides"] = tides
        if len(_encoded_json(snapshot)) > MAX_SNAPSHOT_BYTES:
            snapshot.pop("tides", None)
        return snapshot

    def _catalog(self) -> list[Station]:
        cached_stations: list[Station] | None = None
        cache_is_fresh = False
        try:
            cached = _decode_catalog(self.catalog_path.read_bytes())
            cached_stations = parse_station_catalog(cached)
            cache_is_fresh = self.now().timestamp() - self.catalog_path.stat().st_mtime < CATALOG_REFRESH_SECONDS
        except (OSError, UnicodeDecodeError, ValueError):
            pass
        if cached_stations is not None and cache_is_fresh:
            return cached_stations
        last_error: Exception | None = None
        for url in STATION_CATALOG_URLS:
            try:
                payload = self.download(url, MAX_CATALOG_BYTES)
                text = _decode_catalog(payload)
                stations = parse_station_catalog(text)
                _atomic_write(self.catalog_path, payload)
                return stations
            except (OSError, ValueError, UnicodeError, urllib.error.URLError) as error:
                last_error = error
        if cached_stations is not None:
            return cached_stations
        raise RuntimeError(f"DWD station catalog unavailable: {last_error}")

    def _tide_catalog(self) -> list[TideStation]:
        cached_stations: list[TideStation] | None = None
        cache_is_fresh = False
        try:
            cached_payload = _read_limited(self.tide_catalog_path, MAX_TIDE_CATALOG_BYTES)
            cached_stations, _copyright = parse_tide_catalog(cached_payload)
            cache_is_fresh = (
                self.now().timestamp() - self.tide_catalog_path.stat().st_mtime
                < TIDE_CATALOG_REFRESH_SECONDS
            )
        except (OSError, ValueError, UnicodeError):
            pass
        if cached_stations is not None and cache_is_fresh:
            return cached_stations
        try:
            payload = self.download(TIDE_CATALOG_URL, MAX_TIDE_CATALOG_BYTES)
            stations, _copyright = parse_tide_catalog(payload)
            _atomic_write(self.tide_catalog_path, payload)
            return stations
        except (OSError, ValueError, UnicodeError, urllib.error.URLError):
            if cached_stations is not None:
                return cached_stations
            raise

    def _tides_for_position(self, position: tuple[float, float] | None) -> dict[str, Any] | None:
        current = self.now().astimezone(dt.timezone.utc)
        cached_value = load_json_limited(self.tide_cache_path, MAX_TIDE_CACHE_BYTES) or {}
        if position is None:
            # Tide selection is location-sensitive. A cached weather station or
            # manual DWD override is not evidence that the vehicle is still
            # close to the cached BSH gauge.
            return None

        try:
            stations = self._tide_catalog()
            station, distance_km = nearest_tide_station(stations, *position)
        except (OSError, ValueError, UnicodeError, urllib.error.URLError):
            self._tide_next_attempt = current + dt.timedelta(seconds=TIDE_RETRY_SECONDS)
            return None
        if distance_km > TIDE_MAX_DISTANCE_KM:
            return None

        cached_station = cached_value.get("station") if isinstance(cached_value.get("station"), dict) else {}
        cached_station_id = str((cached_station or {}).get("id") or "")
        cached_updated = parse_time(cached_value.get("updatedUtc"))
        cached_matches = cached_station_id == station.station_id
        if cached_matches:
            # Distance is derived from the current fix. It is safe to update in
            # memory, while exact GPS coordinates are never persisted or logged.
            cached_value = json.loads(json.dumps(cached_value))
            cached_value["station"]["distanceKm"] = round(distance_km, 1)
            cached_tides = _valid_tide_cache(cached_value, current)
        else:
            cached_tides = None

        if (
            cached_tides is not None
            and cached_updated is not None
            and (current - cached_updated).total_seconds() < TIDE_REFRESH_SECONDS
        ):
            return cached_tides
        if self._tide_next_attempt is not None and current < self._tide_next_attempt:
            return cached_tides

        try:
            payload = self.download(tide_station_url(station.station_id), MAX_TIDE_STATION_BYTES)
            station_name, reference_level, events = parse_tide_station(
                payload,
                station.station_id,
                current,
            )
            normalized_cache = {
                "schema": 1,
                "station": {
                    "id": station.station_id,
                    "name": station_name or station.name,
                    "distanceKm": round(distance_km, 1),
                },
                "updatedUtc": iso_utc(current),
                "referenceLevel": reference_level,
                "events": events,
            }
            encoded = _encoded_json(normalized_cache)
            if len(encoded) > MAX_TIDE_CACHE_BYTES:
                raise ValueError("normalized BSH tide cache exceeds size limit")
            _atomic_write(self.tide_cache_path, encoded)
            self._tide_next_attempt = None
            return _valid_tide_cache(normalized_cache, current)
        except (OSError, ValueError, UnicodeError, urllib.error.URLError):
            self._tide_next_attempt = current + dt.timedelta(seconds=TIDE_RETRY_SECONDS)
            return cached_tides

    def _manual_station_id(self) -> str:
        configured = os.environ.get("CAMPER_WEATHER_STATION", "").strip()
        if not configured:
            try:
                configured = self.station_config_path.read_text(encoding="ascii").splitlines()[0].strip()
            except (OSError, IndexError, UnicodeError):
                configured = ""
        return configured if re.fullmatch(r"[A-Za-z0-9]{5}", configured) else ""

    def _select_station(
        self,
        stations: list[Station],
        position: tuple[float, float] | None = None,
    ) -> tuple[Station, float | None]:
        manual = self._manual_station_id()
        if manual:
            for station in stations:
                if station.station_id == manual:
                    return station, None
            raise ValueError(f"configured DWD station {manual} is unknown")
        if position is not None:
            return nearest_station(stations, *position)
        cached = load_json(self.cache_path) or {}
        cached_id = str((cached.get("station") or {}).get("id") or "")
        for station in stations:
            if station.station_id == cached_id:
                return station, None
        raise RuntimeError("no GX GPS fix, cached station or manual DWD station")

    def refresh(self) -> dict[str, Any]:
        stations = self._catalog()
        position = self.position_reader()
        station, distance = self._select_station(stations, position)
        kmz = self.download(FORECAST_URL.format(station=station.station_id), MAX_KMZ_BYTES)
        model_run, station_name, series, times = parse_mosmix_kmz(kmz)
        snapshot = build_snapshot(
            station=station,
            distance_km=distance,
            timezone_name=self.timezone_reader(),
            model_run_utc=model_run,
            station_name=station_name,
            series=series,
            times=times,
            now=self.now(),
        )
        tides = self._tides_for_position(position)
        if tides is not None:
            snapshot["tides"] = tides
        if len(_encoded_json(snapshot)) > MAX_SNAPSHOT_BYTES:
            raise ValueError("normalized weather snapshot exceeds size limit")
        save_json(self.cache_path, snapshot)
        return snapshot
