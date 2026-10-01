/**
 * The in-page DOM→Markdown converter behind `chrome_snapshot`'s
 * `format: "markdown"` mode. One injected expression walks the visible DOM
 * and renders it as GitHub-flavored Markdown — headings, links with absolute
 * URLs, emphasis, inline code, fenced code blocks, nested lists, blockquotes,
 * tables, images, and horizontal rules — bounded by a character budget.
 *
 * Skipped subtrees: scripts/styles/templates, form controls (values belong to
 * `chrome_page_snapshot`), and hidden elements. Cross-origin iframes cannot
 * be reached; they are emitted as an HTML comment marker so the reader knows
 * content exists beyond the conversion.
 * @module dsh-chrome/markdown
 */

/** Raw JSON shape the injected converter returns (parsed from a string). */
export interface RawMarkdownSnapshot {
  /** Page URL at conversion time. */
  readonly url: string
  /** Page title at conversion time. */
  readonly title: string
  /** `document.readyState` at conversion time. */
  readonly readyState: string
  /** The converted Markdown, already bounded to the character budget. */
  readonly markdown: string
  /** Whether the source Markdown exceeded the budget. */
  readonly truncated: boolean
}

/**
 * Build the `Runtime.evaluate` expression that converts the page to Markdown.
 *
 * @param maxChars - character budget for the produced Markdown (clamped >= 100).
 * @returns the self-contained IIFE expression returning a JSON string.
 */
export function markdownExpression(maxChars: number): string {
  const budget = Math.max(100, Math.floor(maxChars))
  return `(() => {
  const MAX_CHARS = ${budget};
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'SVG', 'PATH', 'SOURCE', 'TRACK', 'PARAM', 'OPTION', 'OPTGROUP', 'DATALIST', 'COLGROUP', 'COL', 'AREA', 'MAP', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'OUTPUT', 'METER', 'PROGRESS', 'DIALOG']);
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'HR', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET', 'ADDRESS', 'DL', 'DT', 'DD', 'IFRAME']);
  function hidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }
  function abs(url) {
    try { return new URL(url, location.href).href; } catch (e) { return url; }
  }
  function inlineOf(node) {
    let s = '';
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        s += ch.nodeValue.replace(/\\s+/g, ' ');
      } else if (ch.nodeType === 1) {
        const tag = ch.tagName;
        if (SKIP.has(tag) || hidden(ch)) continue;
        if (tag === 'BR') { s += '  \\n'; continue; }
        if (tag === 'IMG') {
          const src = ch.getAttribute('src');
          if (src) s += '![' + String(ch.alt || '').replace(/[\\[\\]]/g, ' ') + '](' + abs(src) + ')';
          continue;
        }
        const inner = inlineOf(ch).trim();
        if (tag === 'A') {
          const href = ch.getAttribute('href');
          s += href && href.indexOf('javascript:') !== 0 ? '[' + (inner || href) + '](' + abs(href) + ')' : inner;
        } else if (tag === 'STRONG' || tag === 'B') {
          s += inner ? '**' + inner + '**' : '';
        } else if (tag === 'EM' || tag === 'I') {
          s += inner ? '*' + inner + '*' : '';
        } else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP') {
          s += inner ? '\`' + inner + '\`' : '';
        } else {
          s += inlineOf(ch);
        }
      }
    }
    return s;
  }
  function renderList(list, depth) {
    const ordered = list.tagName === 'OL';
    let index = parseInt(list.getAttribute('start') || '1', 10);
    if (!Number.isFinite(index) || index < 1) index = 1;
    const lines = [];
    for (const li of list.children) {
      if (li.tagName !== 'LI' || hidden(li)) continue;
      let nested = '';
      let inlinePart = '';
      for (const ch of li.childNodes) {
        if (ch.nodeType === 3) {
          inlinePart += ch.nodeValue;
        } else if (ch.nodeType === 1) {
          const tag = ch.tagName;
          if (SKIP.has(tag) || hidden(ch)) continue;
          if (tag === 'UL' || tag === 'OL') {
            nested += renderList(ch, depth + 1);
          } else if (tag === 'PRE') {
            const code = ch.textContent.replace(/\\n+$/, '');
            inlinePart += '\`\`\`' + code.replace(/\\n/g, ' ') + '\`\`\`';
          } else {
            inlinePart += inlineOf(ch);
          }
        }
      }
      const text = inlinePart.replace(/\\s+/g, ' ').trim();
      const marker = ordered ? index + '. ' : '- ';
      if (text) lines.push('  '.repeat(depth) + marker + text);
      if (nested) lines.push(nested.replace(/\\n+$/, ''));
      index++;
    }
    return lines.join('\\n');
  }
  function renderTable(table) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      if (hidden(tr)) continue;
      const cells = [];
      for (const cell of tr.children) {
        if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
        cells.push(inlineOf(cell).replace(/\\s+/g, ' ').trim().replace(/\\|/g, '\\\\|') || ' ');
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return '';
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    const norm = rows.map(r => { const c = r.slice(); while (c.length < width) c.push(''); return c; });
    const line = cells => '| ' + cells.join(' | ') + ' |';
    let md = line(norm[0]) + '\\n' + line(Array(width).fill('---'));
    for (let i = 1; i < norm.length; i++) md += '\\n' + line(norm[i]);
    return md;
  }
  function renderBlock(el) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const t = inlineOf(el).trim();
      return t ? '#'.repeat(parseInt(tag.slice(1), 10)) + ' ' + t : '';
    }
    if (tag === 'P' || tag === 'FIGCAPTION' || tag === 'DT' || tag === 'DD' || tag === 'SUMMARY' || tag === 'ADDRESS') {
      return inlineOf(el).trim();
    }
    if (tag === 'PRE') {
      const code = el.textContent.replace(/\\n+$/, '');
      return '\`\`\`\\n' + code + '\\n\`\`\`';
    }
    if (tag === 'BLOCKQUOTE') {
      const inner = renderChildren(el).trim();
      return inner ? inner.split('\\n').map(l => '> ' + l).join('\\n') : '';
    }
    if (tag === 'HR') return '---';
    if (tag === 'UL' || tag === 'OL') return renderList(el, 0);
    if (tag === 'TABLE') return renderTable(el);
    if (tag === 'IFRAME') {
      const src = el.getAttribute('src');
      return src ? '<!-- iframe: ' + abs(src) + ' -->' : '';
    }
    return renderChildren(el);
  }
  function renderChildren(el) {
    let out = '';
    let buf = '';
    const flush = () => {
      const t = buf.replace(/\\s+/g, ' ').trim();
      if (t) out += t + '\\n\\n';
      buf = '';
    };
    for (const ch of el.childNodes) {
      if (ch.nodeType === 3) {
        buf += ch.nodeValue;
      } else if (ch.nodeType === 1) {
        const tag = ch.tagName;
        if (SKIP.has(tag) || hidden(ch)) continue;
        if (BLOCK.has(tag)) {
          flush();
          const block = renderBlock(ch);
          if (block) out += block + '\\n\\n';
        } else {
          buf += inlineOf(ch);
        }
      }
    }
    flush();
    return out;
  }
  const md = document.body ? renderChildren(document.body).trim() : '';
  return JSON.stringify({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    markdown: md.slice(0, MAX_CHARS),
    truncated: md.length > MAX_CHARS,
  });
})()`
}
