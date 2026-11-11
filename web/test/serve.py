"""Shared Playwright harness: serve web/dist and make sure the page talks to nobody else.

The studio is self-contained (three.js, MediaPipe, fonts and models are its own files), so every
request to another host is a bug: `route_cdn` aborts such requests and records them, and the suites
assert that the record stays empty. The server can add a response-header CSP modelled on a
restrictive embedding host (with or without WebAssembly), on top of the page's own <meta> policy."""
import contextlib
import http.server
import os
import threading
from functools import partial

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(WEB, "dist")
NODE = os.path.join(WEB, "node_modules")

# Modelled on the artifact page rules: scripts self/inline/allowed CDNs, fetch same-origin only,
# blob: workers, fonts from Google. wasm compilation needs 'wasm-unsafe-eval', which the host may
# or may not grant, so tests run both ways.
def csp(allow_wasm: bool) -> str:
    wasm = " 'wasm-unsafe-eval'" if allow_wasm else ""
    return (
        "default-src 'self'; "
        f"script-src 'self' 'unsafe-inline'{wasm} https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' blob: data:; worker-src 'self' blob:"
    )


class _Handler(http.server.SimpleHTTPRequestHandler):
    csp_value = ""

    def end_headers(self):
        if self.csp_value:
            self.send_header("Content-Security-Policy", self.csp_value)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


_MIME = {".webmanifest": "application/manifest+json", ".woff2": "font/woff2", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css"}


@contextlib.contextmanager
def server(allow_wasm=True, header_csp=True, directory=DIST):
    handler = type("H", (_Handler,), {"csp_value": csp(allow_wasm) if header_csp else ""})
    handler.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **_MIME, ".task": "application/octet-stream", ".tflite": "application/octet-stream"}
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(handler, directory=directory))
    httpd.handle_error = lambda *a: None  # a page closing mid-download (service worker precache) is not an error
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    finally:
        httpd.shutdown()


THIRD_PARTY = []  # every request any test page tried to make to another host


def route_cdn(page):
    """Abort and record any request that leaves the test server (the name is historical)."""
    def handle(route):
        url = route.request.url
        if url.startswith(("http://127.0.0.1", "data:", "blob:", "about:")):
            return route.continue_()
        THIRD_PARTY.append(url)
        return route.abort()
    page.route("**/*", handle)


LAUNCH_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
