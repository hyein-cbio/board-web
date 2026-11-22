// A small Markdown renderer for board messages. Everything a message says is escaped first;
// the only tags in the output are the ones written here, and links go to http(s) or mailto only.

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The board stores a mention as `@[actor-id]`; the app says whose name that is.
let mentioned = (id) => id;
export const setMentionNames = (name) => { mentioned = name; };
const MENTION = /@\[([^\]\n]+)\]/g;

export function renderMarkdown(source) {
  return blocks(String(source ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '').split('\n')).join('');
}

/** A message whose first line is a heading reads as an article: that heading is its title. */
export function splitTitle(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '');
  const match = /^\s{0,3}#{1,3}\s+(.+?)(?:\s+#+)?\s*(?:\n|$)/.exec(text);
  return match ? { title: plainInline(match[1]), body: text.slice(match[0].length) } : { title: null, body: text };
}

const plainInline = (source) => source
  .replace(MENTION, (_, id) => `@${mentioned(id)}`)
  .replace(/`([^`\n]*)`/g, '$1')
  .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
  .replace(/(\*\*|__|~~|\*)(?=\S)([^\n]*?\S)\1/g, '$2');

/** The words of a message without its markup: for excerpts and titles. */
export function plainText(source) {
  return plainInline(String(source ?? '')
    .replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, '')
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/gm, ''))
    .replace(/^\s*\|?\s*:?-+[-:|\s]*$/gm, '')
    .split('\n').map((line) => line.includes('|') ? line.split('|').map((cell) => cell.trim()).filter(Boolean).join(' · ') : line).join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function blocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let match;
    if (!line.trim()) {
      i++;
    } else if ((match = FENCE.exec(line))) {
      const [, indent, fence, lang] = match;
      const body = [];
      for (i++; i < lines.length; i++) {
        const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
          i++;
          break;
        }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent.length}}`), ''));
      }
      out.push(`<div class="md-code">${lang ? `<span class="md-lang">${escapeHtml(lang)}</span>` : ''}` +
        `<button type="button" class="md-copy" data-action="copy-code" aria-label="코드 복사">복사</button>` +
        `<pre><code>${escapeHtml(body.join('\n'))}</code></pre></div>`);
    } else if ((match = HEADING.exec(line))) {
      const level = match[1].length;
      out.push(`<h${level}>${inline(match[2])}</h${level}>`);
      i++;
    } else if (RULE.test(line)) {
      out.push('<hr>');
      i++;
    } else if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}> ?/, ''));
      out.push(`<blockquote>${blocks(quoted).join('')}</blockquote>`);
    } else if (ITEM.test(line)) {
      i = list(lines, i, out);
    } else if (isTable(lines, i)) {
      i = table(lines, i, out);
    } else {
      const paragraph = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines, i); i++) paragraph.push(lines[i].trim());
      out.push(`<p>${paragraph.map((part) => inline(part)).join('<br>')}</p>`);
    }
  }
  return out;
}

const startsBlock = (lines, i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || RULE.test(lines[i]) ||
  QUOTE.test(lines[i]) || ITEM.test(lines[i]) || isTable(lines, i);
const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length &&
  lines[i + 1].includes('|') && TABLE_RULE.test(lines[i + 1]);
const leading = (line) => /^\s*/.exec(line)[0].length;

function list(lines, i, out) {
  const first = ITEM.exec(lines[i]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const match = ITEM.exec(lines[i]);
    if (!match || match[1].length !== indent || /\d/.test(match[2]) !== ordered) break;
    const width = indent + match[2].length + 1;
    const content = [match[3]];
    for (i++; i < lines.length; i++) {
      const next = lines[i];
      if (!next.trim()) {
        const after = lines[i + 1];
        if (after?.trim() && leading(after) > indent) {
          content.push('');
          continue;
        }
        const sibling = after === undefined ? null : ITEM.exec(after);
        if (sibling && sibling[1].length === indent && /\d/.test(sibling[2]) === ordered) {
          loose = true;
          i++;
        }
        break;
      }
      if (leading(next) > indent) content.push(next.slice(Math.min(leading(next), width)));
      else if (ITEM.test(next) || startsBlock(lines, i)) break;
      else content.push(next.trim());
    }
    items.push(content);
  }

  const tag = ordered ? 'ol' : 'ul';
  const start = ordered ? parseInt(first[2], 10) : 1;
  out.push(`<${tag}${start !== 1 ? ` start="${start}"` : ''}>${items.map((content) => {
    const task = /^\[([ xX])\]\s+/.exec(content[0]);
    if (task) content[0] = content[0].slice(task[0].length);
    let body = blocks(content).join('');
    if (!loose) body = body.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    return task
      ? `<li class="md-task"><span class="md-check"${task[1] === ' ' ? '' : ' data-done'} aria-hidden="true"></span>${body}</li>`
      : `<li>${body}</li>`;
  }).join('')}</${tag}>`);
  return i;
}

function table(lines, i, out) {
  const cells = (line) => {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  };
  const head = cells(lines[i]);
  const align = cells(lines[i + 1]).map((cell) =>
    cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : '');
  const cell = (tag, text, n) => `<${tag}${align[n] ? ` class="md-${align[n]}"` : ''}>${inline(text ?? '')}</${tag}>`;
  const rows = [];
  for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(cells(lines[i]));
  out.push(`<div class="md-table"><table><thead><tr>${head.map((text, n) => cell('th', text, n)).join('')}</tr></thead>` +
    `<tbody>${rows.map((row) => `<tr>${head.map((_, n) => cell('td', row[n], n)).join('')}</tr>`).join('')}</tbody></table></div>`);
  return i;
}

const safeUrl = (url) => /^(?:https?:\/\/|mailto:)/i.test(url);
const anchor = (url, label) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

function inline(text, links = true) {
  const slots = [];
  const keep = (html) => `\0${slots.push(html) - 1}\0`;
  let s = text
    .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, ticks, code) => keep(`<code>${escapeHtml(code.replace(/^ (.+) $/, '$1'))}</code>`))
    .replace(/\\([!-/:-@[-`{-~])/g, (_, char) => keep(escapeHtml(char)))
    .replace(MENTION, (_, id) => keep(`<span class="md-mention">@${escapeHtml(mentioned(id))}</span>`));
  if (links) {
    s = s
      .replace(/\[([^\]\n]+)\]\(\s*<?([^\s)<>]+)>?(?:\s+"[^"\n]*")?\s*\)/g, (whole, label, url) =>
        safeUrl(url) ? keep(anchor(url, inline(label, false))) : whole)
      .replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, url) => keep(anchor(url, escapeHtml(url))))
      .replace(/\bhttps?:\/\/[^\s<>()\0]*[^\s<>().,;:!?'"*_~\0]/g, (url) => keep(anchor(url, escapeHtml(url))));
  }
  s = escapeHtml(s)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])@([a-z0-9][\w.-]*(?:\/[\w.-]*\w)?)/gi, '$1<span class="md-mention">@$2</span>');
  return s.replace(/\0(\d+)\0/g, (_, n) => slots[n]);
}
