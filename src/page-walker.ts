/**
 * The in-page walker behind `chrome_page_snapshot` — a `use-browser`-style
 * structured page read. One injected expression walks the live DOM, emits a
 * compact element tree (role, name, state) where every interactive element
 * carries a stable-for-this-snapshot `[ref=eN]` id, and returns the tree text
 * plus a `ref -> CSS selector` map the runtime keeps for `chrome_click` /
 * `chrome_type` / `chrome_scroll`.
 *
 * Refs are intentionally ephemeral: navigation or reconnection invalidates
 * them, and acting on an unknown ref fails with a "take a fresh snapshot"
 * error instead of clicking a stale selector.
 * @module dsh-chrome/page-walker
 */

/** Default cap on emitted tree nodes. */
export const DEFAULT_PAGE_SNAPSHOT_MAX_NODES = 500

/** Raw JSON shape the injected walker returns (parsed from a string). */
export interface RawPageSnapshot {
  /** Page URL at snapshot time. */
  readonly url: string
  /** Page title at snapshot time. */
  readonly title: string
  /** `document.readyState` at snapshot time. */
  readonly readyState: string
  /** Indented element-tree text, one `- role "name" state [ref=eN]` per line. */
  readonly tree: string
  /** Ref id to CSS selector for every emitted interactive element. */
  readonly refs: Record<string, string>
  /** Number of emitted nodes. */
  readonly nodeCount: number
  /** Whether the node budget cut the walk short. */
  readonly truncated: boolean
}

/**
 * Build the `Runtime.evaluate` expression that captures one structured page
 * snapshot. Everything runs inside the page; the expression returns a JSON
 * string so the result survives `returnByValue` losslessly.
 *
 * @param maxNodes - budget for emitted tree nodes (clamped to >= 10).
 * @returns the self-contained IIFE expression.
 */
