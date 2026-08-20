#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "cerbo-service" / "campercontrol-dbus.py"
SPEC = importlib.util.spec_from_file_location("campercontrol_dbus", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class CamperControlDbusContractTest(unittest.TestCase):
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
        payload = {"schema": 1, "hourly": [], "daily": [], "stale": False}
        bridge._apply_weather(payload)
        bridge._apply_weather(payload)
        writes = [value for path, value in bridge._service.assignments if path == "/State/Weather"]
        self.assertEqual(len(writes), 1)
        self.assertEqual(json.loads(writes[0]), payload)

        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn('threading.Thread(target=self._weather_worker', source)

    def test_compact_state_preserves_ui_sections_and_removes_volatile_values(self):
        state = {
            "sequence": 9,
            "ui": {"designVersion": "v2", "quickAccess": [{"id": "pump", "seen": 123}]},
            "energy": {"battery": {"soc": 87.5, "lastSeen": 123}},
            "water": {"fresh": {"level": None}},
            "climate": {"roomTemperature": 21.4},
            "lights": {"items": [{"id": "inside_main", "on": True}]},
            "vehicle": {"highBeam": {"manualOn": False}},
            "power": {"inverter": {"on": True}},
            "system": {"network": {"password": "must-not-cross-vrm"}},
        }
        fragments = MODULE.compact_state(state)
        self.assertEqual(tuple(fragments), MODULE.STATE_SECTIONS)
        self.assertEqual(json.loads(fragments["energy"]), {"battery": {"soc": 87.5}})
        self.assertNotIn("seen", fragments["ui"])
        self.assertNotIn("password", "".join(fragments.values()))

    def test_command_validation_accepts_current_api_shape(self):
        raw = json.dumps(
            {
                "target": "starpower",
                "action": "dim",
                "value": 55,
                "channel": 9,
                "requestId": "gui-v2-mqtt-1",
            }
        )
        canonical, body = MODULE.validate_command_payload(raw)
        self.assertEqual(body["channel"], 9)
        self.assertEqual(json.loads(canonical), body)

    def test_command_validation_rejects_non_commands_and_oversize_payloads(self):
        for value in ("", "[]", '{"target":"x"}', "x" * (MODULE.MAX_COMMAND_BYTES + 1)):
            with self.subTest(value=value[:20]):
                with self.assertRaises(ValueError):
                    MODULE.validate_command_payload(value)


if __name__ == "__main__":
    unittest.main()
