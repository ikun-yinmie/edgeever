import { buildOutlineTree, type OutlineTreeItem } from "./editor-outline";

const getHeadings = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
    .filter((heading) => heading.textContent?.trim());

export const hasNoteHtmlOutline = (bodyHtml: string) => {
  const root = document.createElement("div");
  root.innerHTML = bodyHtml;
  return getHeadings(root).length > 0;
};

export type NoteHtmlOutlineLabels = {
  show: string;
  hide: string;
  expandAll: string;
  collapseAll: string;
  expandHeading: string;
  collapseHeading: string;
};

const defaultLabels: NoteHtmlOutlineLabels = {
  show: "Show outline",
  hide: "Hide outline",
  expandAll: "Expand all headings",
  collapseAll: "Collapse all headings",
  expandHeading: "Expand {name}",
  collapseHeading: "Collapse {name}",
};

export const buildNoteHtmlOutline = (bodyHtml: string, label: string, labels = defaultLabels) => {
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
  const button = (className: string, text: string, icon: string) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.setAttribute("aria-label", text);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", icon);
    svg.appendChild(path);
    element.appendChild(svg);
    return element;
  };
  const renderList = (items: OutlineTreeItem[], depth = 0): HTMLOListElement => {
    const list = document.createElement("ol");
    for (const item of items) {
      const row = document.createElement("li");
      const heading = document.createElement("div");
      heading.className = "edgeever-html-outline-row";
      heading.style.setProperty("--outline-depth", String(depth));
      if (item.children.length) {
        const toggle = button("edgeever-html-outline-branch", labels.collapseHeading.replace("{name}", item.text), "m9 18 6-6-6-6");
        toggle.dataset.expandLabel = labels.expandHeading.replace("{name}", item.text);
        toggle.dataset.collapseLabel = labels.collapseHeading.replace("{name}", item.text);
        toggle.setAttribute("aria-expanded", "true");
        heading.appendChild(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "edgeever-html-outline-spacer";
        heading.appendChild(spacer);
      }
      const link = document.createElement("a");
      link.setAttribute("href", `#${encodeURIComponent(ids[item.pos])}`);
      link.textContent = item.text;
      heading.appendChild(link);
      row.appendChild(heading);
      if (item.children.length) row.appendChild(renderList(item.children, depth + 1));
      list.appendChild(row);
    }
    return list;
  };
  const sidebar = document.createElement("aside");
  sidebar.className = "edgeever-html-outline-sidebar";
  const restore = button("edgeever-html-outline-restore", labels.show, "M3 3h18v18H3zM15 3v18m-4-12-3 3 3 3");
  restore.setAttribute("aria-expanded", "false");
  sidebar.appendChild(restore);
  const nav = document.createElement("nav");
  nav.className = "edgeever-html-outline";
  nav.setAttribute("aria-label", label);
  const header = document.createElement("div");
  header.className = "edgeever-html-outline-header";
  const title = document.createElement("span");
  title.className = "edgeever-html-outline-title";
  title.textContent = label;
  header.appendChild(title);
  if (tree.some((item) => item.children.length)) {
    const toggleAll = button("edgeever-html-outline-all", labels.collapseAll, "m7 10 5-5 5 5m-10 4 5 5 5-5");
    toggleAll.dataset.expandLabel = labels.expandAll;
    toggleAll.dataset.collapseLabel = labels.collapseAll;
    header.appendChild(toggleAll);
  }
  const hide = button("edgeever-html-outline-hide", labels.hide, "M3 3h18v18H3zM15 3v18m-7-12 3 3-3 3");
  hide.setAttribute("aria-expanded", "true");
  header.appendChild(hide);
  nav.appendChild(header);
  const scroller = document.createElement("div");
  scroller.className = "edgeever-html-outline-scroll";
  scroller.appendChild(renderList(tree));
  nav.appendChild(scroller);
  sidebar.appendChild(nav);
  return { bodyHtml: root.innerHTML, outlineHtml: sidebar.outerHTML };
};