export function pageSnapshotExpression(maxNodes: number): string {
  const budget = Math.max(10, Math.floor(maxNodes))
  return `(() => {
  const MAX_NODES = ${budget};
  const MAX_TEXT = 160;
  const MAX_DEPTH = 24;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'SVG', 'PATH', 'BR', 'WBR', 'SOURCE', 'TRACK', 'PARAM', 'OPTION', 'OPTGROUP', 'DATALIST', 'COLGROUP', 'COL', 'AREA', 'MAP']);
  const lines = [];
  const refs = {};
  let count = 0;
  let visits = 0;
  let truncated = false;
  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  }
  function selectorFor(el) {
    if (el.id && document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + cssEscape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 16) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        let before = 0;
        let found = false;
        for (const child of parent.children) {
          if (child === node) { found = true; break; }
          if (child.tagName === node.tagName) before++;
        }
        if (found && before > 0) part += ':nth-of-type(' + (before + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    if (parts.length === 0 && node) parts.push(node.tagName.toLowerCase());
    return parts.join(' > ');
  }
  function visible(el) {
    if (el.hidden) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return !(rect.width === 0 && rect.height === 0);
  }
  function roleFor(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\\s+/)[0];
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'SUMMARY') return 'summary';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'hidden') return null;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG') return 'img';
    if (tag === 'TABLE') return 'table';
    if (tag === 'TR') return 'row';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'listitem';
    if (tag === 'NAV') return 'navigation';
    if (tag === 'FORM') return 'form';
    if (tag === 'LABEL') return 'label';
    if (tag === 'DIALOG') return 'dialog';
    if (tag === 'P') return 'paragraph';
    if (tag === 'PRE') return 'pre';
    if (tag === 'BLOCKQUOTE') return 'blockquote';
    return null;
  }
  function isInteractive(el) {
    if (el.matches('a[href], button, summary, select, textarea, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [onclick]')) return true;
    if (el.tagName === 'INPUT') return (el.getAttribute('type') || 'text').toLowerCase() !== 'hidden';
    return false;
  }
  function nameFor(el) {
    const direct = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.alt || '';
    const trimmed = String(direct).trim();
    if (trimmed) return trimmed.slice(0, MAX_TEXT);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const label = labelledby.split(/\\s+/).map(id => {
        const by = document.getElementById(id);
        return by ? String(by.innerText || '').trim() : '';
      }).filter(Boolean).join(' ');
      if (label) return label.slice(0, MAX_TEXT);
    }
    if (el.labels && el.labels.length) {
      const label = String(el.labels[0].innerText || '').trim();
      if (label) return label.slice(0, MAX_TEXT);
    }
    const text = String(el.innerText || '').trim().replace(/\\s+/g, ' ');
    if (text) return text.slice(0, MAX_TEXT);
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return type === 'submit' || type === 'button' ? '' : type;
    }
    return '';
  }
  function stateFor(el) {
    const parts = [];
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type !== 'password' && el.value) parts.push('value=' + JSON.stringify(String(el.value).slice(0, MAX_TEXT)));
    } else if (tag === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      parts.push('selected=' + JSON.stringify(opt ? String(opt.innerText || '').trim().slice(0, MAX_TEXT) : ''));
    } else if (tag === 'A') {
      const href = el.getAttribute('href');
      if (href && href !== '#' && href.indexOf('javascript:') !== 0) parts.push('href=' + JSON.stringify(href.slice(0, MAX_TEXT)));
    }
    if (el.disabled) parts.push('disabled');
    return parts.join(' ');
  }
  function walk(el, depth, parentName) {
    if (count >= MAX_NODES || visits > MAX_NODES * 8) { truncated = true; return; }
    visits++;
    if (el.nodeType !== 1 || SKIP.has(el.tagName) || !visible(el)) return;
    const role = roleFor(el);
    const interactive = isInteractive(el);
    let leafText = '';
    if (role === null && !interactive && el.children.length === 0) leafText = String(el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, MAX_TEXT);
    let emitted = false;
    let name = '';
    if (interactive || role !== null) {
      name = nameFor(el);
      count++;
      const ref = 'e' + count;
      refs[ref] = selectorFor(el);
      const state = stateFor(el);
      const indent = '  '.repeat(depth > MAX_DEPTH ? MAX_DEPTH : depth);
      lines.push(indent + '- ' + (role || 'element') + (name ? ' ' + JSON.stringify(name) : '') + (state ? ' ' + state : '') + ' [ref=' + ref + ']');
      emitted = true;
    } else if (leafText !== '' && (parentName === '' || parentName.indexOf(leafText) === -1)) {
      count++;
      const ref = 'e' + count;
      refs[ref] = selectorFor(el);
      const indent = '  '.repeat(depth > MAX_DEPTH ? MAX_DEPTH : depth);
      lines.push(indent + '- text ' + JSON.stringify(leafText) + ' [ref=' + ref + ']');
      emitted = true;
    }
    const childParentName = emitted ? name : parentName;
    for (let i = 0; i < el.children.length; i++) walk(el.children[i], depth + 1, childParentName);
  }
  if (document.body) walk(document.body, 0, '');
  return JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    tree: lines.join('\\n'),
    refs: refs,
    nodeCount: count,
    truncated: truncated,
  });
})()`
}

/**
 * Normalize a model-supplied ref to its canonical `eN` form. Accepts the
 * shapes a model is likely to copy from the tree: `e12`, `[e12]`, `ref=e12`,
 * `[ref=e12]` (case-insensitive).
 *
 * @param raw - the raw ref argument.
 * @returns the canonical ref id, or undefined when it is not a ref at all.
 */
export function normalizePageRef(raw: string): string | undefined {
  const match = raw.trim().match(/^(?:\[)?(?:ref\s*=\s*)?(e\d+)(?:\])?$/i)
  const ref = match?.[1]
  return ref === undefined ? undefined : ref.toLowerCase()
}

/** Canonical `chrome_page_snapshot` outcome. */
export interface ChromePageSnapshotValue {
  url: string
  title: string
  readyState: string
  tree: string
  refCount: number
  truncated: boolean
}

/** Model-facing text for one structured page snapshot. */
export function formatPageSnapshot(value: ChromePageSnapshotValue): string {
  const header = `URL: ${value.url}\nTitle: ${value.title || '(none)'}\nReady: ${value.readyState || 'unknown'}\n\n`
  const hint = '- element tree below; [ref=eN] ids are accepted as the "ref" argument of chrome_click / chrome_type / chrome_scroll\n'
  const footer = value.truncated ? '\n(Tree truncated at the node budget. Narrow scope with chrome_evaluate or raise maxNodes.)' : ''
  return `${header}${hint}${value.tree}${footer}`
}
