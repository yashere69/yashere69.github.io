import presets from "./presets.json";

const $ = (sel, root = document) => root.querySelector(sel);
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const reducedMotion = () => reducedMotionQuery.matches;
const debug = { on: location.hash === "#debug", runs: [], fps: 0 };

// ---- Python in a worker ----------------------------------------------------------------

const RUN_TIMEOUT_MS = 30000;

class Py {
  constructor(statusEl) {
    this.statusEl = statusEl;
    this.worker = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.info = null;
  }

  status(state, text) {
    this.statusEl.dataset.state = state;
    this.statusEl.textContent = text;
  }

  start() {
    if (this.ready) return this.ready;
    this.status("loading", "Starting Python…");
    this.worker = new Worker(new URL("py-worker.js", import.meta.url), { type: "module" });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "progress") this.status("loading", `Python is loading: ${m.text}…`);
        else if (m.type === "ready") {
          this.info = m;
          queueMicrotask(runVisibleConsoles);
          this.status("ready", `Python ${m.pyodide ? `(Pyodide ${m.pyodide}) ` : ""}is ready. It took ${(m.ms / 1000).toFixed(1)} s; runs stay in this tab.`);
          resolve(m);
        } else if (m.type === "result" || (m.type === "error" && m.id !== undefined)) {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            clearTimeout(p.timer);
            if (m.type === "result") p.resolve(m);
            else p.reject(new Error(m.message));
          }
        } else if (m.type === "error") {
          this.status("error", `Python didn't start: ${m.message}. Reload the page to try again.`);
          reject(new Error(m.message));
        }
      };
      this.worker.onerror = (e) => {
        this.status("error", `Python didn't start: ${e.message || "the worker failed to load"}.`);
        reject(new Error(e.message));
      };
    });
    this.worker.postMessage({ type: "init" });
    return this.ready;
  }

  reset(reason) {
    this.worker?.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.worker = null;
    this.ready = null;
  }

  async call(msg) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.reset(`stopped after ${RUN_TIMEOUT_MS / 1000} s`);
        this.status("error", "A run took too long and Python was restarted. It reloads on your next run.");
      }, RUN_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ ...msg, id });
    });
  }

  run(steps, files = {}, collect = []) {
    return this.call({ type: "run", steps, files, collect });
  }

  line(text, style, reply) {
    return this.call({ type: "line", text, style, reply });
  }
}

const py = new Py($("#py-status"));

// Start Python in the background only where it's cheap to do so.
function maybePreload() {
  const c = navigator.connection;
  const cheap = !(c && (c.saveData || /2g|3g/.test(c.effectiveType || "")));
  const roomy = (navigator.deviceMemory || 8) >= 4;
  if (cheap && roomy) {
    const go = () => py.start().then(feedBench).catch(() => {});
    if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 4000 });
    else setTimeout(go, 2500);
  }
}

// ---- rendering output ------------------------------------------------------------------

// parda tokens as issued ([PHONE_1]) and as models rewrite them ([फोन_1], [phone 1])
const TOKEN = /\[[A-Za-z\u0900-\u097F]+(?:[_ ][0-9\u0966-\u096F]+)?\]/g;

function appendHighlighted(el, text) {
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) el.append(text.slice(last, m.index));
    const mark = document.createElement("mark");
    mark.className = "tok";
    mark.textContent = m[0];
    el.append(mark);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}

