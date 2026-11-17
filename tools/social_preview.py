"""Render public/social-preview.png (1280x640) from the built page's bench.

    python tools/build.py && python tools/social_preview.py
"""

import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
from conftest import CHROMIUM_ARGS, Handler  # noqa: E402


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT / "dist")))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    with sync_playwright() as p:
        browser = p.chromium.launch(args=CHROMIUM_ARGS)
        page = browser.new_page(viewport={"width": 1280, "height": 696}, reduced_motion="reduce")
        page.goto(url)
        page.locator("#stations button").first.wait_for()
        page.evaluate(
            "document.querySelectorAll('.py-status, .top nav')"
            ".forEach(e => { e.style.visibility = 'hidden'; })"
        )
        page.wait_for_timeout(1500)
        page.screenshot(
            path=str(ROOT / "public" / "social-preview.png"),
            clip={"x": 0, "y": 0, "width": 1280, "height": 640},
        )
        browser.close()
    server.shutdown()


if __name__ == "__main__":
    main()
