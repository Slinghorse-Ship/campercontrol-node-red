#!/usr/bin/env python3

import datetime as dt
import importlib.util
import io
import json
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

    def test_station_catalog_converts_dwd_degree_minute_coordinates(self):
        stations = MODULE.parse_station_catalog(CATALOG)
        self.assertEqual([item.station_id for item in stations], ["10641", "10866"])
        self.assertAlmostEqual(stations[0].latitude, 50.1, places=5)
        self.assertAlmostEqual(stations[0].longitude, 8.8, places=5)
        nearest, distance = MODULE.nearest_station(stations, 50.11, 8.79)
        self.assertEqual(nearest.station_id, "10641")
        self.assertLess(distance, 3)

    def test_bsh_catalog_filters_ostsee_and_station_url_matches_official_contract(self):
        stations, copyright_note = MODULE.parse_tide_catalog(BSH_OVERVIEW)
        self.assertEqual([item.station_id for item in stations], ["900P", "901P"])
        self.assertNotIn("902P", [item.station_id for item in stations])
        self.assertIn("Bundesamt für Seeschifffahrt und Hydrographie", copyright_note)
        nearest, distance = MODULE.nearest_tide_station(stations, 53.5, 8.1)
        self.assertEqual(nearest.station_id, "900P")
        self.assertLess(distance, 0.1)
        self.assertEqual(
            MODULE.tide_station_url("900P"),
            "https://gezeiten.bsh.de/data/DE__900P_tides.json",
        )

    def test_bsh_mez_timestamp_is_normalized_to_utc_without_dst_guessing(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        name, reference, events = MODULE.parse_tide_station(BSH_STATION, "900P", now)
        self.assertEqual(name, "Nordsee Testpegel")
        self.assertEqual(reference, "PNP")
        self.assertEqual(events[0], {"t": "2026-08-20T12:30:00Z", "type": "HW", "heightM": 7.31})
        self.assertEqual(events[1], {"t": "2026-08-20T18:45:00Z", "type": "NW", "heightM": 4.68})
        berlin = MODULE.parse_time(events[0]["t"]).astimezone(MODULE.ZoneInfo("Europe/Berlin"))
        # Raw BSH is 13:30 +01:00 (year-round MEZ); legal August time is
        # therefore 14:30 CEST after the lossless UTC transport conversion.
        self.assertEqual((berlin.hour, berlin.minute, str(berlin.utcoffset())), (14, 30, "2:00:00"))
        self.assertIsNone(MODULE.parse_bsh_time("2026-08-20 13:30:00"))

    def test_bsh_station_parser_rejects_wrong_station_and_non_pnp_reference(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(BSH_STATION, "999P", now)
        value = json.loads(BSH_STATION)
        value["years"][0]["2026"]["hwnw_prediction"]["level"] = "SKN"
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(json.dumps(value).encode(), "900P", now)

    def test_bsh_json_and_cache_size_limits_fail_closed(self):
        now = dt.datetime(2026, 8, 20, 10, 0, tzinfo=dt.timezone.utc)
        with self.assertRaises(ValueError):
            MODULE.parse_tide_catalog(b"x" * (MODULE.MAX_TIDE_CATALOG_BYTES + 1))
        with self.assertRaises(ValueError):
            MODULE.parse_tide_station(
                b"x" * (MODULE.MAX_TIDE_STATION_BYTES + 1),
                "900P",
                now,
            )
        with tempfile.TemporaryDirectory() as directory:
            cache = pathlib.Path(directory) / "oversized.json"
            cache.write_bytes(b" " * (MODULE.MAX_TIDE_CACHE_BYTES + 1))
            self.assertIsNone(MODULE.load_json_limited(cache, MODULE.MAX_TIDE_CACHE_BYTES))

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
        self.assertEqual(snapshot["hourly"][0]["tempC"], 20.0)
        self.assertEqual(snapshot["hourly"][7]["icon"], "storm")
        self.assertEqual(snapshot["hourly"][1]["windKmh"], 7.2)
        self.assertIsNone(snapshot["hourly"][-1]["precipProbabilityPct"])
        self.assertEqual(len(snapshot["daily"]), 6)
        self.assertIsNone(snapshot["daily"][0]["maxHourlyPrecipProbabilityPct"])
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
        now = dt.datetime(2026, 8, 19, 0, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            downloads = []

            def download(url, _maximum):
                downloads.append(url)
                if "stationskatalog" in url or "mosmix_stations.cfg" in url:
                    return CATALOG.encode("latin-1")
                if url == MODULE.TIDE_CATALOG_URL:
                    return BSH_OVERVIEW
                if url.endswith("_tides.json"):
                    return BSH_STATION
                return sample_kmz()

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                station_config_path=base / "manual.conf",
                tide_cache_path=base / "tides.json",
                tide_catalog_path=base / "tide-stations.json",
                download=download,
                position_reader=lambda: (53.5, 8.1),
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
            self.assertEqual(len(downloads), 4)
            self.assertFalse(list(base.glob("*.kmz")))
            self.assertFalse(list(base.glob("*.kml")))
            self.assertEqual(
                sorted(item.name for item in base.iterdir()),
                ["stations.cfg", "tide-stations.json", "tides.json", "weather.json"],
            )
            self.assertNotIn("latitude", (base / "tides.json").read_text(encoding="utf-8"))
            self.assertNotIn("longitude", (base / "tides.json").read_text(encoding="utf-8"))
            self.assertEqual(snapshot["tides"]["station"]["id"], "900P")
            self.assertEqual(snapshot["tides"]["nextHigh"]["heightM"], 7.31)
            self.assertEqual(provider.cached()["stale"], False)

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

    def test_tides_are_hidden_far_inland_without_downloading_station_file(self):
        now = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            tide_catalog = base / "tide-stations.json"
            tide_catalog.write_bytes(BSH_OVERVIEW)
            calls = []
            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                station_config_path=base / "manual.conf",
                tide_cache_path=base / "tides.json",
                tide_catalog_path=tide_catalog,
                download=lambda url, _maximum: calls.append(url) or BSH_STATION,
                now=lambda: now,
            )
            self.assertIsNone(provider._tides_for_position((48.14, 11.58)))
            self.assertEqual(calls, [])

    def test_tide_cache_marks_stale_then_fails_closed_and_never_contains_gps(self):
        fetched = dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)
        value = {
            "schema": 1,
            "station": {"id": "900P", "name": "Nordsee Testpegel", "distanceKm": 4.2},
            "updatedUtc": MODULE.iso_utc(fetched),
            "referenceLevel": "PNP",
            "events": [
                {"t": "2026-08-23T12:00:00Z", "type": "HW", "heightM": 7.1},
                {"t": "2026-08-23T18:00:00Z", "type": "NW", "heightM": 4.6},
                {"t": "2026-08-28T12:00:00Z", "type": "HW", "heightM": 7.2},
                {"t": "2026-08-28T18:00:00Z", "type": "NW", "heightM": 4.5},
            ],
        }
        stale = MODULE._valid_tide_cache(value, fetched + dt.timedelta(hours=49))
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["source"], "BSH")
        self.assertEqual(stale["referenceLevel"], "PNP")
        self.assertNotIn("latitude", json.dumps(stale))
        self.assertNotIn("longitude", json.dumps(stale))
        self.assertIsNone(MODULE._valid_tide_cache(value, fetched + dt.timedelta(days=8)))

    def test_tide_failure_has_six_hour_backoff_and_keeps_valid_matching_cache(self):
        clock = {"now": dt.datetime(2026, 8, 20, 10, tzinfo=dt.timezone.utc)}
        with tempfile.TemporaryDirectory() as directory:
            base = pathlib.Path(directory)
            (base / "tide-stations.json").write_bytes(BSH_OVERVIEW)
            cache = {
                "schema": 1,
                "station": {"id": "900P", "name": "Nordsee Testpegel", "distanceKm": 0.0},
                "updatedUtc": "2026-08-18T12:00:00Z",
                "referenceLevel": "PNP",
                "events": [
                    {"t": "2026-08-20T12:30:00Z", "type": "HW", "heightM": 7.31},
                    {"t": "2026-08-20T18:45:00Z", "type": "NW", "heightM": 4.68},
                ],
            }
            MODULE.save_json(base / "tides.json", cache)
            calls = []

            def offline(url, _maximum):
                calls.append(url)
                raise OSError("offline")

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                station_config_path=base / "manual.conf",
                tide_cache_path=base / "tides.json",
                tide_catalog_path=base / "tide-stations.json",
                download=offline,
                now=lambda: clock["now"],
            )
            first = provider._tides_for_position((53.5, 8.1))
            clock["now"] += dt.timedelta(hours=1)
            second = provider._tides_for_position((53.5, 8.1))
            self.assertEqual(len(calls), 1)
            self.assertEqual(first["station"]["id"], "900P")
            self.assertEqual(second["station"]["id"], "900P")

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
        self.assertEqual(MODULE.TIDE_REFRESH_SECONDS, 86400)
        self.assertEqual(MODULE.TIDE_RETRY_SECONDS, 21600)
        self.assertEqual(MODULE.TIDE_MAX_DISTANCE_KM, 60.0)


if __name__ == "__main__":
    unittest.main()
