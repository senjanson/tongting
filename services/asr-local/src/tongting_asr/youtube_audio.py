"""Disposable ranged-HTTP bridge for FFmpeg versions without bounded request_size.

Googlevideo may throttle an unbounded Range request. Python fetches short ranges,
while FFmpeg retains ordinary HTTP seek semantics on an ephemeral loopback server.
The parent kills this process group, including FFmpeg, on cancellation or timeout.
"""

from __future__ import annotations

import re
import secrets
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .youtube import validate_media_url

BLOCK_BYTES = 256 * 1024
MAX_FETCH_BYTES = 16 * 1024 * 1024
RANGE = re.compile(r"bytes=(\d+)-(\d*)$")
CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)$")


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_media_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class RangedAudio:
    def __init__(self, url: str):
        self.url = validate_media_url(url)
        self.lock = threading.Lock()
        self.fetched = 0
        self.size: int | None = None
        # build_opener honors environment/macOS proxies and verifies HTTPS certificates.
        self.opener = build_opener(SafeRedirect())
        self.read(0, 1)

    def read(self, start: int, count: int) -> bytes:
        if start < 0 or not 1 <= count <= BLOCK_BYTES:
            raise ValueError("invalid range")
        with self.lock:
            if self.fetched + count > MAX_FETCH_BYTES:
                raise ValueError("media read limit exceeded")
            self.fetched += count
        request = Request(self.url, headers={"Range": f"bytes={start}-{start + count - 1}"})
        with self.opener.open(request, timeout=12) as response:
            match = CONTENT_RANGE.fullmatch(response.headers.get("Content-Range", ""))
            if response.status != 206 or match is None:
                raise ValueError("media does not support byte ranges")
            first, last, total = (int(part) for part in match.groups())
            if first != start or last < first or last >= total or last - first + 1 > count:
                raise ValueError("invalid remote byte range")
            if self.size is not None and total != self.size:
                raise ValueError("media changed during read")
            data = response.read(count + 1)
            if len(data) != last - first + 1:
                raise ValueError("incomplete remote byte range")
            self.size = total
            return data


def handler_for(audio: RangedAudio, path: str):
    class RangeHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def do_GET(self):  # noqa: N802
            if self.path != path:
                self.send_error(404)
                return
            assert audio.size is not None
            requested = RANGE.fullmatch(self.headers.get("Range", "bytes=0-"))
            if requested is None:
                self.send_error(400)
                return
            start = int(requested.group(1))
            end = min(int(requested.group(2)) if requested.group(2) else audio.size - 1, audio.size - 1)
            if start > end:
                self.send_error(416)
                return
            self.send_response(206)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{audio.size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            try:
                while start <= end:
                    data = audio.read(start, min(BLOCK_BYTES, end - start + 1))
                    self.wfile.write(data)
                    start += len(data)
            except Exception:
                # A seek closes the preceding stream. Errors close the stream too,
                # leaving FFmpeg to fail; diagnostics must not expose signed URLs.
                self.close_connection = True

    return RangeHandler


def main() -> int:
    args = sys.argv[1:]
    if not args or args.count("-i") != 1:
        return 2
    try:
        input_index = args.index("-i") + 1
        audio = RangedAudio(args[input_index])
        path = "/" + secrets.token_urlsafe(24)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(audio, path))
        server.daemon_threads = True
        server.block_on_close = False
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            args[input_index] = f"http://127.0.0.1:{server.server_port}{path}"
            # Bypass proxy environment variables for our own loopback connection.
            args[input_index - 1 : input_index - 1] = ["-http_proxy", "", "-seekable", "1"]
            return subprocess.run(args, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
    except Exception:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
