"""Shared Playwright harness: serve web/dist with an artifact-like CSP and answer
CDN requests (jsdelivr three.js / tasks-vision) from the pinned local npm copies,
so tests run offline and exercise exactly the pinned versions."""
import contextlib
import http.server
import os
import threading
from functools import partial

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(WEB, "dist")
NODE = os.path.join(WEB, "node_modules")

CDN_MAP = {
    "https://cdn.jsdelivr.net/npm/three@0.186.1/": os.path.join(NODE, "three") + "/",
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/": os.path.join(NODE, "@mediapipe", "tasks-vision") + "/",
}

# Modelled on the artifact page rules: scripts self/inline/allowed CDNs, fetch same-origin only,
# blob: workers, fonts from Google. wasm compilation needs 'wasm-unsafe-eval', which the host may
# or may not grant, so tests run both ways.
def csp(allow_wasm: bool) -> str:
    wasm = " 'wasm-unsafe-eval'" if allow_wasm else ""
    return (
        "default-src 'self'; "
        f"script-src 'self' 'unsafe-inline'{wasm} https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://unpkg.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; "
        "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' blob: data:; worker-src 'self' blob:"
    )


class _Handler(http.server.SimpleHTTPRequestHandler):
    csp_value = ""

    def end_headers(self):
        self.send_header("Content-Security-Policy", self.csp_value)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


_MIME = {".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css"}


@contextlib.contextmanager
def server(allow_wasm=True):
    handler = type("H", (_Handler,), {"csp_value": csp(allow_wasm)})
    handler.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **_MIME, ".task": "application/octet-stream", ".tflite": "application/octet-stream"}
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(handler, directory=DIST))
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    finally:
        httpd.shutdown()


def route_cdn(page):
    def handle(route):
        url = route.request.url
        for prefix, local in CDN_MAP.items():
            if url.startswith(prefix):
                path = local + url[len(prefix):].split("?")[0]
                if os.path.isfile(path):
                    ext = os.path.splitext(path)[1]
                    with open(path, "rb") as f:
                        return route.fulfill(status=200, body=f.read(), headers={
                            "content-type": _MIME.get(ext, "application/octet-stream"), "access-control-allow-origin": "*"})
                return route.fulfill(status=404, body="not found")
        if "fonts.googleapis.com" in url:
            return route.fulfill(status=200, body="", headers={"content-type": "text/css"})
        if "fonts.gstatic.com" in url:
            return route.fulfill(status=404, body="")
        return route.continue_()
    page.route("**/*", handle)


LAUNCH_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
