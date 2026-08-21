#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "cerbo-service" / "campercontrol-dbus.py"
INSTALLER_PATH = pathlib.Path(__file__).parents[1] / "cerbo-service" / "install-campercontrol-dbus.sh"
ENSURE_PATH = pathlib.Path(__file__).parents[1] / "cerbo-service" / "ensure-campercontrol-dbus.sh"
LOG_SCRIPT_PATHS = tuple(
    pathlib.Path(__file__).parents[1] / "cerbo-service" / name
    for name in (
        "network-repair.sh",
        "bluetooth-repair.sh",
        "node-red-restart.sh",
        "cerbo-reboot.sh",
    )
)
SPEC = importlib.util.spec_from_file_location("campercontrol_dbus", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class CamperControlDbusContractTest(unittest.TestCase):
    def test_local_api_reader_enforces_content_length_and_read_limit_before_json(self):
        class FakeResponse:
            def __init__(self, payload, content_length=None):
                self.payload = payload
                self.headers = {}
                if content_length is not None:
                    self.headers["Content-Length"] = str(content_length)
                self.read_limits = []

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, maximum):
                self.read_limits.append(maximum)
                return self.payload[:maximum]

        maximum = 64
        exact_payload = b'{"ok":true}' + b" " * (maximum - len(b'{"ok":true}'))
        exact = FakeResponse(exact_payload, maximum)
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=exact):
            self.assertEqual(MODULE._http_json("http://127.0.0.1/exact", maximum), {"ok": True})
        self.assertEqual(exact.read_limits, [maximum + 1])

        declared_oversize = FakeResponse(b'{}', maximum + 1)
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=declared_oversize):
            with mock.patch.object(MODULE.json, "loads") as loads:
                with self.assertRaises(ValueError):
                    MODULE._http_json("http://127.0.0.1/declared", maximum)
        self.assertEqual(declared_oversize.read_limits, [])
        loads.assert_not_called()

        streamed_oversize = FakeResponse(b"x" * (maximum + 1))
        with mock.patch.object(MODULE.urllib.request, "urlopen", return_value=streamed_oversize):
            with mock.patch.object(MODULE.json, "loads") as loads:
                with self.assertRaises(ValueError):
                    MODULE._http_json("http://127.0.0.1/streamed", maximum)
        self.assertEqual(streamed_oversize.read_limits, [maximum + 1])
        loads.assert_not_called()

    def test_state_delivery_coalesces_one_thousand_updates_into_one_glib_callback(self):
        class FakeGlib:
            def __init__(self):
                self.callbacks = []

            def idle_add(self, callback):
                self.callbacks.append(callback)
                return len(self.callbacks)

        bridge = MODULE.CamperControlBridge.__new__(MODULE.CamperControlBridge)
        bridge._glib = FakeGlib()
        bridge._state_delivery_lock = MODULE.threading.Lock()
        bridge._pending_state_delivery = None
        bridge._state_delivery_scheduled = False
        bridge._apply_state = mock.Mock(return_value=False)
        bridge._apply_error = mock.Mock(return_value=False)

        for index in range(999):
            bridge._queue_state_delivery("state", {"ui": str(index)})
        bridge._queue_state_delivery("error", "latest")

        self.assertEqual(len(bridge._glib.callbacks), 1)
        self.assertFalse(bridge._glib.callbacks[0]())
        bridge._apply_state.assert_not_called()
        bridge._apply_error.assert_called_once_with("latest")
        self.assertFalse(bridge._state_delivery_scheduled)

        bridge._queue_state_delivery("state", {"ui": "new"})
        self.assertEqual(len(bridge._glib.callbacks), 2)

    def test_weather_delivery_coalesces_one_thousand_updates_into_one_glib_callback(self):
        class FakeGlib:
            def __init__(self):
                self.callbacks = []

            def idle_add(self, callback):
                self.callbacks.append(callback)
                return len(self.callbacks)

        bridge = MODULE.CamperControlBridge.__new__(MODULE.CamperControlBridge)
        bridge._glib = FakeGlib()
        bridge._weather_delivery_lock = MODULE.threading.Lock()
        bridge._pending_weather_delivery = None
        bridge._weather_delivery_scheduled = False
        bridge._apply_weather = mock.Mock(return_value=False)
        bridge._apply_weather_error = mock.Mock(return_value=False)

        for index in range(999):
            bridge._queue_weather_delivery("weather", {"sequence": index})
        bridge._queue_weather_delivery("error", "latest")

        self.assertEqual(len(bridge._glib.callbacks), 1)
        self.assertFalse(bridge._glib.callbacks[0]())
        bridge._apply_weather.assert_not_called()
        bridge._apply_weather_error.assert_called_once_with("latest")
        self.assertFalse(bridge._weather_delivery_scheduled)

    def test_install_and_ensure_require_the_bounded_device_http_helper(self):
        installer = INSTALLER_PATH.read_text(encoding="utf-8")
        ensure = ENSURE_PATH.read_text(encoding="utf-8")
        self.assertIn('[ -f "$BASE/device-http-bounded.py" ] || exit 1', installer)
        self.assertIn('chmod 0755 "$BASE/device-http-bounded.py"', installer)
        self.assertIn('DEVICE_HTTP=/data/campercontrol/service/device-http-bounded.py', ensure)
        self.assertIn('[ -x "$DEVICE_HTTP" ] || exit 1', ensure)

    def test_maintenance_logs_are_overwritten_on_every_invocation(self):
        for script_path in LOG_SCRIPT_PATHS:
            with self.subTest(script=script_path.name):
                source = script_path.read_text(encoding="utf-8")
                self.assertNotRegex(source, r">>\s*(?:\"\$LOG\"|/data/log/)")
                if script_path.name == "cerbo-reboot.sh":
                    self.assertRegex(source, r">\s*/data/log/campercontrol-cerbo-reboot\.log")
                else:
                    self.assertRegex(source, r"}\s*>\s*\"\$LOG\"\s*2>&1")

        # Model two invocations using the redirect operator required above:
        # the second run replaces, rather than grows, the first run's output.
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            log_path = pathlib.Path(directory) / "service.log"
            for marker in (b"first\n", b"second\n"):
                with log_path.open("wb") as handle:
                    handle.write(marker)
            self.assertEqual(log_path.read_bytes(), b"second\n")

    def test_installer_does_not_terminate_a_just_started_service(self):
        source = INSTALLER_PATH.read_text(encoding="utf-8")
        self.assertIn("service_was_up=0", source)
        self.assertIn('if [ "$service_was_up" -eq 1 ]; then', source)
        start_invocation = source.index('\n"$START_LINE"\n')
        self.assertLess(source.index("service_was_up=0"), start_invocation)
        self.assertLess(start_invocation, source.index('svc -t "$SERVICE_LINK"'))
        self.assertNotIn(
            'svc -t "$SERVICE_LINK" >/dev/null 2>&1 || svc -u "$SERVICE_LINK"',
            source,
        )

    def test_weather_is_separate_read_only_changed_only_path(self):
        class FakeService:
            def __init__(self, _name, register=False):
                self.values = {}
                self.path_options = {}
                self.assignments = []

            def add_mandatory_paths(self, **_kwargs):
                return None

            def add_path(self, path, value, **options):
                self.values[path] = value
                self.path_options[path] = options

            def register(self):
                return None

            def __setitem__(self, path, value):
                self.values[path] = value
                self.assignments.append((path, value))

            def __getitem__(self, path):
                return self.values[path]

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        bridge = MODULE.CamperControlBridge(object(), FakeService)
        self.assertFalse(bridge._service.path_options["/State/Weather"].get("writeable", False))
        self.assertTrue(bridge._service.path_options["/Command"].get("writeable", False))
        self.assertTrue(bridge._service.path_options["/Settings/WeatherLocation"].get("writeable", False))
        self.assertEqual(
            json.loads(bridge._service.values["/Settings/WeatherLocation"]),
            {
                "schema": 1,
                "weather": {"mode": "gps", "stationId": ""},
                "tide": {"mode": "gps", "stationId": ""},
            },
        )
        payload = {"schema": 1, "hourly": [], "daily": [], "stale": False}
        bridge._apply_weather(payload)
        bridge._apply_weather(payload)
        writes = [value for path, value in bridge._service.assignments if path == "/State/Weather"]
        self.assertEqual(len(writes), 1)
        self.assertEqual(json.loads(writes[0]), payload)

        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn('threading.Thread(target=self._weather_worker', source)

        fragments = {section: "{}" for section in MODULE.STATE_SECTIONS}
        with mock.patch.object(MODULE.time, "time", side_effect=[1000, 1001, 1060]):
            bridge._apply_state(fragments)
            bridge._apply_state(fragments)
            bridge._apply_state(fragments)
        fragment_writes = [path for path, _value in bridge._service.assignments if path.startswith("/State/") and path != "/State/Weather"]
        heartbeat_writes = [value for path, value in bridge._service.assignments if path == "/Status/LastUpdate"]
        self.assertEqual(len(fragment_writes), len(MODULE.STATE_SECTIONS))
        self.assertEqual(heartbeat_writes, [1000, 1060])

    def test_weather_location_write_is_validated_centrally_and_wakes_provider(self):
        bridge = MODULE.CamperControlBridge.__new__(MODULE.CamperControlBridge)
        bridge._weather = mock.Mock()
        bridge._weather_wakeup = MODULE.threading.Event()
        bridge._service = {}
        raw = json.dumps(
            {
                "schema": 1,
                "weather": {"mode": "station", "stationId": "10641"},
                "tide": {"mode": "gps", "stationId": ""},
            }
        )
        self.assertTrue(bridge._accept_weather_location("/Settings/WeatherLocation", raw))
        bridge._weather.update_location_config.assert_called_once_with(raw)
        self.assertTrue(bridge._weather_wakeup.is_set())
        self.assertEqual(bridge._service["/Status/WeatherLocationError"], "")

        bridge._weather_wakeup.clear()
        bridge._weather.update_location_config.side_effect = ValueError("invalid")
        self.assertFalse(bridge._accept_weather_location("/Settings/WeatherLocation", "{}"))
        self.assertFalse(bridge._weather_wakeup.is_set())
        self.assertEqual(bridge._service["/Status/WeatherLocationError"], "invalid")

    def test_compact_state_preserves_ui_sections_and_removes_volatile_values(self):
        state = {
            "sequence": 9,
            "ui": {"quickAccess": [{"id": "pump", "seen": 123}]},
            "weather": {"schema": 1, "hourly": [{"t": "2026-08-20T06:00:00Z"}]},
            "energy": {"battery": {"soc": 87.5, "lastSeen": 123}},
            "water": {"fresh": {"level": None}},
            "climate": {"roomTemperature": 21.4},
            "lights": {"items": [{"id": "inside_main", "on": True}]},
            "vehicle": {"highBeam": {"manualOn": False}},
            "power": {"inverter": {"on": True}},
            "operations": {
                "scenes": [{"id": "camping", "name": "Camping", "seen": 123}],
                "lightScenes": [{"id": "night", "values": {"inside_main": 20}}],
            },
            "system": {"network": {"password": "must-not-cross-vrm"}},
        }
        fragments = MODULE.compact_state(state)
        self.assertEqual(tuple(fragments), MODULE.STATE_SECTIONS)
        self.assertEqual(json.loads(fragments["energy"]), {"battery": {"soc": 87.5}})
        self.assertEqual(
            json.loads(fragments["operations"]),
            {
                "lightScenes": [{"id": "night", "values": {"inside_main": 20}}],
                "scenes": [{"id": "camping", "name": "Camping"}],
            },
        )
        self.assertNotIn("seen", fragments["ui"])
        self.assertNotIn("weather", "".join(fragments.values()))
        self.assertNotIn("password", "".join(fragments.values()))

    def test_command_validation_accepts_current_api_shape(self):
        raw = json.dumps(
            {
                "target": "starpower",
                "action": "dim",
                "origin": "gx",
                "value": 55,
                "channel": 9,
                "requestId": "gui-v2-mqtt-1",
            }
        )
        canonical, body = MODULE.validate_command_payload(raw)
        self.assertEqual(body["channel"], 9)
        self.assertEqual(json.loads(canonical), body)

    def test_command_validation_rejects_non_commands_and_oversize_payloads(self):
        for value in (
            "",
            "[]",
            '{"target":"x"}',
            '{"target":"starpower","action":"set","origin":"sync"}',
            '{"target":"starpower","action":"set"}',
            "x" * (MODULE.MAX_COMMAND_BYTES + 1),
        ):
            with self.subTest(value=value[:20]):
                with self.assertRaises(ValueError):
                    MODULE.validate_command_payload(value)

    def test_state_worker_backs_off_when_local_node_red_is_unresponsive(self):
        class FakeStop:
            def __init__(self):
                self.waits = []

            def is_set(self):
                return len(self.waits) >= 4

            def wait(self, seconds):
                self.waits.append(seconds)

        class FakeGlib:
            @staticmethod
            def idle_add(*_args):
                return None

        bridge = MODULE.CamperControlBridge.__new__(MODULE.CamperControlBridge)
        bridge._stop = FakeStop()
        bridge._glib = FakeGlib()
        bridge._state_delivery_lock = MODULE.threading.Lock()
        bridge._pending_state_delivery = None
        bridge._state_delivery_scheduled = False
        with mock.patch.object(MODULE, "_http_json", side_effect=OSError("timeout")):
            bridge._state_worker()
        self.assertEqual(bridge._stop.waits, [1.0, 2.0, 5.0, 10.0])


if __name__ == "__main__":
    unittest.main()
