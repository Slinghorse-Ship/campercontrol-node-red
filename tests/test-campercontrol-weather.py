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
SPEC = importlib.util.spec_from_file_location("campercontrol_weather_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


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
                return CATALOG.encode("latin-1") if "stationskatalog" in url or "mosmix_stations.cfg" in url else sample_kmz()

            provider = MODULE.WeatherProvider(
                cache_path=base / "weather.json",
                catalog_path=base / "stations.cfg",
                station_config_path=base / "manual.conf",
                download=download,
                position_reader=lambda: (50.11, 8.79),
                timezone_reader=lambda: "Europe/Berlin",
                now=lambda: now,
            )
            snapshot = provider.refresh()
            self.assertEqual(snapshot["station"]["id"], "10641")
            raw = (base / "weather.json").read_text(encoding="utf-8")
            self.assertNotIn("latitude", raw)
            self.assertNotIn("longitude", raw)
            self.assertNotIn("distanceKm", raw)
            self.assertLessEqual(len(raw.encode("utf-8")), MODULE.MAX_SNAPSHOT_BYTES)
            self.assertEqual(len(downloads), 2)
            self.assertFalse(list(base.glob("*.kmz")))
            self.assertFalse(list(base.glob("*.kml")))
            self.assertEqual(
                sorted(item.name for item in base.iterdir()),
                ["stations.cfg", "weather.json"],
            )
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


if __name__ == "__main__":
    unittest.main()
