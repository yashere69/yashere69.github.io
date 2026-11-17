"""Fixtures: a static server for dist/, a Chromium page, and the native runner."""

import importlib.util
import json
import os
import shutil
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = Path(os.environ.get("SITE_DIST", ROOT / "dist"))
# Software GL, so the bench renders on CI machines without a GPU.
CHROMIUM_ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".whl": "application/zip",
    }

    def log_message(self, *args):
        pass


@pytest.fixture(scope="session")
def dist() -> Path:
    if not (DIST / "py" / "manifest.json").exists():
        pytest.exit(f"{DIST} isn't built; run python tools/build.py first", returncode=2)
    return DIST


@pytest.fixture(scope="session")
def manifest(dist):
    return json.loads((dist / "py" / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def presets():
    return json.loads((ROOT / "src" / "presets.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def base_url(dist):
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(dist)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/"
    server.shutdown()


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch(args=CHROMIUM_ARGS)
        yield b
        b.close()


def open_page(browser, url, **context_args):
    ctx = browser.new_context(**context_args)
    page = ctx.new_page()
    page.problems = []
    page.on("pageerror", lambda e: page.problems.append(f"pageerror: {e}"))
    page.on(
        "console",
        lambda m: page.problems.append(f"console {m.type}: {m.text}") if m.type == "error" else None,
    )
    page.goto(url)
    return page


def wait_for_python(page, timeout=90_000):
    page.locator("#py-status[data-state=ready]").wait_for(timeout=timeout)


@pytest.fixture(scope="module")
def ready_page(browser, base_url):
    page = open_page(browser, base_url)
    page.evaluate("window.__site.py.start()")
    wait_for_python(page)
    yield page
    page.context.close()


@pytest.fixture(scope="session")
def native():
    """src/runner.py loaded into this CPython, with the built wheels installed."""
    spec = importlib.util.spec_from_file_location("site_runner", ROOT / "src" / "runner.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def workdir(tmp_path, dist, manifest):
    """A directory laid out like the browser's: each tool's examples, by relative path."""

    def make(tools, files=None):
        d = tmp_path / "work"
        if d.exists():
            shutil.rmtree(d)
        d.mkdir()
        for tool in tools:
            for e in manifest["examples"][tool]:
                dest = d / e["path"]
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(dist / e["file"], dest)
        for rel, text in (files or {}).items():
            dest = d / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(text, encoding="utf-8")
        return d

    return make
