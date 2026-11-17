"""Build the site into dist/.

    python tools/build.py                       # tools cloned from GitHub at their tags
    python tools/build.py --source-dir ../repos # local checkouts (each must be at its tag)

Needs `npm ci` first (Pyodide, three.js and esbuild come from node_modules).
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tomllib
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache"
OWNER = "yashere69"
PYODIDE_FILES = [
    "pyodide.mjs",
    "pyodide.asm.mjs",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
]
FONTS = {
    "@fontsource-variable/bricolage-grotesque": ["bricolage-grotesque-latin-opsz-normal.woff2"],
    "@fontsource/mukta": [
        "mukta-latin-400-normal.woff2", "mukta-latin-600-normal.woff2",
        "mukta-devanagari-400-normal.woff2", "mukta-devanagari-600-normal.woff2",
    ],
    "@fontsource/ibm-plex-mono": ["ibm-plex-mono-latin-400-normal.woff2"],
}
STATIC = ["index.html", "favicon.svg", "social-preview.png", "404.html", "robots.txt"]
LICENSES = [
    ("three.js", "three/LICENSE"),
    ("Pyodide (MPL-2.0; unmodified files under vendor/pyodide/)", "../licenses/pyodide-314.0.8-LICENSE"),
    ("Bricolage Grotesque", "@fontsource-variable/bricolage-grotesque/LICENSE"),
    ("Mukta", "@fontsource/mukta/LICENSE"),
    ("IBM Plex Mono", "@fontsource/ibm-plex-mono/LICENSE"),
]
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(cmd: list[str], cwd: Path | None = None) -> str:
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"build: {' '.join(cmd)} failed\n{res.stdout}{res.stderr}")
    return res.stdout.strip()


def checkout(name: str, tag: str, source_dir: Path | None) -> Path:
    """A clean checkout of the tag, from GitHub or from a local clone of the repo."""
    origin = f"https://github.com/{OWNER}/{name}.git"
    if source_dir is not None:
        origin = (source_dir / name).resolve().as_uri()
    dest = CACHE / "src" / ("local" if source_dir else "github") / f"{name}-{tag}"
    if not dest.exists():
        run(["git", "clone", "-q", "--depth", "1", "--branch", tag, origin, str(dest)])
    return dest


def build_wheel(name: str, tag: str, repo: Path, out: Path) -> Path:
    tmp = CACHE / "wheels" / f"{name}-{tag}"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    run([sys.executable, "-m", "pip", "wheel", "-q", "--no-deps", "-w", str(tmp), str(repo)])
    wheels = list(tmp.glob("*.whl"))
    if len(wheels) != 1:
        sys.exit(f"build: expected one wheel for {name}, got {wheels}")
    wheel = wheels[0]
    version = wheel.name.split("-")[1]
    if f"v{version}" != tag:
        sys.exit(f"build: {name} wheel is {version}, tag is {tag}")
    target = out / wheel.name
    shutil.copyfile(wheel, target)
    return target


def pure_pyyaml(spec: dict, out: Path) -> Path:
    archive = CACHE / f"pyyaml-{spec['version']}.tar.gz"
    if not archive.exists():
        CACHE.mkdir(exist_ok=True)
        with urllib.request.urlopen(spec["url"]) as resp:  # noqa: S310 (pinned https URL)
            archive.write_bytes(resp.read())
    if sha256(archive) != spec["sha256"]:
        archive.unlink()
        sys.exit("build: PyYAML sdist does not match its pinned sha256")
    target = out / f"pyyaml-{spec['version']}-pure.zip"
    prefix = f"pyyaml-{spec['version']}/"
    with tarfile.open(archive) as tar, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        members = sorted(tar.getmembers(), key=lambda m: m.name)
        for m in members:
            if not m.isfile():
                continue
            rel = m.name.removeprefix(prefix)
            if rel.startswith("lib/yaml/") and rel.endswith(".py"):
                arc = rel.removeprefix("lib/")
            elif rel == "LICENSE":
                arc = f"PyYAML-{spec['version']}.dist-info/LICENSE"
            else:
                continue
            data = tar.extractfile(m).read()  # type: ignore[union-attr]
            zf.writestr(zipfile.ZipInfo(arc, ZIP_TIME), data)
        meta = f"Metadata-Version: 2.1\nName: PyYAML\nVersion: {spec['version']}\n"
        zf.writestr(zipfile.ZipInfo(f"PyYAML-{spec['version']}.dist-info/METADATA", ZIP_TIME), meta)
    return target


def copy_examples(name: str, repo: Path, patterns: list[str], out: Path) -> list[dict]:
    files = []
    for pattern in patterns:
        for p in sorted(glob.glob(str(repo / pattern), recursive=True)):
            path = Path(p)
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            rel = path.relative_to(repo / "examples").as_posix()
            dest = out / name / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, dest)
            files.append({"path": rel, "file": "py/" + dest.relative_to(out.parent).as_posix(),
                          "sha256": sha256(dest), "bytes": dest.stat().st_size})
    if patterns and not files:
        sys.exit(f"build: no example files matched for {name}")
    return files


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-dir", type=Path, help="local clones of the tools instead of GitHub")
    ap.add_argument("--out", type=Path, default=ROOT / "dist")
    args = ap.parse_args()

    sources = tomllib.loads((ROOT / "sources.toml").read_text(encoding="utf-8"))
    out: Path = args.out
    shutil.rmtree(out, ignore_errors=True)
    py_dir = out / "py"
    py_dir.mkdir(parents=True)

    packages = []
    examples: dict[str, list[dict]] = {}
    for name, spec in sources["tools"].items():
        repo = checkout(name, spec["tag"], args.source_dir)
        commit = run(["git", "rev-parse", "HEAD"], cwd=repo)
        wheel = build_wheel(name, spec["tag"], repo, py_dir)
        packages.append({
            "name": name, "tag": spec["tag"], "commit": commit,
            "file": f"py/{wheel.name}", "sha256": sha256(wheel), "bytes": wheel.stat().st_size,
        })
        examples[name] = copy_examples(name, repo, spec["examples"], py_dir / "examples")

    yaml_zip = pure_pyyaml(sources["pyyaml"], py_dir)
    packages.append({
        "name": "pyyaml", "tag": sources["pyyaml"]["version"], "commit": None,
        "file": f"py/{yaml_zip.name}", "sha256": sha256(yaml_zip), "bytes": yaml_zip.stat().st_size,
    })

    nm = ROOT / "node_modules"
    pyo = out / "vendor" / "pyodide"
    pyo.mkdir(parents=True)
    for f in PYODIDE_FILES:
        shutil.copyfile(nm / "pyodide" / f, pyo / f)
    pyodide_version = json.loads((nm / "pyodide" / "package.json").read_text(encoding="utf-8"))["version"]
    three_version = json.loads((nm / "three" / "package.json").read_text(encoding="utf-8"))["version"]

    runner = py_dir / "runner.py"
    shutil.copyfile(ROOT / "src" / "runner.py", runner)
    manifest = {"pyodide": pyodide_version, "three": three_version,
                "runner": {"file": "py/runner.py", "sha256": sha256(runner)},
                "packages": packages, "examples": examples}
    (py_dir / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n", encoding="utf-8")

    esbuild = nm / ".bin" / ("esbuild.cmd" if sys.platform == "win32" else "esbuild")
    common = ["--bundle", "--minify", "--format=esm", "--target=es2022", "--legal-comments=none"]
    run([str(esbuild), "src/main.js", "src/py-worker.js", *common, "--splitting",
         "--outdir=" + str(out / "assets"), "--entry-names=[name]",
         "--chunk-names=chunks/[name]-[hash]"], cwd=ROOT)
    shutil.copyfile(ROOT / "src" / "styles.css", out / "assets" / "styles.css")
    fonts = out / "assets" / "fonts"
    fonts.mkdir()
    for pkg, names in FONTS.items():
        for n in names:
            shutil.copyfile(nm / pkg / "files" / n, fonts / n)
    for f in STATIC:
        if (ROOT / "public" / f).exists():
            shutil.copyfile(ROOT / "public" / f, out / f)
    parts = ["Third-party software and fonts on this site, with their licences.\n"]
    for title, rel in LICENSES:
        parts.append(f"\n{'=' * 78}\n{title}\n{'=' * 78}\n\n{(nm / rel).read_text(encoding='utf-8')}")
    with tarfile.open(CACHE / f"pyyaml-{sources['pyyaml']['version']}.tar.gz") as tar:
        lic = tar.extractfile(f"pyyaml-{sources['pyyaml']['version']}/LICENSE").read().decode()  # type: ignore[union-attr]
    parts.append(f"\n{'=' * 78}\nPyYAML (pure-Python source, py/pyyaml-*-pure.zip)\n{'=' * 78}\n\n{lic}")
    parts.append("\nThe nine tools' wheels under py/ are MIT-licensed; see each repository.\n")
    (out / "licenses.txt").write_text("".join(parts), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"built {out} ({total / 1e6:.1f} MB): pyodide {pyodide_version}, three {three_version}, "
          f"{len(packages)} packages")


if __name__ == "__main__":
    main()
