import { getRenderedAttributes } from "@tiptap/core";
import { TaskItem } from "@tiptap/extension-list";
import i18n from "@/i18n";
import { hasTaskItemSubContent, isTaskItemCollapsed } from "./task-item-collapse";

const visuallyHiddenStyle = "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

const createToggleIcon = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 18 6-6-6-6");
  svg.appendChild(path);
  return svg;
};

export const CollapsibleTaskItem = TaskItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      collapsed: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) => element.getAttribute("data-collapsed") === "true",
        renderHTML: (attributes) => attributes.collapsed ? { "data-collapsed": "true" } : {},
      },
    };
  },
  addNodeView() {
    return ({ node, HTMLAttributes, getPos, editor }) => {
      const listItem = document.createElement("li");
      const toggle = document.createElement("button");
      const checkboxWrapper = document.createElement("label");
      const checkboxStyler = document.createElement("span");
      const checkbox = document.createElement("input");
      const content = document.createElement("div");

      toggle.type = "button";
      toggle.className = "edgeever-task-toggle";
      toggle.contentEditable = "false";
      toggle.appendChild(createToggleIcon());

      checkboxStyler.style.cssText = visuallyHiddenStyle;
      checkboxWrapper.contentEditable = "false";
      checkbox.type = "checkbox";
      checkbox.addEventListener("mousedown", (event) => event.preventDefault());

      const syncCheckboxA11y = (currentNode: typeof node) => {
        const label = currentNode.textContent || i18n.t("editorToolbar.taskList");
        checkbox.setAttribute("aria-label", label);
        checkboxStyler.textContent = label;
      };

      const syncCollapseState = (currentNode: typeof node) => {
        const collapsible = hasTaskItemSubContent(currentNode.childCount);
        const collapsed = isTaskItemCollapsed(currentNode.attrs.collapsed);
        listItem.dataset.collapsed = collapsed ? "true" : "false";
        toggle.classList.toggle("is-placeholder", !collapsible);
        toggle.tabIndex = collapsible ? 0 : -1;
        if (collapsible) {
          toggle.setAttribute("aria-label", i18n.t(collapsed ? "editorToolbar.taskExpand" : "editorToolbar.taskCollapse"));
          toggle.setAttribute("aria-expanded", String(!collapsed));
          toggle.removeAttribute("aria-hidden");
        } else {
          toggle.removeAttribute("aria-label");
          toggle.removeAttribute("aria-expanded");
          toggle.setAttribute("aria-hidden", "true");
        }
      };

      checkbox.addEventListener("change", (event) => {
        if (!editor.isEditable) {
          checkbox.checked = !checkbox.checked;
          return;
        }
        const checked = (event.target as HTMLInputElement).checked;
        if (typeof getPos !== "function") return;
        const position = getPos();
        if (typeof position !== "number") return;
        const currentNode = editor.state.doc.nodeAt(position);
        if (!currentNode) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, {
          ...currentNode.attrs,
          checked,
        }));
      });

      toggle.addEventListener("mousedown", (event) => event.preventDefault());
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        if (!editor.isEditable || typeof getPos !== "function") return;
        const position = getPos();
        if (typeof position !== "number") return;
        const currentNode = editor.state.doc.nodeAt(position);
        if (!currentNode || !hasTaskItemSubContent(currentNode.childCount)) return;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, {
          ...currentNode.attrs,
          collapsed: !isTaskItemCollapsed(currentNode.attrs.collapsed),
        }));
      });

      Object.entries(this.options.HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });
      listItem.dataset.type = this.name;
      listItem.dataset.checked = String(node.attrs.checked === true);
      listItem.dataset.collapsed = String(isTaskItemCollapsed(node.attrs.collapsed));
      checkbox.checked = node.attrs.checked === true;
      syncCheckboxA11y(node);
      syncCollapseState(node);

      checkboxWrapper.appendChild(checkbox);
      checkboxWrapper.appendChild(checkboxStyler);
      listItem.appendChild(toggle);
      listItem.appendChild(checkboxWrapper);
      listItem.appendChild(content);

      Object.entries(HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });

      let previousRenderedAttributeKeys = new Set(Object.keys(HTMLAttributes));

      return {
        dom: listItem,
        contentDOM: content,
        update: (updatedNode) => {
          if (updatedNode.type !== this.type) return false;
          const newHTMLAttributes = getRenderedAttributes(updatedNode, editor.extensionManager.attributes);
          const newKeys = new Set(Object.keys(newHTMLAttributes));
          const staticAttrs = this.options.HTMLAttributes;
          previousRenderedAttributeKeys.forEach((key) => {
            if (newKeys.has(key)) return;
            if (key in staticAttrs) listItem.setAttribute(key, staticAttrs[key]);
            else listItem.removeAttribute(key);
          });
          Object.entries(newHTMLAttributes).forEach(([key, value]) => {
            if (value === null || value === undefined) {
              if (key in staticAttrs) listItem.setAttribute(key, staticAttrs[key]);
              else listItem.removeAttribute(key);
            } else {
              listItem.setAttribute(key, value);
            }
          });
          previousRenderedAttributeKeys = newKeys;
          listItem.dataset.type = this.name;
          listItem.dataset.checked = String(updatedNode.attrs.checked === true);
          checkbox.checked = updatedNode.attrs.checked === true;
          syncCheckboxA11y(updatedNode);
          syncCollapseState(updatedNode);
          return true;
        },
      };
    };
  },
});
