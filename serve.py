#!/usr/bin/env python3
# /// script
# dependencies = []
# ///
"""Local dev server for stac-trace.

Just serves web/ on :8000. Cluster analysis runs entirely in the browser
via OpenRouter (Qwen3-VL); the API key is stored in the user's localStorage,
so no proxying or secrets are needed here.
"""

import http.server

PORT = 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory="web", **kwargs)

    def log_message(self, format, *args):
        if len(args) >= 2 and "200" in str(args[1]):
            return
        super().log_message(format, *args)


if __name__ == "__main__":
    print(f"Serving on http://localhost:{PORT}  (web/)")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
