import katexStyles from "katex/dist/katex.min.css?inline";
import exportStyles from "@/styles/note-html-export.css?inline";
import { script, styles as interactionStyles } from "virtual:note-html-interactions";

export const NOTE_HTML_INTERACTION_SCRIPT = script;

/** Full stylesheet bundle for offline standalone HTML notes (browser/Vite only). */
export const NOTE_HTML_FULL_STYLES = `${katexStyles}\n${exportStyles}\n${interactionStyles}`;
