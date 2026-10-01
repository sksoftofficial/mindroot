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
  // Side-profile cortex, sampled as a curved shell. These are layout guides,
  // never visible geometry: every rendered point is a real note or memory.
  const cortex = [[-300,-30],[-278,-111],[-217,-179],[-121,-217],[-5,-226],
    [111,-205],[215,-158],[271,-83],[284,6],[257,72],[197,93],
    [118,65],[54,60],[3,111],[-81,119],[-152,92],[-179,44],[-251,33]];
  const outline = (angle) => {
    const t = angle / (Math.PI * 2) * cortex.length;
    const index = Math.floor(t);
    const f = t - index;
    const p = (offset) => cortex[(index + offset + cortex.length) % cortex.length];
    return [0, 1].map((axis) => 0.5 * ((2 * p(0)[axis]) +
      (-p(-1)[axis] + p(1)[axis]) * f +
      (2 * p(-1)[axis] - 5 * p(0)[axis] + 4 * p(1)[axis] - p(2)[axis]) * f * f +
      (-p(-1)[axis] + 3 * p(0)[axis] - 3 * p(1)[axis] + p(2)[axis]) * f * f * f));
  };
  const points = [];
  // Allocate fewer points to the small lower lobes for more even visual density.
  const cortexCount = Math.ceil(nodes.length * 0.85);
  const cerebellumCount = Math.floor(nodes.length * 0.12);
  const counts = [cortexCount, cerebellumCount, nodes.length - cortexCount - cerebellumCount];
  for (const [region, count] of counts.entries()) {
    for (let i = 0; i < count; i++) {
      const depth = 1 - 2 * (i + 0.5) / count;
      const angle = (i * 2.399963229728653) % (Math.PI * 2);
      const r = Math.sqrt(1 - depth * depth);
      let x, y;
      if (region === 0) {
        const edge = outline(angle);
        const fold = 1 - 0.035 * Math.sin(angle * 13 + depth * 7) ** 2;
        x = edge[0] * r * fold;
        y = -45 + (edge[1] + 45) * r * fold;
      } else if (region === 1) {
        // A compact, rounded lobe tucked under the posterior cortex.
        const fold = 1 - 0.025 * Math.cos(angle * 12 + depth * 4);
        x = 139 + Math.cos(angle) * r * 91 * fold;
        y = 124 + Math.sin(angle) * r * 54 * fold - (x - 139) * 0.16;
      } else {
        // A continuous tapered stem rather than a detached oval of points.
        const t = (i + 0.5) / count;
        const width = 25 * (1 - t) + 9 * t + 8 * Math.sin(Math.PI * t);
        y = 85 + t * 137;
        x = 37 + 30 * t - 9 * Math.sin(Math.PI * t) + Math.cos(angle) * width;
      }
      points.push({ x, y, depth, region });
    }
  }
  // Morton ordering keeps families spatially close without the old striped rows.
  const spatialKey = (point) => {
    const x = Math.round((point.x + 320) / 640 * 1023);
    const y = Math.round((point.y + 260) / 540 * 1023);
    let key = 0;
    for (let bit = 0; bit < 10; bit++) key |= ((x >> bit) & 1) << (bit * 2) | ((y >> bit) & 1) << (bit * 2 + 1);
    return key;
  };
  points.forEach((point) => { point.key = spatialKey(point); });
  points.sort((a, b) => a.region - b.region || a.key - b.key);
  // Place each note near the center of its own linked memories, not at one end.
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].kind !== "note") continue;
    const count = nodes[i].neighbors.size + 1;
    const family = points.slice(i, i + count);
    const cx = family.reduce((sum, p) => sum + p.x, 0) / count;
    const cy = family.reduce((sum, p) => sum + p.y, 0) / count;
    let nearest = i;
    for (let j = i + 1; j < i + count; j++) {
      if (Math.hypot(points[j].x - cx, points[j].y - cy) < Math.hypot(points[nearest].x - cx, points[nearest].y - cy)) nearest = j;
    }
    [points[i], points[nearest]] = [points[nearest], points[i]];
    // Morton cells and anatomical regions have discontinuities. Keep those
    // boundaries from stretching a real memory link across the whole brain.
    const anchor = points[i];
    for (let j = i + 1; j < i + count; j++) {
      const point = points[j];
      const distance = Math.hypot(point.x - anchor.x, point.y - anchor.y);
      if (distance <= 42) continue;
      // Compress smoothly rather than stacking distant memories on one ring.
      const radius = 42 + 13 * (1 - Math.exp(-(distance - 42) / 32));
      const ratio = radius / distance;
      point.x = anchor.x + (point.x - anchor.x) * ratio;
      point.y = anchor.y + (point.y - anchor.y) * ratio;
      point.depth = anchor.depth + (point.depth - anchor.depth) * ratio;
    }
    i += count - 1;
  }
  nodes.forEach((node, i) => Object.assign(node, points[i], { fx: points[i].x, fy: points[i].y }));
}

