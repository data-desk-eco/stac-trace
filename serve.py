#!/usr/bin/env python3
# /// script
# dependencies = ["python-dotenv"]
# ///
"""Dev server: serves web/ and streams /api/claude via the claude CLI (Max sub).
Caches responses to data/cache/ keyed by prompt hash."""

import hashlib
import http.server
import json
import os
import shutil
import subprocess

PORT = 8000
CACHE_DIR = os.path.join(os.path.dirname(__file__), "data", "cache")
os.makedirs(CACHE_DIR, exist_ok=True)


def cache_path(prompt: str) -> str:
    h = hashlib.sha256(prompt.encode()).hexdigest()[:16]
    return os.path.join(CACHE_DIR, f"{h}.txt")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory="web", **kwargs)

    def do_POST(self):
        if self.path == "/api/claude":
            self._proxy_claude()
        else:
            self.send_error(404)

    def _send_sse(self, data: str):
        self.wfile.write(f"data: {data}\n\n".encode())
        self.wfile.flush()

    def _start_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

    def _proxy_claude(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))

        prompt = ""
        for msg in body.get("messages", []):
            if msg.get("role") == "user":
                prompt = msg.get("content", "")
                break

        if not prompt:
            self.send_error(400, "No prompt found")
            return

        # Check cache
        cp = cache_path(prompt)
        if os.path.exists(cp):
            with open(cp) as f:
                cached_text = f.read()
            self._start_sse()
            # Send as a single assistant text event
            event = json.dumps({
                "type": "assistant",
                "message": {"content": [{"type": "text", "text": cached_text}]},
            })
            self._send_sse(event)
            self._send_sse("[DONE]")
            return

        try:
            claude_bin = shutil.which("claude")
            proc = subprocess.Popen(
                [
                    claude_bin, "-p",
                    "--model", "sonnet",
                    "--allowedTools", "WebSearch", "WebFetch",
                    "--output-format", "stream-json",
                    prompt,
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env={**os.environ},
            )

            self._start_sse()

            collected_text = []

            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                self._send_sse(line)

                # Collect text chunks for caching
                try:
                    event = json.loads(line)
                    if event.get("type") == "assistant":
                        for block in event.get("message", {}).get("content", []):
                            if block.get("type") == "text" and block.get("text"):
                                collected_text.append(block["text"])
                except (json.JSONDecodeError, KeyError):
                    pass

            proc.wait(timeout=5)
            self._send_sse("[DONE]")

            # Cache the final text
            full_text = "".join(collected_text)
            if full_text.strip():
                with open(cp, "w") as f:
                    f.write(full_text)

        except Exception as e:
            try:
                err = json.dumps({"type": "error", "error": str(e)})
                self._send_sse(err)
            except Exception:
                pass

    def log_message(self, format, *args):
        if len(args) >= 2 and "200" in str(args[1]) and "api" not in str(args[0]):
            return
        super().log_message(format, *args)


if __name__ == "__main__":
    if not shutil.which("claude"):
        print("ERROR: 'claude' CLI not found on PATH")
        raise SystemExit(1)
    print(f"Serving on http://localhost:{PORT}  (web/ + claude CLI streaming proxy)")
    print(f"Cache dir: {CACHE_DIR}")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
