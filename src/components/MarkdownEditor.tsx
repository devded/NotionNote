import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Annotation, EditorState, Prec, Transaction, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
  keymap,
  placeholder as placeholderExt,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentUnit, syntaxTree } from "@codemirror/language";

export interface MarkdownEditorHandle {
  focus(): void;
  setCaret(pos: number): void;
  selection(): { from: number; to: number };
  length(): number;
  hasFocus(): boolean;
}

interface MarkdownEditorProps {
  value: string;
  /** Segment index, read by NoteEditor's drop handler. */
  segment?: number;
  placeholder?: string;
  className?: string;
  onChange(text: string): void;
  /** Return true when the paste was handled (default paste is then skipped). */
  onPaste?(e: ClipboardEvent, sel: { from: number; to: number }): boolean;
  /** Backspace with an empty caret at position 0. */
  onBackspaceAtStart?(): void;
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = "•";
    return el;
  }
}

/** Marks doc replacements coming from props, so they don't echo back as edits. */
const external = Annotation.define<boolean>();

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.checked = this.checked;
    el.className = "cm-md-task";
    el.setAttribute("aria-label", this.checked ? "Mark as not done" : "Mark as done");
    return el;
  }
  ignoreEvent() {
    return false; // let the mousedown handler below toggle it
  }
}

const hide = Decoration.replace({});
const done = Decoration.mark({ class: "cm-md-done" });
const bullet = Decoration.replace({ widget: new BulletWidget() });
const marks: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: "cm-md-strong" }),
  Emphasis: Decoration.mark({ class: "cm-md-em" }),
  Strikethrough: Decoration.mark({ class: "cm-md-strike" }),
  InlineCode: Decoration.mark({ class: "cm-md-code" }),
  Link: Decoration.mark({ class: "cm-md-link" }),
};
const HIDDEN_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "LinkMark", "URL"]);

/** Obsidian-style live preview: markdown syntax is hidden and rendered on
 *  every line except the ones holding the cursor, where raw text shows. */
