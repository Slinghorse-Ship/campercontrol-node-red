import base64
import importlib.util
import json
from pathlib import Path
import sys
import unittest


MODULE_PATH = Path(__file__).parents[1] / "cerbo-service" / "device-http-bounded.py"
SPEC = importlib.util.spec_from_file_location("device_http_bounded", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def encode(value):
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


class VanTurtleRestCommandTests(unittest.TestCase):
    def test_documented_speed_and_active_command(self):
        target = MODULE._target(["vanturtle-post", encode({"active": True, "speed": 1})])
        self.assertEqual(target[:4], ("vanturtle-fan.local", 80, "POST", "/state"))
        self.assertEqual(json.loads(target[4]), {"active": True, "speed": 1})

    def test_rejects_undocumented_field_and_invalid_speed(self):
        with self.assertRaises(ValueError):
            MODULE._target(["vanturtle-post", encode({"power": 10})])
        with self.assertRaises(ValueError):
            MODULE._target(["vanturtle-post", encode({"speed": 0})])


if __name__ == "__main__":
    unittest.main()