// The exported file runs offline without the app bundle or translated text in executable code.
export const NOTE_HTML_OUTLINE_SCRIPT = `(() => {
  const shell = document.querySelector('.edgeever-html-shell');
  const sidebar = shell?.querySelector(':scope > .edgeever-html-outline-sidebar');
  const content = shell?.querySelector(':scope > article > .edgeever-html-content');
  if (!sidebar || !content) return;
  const links = Array.from(sidebar.querySelectorAll('a'));
  const headings = links.map(link => document.getElementById(decodeURIComponent(link.hash.slice(1))));
  const branches = Array.from(sidebar.querySelectorAll('.edgeever-html-outline-branch'));
  const allButton = sidebar.querySelector('.edgeever-html-outline-all');
  const restore = sidebar.querySelector('.edgeever-html-outline-restore');
  const hide = sidebar.querySelector('.edgeever-html-outline-hide');
  const scroller = sidebar.querySelector('.edgeever-html-outline-scroll');
  const narrow = window.matchMedia('(max-width: 900px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activeIndex = 0;
  let pausedUntil = 0;
  let frame = 0;
  let activeLink;
  let readingScrollY = null;

  const refreshActive = () => {
    let visible = links[activeIndex];
    let parent = visible?.closest('li');
    while (parent && sidebar.contains(parent)) {
      if (parent.parentElement.hidden) visible = parent.parentElement.previousElementSibling.querySelector('a');
      parent = parent.parentElement.closest('li');
    }
    links.forEach(link => {
      if (link === visible) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    if (visible && activeLink !== visible) {
      activeLink = visible;
      const row = visible.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      if (row.top < viewport.top || row.bottom > viewport.bottom) {
        scroller.scrollTop += row.top - viewport.top - viewport.height / 2;
      }
    }
  };
  const setBranch = (toggle, expanded) => {
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? toggle.dataset.collapseLabel : toggle.dataset.expandLabel);
    toggle.parentElement.nextElementSibling.hidden = !expanded;
  };
  const refreshAll = () => {
    if (!allButton) return;
    const collapsed = branches.every(toggle => toggle.getAttribute('aria-expanded') === 'false');
    allButton.setAttribute('aria-pressed', String(collapsed));
    allButton.setAttribute('aria-label', collapsed ? allButton.dataset.expandLabel : allButton.dataset.collapseLabel);
  };
  branches.forEach(toggle => {
    setBranch(toggle, false);
    toggle.addEventListener('click', () => {
      setBranch(toggle, toggle.getAttribute('aria-expanded') !== 'true');
      refreshAll();
      refreshActive();
    });
  });
  allButton?.addEventListener('click', () => {
    const expanded = branches.every(toggle => toggle.getAttribute('aria-expanded') === 'false');
    branches.forEach(toggle => setBranch(toggle, expanded));
    refreshAll();
    refreshActive();
  });
  const setCollapsed = (collapsed) => {
    if (narrow.matches && !collapsed) readingScrollY = window.scrollY;
    shell.classList.toggle('edgeever-html-outline-collapsed', collapsed);
    if (narrow.matches) {
      if (!collapsed) sidebar.scrollIntoView({ block: 'start', behavior: 'instant' });
      else if (readingScrollY !== null) {
        window.scrollTo({ top: readingScrollY, behavior: 'instant' });
        readingScrollY = null;
      }
    }
    if (collapsed) restore.focus({ preventScroll: true });
    else {
      hide.focus({ preventScroll: true });
      activeLink = null;
      refreshActive();
    }
  };
  restore.addEventListener('click', () => setCollapsed(false));
  hide.addEventListener('click', () => setCollapsed(true));
  sidebar.addEventListener('keydown', event => {
    if (event.key === 'Escape') setCollapsed(true);
  });
  shell.classList.toggle('edgeever-html-outline-collapsed', narrow.matches);
  narrow.addEventListener('change', () => {
    readingScrollY = null;
    shell.classList.toggle('edgeever-html-outline-collapsed', narrow.matches);
  });
  shell.classList.add('edgeever-html-outline-ready');
  refreshAll();

  const updateFromScroll = () => {
    frame = 0;
    if (Date.now() < pausedUntil || readingScrollY !== null) return;
    activeIndex = 0;
    const atEnd = window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    headings.forEach((heading, index) => {
      if (heading?.getClientRects().length && (atEnd || heading.getBoundingClientRect().top <= 80)) activeIndex = index;
    });
    refreshActive();
  };
  links.forEach((link, index) => link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !headings[index]) return;
    event.preventDefault();
    let ancestor = headings[index].parentElement;
    while (ancestor && ancestor !== content) {
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    pausedUntil = Date.now() + 800;
    activeIndex = index;
    refreshActive();
    if (narrow.matches) setCollapsed(true);
    window.scrollTo({ top: window.scrollY + headings[index].getBoundingClientRect().top - 72, behavior: reduceMotion.matches ? 'instant' : 'smooth' });
    history.replaceState(null, '', link.hash);
    window.setTimeout(updateFromScroll, 850);
  }));
  window.addEventListener('scroll', () => {
    if (!frame) frame = window.requestAnimationFrame(updateFromScroll);
  }, { passive: true });
  window.addEventListener('resize', updateFromScroll);
  window.addEventListener('load', updateFromScroll);
  updateFromScroll();
})();`;
