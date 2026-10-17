// Resume documents: a small Markdown dialect <-> the visual page editor <-> PDF.
//
//   # Name                     ## SECTION            ### Role — Company   May 2025 – Sept 2025
//   contact line (paragraph)   - bullet point        **bold**  *italic*
//
// A date range at the end of a "###" line is right-aligned, like most resumes.

const PDFMAKE = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js';
const PDFMAKE_FONTS = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.js';

export const TEMPLATES = {
  classic: { label: 'Classic', nameAlign: 'center', nameSize: 20, rule: true, accentHeadings: false, base: 10.5, gap: 1 },
  modern: { label: 'Modern', nameAlign: 'left', nameSize: 22, rule: false, accentHeadings: true, base: 10.5, gap: 1 },
  compact: { label: 'Compact', nameAlign: 'left', nameSize: 17, rule: true, accentHeadings: true, base: 9.5, gap: 0.75 },
};
export const DEFAULT_STYLE = { template: 'classic', accent: '#1f3a8a', size: 0 };

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const WHEN = `(?:${MONTH}\\s+)?(?:19|20)\\d{2}`;
const DATE_RANGE = new RegExp(`\\s*\\(?((?:${WHEN}|${MONTH})\\s*(?:[-–—]|to)\\s*(?:${WHEN}|present|current|now)|(?:expected\\s+)?${WHEN})\\)?\\s*$`, 'i');

// ---------------------------------------------------------------- parsing

