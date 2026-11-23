// A fast drop-in for makefun-site 1.0.0, written from scratch for
// site-generator-speed-01-run-20261122: run(input) returns the same output
// tree the reference build returns for the same input, byte for byte, in
// less CPU time. One dependency-free ES module.
//
// Where the time goes, and what this file does about it: slugs are memoised
// for the duration of one build (titles, tag names and headings repeat a
// lot), front matter is scanned by offsets instead of split-and-join,
// Markdown lines are classified by direct character checks instead of a
// stack of regexes, and inline text takes a fast path when it holds no
// markup characters at all and is otherwise escaped in bulk runs instead of
// character by character.

// ------------------------------------------------------------------ text

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;

/** `s` with &, <, >, " and ' replaced by their HTML escapes, nothing else. */
function esc(s) {
  return s.replace(ESCAPE_RE, (c) => ESCAPE_MAP[c]);
}

/** Slug memo for the build in flight; reset by every run() call. */
let slugCache = new Map();

/**
 * The slug of `text`: NFKD-normalised, combining marks dropped, A-Z
 * lowered, each run of characters outside a-z and 0-9 collapsed to one "-",
 * none at either end, cut at 64 characters with a "-" left at the cut
 * dropped, and "untitled" when nothing is left.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let dashPending = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      dashPending = out.length > 0;
      continue;
    }
    if (dashPending) out += '-';
    dashPending = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against the `taken` set (and added to it): slug, slug-2, slug-3, ... */
function uniqueSlug(slug, taken) {
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n++) candidate = `${slug}-${n}`;
  taken.add(candidate);
  return candidate;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const first = date.indexOf('-');
  const second = date.indexOf('-', first + 1);
  const month = Number(date.slice(first + 1, second));
  const day = Number(date.slice(second + 1));
  return `${day} ${MONTH_NAMES[month - 1]} ${date.slice(0, first)}`;
}

/** Whether every character of `line` is a space or a tab (or the line is empty). */
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** `line` with spaces and tabs at both ends dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

