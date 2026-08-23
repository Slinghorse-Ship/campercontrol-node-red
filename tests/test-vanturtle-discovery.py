#!/usr/bin/env python3

import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "cerbo-service" / "vanturtle-discovery.py"
SPEC = importlib.util.spec_from_file_location("vanturtle_discovery", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class VanTurtleDiscoveryTest(unittest.TestCase):
    def test_discovers_current_vanturtle_lease_on_cerbo_ap(self):
        leases = "\n".join(
            (
                "2000 70:af:09:65:97:b0 172.24.24.14 vanturtle-fan-0109 client",
                "3000 aa:bb:cc:dd:ee:ff 172.24.24.79 DragonflyG21 client",
            )
        )
        self.assertEqual(MODULE.discover_address(leases, now=1000), "172.24.24.14")

    def test_rejects_expired_external_and_similarly_named_leases(self):
        leases = "\n".join(
            (
                "999 70:af:09:65:97:b0 172.24.24.14 vanturtle-fan-0109 client",
                "2000 70:af:09:65:97:b0 192.168.178.14 vanturtle-fan-0109 client",
                "2000 70:af:09:65:97:b0 172.24.24.15 vanturtle-fan-0109.invalid client",
            )
        )
        self.assertIsNone(MODULE.discover_address(leases, now=1000))

    def test_managed_hosts_block_is_replaced_and_removed(self):
        original = "127.0.0.1 localhost\n"
        first = MODULE.render_hosts(original, "172.24.24.14")
        self.assertIn("172.24.24.14 vanturtle-fan.local vanturtle-fan", first)
        changed = MODULE.render_hosts(first, "172.24.24.77")
        self.assertNotIn("172.24.24.14", changed)
        self.assertEqual(changed.count(MODULE.BEGIN_MARKER), 1)
        self.assertEqual(MODULE.render_hosts(changed, None), original)


if __name__ == "__main__":
    unittest.main()
