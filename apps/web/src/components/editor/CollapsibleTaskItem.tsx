import { getRenderedAttributes } from "@tiptap/core";
import {
  EdgeEverTaskItem,
  handleConsecutiveListEnter,
  insertListItemChildParagraph,
  splitTaskItemWithoutInheritedMarks,
  toggleTaskItemCollapseAtSelection,
} from "@edgeever/shared";
import i18n from "@/i18n";
import { memoTaskAttributes, nextMemoTaskMark } from "@/lib/memo-tasks";
import { hasTaskItemSubContent, isTaskItemCollapsed } from "./task-item-collapse";
import { createTaskItemCompositionPlugin } from "./task-item-composition";

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

export const CollapsibleTaskItem = EdgeEverTaskItem.extend({
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
  addCommands() {
    return {
      ...this.parent?.(),
      toggleTaskItemCollapse: () => ({ state, dispatch }: { state: any; dispatch?: any }) => {
        return toggleTaskItemCollapseAtSelection(state, dispatch);
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Enter: () => this.editor.commands.command(({ state, dispatch }) => {
        if (handleConsecutiveListEnter(state, dispatch)) {
          return true;
        }
        return splitTaskItemWithoutInheritedMarks(state, dispatch);
      }),
      "Shift-Enter": () => this.editor.commands.command(({ state, dispatch }) => {
        return insertListItemChildParagraph(state, dispatch);
      }),
      "Mod-Alt-t": () => this.editor.commands.command(({ state, dispatch }) => {
        return toggleTaskItemCollapseAtSelection(state, dispatch);
      }),
    };
  },
  addProseMirrorPlugins() {
    return [...(this.parent?.() ?? []), createTaskItemCompositionPlugin()];
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
        const text = currentNode.textContent || i18n.t("editorToolbar.taskList");
        const label = currentNode.attrs.rejected === true ? `${i18n.t("editorToolbar.taskRejected")} · ${text}` : text;
        if (checkbox.getAttribute("aria-label") !== label) checkbox.setAttribute("aria-label", label);
        if (checkboxStyler.textContent !== label) checkboxStyler.textContent = label;
      };

      let renderedCollapseState = "";
      const syncCollapseState = (currentNode: typeof node) => {
        const collapsible = hasTaskItemSubContent(currentNode.childCount);
        const collapsed = isTaskItemCollapsed(currentNode.attrs.collapsed);
        const collapseState = `${collapsible}:${collapsed}`;
        if (collapseState === renderedCollapseState) return;
        renderedCollapseState = collapseState;
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

      checkbox.addEventListener("change", () => {
        if (!editor.isEditable) {
          checkbox.checked = !checkbox.checked;
          return;
        }
        if (typeof getPos !== "function") return;
        const position = getPos();
        if (typeof position !== "number") return;
        const currentNode = editor.state.doc.nodeAt(position);
        if (!currentNode) return;
        // Read the document, not the browser's two-state checkbox toggle.
        const mark = nextMemoTaskMark(currentNode.attrs);
        editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, {
          ...currentNode.attrs,
          ...memoTaskAttributes(mark),
        }));
      });

      toggle.addEventListener("mousedown", (event) => event.preventDefault());
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        if (typeof getPos !== "function") return;
        const position = getPos();
        if (typeof position !== "number") return;
        toggleTaskItemCollapseAtSelection(editor.state, editor.view.dispatch, position);
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
      let destroyed = false;
      const finishComposition = () => queueMicrotask(() => {
        if (destroyed || editor.isDestroyed || editor.view.composing || typeof getPos !== "function") return;
        const position = getPos();
        if (typeof position !== "number") return;
        const currentNode = editor.state.doc.nodeAt(position);
        if (currentNode?.type === this.type) syncCheckboxA11y(currentNode);
      });
      content.addEventListener("compositionend", finishComposition);

      return {
        dom: listItem,
        contentDOM: content,
        ignoreMutation: (mutation) => {
          if (mutation.type === "selection") return false;
          return mutation.target === listItem && mutation.type === "attributes"
            || toggle.contains(mutation.target)
            || checkboxWrapper.contains(mutation.target);
        },
        stopEvent: (event) => event.target instanceof Node
          && (toggle.contains(event.target) || checkboxWrapper.contains(event.target)),
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
              if (key in staticAttrs) {
                if (listItem.getAttribute(key) !== String(staticAttrs[key])) listItem.setAttribute(key, staticAttrs[key]);
              } else if (listItem.hasAttribute(key)) listItem.removeAttribute(key);
            } else if (listItem.getAttribute(key) !== String(value)) {
              listItem.setAttribute(key, value);
            }
          });
          previousRenderedAttributeKeys = newKeys;
          if (listItem.dataset.type !== this.name) listItem.dataset.type = this.name;
          const checked = updatedNode.attrs.checked === true;
          if (listItem.dataset.checked !== String(checked)) listItem.dataset.checked = String(checked);
          if (checkbox.checked !== checked) checkbox.checked = checked;
          // Updating non-editable label text can disturb the browser's IME selection.
          if (!editor.view.composing) syncCheckboxA11y(updatedNode);
          syncCollapseState(updatedNode);
          return true;
        },
        destroy: () => {
          destroyed = true;
          content.removeEventListener("compositionend", finishComposition);
        },
      };
    };
  },
});
