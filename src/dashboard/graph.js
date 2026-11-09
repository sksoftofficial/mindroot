let library;

function graphData(data, project = null) {
  const prefix = project ? JSON.stringify(project.slug) + ":" : "";
  const notes = new Map(data.docs.map((doc) => [doc.path, {
    id: prefix + "note:" + doc.path, kind: "note", label: doc.title || doc.path, project,
    neighbors: new Set(),
  }]));
  const nodes = [...notes.values()];
  const links = [];
  for (const memory of data.memories) {
    const [path] = (memory.target_path || "").split("::");
    const note = notes.get(path);
    const node = {
      id: prefix + "memory:" + memory.id, kind: "memory", label: memory.text, project,
      memoryId: memory.id,
      neighbors: new Set(),
    };
    nodes.push(node);
    // Section targets share their note's node; no new relationships are inferred.
    if (note) {
      links.push({ source: node.id, target: note.id, color: project?.color });
      node.neighbors.add(note.id);
      note.neighbors.add(node.id);
    }
  }
  return { nodes, links };
}

// A layout constraint only: coordinates never create graph edges.
function brainLayout(nodes) {
  // Side-profile cortex, filled uniformly in screen space. These are layout guides,
  // never visible geometry: every rendered point is a real note or memory.
  const cortex = [[-300,-30],[-283,-108],[-225,-177],[-128,-219],[-12,-231],
    [107,-212],[210,-165],[269,-91],[284,-3],[260,64],[200,87],
    [123,65],[58,64],[3,111],[-81,119],[-152,92],[-186,47],[-251,37]];
  // The reference's lower lobe sits partly behind the cortex, with a narrow
  // sloping seam rather than a detached bean and a deep empty cutout.
  const cerebellum = [[35,103],[48,73],[73,57],[106,58],[140,65],
    [174,77],[205,86],[221,108],[216,131],[194,148],[162,157],
    [129,156],[96,147],[68,132],[46,118]];
  const outline = (angle, contour) => {
    const t = angle / (Math.PI * 2) * contour.length;
    const index = Math.floor(t);
    const f = t - index;
    const p = (offset) => contour[(index + offset + contour.length) % contour.length];
    return [0, 1].map((axis) => 0.5 * ((2 * p(0)[axis]) +
      (-p(-1)[axis] + p(1)[axis]) * f +
      (2 * p(-1)[axis] - 5 * p(0)[axis] + 4 * p(1)[axis] - p(2)[axis]) * f * f +
      (-p(-1)[axis] + 3 * p(0)[axis] - 3 * p(1)[axis] + p(2)[axis]) * f * f * f));
  };
  if (!nodes.length) return;
  const boundaries = [cortex, cerebellum].map((contour) =>
    Array.from({ length: 180 }, (_, i) => outline(i / 180 * Math.PI * 2, contour)));
  const inside = (x, y) => {
    // A fine, tapered fissure separates the overlapping lobes visually, while
    // both ends stay attached. It replaces the large bean-shaped cutout.
    const seam = (x - 65) / 140;
    if (seam > 0 && seam < 1 && Math.abs(y - (71 + 0.0015 * (x - 90) ** 2)) < 3 * Math.sin(Math.PI * seam)) return false;
    return boundaries.some((boundary) => {
      let hit = false;
      for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
        const [ax, ay] = boundary[i], [bx, by] = boundary[j];
        if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) hit = !hit;
      }
      return hit;
    });
  };
  const hash = (text) => {
    let value = 2166136261;
    for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
    value ^= value >>> 16;
    value = Math.imul(value, 0x7feb352d);
    value ^= value >>> 15;
    return value >>> 0;
  };
  // Poisson-style spacing removes lattice rows without creating clumps.
  // Spatial buckets keep distance checks local even for large collections.
  const sample = (spacing) => {
    const result = [];
    const buckets = new Map();
    for (let i = 0; i < nodes.length * 60 && result.length < nodes.length; i++) {
      const x = -310 + hash(`x:${i}`) / 4294967296 * 600;
      const y = -240 + hash(`y:${i}`) / 4294967296 * 450;
      if (!inside(x, y)) continue;
      const col = Math.floor(x / spacing), row = Math.floor(y / spacing);
      let clear = true;
      for (let dx = -1; dx <= 1 && clear; dx++) {
        for (let dy = -1; dy <= 1 && clear; dy++) {
          for (const point of buckets.get(`${col + dx}:${row + dy}`) || []) {
            if ((point.x - x) ** 2 + (point.y - y) ** 2 < spacing * spacing) { clear = false; break; }
          }
        }
      }
      if (!clear) continue;
      // Lighting varies smoothly across the face; density stays uniform.
      const volume = Math.sqrt(Math.max(0, 1 - (x / 320) ** 2 - ((y + 50) / 280) ** 2));
      const point = { x, y, depth: 0.1 + volume * 0.7, seed: hash(`point:${i}`) };
      result.push(point);
      const key = `${col}:${row}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(point);
    }
    return result;
  };
  let spacing = Math.sqrt(160000 / nodes.length) * 0.7;
  let points = sample(spacing);
  while (points.length < nodes.length) { spacing *= 0.9; points = sample(spacing); }
  // Shuffle positions independently of project and note-family input order.
  points.sort((a, b) => a.seed - b.seed);
  const ordered = [...nodes].sort((a, b) => hash(a.id) - hash(b.id) || a.id.localeCompare(b.id));
  ordered.forEach((node, i) => {
    const point = points[Math.floor(i * points.length / nodes.length)];
    Object.assign(node, { x: point.x, y: point.y, depth: point.depth, fx: point.x, fy: point.y });
  });
  return inside;
}

export async function mountGraph(view, data, { brain = false, openProject } = {}) {
  const projects = brain ? [...data].sort((a, b) => a.slug.localeCompare(b.slug))
    .map((entry, i) => ({ ...entry, color: `hsl(${178 + i * 17 % 42} 80% 82%)` })) : [];
  const graphs = brain ? projects.map((project) => graphData(project.data, project)) : [graphData(data)];
  const nodes = graphs.flatMap((graph) => graph.nodes);
  const links = graphs.flatMap((graph) => graph.links);
  const insideBrain = brain ? brainLayout(nodes) : null;
  if (!nodes.length && !brain) {
    view.innerHTML = '<div class="empty">No notes or memories to graph yet. Existing memory links will appear here automatically.</div>';
    return;
  }

  if (!library) {
    library = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/force-graph.min.js";
      script.onload = () => resolve(window.ForceGraph);
      script.onerror = () => { script.remove(); library = null; reject(new Error("Unable to load the graph renderer. Reopen Graph to retry.")); };
      document.head.appendChild(script);
    });
  }
  const ForceGraph = await library;
  if (!view.isConnected) return;
  view.className = "view graph-view" + (brain ? " brain-view" : " project-graph-view");
  view.innerHTML = `
    <div class="graph-workspace">
      <div class="graph-stage">
        <div class="graph-canvas" role="img" aria-label="Project graph showing notes, memories, and their existing connections."></div>
        <div class="graph-legend"><span><i></i>Notes</span><span><i class="memory-dot"></i>Memories</span></div>
        <div class="graph-controls"><button aria-label="Zoom in">+</button><button aria-label="Zoom out">-</button></div>
      </div>
    </div>
    <p class="graph-hint">Drag to pan or move a node. Scroll or pinch to zoom. Only existing memory-to-note links are shown.</p>`;

  if (brain) {
    const heading = document.createElement("div");
    heading.className = "brain-heading";
    const noteCount = nodes.filter((node) => node.kind === "note").length;
    heading.innerHTML = `<div class="brain-title"><span class="brain-eyebrow">Overview</span><h2>Memory atlas</h2></div>
      <dl class="brain-stats"><div><dt>Projects</dt><dd>${projects.length.toLocaleString()}</dd></div><div><dt>Notes</dt><dd>${noteCount.toLocaleString()}</dd></div><div><dt>Memories</dt><dd>${(nodes.length - noteCount).toLocaleString()}</dd></div></dl>`;
    view.prepend(heading);
    view.querySelector(".graph-canvas").setAttribute("aria-label", "Side-profile brain of all project notes and memories, with luminous existing memory-to-note connections.");
    view.querySelector(".graph-hint")?.remove();
    const footer = document.createElement("div");
    footer.className = "brain-footer";
    const caption = document.createElement("div");
    caption.className = "brain-provenance";
    caption.innerHTML = `<span class="brain-status-dot" aria-hidden="true"></span><span>${links.length.toLocaleString()} saved connections<span class="brain-gesture"> · Scroll to zoom</span></span>`;
    caption.title = "Only existing memory-to-note links are shown. No inferred connections.";
    const actions = document.createElement("div");
    actions.className = "brain-actions";
    const picker = document.createElement("select");
    picker.className = "brain-project-picker";
    picker.setAttribute("aria-label", "Open a project graph");
    picker.add(new Option("Explore a project", ""));
    for (const project of projects) {
      picker.add(new Option(project.slug, project.slug));
    }
    picker.disabled = !projects.length;
    picker.onchange = () => { if (picker.value) openProject(picker.value); };
    actions.append(picker, view.querySelector(".graph-controls"));
    footer.append(caption, actions);
    view.append(footer);
    if (!nodes.length) {
      view.querySelector(".graph-workspace").outerHTML = '<div class="empty">No notes or memories yet. Your brain takes shape as agents save knowledge.</div>';
      view.querySelector(".graph-controls").remove();
      return;
    }
  } else {
    const hint = view.querySelector(".graph-hint");
    hint.className = "brain-interaction-hint";
    hint.textContent = "Drag to arrange · Scroll or pinch to zoom";
    view.querySelector(".graph-stage").append(hint);
    const footer = document.createElement("div");
    footer.className = "brain-footer";
    footer.innerHTML = `<div class="brain-provenance" title="Only existing memory-to-note links are shown."><span class="brain-status-dot" aria-hidden="true"></span><span>${links.length.toLocaleString()} saved connections</span></div>`;
    footer.append(view.querySelector(".graph-controls"));
    view.append(footer);
  }

  const host = view.querySelector(".graph-canvas");
  // Keep the default camera's first paint out of view until fitting completes.
  host.style.visibility = "hidden";
  const colors = { note: "#efffff", memory: "#acf0ff" };
  const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = motionPreference.matches;
  const duration = reducedMotion ? 0 : 300;
  let selected = null;
  let hovered = null;
  let disposed = false;
  let initialFit = true;
  let userAdjusted = false;
  let fitFrame;
  let revealFrame;
  let motionFrame;
  let lastMotionTime = null;
  let motionTime = 0;
  const radius = (node, scale = 1) => node.kind === "note"
    ? (brain ? 1.6 + (node.depth + 1) * 0.45 : Math.max(4 / scale, 5 + Math.min(5, Math.sqrt(node.neighbors.size))))
    : (brain ? 0.65 + (node.depth + 1) * 0.4 : Math.max(2 / scale, 3.5));
  const focused = (node) => {
    const active = hovered || selected;
    return !active || active === node || active.neighbors.has(node.id);
  };
  const paint = (node, ctx, scale) => {
    const active = hovered === node || selected === node;
    const bright = focused(node);
    const r = radius(node, scale);
    ctx.save();
    ctx.globalAlpha = bright ? (brain ? 0.5 + node.depth * 0.5 : 1) : 0.12;
    ctx.shadowColor = "#8deaff";
    ctx.shadowBlur = (node.kind === "note" ? 13 : 7) + (node.pulse || 0) * 9;
    if (bright) ctx.globalAlpha = Math.min(1, ctx.globalAlpha + (node.pulse || 0) * 0.2);
    if (brain && bright && !active) ctx.globalAlpha *= 0.88 + Math.min(1, node.depth / 0.8) * 0.12;
    if (active) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4 / scale, 0, Math.PI * 2);
      ctx.strokeStyle = node.project?.color || colors[node.kind];
      ctx.lineWidth = 1.5 / scale;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = node.kind === "note" ? colors.note : node.project?.color || colors.memory;
    ctx.fill();
    ctx.shadowBlur = 0;
    if (active || (!brain && bright && node.kind === "note")) {
      const label = brain ? node.project.slug + " · " + node.label : node.kind === "memory" ? "#" + node.memoryId + " " + node.label : node.label;
      const text = label.length > 48 ? label.slice(0, 47) + "..." : label;
      const fontSize = 12 / scale;
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const y = node.y + r + 5 / scale;
      const width = ctx.measureText(text).width;
      ctx.fillStyle = "#171d20";
      ctx.fillRect(node.x - width / 2 - 3 / scale, y - 1 / scale, width + 6 / scale, fontSize + 4 / scale);
      ctx.fillStyle = active ? "#fff" : "#c4c4c4";
      ctx.fillText(text, node.x, y);
    }
    ctx.restore();
  };

  const graph = new ForceGraph(host)
    .width(host.clientWidth).height(host.clientHeight)
    .backgroundColor("#00000000")
    .nodeLabel(() => "")
    .nodeCanvasObject(paint)
    .nodePointerAreaPaint((node, color, ctx, scale) => {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius(node, scale) + 5 / scale, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    })
    .linkColor((link) => {
      const active = hovered || selected;
      // The renderer can request colors before resolving endpoint IDs to nodes.
      return active && link.source !== active && link.target !== active ? "#ffffff08" : link.color || colors.memory;
    })
    .linkWidth(brain ? 0.55 : 1)
    .enableNodeDrag(!brain)
    .minZoom(0.15).maxZoom(8)
    .warmupTicks(brain ? 0 : 100).cooldownTicks(brain || reducedMotion ? 0 : 100)
    .onNodeHover((node) => { hovered = node; host.style.cursor = node ? "pointer" : "grab"; redraw(); })
    .onNodeClick((node) => { if (brain) openProject(node.project.slug); else { selected = node; redraw(); } })
    .onBackgroundClick(() => { selected = null; redraw(); })
    .onEngineStop(() => {
      if (initialFit && nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))) {
        initialFit = false;
        fit();
      }
    });
  {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    links.forEach((link, i) => { link.signalPhase = i % (brain ? 13 : 7) === 0 ? (i * 0.61803398875) % 1 : null; });
    if (insideBrain) {
      for (const link of links) {
        const source = byId.get(link.source), target = byId.get(link.target);
        const steps = Math.max(2, Math.ceil(Math.hypot(target.x - source.x, target.y - source.y) / 4));
        link.surfaceVisibility = Array.from({ length: steps + 1 }, (_, i) => {
          const t = i / steps;
          return insideBrain(source.x + (target.x - source.x) * t, source.y + (target.y - source.y) * t) ? 1 : 0.12;
        });
        const reach = Math.min(0.25, 24 / Math.max(1, Math.hypot(target.x - source.x, target.y - source.y)));
        const stops = new Set([0, reach, 1 - reach, 1]);
        link.surfaceVisibility.forEach((value, i, samples) => {
          if (i && value !== samples[i - 1]) { stops.add((i - 1) / steps); stops.add(i / steps); }
        });
        link.surfaceStops = [...stops].sort((a, b) => a - b).map((t) => {
          const position = t * steps, index = Math.floor(position);
          const samples = link.surfaceVisibility;
          const visibility = samples[index] + ((samples[index + 1] ?? samples[index]) - samples[index]) * (position - index);
          return { t, visibility };
        });
      }
    }
    graph.linkCanvasObject((link, ctx, scale) => {
      const source = typeof link.source === "object" ? link.source : byId.get(link.source);
      const target = typeof link.target === "object" ? link.target : byId.get(link.target);
      if (!source || !target || ![source.x, source.y, target.x, target.y].every(Number.isFinite)) return;
      const active = hovered || selected;
      const highlighted = active && (source === active || target === active);
      // Dense note families stay legible without dominating the whole surface.
      const crowding = brain ? Math.min(1, Math.sqrt(10 / Math.max(1, target.neighbors.size))) : 1;
      const distance = Math.hypot(target.x - source.x, target.y - source.y);
      const opacity = active ? (highlighted ? 0.95 : 0.035) : (0.22 + ((source.depth || 0) + (target.depth || 0) + 2) * 0.12)
        * crowding * (brain ? Math.min(1, (45 / Math.max(45, distance)) ** 1.8) : 1);
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = "#54cfff";
      ctx.globalAlpha = opacity * 0.16;
      ctx.lineWidth = 4 / scale;
      if (!brain || active) ctx.stroke();
      ctx.strokeStyle = highlighted ? "#ffffff" : link.color || colors.memory;
      ctx.globalAlpha = opacity;
      if (brain && !active && distance > 0) {
        // Keep a visible connection at each neuron, including the silhouette,
        // while long crossings through the center remain subdued.
        const endpointOpacity = Math.max(opacity, 0.28 * crowding);
        const reach = Math.min(0.25, 24 / distance);
        const connection = ctx.createLinearGradient(source.x, source.y, target.x, target.y);
        link.surfaceStops.forEach(({ t, visibility }) => {
          const endpoint = Math.max(0, 1 - Math.min(t, 1 - t) / reach);
          const alpha = (opacity + (endpointOpacity - opacity) * endpoint) * visibility;
          connection.addColorStop(t, `rgba(172, 240, 255, ${alpha})`);
        });
        ctx.strokeStyle = connection;
        ctx.globalAlpha = 1;
      }
      ctx.lineWidth = (highlighted ? 1.3 : 0.75) / scale;
      ctx.stroke();
      // Visual activity follows real links without modifying the layout.
      if (!motionPreference.matches && link.signalPhase !== null && (!active || highlighted)) {
        // Longer connections get more travel time rather than faster signals.
        const cycle = brain ? Math.max(18, distance / 16 / 0.75) : 8;
        const progress = (motionTime / cycle + link.signalPhase) % 1;
        if (progress < 0.75) {
          const t = progress / 0.75;
          const x = source.x + (target.x - source.x) * t;
          const y = source.y + (target.y - source.y) * t;
          const length = Math.hypot(target.x - source.x, target.y - source.y);
          const tail = Math.max(0, t - Math.min(0.35, 14 / Math.max(1, length * scale)));
          const tailX = source.x + (target.x - source.x) * tail;
          const tailY = source.y + (target.y - source.y) * tail;
          ctx.globalAlpha = Math.min(1, Math.sin(Math.PI * t) * 1.6) * (brain && !highlighted ? 0.7 : 1);
          if (brain && !highlighted) {
            const samples = link.surfaceVisibility;
            const position = t * (samples.length - 1);
            const index = Math.floor(position);
            ctx.globalAlpha *= samples[index] + ((samples[index + 1] ?? samples[index]) - samples[index]) * (position - index);
          }
          const trail = ctx.createLinearGradient(tailX, tailY, x, y);
          trail.addColorStop(0, "#79e3ff00");
          trail.addColorStop(1, "#b9f4ff");
          ctx.strokeStyle = trail;
          ctx.lineWidth = 2.5 / scale;
          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.fillStyle = "#f0ffff";
          ctx.shadowColor = "#79e3ff";
          ctx.shadowBlur = 18;
          ctx.beginPath();
          ctx.arc(x, y, (brain ? 2.2 : 3.2) / scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    });
  }
  graph.d3Force("charge").strength(-90);
  graph.d3Force("link").distance(55);
  // Disconnected note clusters and standalone memories must not drift off-canvas.
  graph.d3Force("contain", (alpha) => {
    for (const node of nodes) {
      node.vx -= node.x * 0.035 * alpha;
      node.vy -= node.y * 0.035 * alpha;
    }
  });
  graph.graphData({ nodes, links });

  function redraw() {
    graph.nodeCanvasObject(paint);
    graph.linkColor(graph.linkColor());
  }
  const clearHover = () => { hovered = null; host.style.cursor = "grab"; redraw(); };
  host.addEventListener("pointerleave", clearHover);

  function animate(time) {
    if (disposed) return;
    motionFrame = requestAnimationFrame(animate);
    if (lastMotionTime === null) { lastMotionTime = time; return; }
    const elapsed = time - lastMotionTime;
    if (elapsed < 1000 / 30) return;
    lastMotionTime = time;
    motionTime += elapsed / 1000;
    nodes.forEach((node, i) => {
      const phase = i * 2.3999632297;
      node.pulse = Math.max(0, Math.sin(motionTime * 0.65 + phase)) ** 8;
    });
    redraw();
  }

  function updateMotion() {
    cancelAnimationFrame(motionFrame);
    lastMotionTime = null;
    if (disposed) return;
    if (motionPreference.matches) {
      for (const node of nodes) node.pulse = 0;
      redraw();
    } else if (!document.hidden && host.style.visibility === "visible") {
      motionFrame = requestAnimationFrame(animate);
    }
  }
  motionPreference.addEventListener("change", updateMotion);

  function fit() {
    cancelAnimationFrame(fitFrame);
    // Fitting before the async layout initializes poisons the camera with NaN.
    // Defer camera changes until after the current canvas frame is painted.
    fitFrame = requestAnimationFrame(() => {
      if (disposed || !host.clientWidth || !host.clientHeight ||
          !nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))) return;
      graph.zoomToFit(0, brain ? Math.min(60, host.clientWidth * 0.08) : 60);
      redraw();
      cancelAnimationFrame(revealFrame);
      revealFrame = requestAnimationFrame(() => {
        if (!disposed) { host.style.visibility = "visible"; updateMotion(); }
      });
    });
  }

  // A hidden browser tab suspends rendering: rAF, layout and ResizeObserver
  // delivery all pause, so a mount or resize overlapping that window can leave
  // the canvas sized for a stale viewport or the camera at the default zoom.
  // Re-assert both when the tab becomes active again.
  function refit() {
    if (disposed || document.hidden || !host.clientWidth || !host.clientHeight) return;
    graph.width(host.clientWidth).height(host.clientHeight);
    if (host.style.visibility !== "visible" || !userAdjusted) fit();
  }
  const markAdjusted = () => { userAdjusted = true; };
  host.addEventListener("wheel", markAdjusted, { passive: true, capture: true });
  host.addEventListener("pointerdown", markAdjusted, { passive: true, capture: true });
  function handleActivation() {
    if (!disposed && !document.hidden) refit();
    updateMotion();
  }
  document.addEventListener("visibilitychange", handleActivation);
  window.addEventListener("resize", refit);

  const [zoomIn, zoomOut] = view.querySelectorAll(".graph-controls button");
  zoomIn.onclick = () => { userAdjusted = true; graph.zoom(Math.min(8, graph.zoom() * 1.4), duration); };
  zoomOut.onclick = () => { userAdjusted = true; graph.zoom(Math.max(0.15, graph.zoom() / 1.4), duration); };
  const resize = new ResizeObserver(() => {
    if (disposed || !host.clientWidth || !host.clientHeight) return;
    graph.width(host.clientWidth).height(host.clientHeight);
    fit();
  });
  resize.observe(host);
  return () => {
    disposed = true;
    cancelAnimationFrame(fitFrame);
    cancelAnimationFrame(revealFrame);
    cancelAnimationFrame(motionFrame);
    motionPreference.removeEventListener("change", updateMotion);
    document.removeEventListener("visibilitychange", handleActivation);
    window.removeEventListener("resize", refit);
    resize.disconnect();
    host.removeEventListener("pointerleave", clearHover);
    graph._destructor();
  };
}