export function parseResume(md = '') {
  const blocks = [];
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    let m;
    if ((m = line.match(/^#\s+(.*)/))) blocks.push({ type: 'name', text: m[1] });
    else if ((m = line.match(/^##\s+(.*)/))) blocks.push({ type: 'section', text: m[1] });
    else if ((m = line.match(/^###\s+(.*)/))) {
      const d = m[1].match(DATE_RANGE);
      blocks.push(d && d.index > 0
        ? { type: 'role', text: m[1].slice(0, d.index).replace(/[\s|,–—-]+$/, ''), date: d[1] }
        : { type: 'role', text: m[1] });
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) blocks.push({ type: 'bullet', text: m[1] });
    else blocks.push({ type: 'text', text: line.trim() });
  }
  return blocks;
}

// Turn plain text (e.g. pasted or imported from a PDF/Word file) into the Markdown dialect.
const SECTION_NAMES = /^(summary|professional summary|profile|objective|about me|experience|work experience|professional experience|employment|employment experience|relevant experience|education|skills|technical skills|key skills|core competencies|projects|personal projects|academic projects|certifications?|licenses( & certifications)?|awards|honou?rs( & awards)?|achievements|leadership|leadership experience|volunteer( experience)?|volunteering|activities|extracurricular activities|publications|research|interests|languages|references|courses|coursework|relevant coursework)$/i;

export function autoFormat(text = '') {
  if (/^#{1,3}\s/m.test(text)) return text; // already formatted
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  // Pass 1: classify each line.
  const items = lines.map((raw) => {
    // Bullet glyphs from PDF/Word imports (, •, ▪, ●, ◦, o, –, -)
    const bullet = /^([•▪●◦‣⁃∙·*o–-])\s+/u.exec(raw);
    const line = bullet ? raw.slice(bullet[0].length) : raw;
    const plain = line.replace(/:$/, '');
    let kind = 'text';
    if (bullet) kind = 'bullet';
    else if (SECTION_NAMES.test(plain) || (/^[A-Z0-9 &/,'().+-]{3,45}$/.test(line) && /[A-Z]{3}/.test(line))) kind = 'section';
    else { const d = line.match(DATE_RANGE); if (d && d.index > 0 && line.length < 140) kind = 'role'; }
    return { line: kind === 'section' ? plain : line, kind };
  });
  // Pass 2: name, wrapped lines, and bullets whose glyphs were lost in the import.
  const hasBullets = items.some((i) => i.kind === 'bullet');
  const out = [];
  let section = '';
  let inEntry = false;
  items.forEach((it, i) => {
    const prev = out[out.length - 1];
    if (i === 0) { out.push(`# ${it.line}`); return; }
    if (it.kind === 'section') { out.push(`## ${it.line}`); section = it.line.toLowerCase(); inEntry = false; return; }
    if (it.kind === 'role') { out.push(`### ${it.line}`); inEntry = true; return; }
    if (it.kind === 'bullet') { out.push(`- ${it.line}`); return; }
    // A wrapped line from a PDF continues the previous bullet/paragraph.
    if (prev && !prev.startsWith('#') && (/^[a-z(]/.test(it.line) || /[,&]$|\b(and|or|of|the|with|to|for|in)$/i.test(prev))) {
      out[out.length - 1] = `${prev} ${it.line}`;
      return;
    }
    // No bullet glyphs survived: sentence-like lines under a role (or in a skills/projects list) become bullets,
    // except a line right before a role, which is usually the employer or school.
    const actionVerb = /^(\w+ed|built|led|wrote|ran|made|grew|won|drove|taught|shipped|owned|set|cut|began|took|sold|spoke|helped)\b/i.test(it.line);
    const looksLikeEmployer = items[i + 1]?.kind === 'role' && it.line.length < 60 && !actionVerb;
    const sentenceLike = it.line.length >= 25 && !/[|@]/.test(it.line);
    if (!hasBullets && !looksLikeEmployer && sentenceLike && (inEntry || /skill|project|award|certif|volunteer|leadership/.test(section))) {
      out.push(`- ${it.line}`);
      return;
    }
    out.push(it.line);
  });
  return out.join('\n');
}

// ---------------------------------------------------------------- HTML (visual editor)

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function inlineHtml(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
}

export function resumeToHtml(md) {
  let html = '';
  let inList = false;
  for (const b of parseResume(md)) {
    if (b.type === 'bullet') {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineHtml(b.text)}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (b.type === 'name') html += `<h1>${inlineHtml(b.text)}</h1>`;
    else if (b.type === 'section') html += `<h2>${inlineHtml(b.text)}</h2>`;
    else if (b.type === 'role') html += `<h3>${inlineHtml(b.text)}${b.date ? ` <span class="date">${escapeHtml(b.date)}</span>` : ''}</h3>`;
    else html += `<p>${inlineHtml(b.text)}</p>`;
  }
  return html + (inList ? '</ul>' : '');
}

function inlineMd(node) {
  let s = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) s += n.textContent.replace(/ /g, ' ');
    else if (n.nodeType !== 1) continue;
    else if (n.tagName === 'BR') s += ' ';
    else if (n.tagName === 'STRONG' || n.tagName === 'B') { const t = inlineMd(n).trim(); if (t) s += `**${t}** `; }
    else if (n.tagName === 'EM' || n.tagName === 'I') { const t = inlineMd(n).trim(); if (t) s += `*${t}* `; }
    else if (n.classList?.contains('date')) s += `  ${n.textContent.trim()}`;
    else s += inlineMd(n);
  }
  return s.replace(/\s+/g, ' ').replace(/\*\* (?=[,.;:)])/g, '**').trim();
}

// Read the visual editor back into Markdown.
export function htmlToResume(root) {
  const lines = [];
  const walk = (parent) => {
    for (const el of parent.childNodes) {
      if (el.nodeType === 3) { const t = el.textContent.trim(); if (t) lines.push(t); continue; }
      if (el.nodeType !== 1) continue;
      const tag = el.tagName;
      const text = () => inlineMd(el);
      if (tag === 'H1') { if (text()) lines.push(`# ${text()}`); }
      else if (tag === 'H2') { if (text()) lines.push(`## ${text()}`); }
      else if (tag === 'H3' || tag === 'H4') { if (text()) lines.push(`### ${text()}`); }
      else if (tag === 'UL' || tag === 'OL') {
        for (const li of el.querySelectorAll(':scope > li')) { const t = inlineMd(li); if (t) lines.push(`- ${t}`); }
      } else if (tag === 'LI') { const t = text(); if (t) lines.push(`- ${t}`); }
      else if ((tag === 'DIV' || tag === 'SECTION') && el.querySelector('h1,h2,h3,p,ul,ol,div,li')) walk(el);
      else { const t = text(); if (t) lines.push(t); }
    }
  };
  walk(root);
  return lines.join('\n');
}

// ---------------------------------------------------------------- styling shared by page + PDF

export function styleFor(style = {}) {
  const s = { ...DEFAULT_STYLE, ...style };
  const t = TEMPLATES[s.template] || TEMPLATES.classic;
  const base = t.base + Number(s.size || 0) * 0.5;
  return { ...t, accent: s.accent || DEFAULT_STYLE.accent, base, template: s.template };
}

// CSS variables + class for the on-screen page so it matches the PDF.
export function applyPageStyle(el, style) {
  const st = styleFor(style);
  el.dataset.template = st.template;
  el.style.setProperty('--r-accent', st.accent);
  el.style.setProperty('--r-base', `${st.base}pt`);
  el.style.setProperty('--r-name', `${st.nameSize}pt`);
  el.style.setProperty('--r-gap', String(st.gap));
  el.style.setProperty('--r-name-align', st.nameAlign);
}

// ---------------------------------------------------------------- PDF

async function loadScript(src) {
  if (document.querySelector(`script[src="${src}"]`)) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

function inlinePdf(text) {
  const parts = [];
  const re = /\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push(m[1] ? { text: m[1], bold: true } : { text: m[2], italics: true });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.length ? parts : [{ text }];
}

export function pdfDefinition(md, style, title = 'Resume') {
  const st = styleFor(style);
  const g = st.gap;
  const content = [];
  let bullets = [];
  let afterName = false;
  const flush = () => {
    if (bullets.length) content.push({ ul: bullets, margin: [6, 1 * g, 0, 3 * g], markerColor: '#333' });
    bullets = [];
  };
  for (const b of parseResume(md)) {
    if (b.type === 'bullet') { bullets.push({ text: inlinePdf(b.text), margin: [0, 0.5 * g, 0, 0.5 * g] }); continue; }
    flush();
    if (b.type === 'name') {
      content.push({ text: inlinePdf(b.text), fontSize: st.nameSize, bold: true, alignment: st.nameAlign,
        color: st.template === 'modern' ? st.accent : '#111', margin: [0, 0, 0, 2] });
      afterName = true;
      continue;
    }
    if (b.type === 'section') {
      content.push({ text: b.text.toUpperCase(), bold: true, fontSize: st.base + 0.5, characterSpacing: 0.6,
        color: st.accentHeadings ? st.accent : '#111', margin: [0, 9 * g, 0, st.rule ? 1 : 3 * g] });
      if (st.rule) content.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 540, y2: 0, lineWidth: 0.7, lineColor: st.accentHeadings ? st.accent : '#555' }], margin: [0, 0, 0, 4 * g] });
      afterName = false;
      continue;
    }
    if (b.type === 'role') {
      content.push(b.date
        ? { columns: [{ text: inlinePdf(b.text), bold: true, width: '*' }, { text: b.date, width: 'auto', italics: true, color: '#444' }], margin: [0, 4 * g, 0, 1] }
        : { text: inlinePdf(b.text), bold: true, margin: [0, 4 * g, 0, 1] });
      afterName = false;
      continue;
    }
    content.push({ text: inlinePdf(b.text), alignment: afterName ? st.nameAlign : 'left', color: afterName ? '#333' : '#111',
      margin: [0, afterName ? 0 : 1, 0, afterName ? 4 : 2 * g] });
  }
  flush();
  return {
    info: { title },
    pageSize: 'LETTER',
    pageMargins: [36, 34, 36, 34],
    content,
    defaultStyle: { font: 'Roboto', fontSize: st.base, lineHeight: 1.18, color: '#111' },
  };
}

export async function downloadPdf(md, style, fileName) {
  await loadScript(PDFMAKE);
  await loadScript(PDFMAKE_FONTS);
  window.pdfMake.createPdf(pdfDefinition(md, style, fileName)).download(`${fileName}.pdf`);
}

export function toPlainText(md) {
  return parseResume(md).map((b) => {
    const t = b.text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1');
    if (b.type === 'name') return t.toUpperCase();
    if (b.type === 'section') return `\n${t.toUpperCase()}`;
    if (b.type === 'role') return b.date ? `${t}    ${b.date}` : t;
    if (b.type === 'bullet') return `• ${t}`;
    return t;
  }).join('\n');
}
