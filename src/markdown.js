export function parseMarkdown(raw) {
  const lines = raw.split("\n");
  let start = 0;
  let frontmatter = null;
  if ((lines[0] ?? "").trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && l.trim() === "---");
    if (end !== -1) {
      frontmatter = lines.slice(0, end + 1).join("\n");
      start = end + 1;
    }
  }
  const heads = [];
  for (let j = start; j < lines.length; j++) {
    const m = lines[j].match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) heads.push({ line: j, level: m[1].length, title: m[2].trim() });
  }
  const bounds = [...heads.map((h) => h.line), lines.length];
  const sections = [];
  if (!heads.length || heads[0].line > start) {
    const endIdx = heads.length ? heads[0].line : lines.length;
    const body = trimBlank(lines.slice(start, endIdx));
    if (body.length) {
      sections.push({
        level: 0,
        title: "",
        path: "",
        bodyStart: start,
        bodyEnd: endIdx,
        body: body.join("\n"),
      });
    }
  }
  const stack = [];
  heads.forEach((h, k) => {
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
    const bodyLines = trimBlank(lines.slice(h.line + 1, bounds[k + 1]));
    sections.push({
      level: h.level,
      title: h.title,
      path: stack.filter((s) => s.level > 1).map((s) => s.title).join("::"),
      bodyStart: h.line + 1,
      bodyEnd: bounds[k + 1],
      body: bodyLines.join("\n"),
    });
  });
  return { frontmatter, sections };
}

function trimBlank(arr) {
  let a = 0;
  let b = arr.length;
  while (a < b && !arr[a].trim()) a++;
  while (b > a && !arr[b - 1].trim()) b--;
  return arr.slice(a, b);
}

export function docTitle(parsed, fileName) {
  const h1 = parsed.sections.find((s) => s.level === 1);
  if (h1) return h1.title;
  if (parsed.frontmatter) {
    const m = parsed.frontmatter.match(/^title:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return fileName.replace(/\.md$/, "");
}

export function replaceSectionBody(raw, sec, newBody) {
  const lines = raw.split("\n");
  const replacement = newBody.replace(/\n+$/, "").split("\n");
  return [...lines.slice(0, sec.bodyStart), ...replacement, ...lines.slice(sec.bodyEnd)].join("\n");
}

export function appendSection(raw, headingPath, body) {
  const note = raw.replace(/\n+$/, "");
  const content = body.replace(/\n+$/, "");
  return `${note ? `${note}\n\n` : ""}## ${headingPath}${content ? `\n\n${content}` : ""}\n`;
}
