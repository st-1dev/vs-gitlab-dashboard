// Pure helpers shared by the webview and Node tests: ANSI log parsing and query completions.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DashboardShared = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
  const BASIC = [...NAMES.map(name => `var(--vscode-terminal-ansi${name})`), ...NAMES.map(name => `var(--vscode-terminal-ansiBright${name})`)];
  const SGR = /\x1b\[([0-9;:]*)m/g;

  function color256(n) {
    if (n < 16) return BASIC[n];
    if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v}, ${v}, ${v})`; }
    const i = n - 16, level = x => (x ? 55 + x * 40 : 0);
    return `rgb(${level(Math.floor(i / 36))}, ${level(Math.floor(i / 6) % 6)}, ${level(i % 6)})`;
  }

  /** Remove GitLab section markers, non-SGR escape sequences and carriage-return overwrites, keeping SGR codes. */
  function normalize(text) {
    return text.replace(/\r\n/g, '\n')
      .replace(/section_(?:start|end):\d+:[^\r\n]*\r(?:\x1b\[0K)?/g, '')
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '')
      .split('\n').map(line => {
        const cr = line.lastIndexOf('\r');
        return cr < 0 ? line : (line.slice(0, cr).match(SGR) || []).join('') + line.slice(cr + 1);
      }).join('\n')
      .replace(/\x1b(?!\[[0-9;:]*m)/g, '')
      .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '');
  }

  function apply(style, codes) {
    const next = { ...style };
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { for (const key of Object.keys(next)) delete next[key]; } else if (code === 1) next.bold = true;
      else if (code === 2) next.dim = true;
      else if (code === 3) next.italic = true;
      else if (code === 4) next.underline = true;
      else if (code === 7) next.inverse = true;
      else if (code === 22) { delete next.bold; delete next.dim; } else if (code === 23) delete next.italic;
      else if (code === 24) delete next.underline;
      else if (code === 27) delete next.inverse;
      else if (code >= 30 && code <= 37) next.fg = BASIC[code - 30];
      else if (code >= 90 && code <= 97) next.fg = BASIC[code - 90 + 8];
      else if (code === 39) delete next.fg;
      else if (code >= 40 && code <= 47) next.bg = BASIC[code - 40];
      else if (code >= 100 && code <= 107) next.bg = BASIC[code - 100 + 8];
      else if (code === 49) delete next.bg;
      else if (code === 38 || code === 48) {
        const key = code === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5 && codes[i + 2] >= 0 && codes[i + 2] <= 255) { next[key] = color256(codes[i + 2]); i += 2; } else if (codes[i + 1] === 2 && codes.slice(i + 2, i + 5).length === 3 && codes.slice(i + 2, i + 5).every(v => v >= 0 && v <= 255)) {
          next[key] = `rgb(${codes.slice(i + 2, i + 5).join(', ')})`; i += 4;
        } else break;
      }
    }
    return next;
  }

  /** UC5: split a job trace into text segments with terminal styles; unknown codes keep the text intact. */
  function parseAnsi(text) {
    const source = normalize(text), segments = [];
    let style = {}, last = 0;
    const push = value => {
      if (!value) return;
      const previous = segments[segments.length - 1];
      if (previous && JSON.stringify(previous.style) === JSON.stringify(style)) previous.text += value;
      else segments.push({ text: value, style });
    };
    for (const match of source.matchAll(SGR)) {
      push(source.slice(last, match.index));
      style = apply(style, match[1] === '' ? [0] : match[1].split(/[;:]/).map(v => (v === '' ? 0 : Number(v))));
      last = match.index + match[0].length;
    }
    push(source.slice(last));
    return segments;
  }

  const stripAnsi = text => normalize(text).replace(SGR, '');

  const KEYS = ['project:', 'branch:', 'status:', 'user:', 'sha:', 'id:', 'name:', 'source:', 'after:', 'before:', 'latest:true', 'text:'];

  /** UC2: completions for the query token before the caret (Ctrl+Space). */
  function completions(query, caret, context) {
    const start = query.slice(0, caret).search(/\S*$/);
    const prefix = query.slice(start, caret);
    const values = key => {
      switch (key) {
        case 'status': return context.statuses;
        case 'project': return context.projects;
        case 'branch': return ['@current', ...context.branches, 'main', 'feature/*', 'release/*'];
        case 'user': return ['me'];
        case 'source': return ['api', 'push', 'web', 'schedule', 'merge_request_event', 'trigger', 'pipeline'];
        case 'after': case 'before': return ['24h', '7d', '30d'];
        case 'latest': return ['true', 'false'];
        default: return null;
      }
    };
    const colon = prefix.indexOf(':');
    const options = colon >= 0 ? (values(prefix.slice(0, colon).toLowerCase()) || []).map(value => `${prefix.slice(0, colon)}:${value}`) : KEYS;
    const items = [...new Set(options)].filter(item => item.toLowerCase().startsWith(prefix.toLowerCase()) && item !== prefix);
    return { start, end: caret, items };
  }

  return { parseAnsi, stripAnsi, completions };
}));
