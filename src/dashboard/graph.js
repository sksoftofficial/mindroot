let library;

export async function mountGraph(view, data) {
  const notes = new Map(data.docs.map((doc) => [doc.path, {
    id: "note:" + doc.path, kind: "note", label: doc.title || doc.path,
    neighbors: new Set(),
  }]));
  const nodes = [...notes.values()];
  const links = [];
  for (const memory of data.memories) {
    const [path] = (memory.target_path || "").split("::");
    const note = notes.get(path);
    const node = {
      id: "memory:" + memory.id, kind: "memory", label: memory.text,
      memoryId: memory.id,
      neighbors: new Set(),
    };
    nodes.push(node);
    // Section targets share their note's node; no new relationships are inferred.
    if (note) {
      links.push({ source: node.id, target: note.id });
      node.neighbors.add(note.id);
      note.neighbors.add(node.id);
    }
  }
  if (!nodes.length) {
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
  view.className = "view graph-view";
  view.innerHTML = `
    <div class="graph-workspace">
      <div class="graph-stage">
        <div class="graph-canvas" role="img" aria-label="Project graph showing notes, memories, and their existing connections."></div>
        <div class="graph-legend"><span><i></i>Notes</span><span><i class="memory-dot"></i>Memories</span></div>
        <div class="graph-controls"><button aria-label="Zoom in">+</button><button aria-label="Zoom out">-</button></div>
      </div>
    </div>
    <p class="graph-hint">Drag to pan or move a node. Scroll or pinch to zoom. Only existing memory-to-note links are shown.</p>`;

  const host = view.querySelector(".graph-canvas");
  const styles = getComputedStyle(view);
  const colors = { note: styles.getPropertyValue("--accent").trim(), memory: styles.getPropertyValue("--ok").trim() };
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reducedMotion ? 0 : 300;
  let selected = null;
  let hovered = null;
  let disposed = false;
  let initialFit = true;
  let fitFrame;
  const radius = (node, scale = 1) => node.kind === "note"
    ? Math.max(4 / scale, 5 + Math.min(5, Math.sqrt(node.neighbors.size)))
    : Math.max(2 / scale, 3.5);
  const focused = (node) => {
    const active = hovered || selected;
    return !active || active === node || active.neighbors.has(node.id);
  };
  const paint = (node, ctx, scale) => {
    const active = hovered === node || selected === node;
    const bright = focused(node);
    const r = radius(node, scale);
    ctx.save();
    ctx.globalAlpha = bright ? 1 : 0.18;
    if (active) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4 / scale, 0, Math.PI * 2);
      ctx.strokeStyle = colors[node.kind];
      ctx.lineWidth = 1.5 / scale;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
    ctx.fillStyle = colors[node.kind];
    ctx.fill();
    if (active || (bright && node.kind === "note")) {
      const label = node.kind === "memory" ? "#" + node.memoryId + " " + node.label : node.label;
      const text = label.length > 48 ? label.slice(0, 47) + "..." : label;
      const fontSize = 12 / scale;
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const y = node.y + r + 5 / scale;
      const width = ctx.measureText(text).width;
      ctx.fillStyle = "#161616";
      ctx.fillRect(node.x - width / 2 - 3 / scale, y - 1 / scale, width + 6 / scale, fontSize + 4 / scale);
      ctx.fillStyle = active ? "#fff" : "#c4c4c4";
      ctx.fillText(text, node.x, y);
    }
    ctx.restore();
  };

  const graph = new ForceGraph(host)
    .width(host.clientWidth).height(host.clientHeight)
    .backgroundColor(styles.getPropertyValue("--bg2").trim())
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
      if (active && (link.source === active || link.target === active)) return "#e9973f99";
      return active ? "#ffffff0c" : "#ffffff26";
    })
    .linkWidth(1)
    .minZoom(0.15).maxZoom(8)
    .warmupTicks(100).cooldownTicks(reducedMotion ? 0 : 100)
    .onNodeHover((node) => { hovered = node; host.style.cursor = node ? "pointer" : "grab"; redraw(); })
    .onNodeClick((node) => { selected = node; redraw(); })
    .onBackgroundClick(() => { selected = null; redraw(); })
    .onEngineStop(() => {
      if (initialFit && nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))) {
        initialFit = false;
        fit();
      }
    });
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

  function fit() {
    cancelAnimationFrame(fitFrame);
    // Fitting before the async layout initializes poisons the camera with NaN.
    // Defer camera changes until after the current canvas frame is painted.
    fitFrame = requestAnimationFrame(() => {
      if (disposed || !host.clientWidth || !host.clientHeight ||
          !nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))) return;
      graph.zoomToFit(0, 60);
      redraw();
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
    resize.disconnect();
    graph._destructor();
  };
}