function shellQuote(arg) {
  if (/^[\w@%+=:,./*-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

// ---- consoles --------------------------------------------------------------------------

function buildConsole(el) {
  const tool = el.dataset.tool;
  const cfg = presets[tool];
  if (!cfg) return;
  let chosen = 0;
  let token = 0; // bumped on every preset change and run, so a late result can't land under the wrong command

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", `${tool} examples`);
  const buttons = cfg.presets.map((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "preset";
    b.textContent = p.label;
    b.setAttribute("aria-pressed", String(i === 0));
    b.addEventListener("click", () => {
      chosen = i;
      buttons.forEach((x, j) => x.setAttribute("aria-pressed", String(j === i)));
      showCommand();
      token++;
      out.textContent = "";
      meta.textContent = "";
    });
    bar.append(b);
    return b;
  });
  el.append(bar);

  let input = null;
  if (cfg.input) {
    const wrap = document.createElement("div");
    wrap.className = "editor";
    const id = `in-${tool}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = cfg.input.kind === "file" ? `Edit ${cfg.input.label}` : cfg.input.label;
    input = document.createElement("textarea");
    input.id = id;
    input.spellcheck = false;
    input.value = cfg.input.default;
    input.rows = cfg.input.kind === "file" ? Math.min(12, cfg.input.default.split("\n").length + 1) : 2;
    if (cfg.input.kind === "file") input.classList.add("code");
    input.addEventListener("input", showCommand);
    wrap.append(label, input);
    el.append(wrap);
  }

  const line = document.createElement("div");
  line.className = "cmdline";
  const cmd = document.createElement("p");
  cmd.className = "cmd";
  const run = document.createElement("button");
  run.type = "button";
  run.className = "run";
  run.textContent = "Run";
  run.setAttribute("aria-label", `Run ${tool}`);
  line.append(cmd, run);
  el.append(line);

  const out = document.createElement("pre");
  out.setAttribute("aria-live", "polite");
  out.tabIndex = 0;
  out.setAttribute("aria-label", `${tool} output`);
  const meta = document.createElement("p");
  meta.className = "meta";
  el.append(out, meta);

  function argvFor(step) {
    return step.argv.map((a) => (input && cfg.input.kind === "text" ? a.replaceAll("{input}", input.value) : a));
  }
  function showCommand() {
    const p = cfg.presets[chosen];
    cmd.textContent = p.steps.map((s) => [s.tool, ...argvFor(s)].map(shellQuote).join(" ")).join(" && ");
  }
  showCommand();

  async function execute() {
    if (run.getAttribute("aria-busy") === "true") return;
    const mine = ++token;
    const p = cfg.presets[chosen];
    const steps = p.steps.map((s) => ({ tool: s.tool, argv: argvFor(s), stopOnError: !!s.stopOnError }));
    const files = input && cfg.input.kind === "file" ? { [cfg.input.path]: input.value } : {};
    run.setAttribute("aria-busy", "true");
    run.textContent = py.info ? "Running…" : "Loading Python…";
    out.textContent = "";
    meta.textContent = "";
    try {
      const res = await py.run(steps, files);
      if (mine !== token) return;
      out.textContent = "";
      res.steps.forEach((r, i) => {
        if (res.steps.length > 1) out.append(`$ ${cmd.textContent.split(" && ")[i]}\n`);
        appendHighlighted(out, r.stdout);
        if (r.stderr) {
          const e = document.createElement("span");
          e.className = "stderr";
          e.textContent = r.stderr;
          out.append(e);
        }
      });
      const codes = res.steps.map((r) => r.code);
      const ms = res.steps.reduce((a, r) => a + r.ms, 0);
      meta.textContent = `exit ${codes.join(", ")} in ${ms < 1 ? "<1" : ms} ms, run in your browser`;
      debug.runs.push({ tool, label: p.label, ms, codes });
      renderDebug();
    } catch (err) {
      if (mine === token) meta.textContent = `Couldn't run: ${err.message}`;
    } finally {
      run.removeAttribute("aria-busy");
      run.textContent = "Run";
    }
  }
  run.addEventListener("click", execute);
  // Once Python is loaded, a console runs its first example when it scrolls into view,
  // so the page shows real output without a click. Never before: that would download
  // Python for someone who only wanted to read.
  autoRun.observe(el);
  el.runIfIdle = () => {
    if (!out.textContent && run.getAttribute("aria-busy") !== "true") execute();
  };
}

const autoRun = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting && py.info) {
        autoRun.unobserve(e.target);
        e.target.runIfIdle();
      }
    }
  },
  { rootMargin: "0px 0px -20% 0px" },
);

function runVisibleConsoles() {
  const firstLine = document.querySelector('#line-steps [data-slot="redacted"]');
  if (firstLine && !firstLine.querySelector(".verdict")) document.querySelector("#line-form").requestSubmit();
  // re-observe so consoles already on screen when Python became ready get their turn
  document.querySelectorAll(".console[data-tool]").forEach((el) => {
    autoRun.unobserve(el);
    autoRun.observe(el);
  });
}

// ---- the line --------------------------------------------------------------------------

function setupLine() {
  const form = $("#line-form");
  const text = $("#line-text");
  const style = $("#line-style");
  const slots = Object.fromEntries([...document.querySelectorAll("#line-steps [data-slot]")].map((e) => [e.dataset.slot, e]));
  const button = form.querySelector(".run");

  function markValues(el, s, values) {
    // highlight restored values so it's clear what came back
    let rest = s;
    const found = values.filter(Boolean).sort((a, b) => b.length - a.length);
    while (rest.length) {
      let best = null;
      for (const v of found) {
        const i = rest.indexOf(v);
        if (i >= 0 && (best === null || i < best.i)) best = { i, v };
      }
      if (!best) { appendHighlighted(el, rest); break; }
      appendHighlighted(el, rest.slice(0, best.i));
      const m = document.createElement("mark");
      m.className = "val";
      m.textContent = best.v;
      el.append(m);
      rest = rest.slice(best.i + best.v.length);
    }
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (button.getAttribute("aria-busy") === "true") return;
    button.setAttribute("aria-busy", "true");
    button.textContent = py.info ? "Sending…" : "Loading Python…";
    try {
      const { result: r } = await py.line(text.value, style.value);
      const n = Object.keys(r.tokens).length;
      for (const el of Object.values(slots)) el.textContent = "";
      appendHighlighted(slots.redacted, r.redacted);
      const v1 = document.createElement("span");
      v1.className = "verdict";
      v1.textContent = n ? `${n} identifier${n === 1 ? "" : "s"} replaced; ${r.leaks} left in the text` : "No identifiers found, so nothing was replaced.";
      slots.redacted.append(v1);
      appendHighlighted(slots.reply, r.reply);
      markValues(slots.restored, r.restored, r.values);
      const v2 = document.createElement("span");
      v2.className = `verdict ${r.restored_count === n ? "good" : "bad"}`;
      v2.textContent = `${r.restored_count} of ${n} restored`;
      slots.restored.append(v2);
      markValues(slots.naive, r.naive, r.values);
      const naiveCount = r.values.filter((v) => r.naive.includes(v)).length;
      const v3 = document.createElement("span");
      v3.className = `verdict ${naiveCount === n ? "good" : "bad"}`;
      v3.textContent = `${naiveCount} of ${n} restored`;
      slots.naive.append(v3);
    } catch (err) {
      slots.redacted.textContent = `Couldn't run: ${err.message}`;
    } finally {
      button.removeAttribute("aria-busy");
      button.textContent = "Send it";
    }
  });
}

// ---- manifest table --------------------------------------------------------------------

async function fillManifest() {
  const body = $("#manifest tbody");
  try {
    const m = await (await fetch("py/manifest.json")).json();
    body.textContent = "";
    const rows = [
      ...m.packages.map((p) => [p.name, p.tag, p.commit, p.bytes, p.commit ? `https://github.com/yashere69/${p.name}/tree/${p.commit}` : null]),
      ["Pyodide", m.pyodide, null, null, null],
      ["three.js", m.three, null, null, null],
    ];
    for (const [name, tag, commit, bytes, href] of rows) {
      const tr = document.createElement("tr");
      const cells = [name, tag, commit ? commit.slice(0, 7) : "", bytes ? `${(bytes / 1024).toFixed(0)} KB` : ""];
      cells.forEach((c, i) => {
        const td = document.createElement("td");
        if (i === 2 && href) {
          const a = document.createElement("a");
          a.href = href;
          a.textContent = c;
          td.append(a);
        } else td.textContent = c;
        tr.append(td);
      });
      body.append(tr);
    }
  } catch {
    body.innerHTML = "";
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "The manifest couldn't be read.";
    tr.append(td);
    body.append(tr);
  }
}

// ---- the bench -------------------------------------------------------------------------

let bench = null;

function scrollToTool(tool) {
  const el = document.getElementById(tool);
  if (!el) return;
  el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  el.setAttribute("data-flash", "");
  setTimeout(() => el.removeAttribute("data-flash"), 1600);
  const first = el.querySelector(".preset");
  first?.focus({ preventScroll: true });
}

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

async function setupBench() {
  const labels = $("#stations");
  const container = $("#bench");
  const fallback = () => {
    labels.setAttribute("data-fallback", "");
    labels.textContent = "";
    for (const tool of Object.keys(presets)) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = tool;
      b.addEventListener("click", () => scrollToTool(tool));
      li.append(b);
      labels.append(li);
    }
  };
  if (!webglAvailable()) return fallback();
  try {
    const { createBench } = await import("./scene.js");
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    container.append(tip);
    let frames = 0;
    let acc = 0;
    bench = createBench({
      container,
      labels,
      tooltip: tip,
      reducedMotion,
      onSelect: scrollToTool,
      onFrame: (dt) => {
        frames++;
        acc += dt;
        if (acc > 1) {
          debug.fps = Math.round(frames / acc);
          frames = 0;
          acc = 0;
          if (debug.on) renderDebug();
        }
      },
    });
  } catch (err) {
    console.error(err);
    container.textContent = "";
    fallback();
  }
}

// Real messages for the cards on the bench: nakli writes a few chats, parda redacts each
// customer line. Both run in the worker like every console.
async function feedBench() {
  if (!bench) return;
  const seed = String(1 + Math.floor(Math.random() * 9999));
  const res = await py.run([{ tool: "nakli", argv: ["chats", "-n", "4", "--seed", seed] }]);
  const raw = res.steps[0].stdout
    .split("\n")
    .map((l) => l.match(/^[^-]+ - ([^:]+): (.+)$/))
    .filter((m) => m && m[1] !== "Indigo Loom")
    .map((m) => m[2])
    .slice(0, 16);
  if (!raw.length) return;
  const red = await py.run(raw.map((t) => ({ tool: "parda", argv: ["redact", "--text", t] })));
  bench.setMessages(raw.map((t, i) => ({ raw: t, redacted: red.steps[i].stdout.trim() })));
}

// ---- #debug ----------------------------------------------------------------------------

const requests = [];
function renderDebug() {
  const el = $("#debug");
  if (!debug.on) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = "";
  const h = (t) => { const x = document.createElement("h2"); x.textContent = t; el.append(x); };
  const list = (items) => {
    const ul = document.createElement("ul");
    for (const i of items) { const li = document.createElement("li"); li.textContent = i; ul.append(li); }
    el.append(ul);
  };
  h(`Frame rate: ${debug.fps || "n/a"} fps${reducedMotion() ? " (reduced motion: cards stay still)" : ""}`);
  const hosts = [...new Set(requests.map((r) => new URL(r.name).host))];
  h(`Requests: ${requests.length}, to ${hosts.length} host${hosts.length === 1 ? "" : "s"}: ${hosts.join(", ")}`);
  list(requests.slice(-12).map((r) => `${new URL(r.name).pathname} ${Math.round(r.transferSize / 1024)} KB, ${Math.round(r.duration)} ms`));
  h(`Python: ${py.info ? `ready in ${py.info.ms} ms` : "not loaded"}`);
  h("Runs");
  list(debug.runs.slice(-8).map((r) => `${r.tool} / ${r.label}: ${r.ms} ms, exit ${r.codes.join(",")}`));
}

function setupDebug() {
  const obs = new PerformanceObserver((l) => {
    requests.push(...l.getEntries());
    if (debug.on) renderDebug();
  });
  obs.observe({ type: "resource", buffered: true });
  window.addEventListener("hashchange", () => {
    debug.on = location.hash === "#debug";
    renderDebug();
  });
  renderDebug();
}

// ---- go --------------------------------------------------------------------------------

document.querySelectorAll(".console[data-tool]").forEach(buildConsole);
setupLine();
fillManifest();
setupDebug();
setupBench().then(() => {
  if (py.info) feedBench();
});
maybePreload();
window.__site = { py, presets };
