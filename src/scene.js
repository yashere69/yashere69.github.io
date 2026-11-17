// The bench: a cutting mat with a conveyor loop and one small machine per tool.
// Everything is built from boxes, cylinders and cones; there are no model files.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PCFShadowMap,
  Raycaster,
  Scene,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

const C = {
  mat: 0x2d5a4c,
  line: 0x4f7d6d,
  paper: 0xe9ece6,
  ink: 0x1f2d29,
  tape: 0xf2c230,
  rust: 0xb5442c,
  steel: 0x8c9a95,
  curtain: 0x8e2f23,
  glass: 0xbfe0d4,
};

const MAT_W = 16;
const MAT_D = 10;

const mats = new Map();
function mat(color, opts = {}) {
  const key = `${color}-${JSON.stringify(opts)}`;
  if (!mats.has(key)) {
    mats.set(key, new MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02, ...opts }));
  }
  return mats.get(key);
}

function box(w, h, d, color, x = 0, y = 0, z = 0, opts) {
  const m = new Mesh(new BoxGeometry(w, h, d), mat(color, opts));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(rt, rb, h, color, x = 0, y = 0, z = 0, seg = 20) {
  const m = new Mesh(new CylinderGeometry(rt, rb, h, seg), mat(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function matTexture() {
  const W = 1600;
  const H = 1000;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d");
  const u = W / MAT_W;
  g.fillStyle = "#2d5a4c";
  g.fillRect(0, 0, W, H);
  // fine grid, every half unit
  g.strokeStyle = "rgba(120,170,150,0.28)";
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += u / 2) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let y = 0; y <= H; y += u / 2) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  // heavier lines every two units
  g.strokeStyle = "rgba(160,200,185,0.45)";
  g.lineWidth = 2;
  for (let x = 0; x <= W; x += u * 2) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  for (let y = 0; y <= H; y += u * 2) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  // 45 and 60 degree guides from one corner, as on a real cutting mat
  g.strokeStyle = "rgba(160,200,185,0.3)";
  for (const deg of [30, 45, 60]) {
    const a = (deg * Math.PI) / 180;
    g.beginPath(); g.moveTo(0, H); g.lineTo(Math.cos(a) * W * 1.5, H - Math.sin(a) * W * 1.5); g.stroke();
  }
  // ruler ticks along two edges
  g.strokeStyle = "#f2c230";
  g.fillStyle = "#f2c230";
  g.font = "600 18px sans-serif";
  for (let i = 0; i <= MAT_W * 4; i++) {
    const x = (i * u) / 4;
    const len = i % 4 === 0 ? 26 : i % 2 === 0 ? 16 : 9;
    g.lineWidth = i % 4 === 0 ? 2.5 : 1.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, len); g.stroke();
    if (i % 8 === 0 && i > 0 && i < MAT_W * 4) g.fillText(String(i / 4), x + 4, 44);
  }
  for (let i = 0; i <= MAT_D * 4; i++) {
    const y = (i * u) / 4;
    const len = i % 4 === 0 ? 26 : i % 2 === 0 ? 16 : 9;
    g.lineWidth = i % 4 === 0 ? 2.5 : 1.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(len, y); g.stroke();
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// A flat ribbon along the loop, with raised edges.
function ribbon(curve, width, y, color, samples = 320) {
  const pos = new Float32Array((samples + 1) * 2 * 3);
  const idx = [];
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = curve.getPointAt(t % 1);
    const tan = curve.getTangentAt(t % 1);
    const n = new Vector3().crossVectors(up, tan).normalize().multiplyScalar(width / 2);
    pos.set([p.x + n.x, y, p.z + n.z, p.x - n.x, y, p.z - n.z], i * 6);
    if (i < samples) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new Mesh(geo, mat(color));
  m.receiveShadow = true;
  return m;
}

// ---- the nine machines ------------------------------------------------------------------
// Each returns {group, height, update(dt, time), pass()} where pass() fires when a message
// card goes by. Animations are small, so the bench reads as a working line, not a toy box.

function nakli() {
  const g = new Group();
  g.add(box(1.3, 0.25, 1.0, C.ink, 0, 0.125, 0));
  g.add(box(0.14, 1.2, 0.14, C.steel, -0.5, 0.85, -0.3), box(0.14, 1.2, 0.14, C.steel, 0.5, 0.85, -0.3));
  g.add(box(1.2, 0.2, 0.3, C.steel, 0, 1.45, -0.3));
  const ram = new Group();
  ram.add(box(0.12, 0.5, 0.12, C.steel, 0, 0.25, 0), box(0.62, 0.16, 0.42, C.tape, 0, 0, 0));
  ram.position.set(0, 0.95, 0);
  g.add(ram);
  const stack = new Group();
  for (let i = 0; i < 4; i++) stack.add(box(0.5, 0.05, 0.34, C.paper, 0.05 * (i % 2), 0.29 + i * 0.06, 0.15));
  g.add(stack);
  let hit = 0;
  return {
    group: g, height: 1.7,
    update(dt) {
      hit = Math.max(0, hit - dt * 2.2);
      ram.position.y = 0.95 - Math.sin(hit * Math.PI) * 0.45;
    },
    pass() { hit = 1; },
  };
}

function chat2faq() {
  const g = new Group();
  for (const [x, z] of [[-0.42, -0.3], [0.42, -0.3], [0, 0.42]]) g.add(cyl(0.05, 0.05, 1.0, C.steel, x, 0.5, z, 8));
  const funnel = new Mesh(new ConeGeometry(0.62, 0.8, 24, 1, true), mat(C.paper, { side: 2 }));
  funnel.rotation.x = Math.PI;
  funnel.position.y = 1.25;
  funnel.castShadow = true;
  g.add(funnel);
  g.add(cyl(0.08, 0.08, 0.3, C.ink, 0, 0.75, 0, 12));
  const tray = box(0.8, 0.08, 0.6, C.ink, 0, 0.04, 0);
  g.add(tray);
  const card = box(0.36, 0.03, 0.24, C.tape, 0, 0.1, 0);
  g.add(card);
  let k = 0;
  return {
    group: g, height: 1.75,
    update(dt) {
      k = Math.max(0, k - dt * 1.5);
      card.position.y = 0.1 + k * 0.5;
      funnel.rotation.y += dt * 0.4;
    },
    pass() { k = 1; },
  };
}

function parda(tangentAngle) {
  // The loop runs through this frame; slats close as a card passes.
  const g = new Group();
  const frame = new Group();
  frame.add(box(0.12, 1.5, 0.12, C.steel, 0, 0.75, -0.55), box(0.12, 1.5, 0.12, C.steel, 0, 0.75, 0.55));
  frame.add(box(0.16, 0.12, 1.3, C.ink, 0, 1.5, 0));
  g.add(frame);
  const slats = [];
  for (let i = 0; i < 7; i++) {
    const s = box(0.05, 1.18, 0.15, C.curtain, 0, 0.83, 0);
    g.add(s);
    slats.push(s);
  }
  g.rotation.y = tangentAngle;
  let close = 0;
  let target = 0;
  return {
    group: g, height: 1.8, onTrack: true,
    update(dt) {
      target = Math.max(0, target - dt * 0.9);
      close += (Math.min(1, target * 2) - close) * Math.min(1, dt * 8);
      slats.forEach((s, i) => {
        const open = i < 3.5 ? -0.5 + i * 0.04 : 0.5 - (6 - i) * 0.04;
        const shut = -0.48 + i * 0.16;
        s.position.z = MathUtils.lerp(open, shut, close);
        s.rotation.x = Math.sin(i + close * 3) * 0.04 * close;
      });
    },
    pass() { target = 1; },
  };
}

function turncheck() {
  const g = new Group();
  g.add(cyl(0.16, 0.2, 0.95, C.steel, 0, 0.475, 0, 16));
  const hub = new Group();
  hub.position.y = 0.85;
  for (let i = 0; i < 3; i++) {
    const arm = box(0.62, 0.07, 0.07, C.ink, 0.31, 0, 0);
    const holder = new Group();
    holder.rotation.y = (i * Math.PI * 2) / 3;
    holder.add(arm);
    hub.add(holder);
  }
  hub.rotation.z = -0.2;
  g.add(hub);
  const lamp = new Mesh(new CylinderGeometry(0.11, 0.11, 0.08, 16), mat(0x58c08c, { emissive: 0x2a8a5a, emissiveIntensity: 0.6 }));
  lamp.position.set(0, 1.0, 0);
  g.add(lamp);
  let turn = 0;
  let spin = 0;
  return {
    group: g, height: 1.25,
    update(dt) {
      if (turn > 0) {
        const step = Math.min(turn, dt * 2.5);
        spin += step;
        turn -= step;
      }
      hub.rotation.y = spin * ((Math.PI * 2) / 3);
    },
    pass() { turn += 1; },
  };
}

function chatlens() {
  const g = new Group();
  g.add(box(0.7, 0.12, 0.7, C.ink, 0, 0.06, 0));
  g.add(cyl(0.05, 0.05, 1.0, C.steel, 0, 0.6, 0, 10));
  const head = new Group();
  head.position.y = 1.15;
  const ring = new Mesh(new TorusGeometry(0.42, 0.06, 12, 40), mat(C.ink));
  ring.castShadow = true;
  const glass = new Mesh(new CylinderGeometry(0.4, 0.4, 0.03, 40), mat(C.glass, { transparent: true, opacity: 0.45, roughness: 0.1 }));
  glass.rotation.x = Math.PI / 2;
  head.add(ring, glass);
  head.rotation.x = -0.5;
  g.add(head);
  let t0 = Math.random() * 10;
  return {
    group: g, height: 1.7,
    update(dt, time) {
      head.rotation.y = Math.sin((time + t0) * 0.6) * 0.5;
    },
    pass() { t0 += 0.6; },
  };
}

function mixslot() {
  const g = new Group();
  g.add(box(1.1, 0.5, 0.7, C.ink, 0, 0.25, 0));
  g.add(cyl(0.22, 0.22, 0.06, C.steel, -0.3, 0.53, 0, 24));
  const bars = [];
  for (let i = 0; i < 5; i++) {
    const b = box(0.09, 0.4, 0.09, C.tape, 0.02 + i * 0.12, 0.7, 0);
    g.add(b);
    bars.push(b);
  }
  let boost = 0;
  return {
    group: g, height: 1.25,
    update(dt, time) {
      boost = Math.max(0, boost - dt);
      bars.forEach((b, i) => {
        const h = 0.25 + Math.abs(Math.sin(time * (2.1 + i * 0.7) + i)) * (0.35 + boost * 0.4);
        b.scale.y = h / 0.4;
        b.position.y = 0.5 + h / 2;
      });
    },
    pass() { boost = 1; },
  };
}

function chunkbench() {
  const g = new Group();
  g.add(box(1.4, 0.12, 0.8, C.ink, 0, 0.06, 0));
  for (let i = 0; i < 6; i++) g.add(box(0.13, 0.42, 0.55, i % 2 ? C.paper : 0xd5dbd2, -0.45 + i * 0.17, 0.33, 0));
  const blade = box(0.03, 0.5, 0.75, C.steel, 0.55, 0.9, 0, { metalness: 0.4, roughness: 0.35 });
  g.add(blade);
  g.add(box(0.06, 1.1, 0.06, C.steel, 0.55, 0.55, -0.42));
  let cut = 0;
  return {
    group: g, height: 1.35,
    update(dt) {
      cut = Math.max(0, cut - dt * 2);
      blade.position.y = 0.9 - Math.sin(cut * Math.PI) * 0.42;
    },
    pass() { cut = 1; },
  };
}

function skillPreflight() {
  const g = new Group();
  g.add(box(0.6, 0.9, 0.6, C.paper, 0, 0.45, 0));
  g.add(box(0.66, 0.1, 0.66, C.ink, 0, 0.95, 0));
  g.add(box(0.3, 0.2, 0.02, C.glass, 0, 0.6, 0.31));
  const boom = new Group();
  boom.position.set(0.3, 0.55, 0);
  const arm = new Group();
  for (let i = 0; i < 5; i++) arm.add(box(0.28, 0.07, 0.07, i % 2 ? C.paper : C.rust, 0.14 + i * 0.28, 0, 0));
  boom.add(arm);
  g.add(boom);
  let lift = 0;
  return {
    group: g, height: 1.2,
    update(dt) {
      lift = Math.max(0, lift - dt * 0.8);
      boom.rotation.z = Math.min(1, lift * 2) * 1.25;
    },
    pass() { lift = 1; },
  };
}

function shoplint() {
  const g = new Group();
  g.add(box(1.3, 0.5, 0.7, C.paper, 0, 0.25, 0));
  for (const [x, z] of [[-0.6, -0.32], [0.6, -0.32], [-0.6, 0.32], [0.6, 0.32]]) g.add(box(0.06, 1.25, 0.06, C.steel, x, 0.62, z));
  const awning = new Group();
  for (let i = 0; i < 7; i++) awning.add(box(0.2, 0.05, 0.86, i % 2 ? C.paper : C.tape, -0.6 + i * 0.2, 0, 0));
  awning.position.y = 1.28;
  awning.rotation.x = 0.18;
  g.add(awning);
  const goods = [];
  for (let i = 0; i < 3; i++) {
    const b = box(0.24, 0.2, 0.24, [C.rust, C.mat, C.ink][i], -0.35 + i * 0.35, 0.6, 0);
    g.add(b);
    goods.push(b);
  }
  let k = 0;
  return {
    group: g, height: 1.6,
    update(dt) {
      k = Math.max(0, k - dt * 1.5);
      goods.forEach((b, i) => { b.position.y = 0.6 + Math.max(0, Math.sin((k * 3 - i * 0.4) * Math.PI)) * 0.12 * k; });
    },
    pass() { k = 1; },
  };
}

const BUILDERS = {
  nakli, chat2faq, parda, turncheck, chatlens, mixslot, chunkbench,
  "skill-preflight": skillPreflight, shoplint,
};

export const ORDER = ["nakli", "chat2faq", "parda", "turncheck", "chatlens", "mixslot", "chunkbench", "skill-preflight", "shoplint"];

// ---------------------------------------------------------------------------------------

export function createBench({ container, labels, tooltip, onSelect, reducedMotion, onFrame }) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setClearColor(new Color(C.mat));
  container.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.add(new HemisphereLight(0xf4f6ef, 0x22443a, 1.6));
  const sun = new DirectionalLight(0xfff4de, 2.4);
  sun.position.set(-6, 14, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 9, bottom: -9, near: 1, far: 40 });
  sun.shadow.bias = -0.0004;
  sun.shadow.radius = 3;
  scene.add(sun);

  const bench = new Group();
  scene.add(bench);
  const top = new Mesh(new BoxGeometry(MAT_W, 0.3, MAT_D), [
    mat(C.mat), mat(C.mat), new MeshStandardMaterial({ map: matTexture(), roughness: 0.9 }),
    mat(C.mat), mat(0x264d41), mat(0x264d41),
  ]);
  top.position.y = -0.15;
  top.receiveShadow = true;
  bench.add(top);

  const pts = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a) * 4.5, 0, Math.sin(a) * 2.25));
  }
  const curve = new CatmullRomCurve3(pts, true, "centripetal");
  bench.add(ribbon(curve, 0.78, 0.02, C.ink));
  bench.add(ribbon(curve, 0.5, 0.03, 0x2a3b36));

  const stations = ORDER.map((tool, i) => {
    const t = (i + 0.5) / ORDER.length;
    const p = curve.getPointAt(t);
    const tan = curve.getTangentAt(t);
    const angle = Math.atan2(-tan.z, tan.x);
    const m = BUILDERS[tool](angle + Math.PI / 2);
    const outward = new Vector3(p.x, 0, p.z).normalize();
    const pos = m.onTrack ? p.clone() : p.clone().add(outward.multiplyScalar(1.3));
    m.group.position.copy(pos);
    if (!m.onTrack) m.group.rotation.y = Math.atan2(-outward.x, -outward.z) + Math.PI;
    bench.add(m.group);
    m.group.traverse((o) => { o.userData.tool = tool; });
    return { tool, t, ...m, base: pos.clone(), lift: 0, poke: 0 };
  });

  // message cards on the loop
  const cards = [];
  const N = 11;
  for (let i = 0; i < N; i++) {
    const g = new Group();
    const body = box(0.46, 0.1, 0.3, C.paper, 0, 0.11, 0);
    const lines = box(0.3, 0.012, 0.035, C.steel, -0.03, 0.166, -0.06);
    const lines2 = box(0.2, 0.012, 0.035, C.steel, -0.08, 0.166, 0.02);
    const tape = box(0.36, 0.02, 0.09, C.tape, 0, 0.17, 0.02);
    tape.visible = false;
    g.add(body, lines, lines2, tape);
    g.traverse((o) => { o.userData.card = i; });
    bench.add(g);
    cards.push({ g, tape, t: i / N, message: null, redacted: false });
  }

  let messages = [];
  let nextMessage = 0;
  function assign(card) {
    if (!messages.length) { card.message = null; return; }
    card.message = messages[nextMessage % messages.length];
    nextMessage++;
  }

  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const target = new Vector3();
  const az = { base: MathUtils.degToRad(-38), cur: MathUtils.degToRad(-38), want: MathUtils.degToRad(-38) };
  const EL = MathUtils.degToRad(36);
  let view = { w: 1, h: 1, wide: true };

  function placeCamera() {
    const r = 30;
    camera.position.set(
      target.x + r * Math.cos(EL) * Math.sin(az.cur),
      target.y + r * Math.sin(EL),
      target.z + r * Math.cos(EL) * Math.cos(az.cur),
    );
    camera.lookAt(target);
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    view = { w, h, wide: w / h > 1.15 };
    renderer.setSize(w, h, false);
    const aspect = w / h;
    // Fit the mat, then slide the view window so the bench sits up and to the right on
    // wide screens, leaving the lower left for the headline.
    const fit = view.wide ? 12.6 : Math.max(11, 17.5 / aspect);
    const shiftX = view.wide ? -fit * aspect * 0.16 : 0;
    const shiftY = view.wide ? -fit * 0.05 : -fit * 0.16;
    camera.top = fit / 2 + shiftY;
    camera.bottom = -fit / 2 + shiftY;
    camera.left = (-fit * aspect) / 2 + shiftX;
    camera.right = (fit * aspect) / 2 + shiftX;
    camera.updateProjectionMatrix();
    target.set(0, 0, 0);
    placeCamera();
    dirty = true;
  }

  // labels: real buttons, placed over each machine
  const labelEls = stations.map((s) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.tool;
    b.addEventListener("click", () => select(s.tool));
    b.addEventListener("focus", () => { hovered = s.tool; dirty = true; });
    b.addEventListener("blur", () => { if (hovered === s.tool) hovered = null; dirty = true; });
    b.addEventListener("mouseenter", () => { hovered = s.tool; dirty = true; });
    b.addEventListener("mouseleave", () => { if (hovered === s.tool) hovered = null; dirty = true; });
    li.appendChild(b);
    labels.appendChild(li);
    return { s, li, b };
  });

  const v = new Vector3();
  function placeLabels() {
    for (const { s, li } of labelEls) {
      v.copy(s.group.position);
      v.y += s.height + 0.25;
      v.project(camera);
      const x = ((v.x + 1) / 2) * view.w;
      const y = ((1 - v.y) / 2) * view.h;
      li.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  let hovered = null;
  let current = null;
  function select(tool) {
    current = tool;
    const s = stations.find((x) => x.tool === tool);
    if (s) { s.poke = 1; s.pass(); }
    for (const { s: st, b } of labelEls) b.setAttribute("aria-current", String(st.tool === tool));
    dirty = true;
    onSelect(tool);
  }

  const ray = new Raycaster();
  const ndc = new Vector2();
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(bench.children, true);
    for (const h of hits) {
      if (h.object.userData.card !== undefined) return { card: cards[h.object.userData.card] };
      if (h.object.userData.tool) return { tool: h.object.userData.tool };
    }
    return {};
  }

  const canvas = renderer.domElement;
  canvas.addEventListener("pointermove", (ev) => {
    if (ev.pointerType === "mouse") {
      const r = canvas.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width - 0.5;
      az.want = az.base + px * MathUtils.degToRad(10);
    }
    const hit = pick(ev);
    hovered = hit.tool || null;
    canvas.style.cursor = hit.tool || hit.card ? "pointer" : "default";
    showTip(hit.card, ev);
    dirty = true;
  });
  canvas.addEventListener("pointerleave", () => { hovered = null; az.want = az.base; showTip(null); dirty = true; });
  canvas.addEventListener("click", (ev) => {
    const hit = pick(ev);
    if (hit.tool) select(hit.tool);
    else if (hit.card) showTip(hit.card, ev, true);
  });

  function showTip(card, ev, sticky = false) {
    if (!card) { if (!tooltip.dataset.sticky) tooltip.hidden = true; return; }
    const msg = card.message;
    let text;
    if (!msg) text = "A customer message. Its text arrives once Python has loaded.";
    else text = card.redacted ? msg.redacted : msg.raw;
    tooltip.textContent = "";
    const head = document.createElement("strong");
    head.textContent = card.redacted ? "after parda" : "from nakli";
    const body = document.createElement("span");
    body.textContent = text;
    tooltip.append(head, body);
    const r = container.getBoundingClientRect();
    tooltip.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - 300)}px`;
    tooltip.style.top = `${ev.clientY - r.top + 14}px`;
    tooltip.hidden = false;
    if (sticky) {
      tooltip.dataset.sticky = "1";
      setTimeout(() => { delete tooltip.dataset.sticky; tooltip.hidden = true; }, 4000);
    }
  }

  const passAt = stations.map((s) => s.t);
  const speed = 0.016;
  let dirty = true;
  let last = performance.now();
  let running = false;
  let raf = 0;
  let time = 0;

  function frame(now) {
    // rAF's timestamp can be a little older than the performance.now() taken in start(),
    // which made dt negative and pushed cards to t < 0, off the end of the curve.
    const dt = MathUtils.clamp((now - last) / 1000, 0, 0.05);
    last = now;
    time += dt;
    const move = reducedMotion() ? 0 : speed * dt;
    for (const c of cards) {
      const before = c.t;
      c.t = (c.t + move) % 1;
      if (c.t < before) { c.redacted = false; assign(c); }
      for (let i = 0; i < stations.length; i++) {
        if (before < passAt[i] && c.t >= passAt[i]) {
          stations[i].pass();
          if (stations[i].tool === "parda") c.redacted = true;
        }
      }
      c.tape.visible = c.redacted;
      const p = curve.getPointAt(c.t);
      const tan = curve.getTangentAt(c.t);
      c.g.position.set(p.x, 0.04, p.z);
      c.g.rotation.y = Math.atan2(-tan.z, tan.x);
    }
    for (const s of stations) {
      if (!reducedMotion()) s.update(dt, time);
      const wantLift = s.tool === hovered || s.tool === current ? 0.12 : 0;
      s.lift += (wantLift - s.lift) * Math.min(1, dt * 10);
      s.poke = Math.max(0, s.poke - dt * 2.5);
      const squash = Math.sin(s.poke * Math.PI * 2) * 0.08 * s.poke;
      s.group.position.y = s.base.y + s.lift;
      s.group.scale.set(1 + squash, 1 - squash, 1 + squash);
    }
    az.cur += (az.want - az.cur) * Math.min(1, dt * 3);
    placeCamera();
    renderer.render(scene, camera);
    placeLabels();
    dirty = false;
    onFrame?.(dt);
    if (running) raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  // spread cards so the first frame already shows some redacted ones
  for (const c of cards) c.redacted = c.t > stations.find((s) => s.tool === "parda").t;

  resize();
  new ResizeObserver(resize).observe(container);
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !document.hidden) start();
    else stop();
  });
  io.observe(container);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (container.getBoundingClientRect().bottom > 0) start();
  });
  frame(performance.now());

  return {
    select,
    setMessages(list) {
      messages = list;
      for (const c of cards) assign(c);
    },
    get dirty() { return dirty; },
  };
}
