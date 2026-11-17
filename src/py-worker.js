// Runs the tools' real command-line entry points in Pyodide, off the main thread.
//
// Messages in:  {type: "init"}
//               {type: "run", id, steps: [{tool, argv}], files: {path: text}}
// Messages out: {type: "progress", text}
//               {type: "ready", ms, versions}
//               {type: "result", id, steps: [{stdout, stderr, code, ms}], files: {path: text}}
//               {type: "error", id?, message}

const base = new URL("../", import.meta.url);
let pyodide = null;
let manifest = null;
const exampleCache = new Map();

async function fetchVerified(rel, expected) {
  const resp = await fetch(new URL(rel, base));
  if (!resp.ok) throw new Error(`${rel}: HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== expected) throw new Error(`${rel}: sha256 mismatch, refusing to load it`);
  return new Uint8Array(buf);
}

async function init() {
  const t0 = performance.now();
  postMessage({ type: "progress", text: "fetching the manifest" });
  const mresp = await fetch(new URL("py/manifest.json", base));
  if (!mresp.ok) throw new Error(`manifest: HTTP ${mresp.status}`);
  manifest = await mresp.json();

  postMessage({ type: "progress", text: `starting Python (Pyodide ${manifest.pyodide})` });
  const indexURL = new URL("vendor/pyodide/", base).href;
  const { loadPyodide } = await import(new URL("pyodide.mjs", indexURL).href);
  pyodide = await loadPyodide({ indexURL, packages: [] });

  postMessage({ type: "progress", text: "installing the tools" });
  const site = pyodide.runPython("import sysconfig; sysconfig.get_paths()['purelib']");
  pyodide.FS.mkdirTree("/wheels");
  const blobs = await Promise.all(
    manifest.packages.map(async (p) => [p, await fetchVerified(p.file, p.sha256)]),
  );
  for (const [p, bytes] of blobs) {
    const name = p.file.split("/").pop();
    pyodide.FS.writeFile(`/wheels/${name}`, bytes);
  }
  pyodide.runPython(`
import os, zipfile
for w in sorted(os.listdir("/wheels")):
    zipfile.ZipFile("/wheels/" + w).extractall(${JSON.stringify(site)})
`);
  const runner = await fetchVerified(manifest.runner.file, manifest.runner.sha256);
  pyodide.runPython(new TextDecoder().decode(runner));
  const versions = Object.fromEntries(
    manifest.packages.map((p) => [p.name, { tag: p.tag, commit: p.commit }]),
  );
  postMessage({ type: "ready", ms: Math.round(performance.now() - t0), versions, pyodide: manifest.pyodide });
}

async function examplesFor(tool) {
  if (exampleCache.has(tool)) return exampleCache.get(tool);
  const list = manifest.examples[tool] || [];
  const files = await Promise.all(
    list.map(async (e) => [e.path, await fetchVerified(e.file, e.sha256)]),
  );
  exampleCache.set(tool, files);
  return files;
}

function writeFile(path, data) {
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir) pyodide.FS.mkdirTree(dir);
  pyodide.FS.writeFile(path, data);
}

async function runJob({ id, steps, files, collect }) {
  const work = `/work/${id}`;
  pyodide.FS.mkdirTree(work);
  const tools = [...new Set(steps.map((s) => s.tool))];
  for (const tool of tools) {
    for (const [path, bytes] of await examplesFor(tool)) writeFile(`${work}/${path}`, bytes);
  }
  for (const [path, text] of Object.entries(files || {})) {
    if (path.includes("..") || path.startsWith("/")) throw new Error(`bad path ${path}`);
    writeFile(`${work}/${path}`, text);
  }
  const os = pyodide.pyimport("os");
  os.chdir(work);
  const runCli = pyodide.globals.get("run_cli");
  const results = [];
  for (const step of steps) {
    const argv = pyodide.toPy(step.argv);
    const r = runCli(step.tool, argv).toJs();
    argv.destroy();
    results.push({ stdout: r[0], stderr: r[1], code: r[2], ms: Math.round(r[3]) });
    if (r[2] !== 0 && step.stopOnError) break;
  }
  runCli.destroy();
  const out = {};
  for (const path of collect || []) {
    try {
      out[path] = pyodide.FS.readFile(`${work}/${path}`, { encoding: "utf8" });
    } catch {
      // not written by this run
    }
  }
  os.chdir("/");
  pyodide.runPython(`import shutil; shutil.rmtree(${JSON.stringify(work)}, ignore_errors=True)`);
  os.destroy();
  return { results, files: out };
}

let ready = null;
onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      ready ??= init();
      await ready;
    } else if (msg.type === "run") {
      ready ??= init();
      await ready;
      const { results, files } = await runJob(msg);
      postMessage({ type: "result", id: msg.id, steps: results, files });
    } else if (msg.type === "line") {
      ready ??= init();
      await ready;
      const fn = pyodide.globals.get("line");
      const json = fn(msg.text, msg.style, msg.reply ?? undefined);
      fn.destroy();
      postMessage({ type: "result", id: msg.id, result: JSON.parse(json) });
    }
  } catch (err) {
    postMessage({ type: "error", id: msg.id, message: String(err && err.message ? err.message : err) });
  }
};
