#!/usr/bin/env python3

import datetime as dt
import gzip
import importlib.util
import io
import json
import math
import os
import pathlib
import sys
import tempfile
import unittest
import zipfile
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "cerbo-service" / "campercontrol_weather.py"
FIXTURE_PATH = pathlib.Path(__file__).parent / "fixtures"
SPEC = importlib.util.spec_from_file_location("campercontrol_weather_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

BSH_OVERVIEW = (FIXTURE_PATH / "bsh-tides-overview.json").read_bytes()
BSH_STATION = (FIXTURE_PATH / "bsh-tides-station.json").read_bytes()


def bsh_hits(count: int) -> bytes:
    return json.dumps(
        {
            "type": "FeatureCollection",
            "numberReturned": count,
            "numberMatched": count,
            "timeStamp": "2026-08-20T10:00:00Z",
            "features": [],
        }
    ).encode()


def bsh_station(
    station_id: str,
    name: str = "Nordsee Testpegel",
    latitude: float = 53.5,
    longitude: float = 8.1,
    region: str = "north_sea",
) -> bytes:
    value = json.loads(BSH_STATION)
    value["id"] = station_id
    value["geometry"] = {"type": "Point", "coordinates": [longitude, latitude]}
    value["properties"]["gauge_label"] = name
    value["properties"]["region"] = region
    return json.dumps(value).encode()


def write_location_config(
    path: pathlib.Path,
    *,
    weather_mode: str = "gps",
    weather_station_id: str = "",
    tide_mode: str = "gps",
    tide_station_id: str = "",
) -> None:
    path.write_text(
        json.dumps(
            {
                "schema": 1,
                "weather": {"mode": weather_mode, "stationId": weather_station_id},
                "tide": {"mode": tide_mode, "stationId": tide_station_id},
            }
        ),
        encoding="utf-8",
    )


CATALOG = """ID    ICAO NAME                 LAT    LON     ELEV
----- ---- -------------------- -----  ------- -----
10641 ---- OFFENBACH-WETTERPARK  50.06    8.48   119
10866 ---- MUENCHEN-STADT         48.08   11.33   515
"""


def sample_kmz() -> bytes:
    times = [dt.datetime(2026, 8, 19, hour, tzinfo=dt.timezone.utc) for hour in range(12)]
    steps = "".join(f"<dwd:TimeStep>{value.isoformat().replace('+00:00', 'Z')}</dwd:TimeStep>" for value in times)
    rows = {
        "TTT": "293.15 294.15 295.15 296.15 297.15 298.15 299.15 300.15 298.15 296.15 294.15 293.15",
        "R101": "5 10 20 30 40 50 60 70 45 25 10 -",
        "RR1c": "0 0 0.1 0.2 0.4 0.8 1.2 0.3 0.1 0 0 -",
        "DD": "180 180 190 190 200 200 210 210 200 190 180 180",
        "FF": "2 2 3 3 4 4 5 5 4 3 2 2",
        "FX1": "4 4 5 5 7 7 9 9 7 5 4 4",
        "ww": "0 1 2 3 51 61 80 95 61 3 2 -",
    }
    forecasts = "".join(
        f'<dwd:Forecast dwd:elementName="{name}"><dwd:value>{values}</dwd:value></dwd:Forecast>'
        for name, values in rows.items()
    )
    kml = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"
 xmlns:dwd="https://opendata.dwd.de/weather/lib/pointforecast_dwd_extension_V1_0.xsd">
 <kml:Document>
  <dwd:ProductDefinition><dwd:IssueTime>2026-08-18T21:00:00Z</dwd:IssueTime>
   <dwd:ForecastTimeSteps>{steps}</dwd:ForecastTimeSteps>
  </dwd:ProductDefinition>
  <kml:Placemark><kml:name>10641</kml:name><kml:description>OFFENBACH-WETTERPARK</kml:description>
   <kml:ExtendedData>{forecasts}</kml:ExtendedData>
   <kml:Point><kml:coordinates>8.80,50.10,119</kml:coordinates></kml:Point>
  </kml:Placemark>
 </kml:Document>
</kml:kml>""".encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("MOSMIX_L_LATEST_10641.kml", kml)
    return output.getvalue()


class CamperControlWeatherTest(unittest.TestCase):
    def test_all_official_mosmix_ww_codes_and_defensive_hail_are_classified(self):
        expected = {
            0: "clear",
            1: "partly-cloudy",
            2: "partly-cloudy",
            3: "cloudy",
            45: "fog",
            49: "fog",
            51: "drizzle",
            53: "drizzle",
            55: "drizzle",
            56: "freezing-rain",
            57: "freezing-rain",
            61: "rain",
            63: "rain",
            65: "rain",
            66: "freezing-rain",
            67: "freezing-rain",
            68: "sleet",
            69: "sleet",
            71: "snow",
            73: "snow",
            75: "snow",
            80: "showers",
            81: "showers",
            82: "showers",
            83: "sleet",
            84: "sleet",
            85: "snow",
            86: "snow",
            95: "thunderstorm",
        }
        self.assertEqual(set(MODULE.MOSMIX_WW), set(expected))
        self.assertEqual({code: MODULE.weather_icon(code) for code in expected}, expected)
        self.assertEqual(MODULE.weather_icon(96), "hail")
        self.assertEqual(MODULE.weather_icon(99), "hail")
        self.assertEqual(MODULE.weather_icon(97), "thunderstorm")
        self.assertEqual(MODULE.weather_icon(98), "thunderstorm")
        self.assertEqual(MODULE.weather_icon(77), "unknown")
        self.assertEqual(MODULE.weather_icon(None), "unknown")

    def test_daily_representative_uses_official_dwd_priority_not_numeric_order(self):
        ordered = [95, 57, 56, 67, 66, 86, 85, 84, 83, 82, 81, 80, 75, 73, 71, 69, 68, 55, 53, 51, 65, 63, 61, 49, 45, 3, 2, 1, 0]
        self.assertEqual(
            sorted(ordered, key=MODULE.weather_priority),
            ordered,
        )
        self.assertLess(MODULE.weather_priority(57), MODULE.weather_priority(67))
        self.assertLess(MODULE.weather_priority(51), MODULE.weather_priority(65))

    def test_dbus_parser_accepts_plain_and_value_formats_used_by_venus(self):
        self.assertEqual(MODULE._parse_dbus_output("'com.victronenergy.gps.ve_ttyACM0'\n"), "com.victronenergy.gps.ve_ttyACM0")
        self.assertEqual(MODULE._parse_dbus_output("0\n"), 0)
        self.assertEqual(MODULE._parse_dbus_output("value = 51.2345\n"), 51.2345)
        self.assertEqual(MODULE._parse_dbus_output("value = 'service'\n"), "service")
        self.assertIsNone(MODULE._parse_dbus_output(""))
        self.assertIsNone(MODULE._parse_dbus_output("Error: unavailable"))

    def test_live_mixed_dbus_formats_produce_gps_fix_and_normalized_timezone(self):
        values = {
            ("com.victronenergy.system", "/GpsService"): "'com.victronenergy.gps.ve_ttyACM0'\n",
            ("com.victronenergy.gps.ve_ttyACM0", "/Connected"): "value = 1\n",
            ("com.victronenergy.gps.ve_ttyACM0", "/Fix"): "value = 1\n",
            ("com.victronenergy.gps.ve_ttyACM0", "/Position/Latitude"): "value = 51.2345\n",
            ("com.victronenergy.gps.ve_ttyACM0", "/Position/Longitude"): "value = 7.1234\n",
            ("com.victronenergy.settings", "/Settings/System/TimeZone"): "'/UTC'\n",
        }

        def run(command, **_kwargs):
            key = (command[2], command[3])
            return type("Result", (), {"returncode": 0, "stdout": values[key]})()

        with mock.patch.object(MODULE.subprocess, "run", side_effect=run):
            self.assertEqual(MODULE.read_gx_position(), (51.2345, 7.1234))
            self.assertEqual(MODULE.read_gx_timezone(), "UTC")

    def test_location_config_is_bounded_validated_and_legacy_weather_only(self):
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            location = base / "weather-location.json"
            legacy = base / "weather-station.conf"
            provider = MODULE.WeatherProvider(
                station_config_path=legacy,
                location_config_path=location,
            )

            legacy.write_text("10641\n", encoding="ascii")
            self.assertEqual(
                provider._location_config(),
                {
                    "schema": 1,
                    "weather": {"mode": "station", "stationId": "10641"},
                    "tide": {"mode": "gps", "stationId": ""},
                },
            )

            write_location_config(
                location,
                weather_mode="station",
                weather_station_id="a1234",
                tide_mode="station",
                tide_station_id="wilhelmshaven_alter_vorhafen",
            )
            self.assertEqual(provider._location_config()["weather"]["stationId"], "A1234")
            self.assertEqual(
                provider._location_config()["tide"]["stationId"],
                "wilhelmshaven_alter_vorhafen",
            )

            invalid = [
                {"schema": 2, "weather": {"mode": "gps", "stationId": ""}, "tide": {"mode": "gps", "stationId": ""}},
                {"schema": 1, "weather": {"mode": "automatic", "stationId": ""}, "tide": {"mode": "gps", "stationId": ""}},
                {"schema": 1, "weather": {"mode": "station", "stationId": "../x"}, "tide": {"mode": "gps", "stationId": ""}},
                {"schema": 1, "weather": {"mode": "gps", "stationId": ""}, "tide": {"mode": "station", "stationId": "Baltic Gauge"}},
                {"schema": 1, "weather": {"mode": "gps", "stationId": "10641"}, "tide": {"mode": "gps", "stationId": ""}},
            ]
            for value in invalid:
                location.write_text(json.dumps(value), encoding="utf-8")
                self.assertEqual(provider._location_config(), MODULE.default_location_config())

            location.write_bytes(b" " * (MODULE.MAX_LOCATION_CONFIG_BYTES + 1))
            self.assertEqual(provider._location_config(), MODULE.default_location_config())
            # An invalid existing JSON file must not revive the legacy override.
            self.assertEqual(provider._manual_station_id(), "")

            valid_raw = json.dumps(
                {
                    "schema": 1,
                    "weather": {"mode": "station", "stationId": "10641"},
                    "tide": {"mode": "gps", "stationId": ""},
                }
            )
            updated = provider.update_location_config(valid_raw)
            self.assertEqual(updated["weather"]["stationId"], "10641")
            self.assertEqual(json.loads(location.read_text(encoding="utf-8")), updated)
            with mock.patch.object(MODULE, "save_json") as save:
                provider.update_location_config(valid_raw)
            save.assert_not_called()
            previous = location.read_bytes()
            with self.assertRaises(ValueError):
                provider.update_location_config('{"schema":1,"weather":{}}')
            self.assertEqual(location.read_bytes(), previous)

    def test_station_catalog_converts_dwd_degree_minute_coordinates(self):
        stations = MODULE.parse_station_catalog(CATALOG)
        self.assertEqual([item.station_id for item in stations], ["10641", "10866"])
        self.assertAlmostEqual(stations[0].latitude, 50.1, places=5)
        self.assertAlmostEqual(stations[0].longitude, 8.8, places=5)
        nearest, distance = MODULE.nearest_station(stations, 50.11, 8.79)
        self.assertEqual(nearest.station_id, "10641")
        self.assertLess(distance, 3)

    def test_bsh_ogc_collection_filters_baltic_and_urls_match_official_contract(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        stations, returned, matched = MODULE.parse_tide_feature_collection(BSH_OVERVIEW, now)
        self.assertEqual(returned, 3)
        self.assertEqual(matched, 3)
        self.assertEqual([item.station_id for item in stations], ["northsea_test_gauge", "northsea_far_gauge"])
        self.assertNotIn("baltic_test_gauge", [item.station_id for item in stations])
        nearest, distance = MODULE.nearest_tide_station(stations, 53.5, 8.1)
        self.assertEqual(nearest.station_id, "northsea_test_gauge")
        self.assertLess(distance, 0.1)
        self.assertEqual(
            MODULE.tide_station_url("northsea_test_gauge"),
            MODULE.TIDE_ITEMS_URL + "/northsea_test_gauge?f=json&lang=en",
        )
        query = MODULE._tide_query_url(53.5, 8.1, 10, hits_only=True)
        self.assertIn("region=north_sea", query)
        self.assertIn("result-type=hitsOnly", query)
        self.assertEqual(MODULE.parse_tide_hits(bsh_hits(2)), 2)

    def test_bsh_explicit_summer_offset_is_normalized_to_utc(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        name, reference, events, curve = MODULE.parse_tide_station(
            BSH_STATION,
            "northsea_test_gauge",
            now,
        )
        self.assertEqual(name, "Nordsee Testpegel")
        self.assertEqual(reference, "PNP")
        self.assertEqual(events[0], {"t": "2026-08-20T12:30:00Z", "type": "HW", "heightM": 7.31})
        self.assertEqual(events[1], {"t": "2026-08-20T18:45:00Z", "type": "NW", "heightM": 4.68})
        berlin = MODULE.parse_time(events[0]["t"]).astimezone(MODULE.ZoneInfo("Europe/Berlin"))
        self.assertEqual((berlin.hour, berlin.minute, str(berlin.utcoffset())), (14, 30, "2:00:00"))
        self.assertIsNone(MODULE.parse_bsh_time("2026-08-20 13:30:00"))
        self.assertEqual(curve[0], {"t": "2026-08-20T10:10:00Z", "heightM": 6.1})
        # The automated forecast wins; the point without it falls back to the
        # official tidal prediction (730 cm -> 7.30 m PNP).
        self.assertIn({"t": "2026-08-21T12:00:00Z", "heightM": 7.3}, curve)

    def test_bsh_station_parser_rejects_wrong_station_region_and_licence(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(BSH_STATION, "another_station", now)
        value = json.loads(BSH_STATION)
        value["properties"]["region"] = "baltic_sea"
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(json.dumps(value).encode(), "northsea_test_gauge", now)
        value = json.loads(BSH_STATION)
        value["properties"]["licence"] = "unknown"
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(json.dumps(value).encode(), "northsea_test_gauge", now)
        value = json.loads(BSH_STATION)
        value["type"] = "FeatureCollection"
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(json.dumps(value).encode(), "northsea_test_gauge", now)
        value = json.loads(BSH_STATION)
        value["geometry"]["type"] = "LineString"
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(json.dumps(value).encode(), "northsea_test_gauge", now)
        value = json.loads(BSH_STATION)
        value["id"] = "river_sperrwerk_binnenpegel"
        value["properties"]["gauge_label"] = "Fluss-Sperrwerk, Binnenpegel"
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(json.dumps(value).encode(), "river_sperrwerk_binnenpegel", now)

    def test_bsh_curve_fallback_derives_future_high_and_low(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        value = json.loads(BSH_STATION)
        value["properties"]["high_water_low_water"] = []
        _name, _reference, events, curve = MODULE.parse_tide_station(
            json.dumps(value).encode(),
            "northsea_test_gauge",
            now,
        )
        self.assertGreaterEqual(len(events), 2)
        self.assertEqual({item["type"] for item in events}, {"HW", "NW"})
        self.assertLessEqual(len(curve), MODULE.TIDE_CACHE_CURVE_LIMIT)

    def test_bsh_curve_is_downsampled_and_never_persists_raw_ten_minute_series(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        value = json.loads(BSH_STATION)
        raw_curve = []
        for index in range(481):
            timestamp = now + dt.timedelta(minutes=10 * index)
            centimetres = 600 + 120 * math.sin(index / 12)
            raw_curve.append(
                {
                    "timestamp": timestamp.astimezone(dt.timezone(dt.timedelta(hours=2))).isoformat(sep=" "),
                    "tidal_prediction": str(round(centimetres)),
                    "automated_curve_forecast": str(round(centimetres + 10)),
                }
            )
        value["properties"]["curve"] = raw_curve
        name, reference, events, curve = MODULE.parse_tide_station(
            json.dumps(value).encode(),
            "northsea_test_gauge",
            now,
        )
        self.assertLessEqual(len(curve), MODULE.TIDE_CACHE_CURVE_LIMIT)
        self.assertLess(len(curve), len(raw_curve))
        self.assertEqual(curve, sorted(curve, key=lambda item: item["t"]))
        cache = {
            "schema": 1,
            "station": {"id": "northsea_test_gauge", "name": name, "distanceKm": 0.0},
            "updatedUtc": MODULE.iso_utc(now),
            "referenceLevel": reference,
            "events": events,
            "curve": curve,
        }
        cache["events"] = [
            {
                "t": MODULE.iso_utc(now + dt.timedelta(hours=hours)),
                "type": "HW" if index % 2 == 0 else "NW",
                "heightM": 7.2 if index % 2 == 0 else 5.1,
            }
            for index, hours in enumerate(range(3, 82, 6))
        ]
        six_hours_later = now + dt.timedelta(hours=6)
        public = MODULE._valid_tide_cache(cache, six_hours_later)
        self.assertEqual(public["attribution"], MODULE.TIDE_ATTRIBUTION)
        self.assertEqual(public["license"], "CC BY 4.0")
        self.assertEqual(public["licenseUrl"], "https://creativecommons.org/licenses/by/4.0/")
        self.assertIn("Kurvenreduktion", public["changes"])
        self.assertEqual(len(public["curve"]), MODULE.TIDE_PUBLIC_CURVE_LIMIT)
        self.assertEqual(MODULE.parse_time(public["curve"][0]["t"]), six_hours_later)
        self.assertEqual(
            MODULE.parse_time(public["curve"][-1]["t"]),
            six_hours_later + dt.timedelta(hours=24),
        )
        # The four HW/NW turns inside this 24-hour sine fixture must survive
        # the resource-saving reduction. They were lost by the old even-index
        # sampler and caused a visibly flattened/shortened Tide curve.
        extrema = {
            item["t"]
            for index, item in enumerate(public["curve"][1:-1], 1)
            if (
                item["heightM"] > public["curve"][index - 1]["heightM"]
                and item["heightM"] >= public["curve"][index + 1]["heightM"]
            )
            or (
                item["heightM"] < public["curve"][index - 1]["heightM"]
                and item["heightM"] <= public["curve"][index + 1]["heightM"]
            )
        }
        self.assertEqual(len(extrema), 4)

        # A complete 24-hour curve is still available at the exact stale
        # boundary when the Cerbo has been unable to refresh BSH for 48 hours.
        forty_eight_hours_later = now + dt.timedelta(hours=48)
        offline_public = MODULE._valid_tide_cache(cache, forty_eight_hours_later)
        self.assertIsNotNone(offline_public)
        self.assertTrue(offline_public["stale"])
        self.assertEqual(len(offline_public["curve"]), MODULE.TIDE_PUBLIC_CURVE_LIMIT)
        self.assertEqual(MODULE.parse_time(offline_public["curve"][0]["t"]), forty_eight_hours_later)
        self.assertEqual(
            MODULE.parse_time(offline_public["curve"][-1]["t"]),
            forty_eight_hours_later + dt.timedelta(hours=24),
        )

    def test_bsh_json_and_cache_size_limits_fail_closed(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        with self.assertRaises(ValueError):
            MODULE.parse_tide_hits(b"x" * (MODULE.MAX_TIDE_HITS_BYTES + 1))
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(
                b"x" * (MODULE.MAX_TIDE_STATION_BYTES + 1),
                "northsea_test_gauge",
                now,
            )
        compressed = gzip.compress(b"x" * 1025)
        with self.assertRaises(ValueError):
            MODULE._decode_http_payload(compressed, "gzip", 1024)
        with tempfile.TemporaryDirectory() as directory:
            cache = pathlib.Path(directory) / "oversized.json"
            cache.write_bytes(b" " * (MODULE.MAX_TIDE_CACHE_BYTES + 1))
            self.assertIsNone(MODULE.load_json_limited(cache, MODULE.MAX_TIDE_CACHE_BYTES))

    def test_local_weather_catalog_and_station_files_fail_closed_when_oversized(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            weather = base / "weather.json"
            catalog = base / "stations.cfg"
            manual = base / "manual.conf"
            weather.write_bytes(b" " * (MODULE.MAX_SNAPSHOT_BYTES + 1))
            catalog.write_bytes(b"x" * (MODULE.MAX_CATALOG_BYTES + 1))
            manual.write_bytes(b"10641\n" + b"x" * MODULE.MAX_STATION_CONFIG_BYTES)

            provider = MODULE.WeatherProvider(
                cache_path=weather,
                catalog_path=catalog,
                station_config_path=manual,
                download=lambda _url, _maximum: (_ for _ in ()).throw(OSError("offline")),
                now=lambda: now,
            )
            self.assertIsNone(provider.cached())
            self.assertEqual(provider._manual_station_id(), "")
            with mock.patch.object(MODULE, "_decode_catalog") as decode_catalog:
                with self.assertRaises(RuntimeError):
                    provider._catalog()
            decode_catalog.assert_not_called()

    def test_mosmix_parser_and_snapshot_use_exact_transport_contract(self):
        model_run, name, series, times = MODULE.parse_mosmix_kmz(sample_kmz())
        self.assertEqual(model_run, "2026-08-18T21:00:00Z")
        self.assertEqual(name, "OFFENBACH-WETTERPARK")
        station = MODULE.parse_station_catalog(CATALOG)[0]
        snapshot = MODULE.build_snapshot(
            station,
            1.2,
            "Europe/Berlin",
            model_run,
            name,
            series,
            times,
            dt.datetime(2026, 8, 19, 0, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(snapshot["schema"], 1)
        self.assertEqual(snapshot["source"], "DWD MOSMIX_L")
        self.assertEqual(snapshot["attribution"], "Quelle: Deutscher Wetterdienst")
        self.assertEqual(snapshot["license"], "CC BY 4.0")
        self.assertEqual(snapshot["licenseUrl"], "https://creativecommons.org/licenses/by/4.0/")
        self.assertIn("Tagesaggregation", snapshot["changes"])
        self.assertEqual(snapshot["hourly"][0]["tempC"], 20.0)
        self.assertEqual(snapshot["hourly"][7]["icon"], "thunderstorm")
        self.assertEqual(snapshot["hourly"][1]["windKmh"], 7.2)
        self.assertIsNone(snapshot["hourly"][-1]["precipProbabilityPct"])
        self.assertEqual(len(snapshot["daily"]), 6)
        self.assertIsNone(snapshot["daily"][0]["maxHourlyPrecipProbabilityPct"])
        legacy_cache = dict(snapshot)
        legacy_cache.pop("license")
        legacy_cache.pop("licenseUrl")
        legacy_cache.pop("changes")
        enriched_cache = MODULE.mark_stale(legacy_cache, dt.datetime(2026, 8, 19, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(enriched_cache["license"], "CC BY 4.0")
        self.assertEqual(enriched_cache["licenseUrl"], MODULE.DATA_LICENSE_URL)
        self.assertEqual(enriched_cache["changes"], MODULE.SOURCE_CHANGES)
        complete_series = {name: list(values) for name, values in series.items()}
        complete_series["R101"][-1] = 10
        complete_series["RR1c"][-1] = 0
        complete = MODULE.build_snapshot(
            station,
            1.2,
            "Europe/Berlin",
            model_run,
            name,
            complete_series,
            times,
            dt.datetime(2026, 8, 19, 0, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(complete["daily"][0]["maxHourlyPrecipProbabilityPct"], 70)
        self.assertEqual(snapshot["sun"]["origin"], "calculated")
        self.assertLess(len(json.dumps(snapshot, separators=(",", ":")).encode()), MODULE.MAX_SNAPSHOT_BYTES)

    def test_provider_writes_atomic_cache_without_gps_coordinates(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            downloads = []

            def download(url, _maximum):
                downloads.append(url)
                if "stationskatalog" in url or "mosmix_stations.cfg" in url:
                    return CATALOG.encode("latin-1")
                return sample_kmz()

            tide_calls = []

            def tide_http(url, _maximum, etag=None):
                tide_calls.append((url, etag))
                if "result-type=hitsOnly" in url:
                    return MODULE.HttpResult(200, bsh_hits(3), '"hits"')
                if "/items?" in url:
                    return MODULE.HttpResult(200, BSH_OVERVIEW, '"page"')
                return MODULE.HttpResult(200, BSH_STATION, '"station-gzip"')

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                station_config_path=base / "manual.conf",
                tide_cache_path=base / "tides.json",
                download=download,
                tide_http=tide_http,
                position_reader=lambda: (53.501, 8.102),
                timezone_reader=lambda: "Europe/Berlin",
                now=lambda: now,
            )
            snapshot = provider.refresh()
            self.assertEqual(snapshot["station"]["id"], "10641")
            raw = (base / "weather.json").read_text(encoding="utf-8")
            self.assertNotIn("latitude", raw)
            self.assertNotIn("longitude", raw)
            self.assertIn("distanceKm", raw)
            self.assertLessEqual(len(raw.encode("utf-8")), MODULE.MAX_SNAPSHOT_BYTES)
            self.assertEqual(len(downloads), 2)
            self.assertEqual(len(tide_calls), 3)
            self.assertFalse(list(base.glob("*.kmz")))
            self.assertFalse(list(base.glob("*.kml")))
            self.assertEqual(
                sorted(item.name for item in base.iterdir()),
                ["stations.cfg", "tides.json", "weather.json"],
            )
            tide_cache = (base / "tides.json").read_text(encoding="utf-8")
            self.assertNotIn("53.501", tide_cache)
            self.assertNotIn("8.102", tide_cache)
            self.assertEqual(snapshot["tides"]["station"]["id"], "northsea_test_gauge")
            self.assertEqual(snapshot["tides"]["nextHigh"]["heightM"], 7.31)
            self.assertLessEqual(len(snapshot["tides"]["curve"]), MODULE.TIDE_PUBLIC_CURVE_LIMIT)
            self.assertLess(len(tide_cache.encode("utf-8")), MODULE.MAX_TIDE_CACHE_BYTES)
            self.assertEqual(provider.cached()["stale"], False)

    def test_fixed_dwd_weather_station_is_independent_from_fixed_tide_station(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            location = base / "weather-location.json"
            write_location_config(
                location,
                weather_mode="station",
                weather_station_id="10866",
                tide_mode="station",
                tide_station_id=MODULE.DEFAULT_TIDE_STATION_ID,
            )
            downloads = []
            tide_calls = []

            def download(url, _maximum):
                downloads.append(url)
                return (
                    CATALOG.encode("latin-1")
                    if "stationskatalog" in url or "mosmix_stations.cfg" in url
                    else sample_kmz()
                )

            def tide_http(url, _maximum, _etag=None):
                tide_calls.append(url)
                return MODULE.HttpResult(
                    200,
                    bsh_station(MODULE.DEFAULT_TIDE_STATION_ID, "Wilhelmshaven Alter Vorhafen"),
                    None,
                )

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                location_config_path=location,
                tide_cache_path=base / "tides.json",
                download=download,
                tide_http=tide_http,
                position_reader=lambda: (50.1, 8.8),
                timezone_reader=lambda: "Europe/Berlin",
                now=lambda: now,
            )
            snapshot = provider.refresh()
            self.assertEqual(snapshot["station"]["id"], "10866")
            self.assertTrue(any("LATEST_10866" in url for url in downloads))
            self.assertEqual(snapshot["tides"]["station"]["id"], MODULE.DEFAULT_TIDE_STATION_ID)
            self.assertEqual(tide_calls, [MODULE.tide_station_url(MODULE.DEFAULT_TIDE_STATION_ID)])

    def test_fixed_bsh_tide_station_is_independent_from_gps_weather_station(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            location = base / "weather-location.json"
            write_location_config(
                location,
                tide_mode="station",
                tide_station_id="northsea_test_gauge",
            )
            tide_calls = []

            def download(url, _maximum):
                return (
                    CATALOG.encode("latin-1")
                    if "stationskatalog" in url or "mosmix_stations.cfg" in url
                    else sample_kmz()
                )

            def tide_http(url, _maximum, _etag=None):
                tide_calls.append(url)
                return MODULE.HttpResult(200, BSH_STATION, None)

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                location_config_path=location,
                tide_cache_path=base / "tides.json",
                download=download,
                tide_http=tide_http,
                position_reader=lambda: (50.1, 8.8),
                timezone_reader=lambda: "Europe/Berlin",
                now=lambda: now,
            )
            snapshot = provider.refresh()
            self.assertEqual(snapshot["station"]["id"], "10641")
            self.assertEqual(snapshot["tides"]["station"]["id"], "northsea_test_gauge")
            self.assertEqual(tide_calls, [MODULE.tide_station_url("northsea_test_gauge")])

    def test_stale_station_catalog_is_refreshed_but_survives_network_failure(self):
        now = dt.datetime(2026, 8, 19, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            catalog = base / "stations.cfg"
            catalog.write_text(CATALOG, encoding="utf-8")
            old = now.timestamp() - MODULE.CATALOG_REFRESH_SECONDS - 60
            os.utime(catalog, (old, old))

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=catalog,
                download=lambda _url, _maximum: (_ for _ in ()).throw(OSError("offline")),
                now=lambda: now,
            )
            self.assertEqual(provider._catalog()[0].station_id, "10641")

    def test_corrupt_cache_is_ignored_and_old_cache_is_marked_stale(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = pathlib.Path(directory) / "weather.json"
            cache.write_text("not-json", encoding="utf-8")
            provider = MODULE.WeatherProvider(cache_path=cache)
            self.assertIsNone(provider.cached())
            value = {
                "fetchedAtUtc": "2026-08-18T00:00:00Z",
                "timezone": "Europe/Berlin",
                "sun": {
                    "date": "2026-08-18",
                    "riseUtc": "2026-08-18T04:00:00Z",
                    "setUtc": "2026-08-18T18:00:00Z",
                    "origin": "calculated",
                },
                "hourly": [{"t": "2026-08-18T01:00:00Z"}],
                "daily": [{"date": "2026-08-18"}],
            }
            MODULE.save_json(cache, value)
            provider = MODULE.WeatherProvider(
                cache_path=cache,
                now=lambda: dt.datetime(2026, 8, 19, 0, tzinfo=dt.timezone.utc),
            )
            cached = provider.cached()
            self.assertTrue(cached["stale"])
            self.assertEqual(cached["hourly"], [])
            self.assertEqual(cached["daily"], [])
            self.assertIsNone(cached["sun"]["riseUtc"])

    def test_gps_far_inland_uses_wilhelmshaven_fallback_and_remains_visible(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            calls = []

            def tide_http(url, _maximum, _etag=None):
                calls.append(url)
                if "result-type=hitsOnly" in url:
                    return MODULE.HttpResult(200, bsh_hits(0), None)
                return MODULE.HttpResult(
                    200,
                    bsh_station(
                        MODULE.DEFAULT_TIDE_STATION_ID,
                        "Wilhelmshaven Alter Vorhafen",
                        53.5133,
                        8.145,
                    ),
                    '"wilhelmshaven"',
                )

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                station_config_path=base / "manual.conf",
                location_config_path=base / "weather-location.json",
                tide_cache_path=base / "tides.json",
                tide_http=tide_http,
                now=lambda: now,
            )
            tides = provider._tides_for_position((48.14, 11.58))
            self.assertEqual(tides["station"]["id"], MODULE.DEFAULT_TIDE_STATION_ID)
            self.assertGreater(tides["station"]["distanceKm"], MODULE.TIDE_MAX_DISTANCE_KM)
            self.assertEqual(len(calls), len(MODULE.TIDE_DISCOVERY_RADII_KM) + 1)
            self.assertTrue(all("result-type=hitsOnly" in url for url in calls[:-1]))
            self.assertEqual(calls[-1], MODULE.tide_station_url(MODULE.DEFAULT_TIDE_STATION_ID))

    def test_no_gps_loads_wilhelmshaven_fallback_directly(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            calls = []

            def tide_http(url, _maximum, _etag=None):
                calls.append(url)
                return MODULE.HttpResult(
                    200,
                    bsh_station(
                        MODULE.DEFAULT_TIDE_STATION_ID,
                        "Wilhelmshaven Alter Vorhafen",
                    ),
                    None,
                )

            provider = MODULE.WeatherProvider(
                location_config_path=base / "weather-location.json",
                tide_cache_path=base / "tides.json",
                tide_http=tide_http,
                now=lambda: now,
            )
            tides = provider._tides_for_position(None)
            self.assertEqual(tides["station"]["id"], MODULE.DEFAULT_TIDE_STATION_ID)
            self.assertEqual(tides["station"]["distanceKm"], 0.0)
            self.assertEqual(calls, [MODULE.tide_station_url(MODULE.DEFAULT_TIDE_STATION_ID)])

    def test_tide_cache_marks_stale_then_fails_closed_and_never_contains_gps(self):
        fetched = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        value = {
            "schema": 1,
            "station": {"id": "northsea_test_gauge", "name": "Nordsee Testpegel", "distanceKm": 642.2},
            "updatedUtc": MODULE.iso_utc(fetched),
            "referenceLevel": "PNP",
            "events": [
                {"t": "2026-08-23T12:00:00Z", "type": "HW", "heightM": 7.1},
                {"t": "2026-08-23T18:00:00Z", "type": "NW", "heightM": 4.6},
                {"t": "2026-08-28T12:00:00Z", "type": "HW", "heightM": 7.2},
                {"t": "2026-08-28T18:00:00Z", "type": "NW", "heightM": 4.5},
            ],
            "curve": [
                {"t": "2026-08-22T12:00:00Z", "heightM": 6.1},
                {"t": "2026-08-22T13:00:00Z", "heightM": 6.2},
            ],
        }
        stale = MODULE._valid_tide_cache(value, fetched + dt.timedelta(hours=49))
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["source"], "BSH")
        self.assertEqual(stale["referenceLevel"], "PNP")
        self.assertEqual(stale["station"]["distanceKm"], 642.2)
        self.assertNotIn("latitude", json.dumps(stale))
        self.assertNotIn("longitude", json.dumps(stale))
        self.assertIsNone(MODULE._valid_tide_cache(value, fetched + dt.timedelta(days=8)))

    def test_tide_failure_has_six_hour_backoff_and_keeps_valid_matching_cache(self):
        clock = {"now": dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)}
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            cache = {
                "schema": 1,
                "station": {
                    "id": "northsea_test_gauge",
                    "name": "Nordsee Testpegel",
                    "latitude": 53.5,
                    "longitude": 8.1,
                    "distanceKm": 0.0,
                },
                "updatedUtc": "2026-08-18T12:00:00Z",
                "referenceLevel": "PNP",
                "events": [
                    {"t": "2026-08-20T12:30:00Z", "type": "HW", "heightM": 7.31},
                    {"t": "2026-08-20T18:45:00Z", "type": "NW", "heightM": 4.68},
                ],
            }
            MODULE.save_json(base / "tides.json", cache)
            write_location_config(
                base / "weather-location.json",
                tide_mode="station",
                tide_station_id="northsea_test_gauge",
            )
            calls = []

            def offline(url, _maximum):
                calls.append(url)
                raise OSError("offline")

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                station_config_path=base / "manual.conf",
                location_config_path=base / "weather-location.json",
                tide_cache_path=base / "tides.json",
                download=offline,
                now=lambda: clock["now"],
            )
            first = provider._tides_for_position(None)
            clock["now"] += dt.timedelta(hours=1)
            second = provider._tides_for_position(None)
            self.assertEqual(len(calls), 1)
            self.assertEqual(first["station"]["id"], "northsea_test_gauge")
            self.assertEqual(second["station"]["id"], "northsea_test_gauge")

    def test_fixed_tide_never_uses_cache_from_another_station(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            MODULE.save_json(
                base / "weather.json",
                {
                    "fetchedAtUtc": "2026-08-20T09:00:00Z",
                    "timezone": "Europe/Berlin",
                    "sun": {"date": "2026-08-20", "riseUtc": None, "setUtc": None, "origin": "calculated"},
                    "hourly": [],
                    "daily": [],
                },
            )
            MODULE.save_json(
                base / "tides.json",
                {
                    "schema": 1,
                    "station": {
                        "id": "another_northsea_gauge",
                        "name": "Anderer Nordseepegel",
                        "latitude": 53.8,
                        "longitude": 8.7,
                        "distanceKm": 12.0,
                    },
                    "updatedUtc": "2026-08-20T09:00:00Z",
                    "referenceLevel": "PNP",
                    "events": [
                        {"t": "2026-08-20T12:30:00Z", "type": "HW", "heightM": 7.31},
                        {"t": "2026-08-20T18:45:00Z", "type": "NW", "heightM": 4.68},
                    ],
                },
            )
            write_location_config(
                base / "weather-location.json",
                tide_mode="station",
                tide_station_id="wanted_northsea_gauge",
            )
            calls = []

            def offline(url, _maximum, _etag=None):
                calls.append(url)
                raise OSError("offline")

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                location_config_path=base / "weather-location.json",
                tide_cache_path=base / "tides.json",
                tide_http=offline,
                now=lambda: now,
            )
            self.assertNotIn("tides", provider.cached())
            self.assertIsNone(provider._tides_for_position(None))
            self.assertEqual(calls, [MODULE.tide_station_url("wanted_northsea_gauge")])

    def test_matching_etag_304_refreshes_atomic_cache_without_payload_download(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            cache = {
                "schema": 1,
                "station": {
                    "id": "northsea_test_gauge",
                    "name": "Nordsee Testpegel",
                    "latitude": 53.5,
                    "longitude": 8.1,
                    "distanceKm": 0.0,
                },
                "updatedUtc": "2026-08-20T00:00:00Z",
                "referenceLevel": "PNP",
                "etag": '"station-gzip"',
                "events": [
                    {"t": "2026-08-20T12:30:00Z", "type": "HW", "heightM": 7.31},
                    {"t": "2026-08-20T18:45:00Z", "type": "NW", "heightM": 4.68},
                ],
                "curve": [
                    {"t": "2026-08-20T10:10:00Z", "heightM": 6.1},
                    {"t": "2026-08-20T11:10:00Z", "heightM": 6.5},
                ],
            }
            MODULE.save_json(base / "tides.json", cache)
            calls = []

            def not_modified(url, maximum, etag):
                calls.append((url, maximum, etag))
                return MODULE.HttpResult(304, b"", etag)

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                tide_cache_path=base / "tides.json",
                tide_http=not_modified,
                now=lambda: now,
            )
            tides = provider._tides_for_position((53.5, 8.1))
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][2], '"station-gzip"')
            self.assertEqual(tides["updatedUtc"], "2026-08-20T10:00:00Z")
            self.assertEqual(json.loads((base / "tides.json").read_text())["updatedUtc"], "2026-08-20T10:00:00Z")

    def test_kmz_rejects_multiple_or_unsafe_kml_members(self):
        with self.assertRaises(ValueError):
            MODULE.parse_mosmix_kmz(b"x" * (MODULE.MAX_KMZ_BYTES + 1))

        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("one.kml", "<kml/>")
            archive.writestr("two.kml", "<kml/>")
        with self.assertRaises(ValueError):
            MODULE.parse_mosmix_kmz(payload.getvalue())

        payload = io.BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("forecast.kml", "<!DOCTYPE kml><kml/>")
        with self.assertRaises(ValueError):
            MODULE.parse_mosmix_kmz(payload.getvalue())

    def test_retry_and_refresh_intervals_are_bounded(self):
        self.assertEqual(MODULE.RETRY_SECONDS, (900, 1800, 3600, 10800))
        self.assertEqual(MODULE.REFRESH_SECONDS, 21600)
        self.assertEqual(MODULE.TIDE_REFRESH_SECONDS, 21600)
        self.assertEqual(MODULE.TIDE_RETRY_SECONDS, 21600)
        self.assertEqual(MODULE.TIDE_MAX_DISTANCE_KM, 60.0)
        self.assertEqual(MODULE.TIDE_PUBLIC_CURVE_LIMIT, 27)
        self.assertEqual(MODULE.TIDE_CACHE_CURVE_LIMIT, 145)
        self.assertEqual(MODULE.TIDE_CURVE_CACHE_HORIZON_SECONDS, 72 * 60 * 60)
        self.assertEqual(MODULE.MAX_TIDE_DISCOVERY_TOTAL_BYTES, 4 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
