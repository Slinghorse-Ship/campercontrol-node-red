#!/usr/bin/env python3

import importlib.util
import ipaddress
import pathlib
import sys
import unittest
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).parents[1] / "cerbo-service" / "device-http-bounded.py"
SPEC = importlib.util.spec_from_file_location("device_http_bounded_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class FakeSocket:
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.sent = b""
        self.timeout = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def settimeout(self, value):
        self.timeout = value

    def sendall(self, value):
        self.sent += value

    def recv(self, maximum):
        if not self.chunks:
            return b""
        value = self.chunks.pop(0)
        if len(value) > maximum:
            self.chunks.insert(0, value[maximum:])
            value = value[:maximum]
        return value


class BoundedDeviceHttpTest(unittest.TestCase):
    def request(self, chunks):
        connection = FakeSocket(chunks)
        with mock.patch.object(MODULE.socket, "create_connection", return_value=connection):
            response = MODULE.bounded_http_request("192.168.1.2", 80, "GET", "/state")
        self.assertIn(b"Connection: close", connection.sent)
        return response

    def test_fragmented_content_length_response_is_read_to_exact_end(self):
        response = self.request(
            [
                b"HTTP/1.1 200 OK\r\nContent-L",
                b"ength: 11\r\nContent-Type: application/json\r\n\r\n{\"ok\"",
                b":true}",
            ]
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.body, b'{"ok":true}')

    def test_fragmented_chunked_response_is_decoded_without_full_transport_buffer(self):
        response = self.request(
            [
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"ok",
                b"\r\n7\r\n\":true}\r\n0\r\n\r\n",
            ]
        )
        self.assertEqual(response.body, b'{"ok":true}')

    def test_declared_and_streamed_bodies_over_64_kib_fail_closed(self):
        declared = FakeSocket([f"HTTP/1.1 200 OK\r\nContent-Length: {MODULE.MAX_BODY_BYTES + 1}\r\n\r\n".encode()])
        with mock.patch.object(MODULE.socket, "create_connection", return_value=declared):
            with self.assertRaises(MODULE.ResponseTooLarge):
                MODULE.bounded_http_request("192.168.1.2", 80, "GET", "/state")

        streamed = FakeSocket([b"HTTP/1.1 200 OK\r\n\r\n", b"x" * MODULE.MAX_BODY_BYTES, b"x"])
        with mock.patch.object(MODULE.socket, "create_connection", return_value=streamed):
            with self.assertRaises(MODULE.ResponseTooLarge):
                MODULE.bounded_http_request("192.168.1.2", 80, "GET", "/state")

    def test_indevolt_target_accepts_only_literal_rfc1918_ipv4(self):
        for address in ("10.0.0.1", "172.24.24.159", "192.168.4.9"):
            host, port, method, path = MODULE._target(["indevolt", address])
            self.assertEqual(ipaddress.ip_address(host), ipaddress.ip_address(address))
            self.assertEqual((port, method), (8080, "POST"))
            self.assertTrue(path.startswith("/rpc/Indevolt.GetData?"))
        for address in ("8.8.8.8", "127.0.0.1", "example.org", "172.24.24.1;reboot"):
            with self.subTest(address=address):
                with self.assertRaises(ValueError):
                    MODULE._target(["indevolt", address])


if __name__ == "__main__":
    unittest.main()
