"""Exercise the actual locked HF transport with HTTPX's in-memory network."""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "anagramd"))
import httpx
import hub_transfer
from huggingface_hub import close_session


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(close_session)
        self.part = Path(self.temp.name) / "weights.part"
        self.data = b"0123456789"
        self.requests = []

    def run_transfer(self, handler, offset=0):
        def request(req):
            self.requests.append(req)
            self.assertNotIn("authorization", req.headers)
            return handler(req)
        with contextlib.redirect_stderr(io.StringIO()):
            hub_transfer.transfer("https://fixture.test/model", self.part, len(self.data), offset,
                                  lambda n: self.assertLessEqual(n, len(self.data)),
                                  client_factory=lambda: httpx.Client(transport=httpx.MockTransport(request), follow_redirects=True),
                                  sleep=lambda _: None)

    def test_range_resume_uses_the_existing_partial(self):
        self.part.write_bytes(self.data[:4])
        self.run_transfer(lambda _: httpx.Response(206, content=self.data[4:],
                          headers={"Content-Range": "bytes 4-9/10"}), 4)
        self.assertEqual(self.requests[0].headers["range"], "bytes=4-")
        self.assertEqual(self.part.read_bytes(), self.data)

    def test_ignored_range_restarts_without_appending(self):
        self.part.write_bytes(b"bad!")
        self.run_transfer(lambda _: httpx.Response(200, content=self.data), 4)
        self.assertEqual(self.part.read_bytes(), self.data)

    def test_retry_503_then_success(self):
        def handler(_):
            return httpx.Response(503) if len(self.requests) == 1 else httpx.Response(200, content=self.data)
        self.run_transfer(handler)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.part.read_bytes(), self.data)

    def test_short_response_resumes_and_eventually_preserves_failure(self):
        def handler(_):
            start = self.part.stat().st_size
            return httpx.Response(206, content=self.data[start:start+2],
                                  headers={"Content-Range": f"bytes {start}-9/10"})
        with self.assertRaises(OSError):
            self.run_transfer(handler)
        self.assertEqual(self.part.read_bytes(), self.data[:6])
        self.assertEqual([r.headers.get("range") for r in self.requests], [None, "bytes=2-", "bytes=4-"])
        self.run_transfer(lambda _: httpx.Response(206, content=self.data[6:],
                          headers={"Content-Range": "bytes 6-9/10"}), 6)
        self.assertEqual(self.part.read_bytes(), self.data)

    def test_404_is_not_retried(self):
        with self.assertRaises(Exception):
            self.run_transfer(lambda _: httpx.Response(404))
        self.assertEqual(len(self.requests), 1)

    def test_redirect_cannot_downgrade_https(self):
        with self.assertRaisesRegex(ValueError, "non-HTTPS"):
            self.run_transfer(lambda _: httpx.Response(302, headers={"Location": "http://fixture.test/model"}))
        self.assertEqual(len(self.requests), 1)

    def test_linked_partial_never_changes_external_file(self):
        outside = self.part.with_name("outside")
        outside.write_bytes(b"keep")
        self.part.hardlink_to(outside)
        with self.assertRaisesRegex(ValueError, "linked"):
            self.run_transfer(lambda _: httpx.Response(200, content=self.data))
        self.assertEqual(outside.read_bytes(), b"keep")
        self.assertEqual(self.requests, [])

    def test_oversized_transfer_stops_before_writing(self):
        with self.assertRaisesRegex(ValueError, "pinned file size"):
            self.run_transfer(lambda _: httpx.Response(200, content=self.data * 2))
        self.assertLessEqual(self.part.stat().st_size, len(self.data))

    def test_diagnostic_removes_signed_query(self):
        self.assertEqual(hub_transfer.safe_error("GET https://cdn.test/file?Signature=secret failed"),
                         "GET https://cdn.test/file failed")


if __name__ == "__main__":
    unittest.main()
