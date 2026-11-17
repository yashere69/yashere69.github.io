"""The page runs the real tools, loads nothing from other hosts, and degrades cleanly."""

import hashlib
import importlib.metadata
import json
from urllib.parse import urlparse

import pytest
from axe_playwright_python.sync_playwright import Axe

from conftest import ROOT, open_page, wait_for_python

PRESETS = json.loads((ROOT / "src" / "presets.json").read_text(encoding="utf-8"))


def preset_cases(presets):
    for tool, cfg in presets.items():
        for i, p in enumerate(cfg["presets"]):
            yield pytest.param(tool, i, id=f"{tool}-{p['label']}")


def steps_for(cfg, preset, text=None):
    inp = cfg["input"]
    value = text if text is not None else (inp["default"] if inp else "")
    steps = []
    for s in preset["steps"]:
        argv = [a.replace("{input}", value) if inp and inp["kind"] == "text" else a for a in s["argv"]]
        steps.append({"tool": s["tool"], "argv": argv, "stopOnError": bool(s.get("stopOnError"))})
    files = {inp["path"]: inp["default"]} if inp and inp["kind"] == "file" else {}
    return steps, files


# ---- build output ----------------------------------------------------------------------


def test_manifest_matches_the_files(dist, manifest):
    listed = [manifest["runner"], *manifest["packages"]]
    listed += [e for files in manifest["examples"].values() for e in files]
    for entry in listed:
        data = (dist / entry["file"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"], entry["file"]


def test_native_tools_are_the_built_versions(manifest):
    """The golden tests compare against CPython; it must have the same releases installed."""
    for p in manifest["packages"]:
        if p["name"] == "pyyaml":
            continue
        assert "v" + importlib.metadata.version(p["name"]) == p["tag"], p["name"]


# ---- the page runs the real tools -------------------------------------------------------


@pytest.mark.parametrize("tool, index", list(preset_cases(PRESETS)))
def test_console_matches_cpython(ready_page, presets, native, workdir, monkeypatch, tool, index):
    cfg = presets[tool]
    steps, files = steps_for(cfg, cfg["presets"][index])
    got = ready_page.evaluate(
        "([steps, files]) => window.__site.py.run(steps, files)", [steps, files]
    )["steps"]

    work = workdir({s["tool"] for s in steps}, files)
    monkeypatch.chdir(work)
    want = []
    for s in steps:
        out, err, code, _ = native.run_cli(s["tool"], s["argv"])
        want.append({"stdout": out, "stderr": err, "code": code})
        if code and s["stopOnError"]:
            break
    assert [{k: r[k] for k in ("stdout", "stderr", "code")} for r in got] == want


@pytest.mark.parametrize(
    "style",
    ["verbatim", "lowercase", "brackets dropped", "space for underscore", "markdown bold",
     "label in Hindi", "label and digit in Hindi", "label renamed"],
)
def test_line_matches_cpython(ready_page, native, style):
    text = ready_page.input_value("#line-text")
    got = ready_page.evaluate("([t, s]) => window.__site.py.line(t, s)", [text, style])["result"]
    assert got == json.loads(native.line(text, style))


def test_line_through_the_form(ready_page):
    page = ready_page
    page.select_option("#line-style", "label in Hindi")
    page.click("#line-form .run")
    restored = page.locator('[data-slot="restored"]')
    restored.locator(".verdict").wait_for()
    assert "3 of 3 restored" in restored.inner_text()
    assert "asha.k@okicici" in restored.inner_text()
    assert "0 of 3 restored" in page.locator('[data-slot="naive"]').inner_text()
    assert "[PHONE_1]" in page.locator('[data-slot="redacted"]').inner_text()


def test_consoles_on_screen_run_once_python_is_ready(ready_page):
    page = ready_page
    page.locator("#nakli").scroll_into_view_if_needed()
    meta = page.locator('.console[data-tool="nakli"] .meta', has_text="exit 0")
    meta.wait_for()
    assert page.locator('.console[data-tool="nakli"] pre').inner_text().count("\n") == 6


def test_a_late_result_never_lands_under_another_command(ready_page):
    page = ready_page
    console = page.locator('.console[data-tool="chatlens"]')
    console.scroll_into_view_if_needed()
    page.evaluate(
        "() => { const py = window.__site.py, run = py.run.bind(py);"
        " py.run = (...a) => new Promise(r => setTimeout(() => r(run(...a)), 700)); }"
    )
    try:
        console.locator(".preset", has_text="report").click()
        console.locator(".run").click()
        console.locator(".preset", has_text="suggest").click()  # while the report is running
        page.wait_for_timeout(1500)
        assert "traces labelled" not in console.locator("pre").inner_text()
        assert console.locator(".meta").inner_text() == ""
    finally:
        page.evaluate("() => { delete window.__site.py.run; }")


def test_console_ui_shows_output_and_exit_code(ready_page):
    page = ready_page
    console = page.locator('.console[data-tool="skill-preflight"]')
    console.locator(".preset", has_text="check my skill").click()
    assert "skill-preflight check mine" in console.locator(".cmd").inner_text()
    console.locator(".run").click()
    console.locator(".meta", has_text="exit").wait_for()
    assert "instr.upload-cmd" in console.locator("pre").inner_text()
    assert console.locator(".meta").inner_text().startswith("exit 1")


def test_editing_input_changes_the_command(ready_page):
    page = ready_page
    console = page.locator('.console[data-tool="parda"]')
    console.locator("textarea").fill("PAN ABCPE1234F, it's mine")
    assert "'PAN ABCPE1234F, it'\\''s mine'" in console.locator(".cmd").inner_text()
    console.locator(".run").click()
    console.locator(".meta", has_text="exit").wait_for()
    assert console.locator("pre mark.tok").first.inner_text() == "[PAN_1]"


# ---- privacy and integrity --------------------------------------------------------------


def test_nothing_loads_from_other_hosts(browser, base_url):
    page = open_page(browser, base_url)
    seen = []
    page.on("request", lambda r: seen.append(r.url))
    page.reload()
    page.evaluate("window.__site.py.start()")
    wait_for_python(page)
    page.click("#line-form .run")
    page.locator('[data-slot="restored"] .verdict').wait_for()
    host = urlparse(base_url).netloc
    others = [u for u in seen if urlparse(u).scheme in ("http", "https") and urlparse(u).netloc != host]
    assert others == []
    assert any(u.endswith(".wasm") for u in seen)
    assert page.problems == []
    page.context.close()


def test_no_csp_violations(browser, base_url):
    ctx = browser.new_context()
    ctx.add_init_script(
        "window.__csp = []; document.addEventListener('securitypolicyviolation',"
        " e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));"
    )
    page = ctx.new_page()
    page.goto(base_url)
    page.evaluate("window.__site.py.start()")
    wait_for_python(page)
    page.locator('.console[data-tool="chat2faq"] .run').click()
    page.locator('.console[data-tool="chat2faq"] .meta', has_text="exit").wait_for()
    assert page.evaluate("window.__csp") == []
    ctx.close()


def test_a_tampered_wheel_is_refused(browser, base_url):
    ctx = browser.new_context()

    def tamper(route):
        body = bytearray(route.fetch().body())
        body[-1] ^= 0xFF
        route.fulfill(body=bytes(body), content_type="application/zip")

    ctx.route("**/py/parda-*.whl", tamper)
    page = ctx.new_page()
    page.goto(base_url)
    page.locator('.console[data-tool="nakli"] .run').click()
    status = page.locator("#py-status[data-state=error]")
    status.wait_for(timeout=90_000)
    assert "sha256 mismatch" in status.inner_text()
    ctx.close()


# ---- usable without the fancy parts -----------------------------------------------------


def test_without_webgl_the_stations_become_a_list(browser, base_url):
    ctx = browser.new_context()
    ctx.add_init_script(
        "const g = HTMLCanvasElement.prototype.getContext;"
        "HTMLCanvasElement.prototype.getContext = function (t, ...a) {"
        "  return /webgl/.test(t) ? null : g.call(this, t, ...a); };"
    )
    page = ctx.new_page()
    page.goto(base_url)
    labels = page.locator("#stations[data-fallback] button")
    labels.first.wait_for()
    assert labels.count() == 9
    assert page.locator("#bench canvas").count() == 0
    labels.filter(has_text="shoplint").click()
    page.locator("#shoplint .preset").first.wait_for()
    assert page.evaluate("document.activeElement.closest('#shoplint') !== null")
    ctx.close()


def test_keyboard_reaches_a_tool_from_the_bench(browser, base_url):
    page = open_page(browser, base_url)
    page.locator("#stations button").first.wait_for()
    page.locator("#stations button", has_text="parda").focus()
    page.keyboard.press("Enter")
    page.wait_for_timeout(300)
    assert page.evaluate("document.activeElement.closest('#parda') !== null")
    assert page.problems == []
    page.context.close()


def test_accessibility_scan(browser, base_url):
    page = open_page(browser, base_url)
    page.locator("#stations button").first.wait_for()
    results = Axe().run(page)
    serious = [
        v for v in results.response["violations"] if v["impact"] in ("serious", "critical")
    ]
    assert serious == [], [(v["id"], [n["target"] for n in v["nodes"]]) for v in serious]
    page.context.close()


@pytest.mark.parametrize("width", [360, 768])
def test_no_horizontal_scroll_on_small_screens(browser, base_url, width):
    page = open_page(browser, base_url, viewport={"width": width, "height": 800})
    page.locator("#stations button").first.wait_for()
    page.wait_for_timeout(1500)  # let the bench animate for a while
    assert page.evaluate("document.documentElement.scrollWidth") <= width
    assert page.problems == []
    page.context.close()


def test_reduced_motion_keeps_working(browser, base_url):
    page = open_page(browser, base_url, reduced_motion="reduce")
    page.locator("#stations button").first.wait_for()
    page.locator("#stations button", has_text="nakli").click()
    page.wait_for_timeout(200)
    assert page.evaluate("document.activeElement.closest('#nakli') !== null")
    assert page.problems == []
    page.context.close()