function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = new Set<number>();
  const carets = view.hasFocus ? state.selection.ranges : [];
  /** Task checkboxes stay rendered unless the caret is inside "- [x] " itself. */
  const inPrefix = (from: number, to: number) => carets.some((r) => r.to >= from && r.from <= to);
  if (view.hasFocus) {
    for (const r of state.selection.ranges) {
      for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
    }
  }
  const out: Range<Decoration>[] = [];
  const lineClass = (pos: number, cls: string) =>
    out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const eachLine = (from: number, to: number, cls: string) => {
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
      out.push(Decoration.line({ class: cls }).range(doc.line(l).from));
    }
  };
  // Hide [from, to) plus one trailing space ("## Title" -> "Title").
  const hideWithSpace = (from: number, to: number) =>
    out.push(hide.range(from, doc.sliceString(to, to + 1) === " " ? to + 1 : to));

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        let raw = active.has(doc.lineAt(node.from).number);
        const task =
          name === "TaskMarker" ? node.node.parent : name === "ListMark" ? node.node.nextSibling : null;
        if (task?.name === "Task") {
          const marker = task.firstChild;
          raw = inPrefix(task.parent?.from ?? task.from, (marker?.to ?? task.from) + 1);
          if (name === "TaskMarker" && /x/i.test(doc.sliceString(node.from, node.to)) && node.to < task.to) {
            out.push(done.range(node.to, task.to));
          }
        }
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) lineClass(node.from, `cm-md-h${heading[1]}`);
        else if (name === "Blockquote") eachLine(node.from, node.to, "cm-md-quote");
        else if (name === "FencedCode") {
          eachLine(node.from, node.to, "cm-md-codeblock");
          return false; // keep code contents literal
        } else if (name === "HorizontalRule") lineClass(node.from, "cm-md-hr");
        // "[x]" alone is a shortcut reference, not a link: leave it as text.
        else if (name === "Link" && !node.node.getChild("URL")) return false;
        else if (marks[name] && node.from < node.to) out.push(marks[name].range(node.from, node.to));

        if (raw) return;
        if (name === "HeaderMark" || name === "QuoteMark") hideWithSpace(node.from, node.to);
        else if (HIDDEN_MARKS.has(name)) out.push(hide.range(node.from, node.to));
        else if (name === "CodeMark" && node.node.parent?.name === "InlineCode") {
          out.push(hide.range(node.from, node.to));
        } else if (name === "ListMark" && node.node.nextSibling?.name === "Task") {
          hideWithSpace(node.from, node.to); // the checkbox replaces the bullet
        } else if (name === "ListMark" && node.node.parent?.parent?.name === "BulletList") {
          out.push(bullet.range(node.from, node.to));
        } else if (name === "TaskMarker") {
          const checked = /x/i.test(doc.sliceString(node.from, node.to));
          out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to));
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        u.focusChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state)
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const baseTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "inherit" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { padding: 0, fontFamily: "inherit", caretColor: "currentColor" },
  ".cm-line": { padding: 0 },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "inherit", overflow: "visible" },
});

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ value, segment, placeholder, className, onChange, onPaste, onBackspaceAtStart }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Latest callbacks, so the editor is created once and never rebuilt.
    const cb = useRef({ onChange, onPaste, onBackspaceAtStart });
    useEffect(() => {
      cb.current = { onChange, onPaste, onBackspaceAtStart };
    });

    useEffect(() => {
      const view = new EditorView({
        parent: hostRef.current!,
        state: EditorState.create({
          doc: value,
          extensions: [
            Prec.highest(
              keymap.of([
                {
                  key: "Backspace",
                  run: (v) => {
                    const sel = v.state.selection.main;
                    if (!sel.empty || sel.from !== 0 || !cb.current.onBackspaceAtStart) return false;
                    cb.current.onBackspaceAtStart();
                    return true;
                  },
                },
                // Notion-style nesting: indent/outdent the line from anywhere in it.
                // Synced to Notion as child blocks (2 spaces per level).
                { key: "Tab", run: indentMore },
                { key: "Shift-Tab", run: indentLess },
              ]),
            ),
            indentUnit.of("  "),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            markdown({ base: markdownLanguage }), // GFM; Enter continues lists
            EditorView.lineWrapping,
            placeholder ? placeholderExt(placeholder) : [],
            livePreview,
            baseTheme,
            EditorView.domEventHandlers({
              // Toggle "[ ]" <-> "[x]" without moving the caret onto the line.
              mousedown: (e, v) => {
                const el = e.target as HTMLElement;
                if (!el.classList?.contains("cm-md-task")) return false;
                e.preventDefault();
                const pos = v.posAtDOM(el);
                const marker = v.state.doc.sliceString(pos, pos + 3);
                if (!/^\[[ xX]\]$/.test(marker)) return true;
                v.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: marker[1] === " " ? "x" : " " } });
                return true;
              },
              paste: (e, v) => {
                const { from, to } = v.state.selection.main;
                return cb.current.onPaste?.(e, { from, to }) ?? false;
              },
            }),
            EditorView.updateListener.of((u) => {
              if (u.docChanged && !u.transactions.some((t) => t.annotation(external)))
                cb.current.onChange(u.state.doc.toString());
            }),
          ],
        }),
      });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // External changes (remote sync, image insert/remove) replace the doc.
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const cur = view.state.doc.toString();
      if (cur === value) return;
      const caret = Math.min(view.state.selection.main.head, value.length);
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: value },
        selection: { anchor: caret },
        // Not undoable: undo would restore text that now lives in another segment.
        annotations: [external.of(true), Transaction.addToHistory.of(false)],
      });
    }, [value]);

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      setCaret: (pos) => {
        const v = viewRef.current;
        if (v) v.dispatch({ selection: { anchor: Math.min(pos, v.state.doc.length) } });
      },
      selection: () => {
        const s = viewRef.current?.state.selection.main;
        return { from: s?.from ?? 0, to: s?.to ?? 0 };
      },
      length: () => viewRef.current?.state.doc.length ?? 0,
      hasFocus: () => viewRef.current?.hasFocus ?? false,
    }));

    return <div ref={hostRef} data-segment={segment} className={className} />;
  },
);