export async function mountGraph(view, data, { brain = false, openProject } = {}) {
  const projects = brain ? [...data].sort((a, b) => a.slug.localeCompare(b.slug))
    .map((entry, i) => ({ ...entry, color: `hsl(${178 + i * 17 % 42} 80% 82%)` })) : [];
  const graphs = brain ? projects.map((project) => graphData(project.data, project)) : [graphData(data)];
  const nodes = graphs.flatMap((graph) => {
    if (!brain) return graph.nodes;
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const ordered = [];
    for (const note of graph.nodes.filter((node) => node.kind === "note")) {
      ordered.push(note, ...[...note.neighbors].map((id) => byId.get(id)));
    }
    return ordered.concat(graph.nodes.filter((node) => node.kind === "memory" && !node.neighbors.size));
  });
  const links = graphs.flatMap((graph) => graph.links);
  if (brain) brainLayout(nodes);
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
    ctx.globalAlpha = bright ? (brain ? 0.5 + (node.depth + 1) * 0.25 : 1) : 0.12;
    ctx.shadowColor = "#8deaff";
    ctx.shadowBlur = (node.kind === "note" ? 13 : 7) + (node.pulse || 0) * 9;
    if (bright) ctx.globalAlpha = Math.min(1, ctx.globalAlpha + (node.pulse || 0) * 0.2);
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
    links.forEach((link, i) => { link.signalPhase = i % 7 === 0 ? (i * 0.61803398875) % 1 : null; });
    graph.linkCanvasObject((link, ctx, scale) => {
      const source = typeof link.source === "object" ? link.source : byId.get(link.source);
      const target = typeof link.target === "object" ? link.target : byId.get(link.target);
      if (!source || !target || ![source.x, source.y, target.x, target.y].every(Number.isFinite)) return;
      const active = hovered || selected;
      const highlighted = active && (source === active || target === active);
      const opacity = active ? (highlighted ? 0.95 : 0.035) : 0.22 + ((source.depth || 0) + (target.depth || 0) + 2) * 0.12;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = "#54cfff";
      ctx.globalAlpha = opacity * 0.16;
      ctx.lineWidth = 4 / scale;
      ctx.stroke();
      ctx.strokeStyle = highlighted ? "#ffffff" : link.color || colors.memory;
      ctx.globalAlpha = opacity;
      ctx.lineWidth = (highlighted ? 1.3 : 0.75) / scale;
      ctx.stroke();
      // Visual activity follows real links without modifying the layout.
      if (!motionPreference.matches && link.signalPhase !== null && (!active || highlighted)) {
        const progress = (motionTime / 8 + link.signalPhase) % 1;
        if (progress < 0.75) {
          const t = progress / 0.75;
          const x = source.x + (target.x - source.x) * t;
          const y = source.y + (target.y - source.y) * t;
          const length = Math.hypot(target.x - source.x, target.y - source.y);
          const tail = Math.max(0, t - Math.min(0.35, 14 / Math.max(1, length * scale)));
          const tailX = source.x + (target.x - source.x) * tail;
          const tailY = source.y + (target.y - source.y) * tail;
          ctx.globalAlpha = Math.min(1, Math.sin(Math.PI * t) * 1.6);
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
          ctx.arc(x, y, 3.2 / scale, 0, Math.PI * 2);
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
  document.addEventListener("visibilitychange", updateMotion);

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

  const [zoomIn, zoomOut] = view.querySelectorAll(".graph-controls button");
  zoomIn.onclick = () => graph.zoom(Math.min(8, graph.zoom() * 1.4), duration);
  zoomOut.onclick = () => graph.zoom(Math.max(0.15, graph.zoom() / 1.4), duration);
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
    document.removeEventListener("visibilitychange", updateMotion);
    resize.disconnect();
    graph._destructor();
  };
}
