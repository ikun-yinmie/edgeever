import { buildOutlineTree, type OutlineTreeItem } from "./editor-outline";

const getHeadings = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    .filter((heading) => heading.textContent?.trim());

export const hasNoteHtmlOutline = (bodyHtml: string) => {
  const root = document.createElement("div");
  root.innerHTML = bodyHtml;
  return getHeadings(root).length > 0;
};

/** Build an offline, script-free outline from body headings, not the note title. */
export const buildNoteHtmlOutline = (bodyHtml: string, label: string) => {
  const root = document.createElement("div");
  root.innerHTML = bodyHtml;
  const headings = getHeadings(root);
  if (!headings.length) return { bodyHtml, outlineHtml: "" };

  const idCounts = new Map<string, number>();
  root.querySelectorAll<HTMLElement>("[id]").forEach((element) => {
    idCounts.set(element.id, (idCounts.get(element.id) ?? 0) + 1);
  });
  const usedIds = new Set(idCounts.keys());
  const ids = headings.map((heading, index) => {
    if (heading.id && idCounts.get(heading.id) === 1) return heading.id;
    const base = `edgeever-heading-${index + 1}`;
    let id = base;
    let suffix = 1;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    heading.id = id;
    return id;
  });

  const tree = buildOutlineTree(headings.map((heading, pos) => ({
    level: Number(heading.tagName.slice(1)),
    pos,
    text: heading.textContent!.trim(),
  })));
  const renderList = (items: OutlineTreeItem[]): HTMLOListElement => {
    const list = document.createElement("ol");
    for (const item of items) {
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.setAttribute("href", `#${encodeURIComponent(ids[item.pos])}`);
      link.textContent = item.text;
      row.appendChild(link);
      if (item.children.length) row.appendChild(renderList(item.children));
      list.appendChild(row);
    }
    return list;
  };
  const nav = document.createElement("nav");
  nav.className = "edgeever-html-outline";
  nav.setAttribute("aria-label", label);
  const title = document.createElement("div");
  title.className = "edgeever-html-outline-title";
  title.textContent = label;
  nav.appendChild(title);
  nav.appendChild(renderList(tree));
  return { bodyHtml: root.innerHTML, outlineHtml: nav.outerHTML };
};