// ----------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days in month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." whose only escapes are \" and \\, or a bare rest-of-line. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One front-matter key's value, or the reason it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m === null ? 0 : Number(m[1]);
      const mo = m === null ? 0 : Number(m[2]);
      const d = m === null ? 0 : Number(m[3]);
      if (m === null || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason the source is refused. The closing fence is located before
 * any line inside is judged, exactly as the reference orders its checks.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const inner = [];
  let closeNl = -1;
  let pos = firstNl + 1;
  for (;;) {
    const end = text.indexOf('\n', pos);
    const lineEnd = end === -1 ? text.length : end;
    if (text.slice(pos, lineEnd) === '---') {
      closeNl = end;
      break;
    }
    inner.push([pos, lineEnd]);
    if (end === -1) return { error: 'the front matter is not closed' };
    pos = end + 1;
  }
  const data = {};
  for (let k = 0; k < inner.length; k++) {
    const line = text.slice(inner[k][0], inner[k][1]);
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${k + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
}

// -------------------------------------------------------------- markdown

/** A fence-opening line's language, or null: three backticks, language characters, then blanks only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line[i];
    const ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
    if (!ok) break;
    lang += c;
    i++;
  }
  for (; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return null;
  }
  return lang;
}

/** Whether `line` closes a fence: three backticks, then blanks only. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A heading line's depth and text, or null (7+ hashes, no blank after them, or no text: not a heading). */
function headingOf(line) {
  let n = 0;
  while (line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  const c = line[n];
  if (c !== ' ' && c !== '\t') return null;
  const rest = line.slice(n);
  let a = 0;
  while (rest[a] === ' ' || rest[a] === '\t') a++;
  let b = rest.length;
  while (b > a && (rest[b - 1] === ' ' || rest[b - 1] === '\t')) b--;
  const text = rest.slice(a, b);
  return text === '' ? null : { depth: n, text };
}

/** Whether `line` is a thematic break: "---" or "***", then blanks only. */
function isBreak(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/** A bullet item's text (after "- " or "* "), or null. */
function bulletOf(line) {
  const c = line[0];
  return (c === '-' || c === '*') && line[1] === ' ' ? line.slice(2) : null;
}

/** An ordered item's number and text (after "12. "), or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && line[n] >= '0' && line[n] <= '9') n++;
  if (n === 0 || n > 9) return null;
  if (line[n] !== '.' || line[n + 1] !== ' ') return null;
  return { num: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

const ANY_WS = /\s/;

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  if (n < 2) return false;
  const c = line[n];
  return c !== undefined && !ANY_WS.test(c);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isBreak(line);
}

/** The characters a backslash escapes inline. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** Text holding none of these takes no inline markup at all and is only escaped. */
const INLINE_MARK = /[\\`*[]/;

/**
 * `s` rendered inline; `linkFn(target)` resolves a link's href. Plain runs
 * between markup are escaped in bulk; a markup character that opens
 * nothing stays in its run, exactly as the reference leaves it.
 */
function renderInline(s, linkFn) {
  if (!INLINE_MARK.test(s)) return esc(s);
  let out = '';
  let runStart = 0;
  let i = 0;
  const flush = (upto) => {
    if (upto > runStart) out += esc(s.slice(runStart, upto));
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out += esc(s[i + 1]);
      i += 2;
      runStart = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<code>${esc(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out += `<strong>${renderInline(s.slice(i + 2, j), linkFn)}</strong>`;
          i = j + 2;
          runStart = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        flush(i);
        out += `<em>${renderInline(s.slice(i + 1, j), linkFn)}</em>`;
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        flush(i);
        out += `<a href="${esc(linkFn(target))}">${renderInline(s.slice(i + 1, k), linkFn)}</a>`;
        i = m + 1;
        runStart = i;
      } else i++;
      continue;
    }
    i++;
  }
  flush(s.length);
  return out;
}

/**
 * `src` rendered in one pass: its HTML (a "\n" after every block), its
 * table of contents (each level 2 and 3 heading's level, id and inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, linkFn) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      let inner = '';
      i++;
      while (i < lines.length && !fenceClose(lines[i])) {
        inner += `${esc(lines[i])}\n`;
        i++;
      }
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = renderInline(heading.text, linkFn);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreak(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const kept = [];
      while (i < lines.length && lines[i][0] === '>') {
        let q = lines[i].slice(1);
        if (q[0] === ' ') q = q.slice(1);
        const t = trimLine(q);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${renderInline(kept.join('\n'), linkFn)}</p>\n</blockquote>`,
      );
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrd = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const hit = isOrd ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (hit !== null) {
          items.push([trimLine(isOrd ? hit.text : hit)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && ordered.num !== 1 ? `<ol start="${ordered.num}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const parts of items) block += `<li>${renderInline(parts.join('\n'), linkFn)}</li>\n`;
      blocks.push(`${block}</${tag}>`);
      continue;
    }
    const para = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      para.push(trimLine(lines[i]));
      i++;
    }
    const html = renderInline(para.join('\n'), linkFn);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (const b of blocks) html += `${b}\n`;
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------- templates

/** A template that does not parse; the message names it and says why. */
class TemplateProblem extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** The deepest an include nests; one past it renders nothing. */
const INCLUDE_LIMIT = 8;

/** The path `text` names, split at its dots, or a TemplateProblem. */
function tplPath(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateProblem(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[from..to) holds spaces and tabs only. */
function onlyBlanks(src, from, to) {
  for (let k = from; k < to; k++) {
    const c = src[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * `src`'s tokens: text, {{ }} (var), {{{ }}} (raw) and {% %} (tag). A {% %}
 * tag alone on its line takes the whole line with it, its "\n" included.
 */
function tplTokens(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateProblem(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateProblem(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlyBlanks(src, lineStart, open) && onlyBlanks(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateProblem when it does not parse). */
function parseTemplate(name, src) {
  const rootBody = [];
  const stack = [{ kind: 'root', body: rootBody }];
  const currentBody = () => {
    const top = stack[stack.length - 1];
    if (top.kind === 'if') return top.else !== null ? top.else : top.then;
    return top.body;
  };
  for (const tok of tplTokens(name, src)) {
    if (tok.t === 'text') {
      currentBody().push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      currentBody().push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m = TPL_FOR.exec(tag);
    if (m !== null) {
      const node = { kind: 'for', name: m[1], path: tplPath(name, m[2]), body: [] };
      currentBody().push(node);
      stack.push(node);
      continue;
    }
    m = TPL_IF.exec(tag);
    if (m !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: tplPath(name, m[2]), then: [], else: null };
      currentBody().push(node);
      stack.push(node);
      continue;
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateProblem(`template "${name}": an else outside an if`);
      top.else = [];
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw new TemplateProblem(`template "${name}": an ${tag} with no open ${want}`);
      stack.pop();
      continue;
    }
    m = TPL_INCLUDE.exec(tag);
    if (m !== null) {
      currentBody().push({ kind: 'include', name: m[1] });
      continue;
    }
    throw new TemplateProblem(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) {
    throw new TemplateProblem(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return rootBody;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` ({ vars, parent }); `templates` maps names to parsed nodes. */
function renderNodes(nodes, scope, templates, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(valueText(lookupPath(scope, n.path)));
        break;
      case 'raw':
        out += valueText(lookupPath(scope, n.path));
        break;
      case 'if': {
        const branch = isTruthy(lookupPath(scope, n.path)) !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookupPath(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          out += renderNodes(n.body, { vars, parent: scope }, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_LIMIT) out += renderNodes(t, scope, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------- build

/** The top-level directories the generator writes itself; no root slug may take one. */
const RESERVED_DIRS = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The directory of a "/"-separated path, or "" at the root. */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` resolved from the directory `dir`, or null when it climbs above the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The words of a body: its runs of characters other than whitespace. */
function wordCount(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One case's answer: the output tree makefun-site 1.0.0 builds for `input`, path -> text. */
export function run(input) {
  slugCache = new Map();
  const report = [];

  // Every template parsed, in code-unit order of its name; one that does
  // not parse is reported and left out, as if it were not there.
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateProblem)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // The sources in code-unit order of their paths, line ends made "\n";
  // any other file is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in their order: a refused source
  // is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED_DIRS.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source
  // order; at the root the generator's own directories are taken already.
  const takenByDir = new Map();
  const takenIn = (dir) => {
    let set = takenByDir.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Each body's Markdown, its links resolved against the built pages and
  // the static files; a target naming neither is a broken link.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkFn = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, linkFn);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // The posts, newest date first, equal dates by slug; each post's newer
  // and older neighbours in that order.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // The tags: grouped by slug, each named as first met walking the posts
  // in collection order, ordered by count of posts, then by slug.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tagList = [...tagBySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // Cards and pages, as templates read them; a source's card is built once.
  const cardCache = new Map();
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordCount(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, card);
    }
    return card;
  };
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page through its own, the index pages, the tag pages
  // and the tags page through theirs; then each static file at its path.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tagList.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tagList) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported along the way, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tagList.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
