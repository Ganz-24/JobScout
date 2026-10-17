// Resume studio: manage resumes, match-report against a posting, and Claude-powered
// suggestions / auto-tailoring / cover letters.

import { resumeToHtml, htmlToResume, autoFormat, applyPageStyle, downloadPdf, toPlainText, TEMPLATES, DEFAULT_STYLE } from './resume-doc.js';

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

export function initResume(ctx) {
  const { S, $, $$, api, persist, esc, toast, findJob, safeUrl, download, showTab, selectJob } = ctx;
  const R = { sub: 'report', jobId: null, busy: null, analyzeTimer: null, showDiff: false, undo: null, syncTimer: null };
  try { R.mode = localStorage.getItem('resumeEditorMode') || 'visual'; } catch { R.mode = 'visual'; }

  // ---------------------------------------------------------------- state helpers

  const resumes = () => (S.state.resumes ||= []);
  const aiCache = () => (S.state.resumeAI ||= {});
  function current() {
    const list = resumes();
    return list.find((r) => r.id === S.state.activeResumeId) || list.find((r) => r.id === S.state.defaultResumeId) || list[0] || null;
  }
  function hash(s = '') {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return `${s.length}:${h}`;
  }
  const cacheKey = () => `${current()?.id}|${R.jobId}`;
  function slimJob(job) {
    const { title, company, location, seniority, skills, requirements, description } = job;
    return { title, company, location, seniority, skills, requirements, description };
  }
  function newResume(name = 'Untitled resume', text = '', style = null) {
    const r = { id: `r${Date.now().toString(36)}`, name, text, updatedAt: new Date().toISOString(),
      style: { ...DEFAULT_STYLE, ...(style || {}) }, autoFormatted: true };
    resumes().push(r);
    S.state.activeResumeId = r.id;
    if (!S.state.defaultResumeId) S.state.defaultResumeId = r.id;
    persist();
    return r;
  }

  // ---------------------------------------------------------------- editor

  function renderEditor() {
    const list = resumes();
    const cur = current();
    $('#resumeSelect').innerHTML = list.length
      ? list.map((r) => `<option value="${esc(r.id)}" ${r.id === cur?.id ? 'selected' : ''}>${r.id === S.state.defaultResumeId ? '★ ' : ''}${esc(r.name)}</option>`).join('')
      : '<option>No resumes yet</option>';
    $('#resumeSelect').disabled = !list.length;
    $('#resumeName').value = cur?.name || '';
    $('#resumeName').disabled = !cur;
    $('#resumeText').value = cur?.text || '';
    $('#resumeDefault').textContent = cur && cur.id === S.state.defaultResumeId ? '★' : '☆';
    $('#resumeDefault').classList.toggle('on', !!cur && cur.id === S.state.defaultResumeId);
    $('#resumeDelete').disabled = !cur;
    renderStyleControls();
    renderPage();
    renderMeta();
  }

  // ---------------------------------------------------------------- page editor

  function renderStyleControls() {
    const st = { ...DEFAULT_STYLE, ...(current()?.style || {}) };
    $('#tplSelect').innerHTML = Object.entries(TEMPLATES).map(([id, t]) => `<option value="${id}" ${id === st.template ? 'selected' : ''}>${t.label} template</option>`).join('');
    $('#tplSize').value = String(st.size || 0);
    $('#tplAccent').value = st.accent;
    for (const el of ['#tplSelect', '#tplSize', '#tplAccent', '#resumeDup', '#resumeDl']) $(el).disabled = !current();
    $$('#editorMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === R.mode));
    const visual = R.mode === 'visual';
    $('#paperWrap').classList.toggle('hidden', !visual);
    $('#formatBar').classList.toggle('hidden', !visual);
    $('#resumeText').classList.toggle('hidden', visual);
    $('#aiUndoBtn').classList.toggle('hidden', !(R.undo && R.undo.id === current()?.id));
    if (R.undo) $('#aiUndoBtn').textContent = R.undo.label;
  }

  // Draw the resume onto the page (skipped while you're typing in it, so the caret doesn't jump).
  function renderPage({ force = false } = {}) {
    const cur = current();
    const paper = $('#resumePaper');
    if (R.mode !== 'visual') return;
    if (cur && cur.text.trim() && !cur.autoFormatted && !/^#{1,3}\s/m.test(cur.text)) {
      // Older resumes are plain text: detect name / sections / roles / bullets once, with an undo.
      R.undo = { id: cur.id, text: cur.text, label: 'Undo auto-format' };
      cur.text = autoFormat(cur.text);
      cur.autoFormatted = true;
      persist();
      $('#aiUndoBtn').classList.remove('hidden');
      $('#aiUndoBtn').textContent = R.undo.label;
    }
    if (document.activeElement === paper && !force) return;
    paper.innerHTML = cur ? resumeToHtml(cur.text) : '';
    paper.contentEditable = cur ? 'true' : 'false';
    applyPageStyle(paper, cur?.style);
    fitPaper();
  }

  // Scale the real-size page to fit the panel.
  function fitPaper() {
    const wrap = $('#paperWrap');
    const paper = $('#resumePaper');
    if (!wrap.clientWidth) return;
    const zoom = Math.min(1, (wrap.clientWidth - 32) / 816);
    paper.style.zoom = zoom.toFixed(3);
    renderMeta();
  }

  function pageCount() {
    const paper = $('#resumePaper');
    if (R.mode !== 'visual' || !paper.offsetHeight) return null;
    return Math.max(1, Math.ceil((paper.offsetHeight - 2) / 1056));
  }

  // Read the edited page back into the resume text (debounced).
  function syncFromPaper() {
    clearTimeout(R.syncTimer);
    R.syncTimer = setTimeout(() => {
      const cur = current();
      if (!cur) return;
      cur.text = htmlToResume($('#resumePaper'));
      cur.updatedAt = new Date().toISOString();
      persist();
      renderMeta();
      clearTimeout(R.analyzeTimer);
      R.analyzeTimer = setTimeout(() => { if (R.sub === 'report') renderOut(); }, 700);
    }, 250);
  }

  function setStyle(patch) {
    const cur = current();
    if (!cur) return;
    cur.style = { ...DEFAULT_STYLE, ...(cur.style || {}), ...patch };
    persist();
    applyPageStyle($('#resumePaper'), cur.style);
    renderMeta();
  }

  function fileBaseFor(r) {
    return (r?.name || 'resume').replace(/[^\w\s.-]+/g, '').trim().replace(/\s+/g, '-') || 'resume';
  }

  function renderMeta() {
    const cur = current();
    const words = (cur?.text.match(/\S+/g) || []).length;
    $('#resumeMeta').textContent = cur
      ? `${pageCount() ? `${pageCount()} page${pageCount() > 1 ? 's' : ''} · ` : ''}${words.toLocaleString()} words · saved ${new Date(cur.updatedAt).toLocaleString()}${cur.basedOn ? ` · tailored for ${cur.basedOn}` : ''}${pageCount() > 1 ? ' · red lines mark page breaks' : ''}`
      : 'Paste your resume to get started — it stays on this computer (data/state.json).';
  }

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

  async function fileToText(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'txt' || ext === 'md') return file.text();
    if (ext === 'docx') {
      await loadScript(MAMMOTH);
      const out = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return out.value;
    }
    if (ext === 'pdf') {
      await loadScript(PDFJS);
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      const pages = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const content = await (await pdf.getPage(p)).getTextContent();
        pages.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join(''));
      }
      return pages.join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    throw new Error('Unsupported file type — use PDF, DOCX, TXT or MD');
  }

  // ---------------------------------------------------------------- job picker

  function jobOptions() {
    const seen = new Set();
    const groups = [];
    const add = (label, jobs) => {
      const items = jobs.filter((j) => j && !seen.has(j.id));
      items.forEach((j) => seen.add(j.id));
      if (items.length) groups.push({ label, items });
    };
    add('Selected in Discover', [findJob(S.selectedId)]);
    add('Your tracker', Object.values(S.state.tracker).map((t) => t.job));
    add('Top results', S.filtered.slice(0, 40));
    return groups;
  }

  function renderJobPicker() {
    const groups = jobOptions();
    const all = groups.flatMap((g) => g.items);
    if (!all.some((j) => j.id === R.jobId)) R.jobId = all[0]?.id || null;
    $('#resumeJob').innerHTML = all.length
      ? groups.map((g) => `<optgroup label="${esc(g.label)}">${g.items.map((j) =>
        `<option value="${esc(j.id)}" ${j.id === R.jobId ? 'selected' : ''}>${esc(j.title)} — ${esc(j.company || '')}</option>`).join('')}</optgroup>`).join('')
      : '<option value="">Search for jobs or save some to your tracker first</option>';
    const job = findJob(R.jobId);
    $('#resumeJobCard').innerHTML = job ? `
      <div class="mini-job">
        <div><b>${esc(job.title)}</b><div class="muted small">${esc(job.company || '')}${job.location ? ` · ${esc(job.location)}` : ''}</div></div>
        <div class="row gap">
          <button class="link-btn" data-r="view-job">View posting details</button>
          ${safeUrl(job.applyUrl || job.url) ? `<a class="link-btn" href="${esc(safeUrl(job.applyUrl || job.url))}" target="_blank" rel="noopener noreferrer">Apply ↗</a>` : ''}
        </div>
      </div>` : '';
  }

  // ---------------------------------------------------------------- output panes

  function renderSubtabs() {
    $$('.subtab').forEach((b) => b.classList.toggle('on', b.dataset.sub === R.sub));
  }

  function needs() {
    if (!current()?.text.trim()) return '<div class="empty"><b>Add your resume first</b>Paste it on the left or upload a PDF / Word file.</div>';
    if (!findJob(R.jobId)) return '<div class="empty"><b>Pick a job</b>Choose a posting above — run a search or save jobs to your tracker first.</div>';
    return null;
  }

  function renderOut() {
    renderSubtabs();
    const blocker = needs();
    if (blocker) { $('#resumeOut').innerHTML = blocker; return; }
    if (R.sub === 'report') return runAnalyze();
    if (R.busy === `${R.sub}|${cacheKey()}`) return renderBusy();
    const cached = aiCache()[cacheKey()]?.[R.sub];
    if (cached) return renderAiResult(R.sub, cached);
    renderAiIntro(R.sub);
  }

  function scoreRing(score) {
    const cls = score >= 70 ? 'hi' : score >= 40 ? 'mid' : 'lo';
    return `<div class="match ${cls} match-lg" style="--p:${score}"><span>${score}%</span></div>`;
  }

  async function runAnalyze() {
    const out = $('#resumeOut');
    if (!out.innerHTML.trim() || !out.querySelector('.report')) out.innerHTML = '<div class="skeleton"></div>';
    try {
      const a = await api('/api/resume/analyze', { method: 'POST', body: { resume: current().text, job: slimJob(findJob(R.jobId)) } });
      if (R.sub !== 'report') return;
      const icon = { covered: '✓', partial: '◐', missing: '✕' };
      out.innerHTML = `
      <div class="report">
        <div class="report-head">
          ${scoreRing(a.score)}
          <div>
            <h3>Resume match: ${a.score >= 70 ? 'strong' : a.score >= 40 ? 'fair' : 'weak'}</h3>
            <p class="muted small">Keyword match ${a.keywordScore ?? '—'}% · ${a.requirements.filter((r) => r.status === 'covered').length}/${a.requirements.length} key requirements covered · ${a.stats.wordCount} words.
              Instant check, no AI — use <b>AI suggestions</b> for deeper feedback.</p>
          </div>
        </div>
        ${a.tips.length ? `<div class="section"><h2>What to fix</h2><ol class="tips">${a.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>` : ''}
        <div class="section">
          <h2>Skills from the posting</h2>
          <div class="chips">
            ${a.skills.found.map((s) => `<span class="chip have">✓ ${esc(s)}</span>`).join('')}
            ${a.skills.missing.map((s) => `<span class="chip missing" title="Not found in your resume">${esc(s)}</span>`).join('')}
          </div>
          ${!a.skills.found.length && !a.skills.missing.length ? '<p class="hint">No specific skills detected in this posting.</p>' : ''}
        </div>
        ${a.requirements.length ? `<div class="section"><h2>Key requirements</h2>
          <ul class="req-cover">${a.requirements.map((r) => `
            <li class="${r.status}"><span class="ri" aria-label="${r.status}">${icon[r.status]}</span>
              <div>${esc(r.text)}${r.status !== 'covered' && r.missingTerms.length ? `<div class="muted small">Not in your resume: ${r.missingTerms.map(esc).join(', ')}</div>` : ''}</div></li>`).join('')}
          </ul></div>` : ''}
        <div class="section"><h2>Resume health</h2>
          <ul class="checks">${a.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}"><span class="ri">${c.ok ? '✓' : '!'}</span>${esc(c.label)}${c.detail ? ` <span class="muted small">— ${esc(c.detail)}</span>` : ''}</li>`).join('')}</ul>
        </div>
      </div>`;
    } catch (e) {
      out.innerHTML = `<div class="empty"><b>Couldn't analyze</b>${esc(e.message)}</div>`;
    }
  }

  const AI_INTRO = {
    suggest: {
      title: 'Get tailored suggestions',
      body: 'Claude reviews your resume against this posting: fit score, strengths, gaps and how to address them truthfully, missing keywords, rewritten bullets and a tailored summary.',
      button: 'Generate suggestions',
    },
    tailor: {
      title: 'Auto-tailor your resume',
      body: 'Claude rewrites your resume for this posting — reordering, rephrasing with the posting\'s language and tightening bullets — without inventing experience. You can edit the result, compare it with the original, and save it as a new version.',
      button: 'Tailor my resume',
    },
    cover: {
      title: 'Write a cover letter',
      body: 'A 250–350 word letter that connects your actual accomplishments to what this posting asks for.',
      button: 'Write cover letter',
    },
  };

  function renderAiIntro(sub) {
    const i = AI_INTRO[sub];
    const ai = S.meta.ai || {};
    const blocked = !ai.installed
      ? 'Run <code>npm install</code> and restart the server to enable AI features.'
      : !ai.configured
        ? 'Add <code>ANTHROPIC_API_KEY=...</code> to your <code>.env</code> file and restart the server. Get a key at <a href="https://platform.claude.com" target="_blank" rel="noopener noreferrer">platform.claude.com</a>.'
        : null;
    $('#resumeOut').innerHTML = `
      <div class="ai-intro">
        <h3>${i.title}</h3>
        <p class="muted">${i.body}</p>
        ${sub === 'cover' ? `<label class="field"><span>Tone</span><select id="coverTone">
          <option value="professional">Professional</option><option value="warm and enthusiastic">Enthusiastic</option>
          <option value="concise and direct">Concise</option></select></label>` : ''}
        ${blocked ? `<div class="callout">${blocked}</div>` : `<button class="btn primary" data-r="run">${i.button}</button>
          <p class="hint">Uses ${esc(ai.model || 'Claude')} via your API key · usually a few cents per run · takes 20–60 seconds.</p>`}
      </div>`;
  }

  function renderBusy() {
    const started = R.busyStarted;
    $('#resumeOut').innerHTML = `<div class="ai-intro"><div class="row gap"><span class="spinner dark"></span><b>Claude is working on it…</b></div>
      <p class="muted small" id="busyTimer">${Math.round((Date.now() - started) / 1000)}s</p></div>`;
  }

  async function runAi(sub) {
    const key = cacheKey();
    const job = findJob(R.jobId);
    const resume = current();
    const endpoint = { suggest: 'suggest', tailor: 'tailor', cover: 'cover-letter' }[sub];
    const tone = $('#coverTone')?.value;
    R.busy = `${sub}|${key}`;
    R.busyStarted = Date.now();
    renderBusy();
    const tick = setInterval(() => {
      const el = $('#busyTimer');
      if (el) el.textContent = `${Math.round((Date.now() - R.busyStarted) / 1000)}s`;
    }, 1000);
    try {
      const result = await api(`/api/resume/${endpoint}`, { method: 'POST', body: { resume: resume.text, job: slimJob(job), tone } });
      const entry = (aiCache()[key] ||= {});
      entry[sub] = { ...result, at: new Date().toISOString(), resumeHash: hash(resume.text), draft: null };
      persist();
      toast('Done');
    } catch (e) {
      toast(e.message);
      R.lastError = e.message;
    } finally {
      clearInterval(tick);
      R.busy = null;
      if (cacheKey() === key && R.sub === sub) {
        if (!aiCache()[key]?.[sub] && R.lastError) {
          renderAiIntro(sub);
          $('#resumeOut').insertAdjacentHTML('afterbegin', `<div class="callout error">${esc(R.lastError)}</div>`);
        } else {
          renderOut();
        }
      }
      R.lastError = null;
    }
  }

  function staleNote(result) {
    return result.resumeHash !== hash(current().text)
      ? '<div class="callout">Your resume changed since this was generated. <button class="link-btn" data-r="run">Regenerate</button></div>'
      : '';
  }

  function resultHeader(sub, result) {
    return `<div class="result-head">
      <span class="muted small">Generated ${new Date(result.at).toLocaleString()}</span>
      <button class="link-btn" data-r="run">Regenerate</button></div>${staleNote(result)}`;
  }

  function renderAiResult(sub, r) {
    const out = $('#resumeOut');
    if (sub === 'suggest') {
      out.innerHTML = `${resultHeader(sub, r)}
      <div class="report">
        <div class="report-head">${scoreRing(Math.max(0, Math.min(100, r.fit_score)))}<div><h3>Fit assessment</h3><p>${esc(r.fit_summary)}</p></div></div>
        ${r.strengths.length ? `<div class="section"><h2>Strengths</h2><ul class="checks">${r.strengths.map((s) => `<li class="ok"><span class="ri">✓</span>${esc(s)}</li>`).join('')}</ul></div>` : ''}
        ${r.gaps.length ? `<div class="section"><h2>Gaps &amp; how to address them</h2>
          <div class="cards">${r.gaps.map((g) => `<div class="s-card"><b>${esc(g.gap)}</b><p>${esc(g.suggestion)}</p></div>`).join('')}</div></div>` : ''}
        ${r.bullet_rewrites.length ? `<div class="section"><h2>Bullet rewrites</h2>
          <div class="cards">${r.bullet_rewrites.map((b, i) => `<div class="s-card">
            <div class="before">${esc(b.original)}</div>
            <div class="after">${esc(b.improved)}</div>
            <p class="muted small">${esc(b.reason)}</p>
            <div class="row gap"><button class="btn small" data-r="apply-bullet" data-i="${i}">Apply to resume</button>
              <button class="btn small" data-r="copy" data-text="${esc(b.improved)}">Copy</button></div>
          </div>`).join('')}</div></div>` : ''}
        ${r.keywords_to_add.length ? `<div class="section"><h2>Keywords to work in</h2>
          <ul class="kw-list">${r.keywords_to_add.map((k) => `<li><span class="chip ${k.only_if_true ? 'missing' : 'on'}">${esc(k.keyword)}</span>
            <span>${esc(k.where)}${k.only_if_true ? ' <em class="warn-text">— only if you really have this</em>' : ''}</span></li>`).join('')}</ul></div>` : ''}
        ${r.summary_rewrite ? `<div class="section"><h2>Suggested summary</h2>
          <div class="s-card"><p>${esc(r.summary_rewrite)}</p><button class="btn small" data-r="copy" data-text="${esc(r.summary_rewrite)}">Copy</button></div></div>` : ''}
        ${r.other_tips.length ? `<div class="section"><h2>Other tips</h2><ol class="tips">${r.other_tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ol></div>` : ''}
      </div>`;
    } else if (sub === 'tailor') {
      const text = r.draft ?? r.tailored_resume;
      out.innerHTML = `${resultHeader(sub, r)}
        <div class="row gap wrap tailor-actions">
          <button class="btn primary small" data-r="save-version">Save as new resume</button>
          <button class="btn small" data-r="toggle-diff">${R.showDiff ? 'Edit text' : 'Compare with original'}</button>
          <button class="btn small" data-r="copy-tailored">Copy</button>
          <button class="btn small" data-r="dl-md">Download .md</button>
          <button class="btn small" data-r="dl-txt">Download .txt</button>
          <button class="btn small" data-r="dl-pdf">Download PDF</button>
          <button class="btn small" data-r="print">Print</button>
        </div>
        ${R.showDiff ? `<div class="diff">${diffHtml(current().text, text)}</div>`
          : `<textarea class="tailored" id="tailoredText">${esc(text)}</textarea>`}
        ${r.changes.length ? `<div class="section"><h2>What changed</h2><ul class="checks">${r.changes.map((c) => `<li class="ok"><span class="ri">✎</span>${esc(c)}</li>`).join('')}</ul></div>` : ''}
        ${r.not_added.length ? `<div class="section"><h2>Not added — your call</h2>
          <p class="hint">The posting asks for these but your resume doesn't show them. Add them yourself only if they're true.</p>
          <ul class="checks">${r.not_added.map((c) => `<li class="bad"><span class="ri">!</span>${esc(c)}</li>`).join('')}</ul></div>` : ''}`;
    } else if (sub === 'cover') {
      out.innerHTML = `${resultHeader(sub, r)}
        <div class="row gap wrap tailor-actions">
          <button class="btn small" data-r="copy-cover">Copy</button>
          <button class="btn small" data-r="dl-cover">Download .txt</button>
          <select id="coverTone" class="small-select" aria-label="Tone">
            <option value="professional">Professional</option><option value="warm and enthusiastic">Enthusiastic</option><option value="concise and direct">Concise</option>
          </select>
        </div>
        <textarea class="tailored" id="coverText">${esc(r.draft ?? r.cover_letter)}</textarea>`;
    }
  }

  // ---------------------------------------------------------------- diff & export

  function diffHtml(a, b) {
    const x = a.split('\n');
    const y = b.split('\n');
    const n = x.length;
    const m = y.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = x[i].trim() === y[j].trim() ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i].trim() === y[j].trim()) { out.push(['same', y[j]]); i++; j++; }
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push(['add', y[j]]); j++; }
      else { out.push(['del', x[i]]); i++; }
    }
    return out.filter(([, l]) => l.trim()).map(([t, l]) => `<div class="d-${t}"><span>${t === 'add' ? '+' : t === 'del' ? '−' : ' '}</span>${esc(l)}</div>`).join('')
      + '<p class="hint">Green lines are new or rewritten; red lines were removed or replaced.</p>';
  }

  function printResume(md, style, title) {
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups to print');
    const holder = document.createElement('div');
    applyPageStyle(holder, style);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,400;0,700;1,400&display=swap">
      <link rel="stylesheet" href="${location.origin}/styles.css">
      <style>@page{size:letter;margin:0} html,body{background:#fff!important;margin:0}
        .resume-paper{box-shadow:none!important;background-image:none!important;margin:0!important;min-height:0}</style>
      </head><body><div class="resume-paper" data-template="${holder.dataset.template}" style="${holder.getAttribute('style') || ''}">${resumeToHtml(md)}</div>
      <script>document.fonts.ready.then(() => setTimeout(() => window.print(), 300))<\/script></body></html>`);
    w.document.close();
  }

  const stripMd = (md) => toPlainText(md);
  const fileBase = () => {
    const job = findJob(R.jobId);
    return `resume-${(job?.company || 'tailored').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  };

  // ---------------------------------------------------------------- events

  $('#resumeSelect').addEventListener('change', (e) => {
    S.state.activeResumeId = e.target.value;
    persist();
    renderEditor();
    renderOut();
  });
  $('#resumeName').addEventListener('input', (e) => {
    const cur = current();
    if (!cur) return;
    cur.name = e.target.value || 'Untitled resume';
    persist();
    const opt = $('#resumeSelect').selectedOptions[0];
    if (opt) opt.textContent = `${cur.id === S.state.defaultResumeId ? '★ ' : ''}${cur.name}`;
  });
  $('#resumeText').addEventListener('input', (e) => {
    let cur = current();
    if (!cur) cur = newResume('My resume', '');
    cur.text = e.target.value;
    cur.updatedAt = new Date().toISOString();
    persist();
    renderMeta();
    if (resumes().length === 1 && $('#resumeSelect').disabled) renderEditor();
    clearTimeout(R.analyzeTimer);
    R.analyzeTimer = setTimeout(() => { if (R.sub === 'report') renderOut(); }, 700);
  });
  $('#resumeNew').addEventListener('click', () => {
    newResume();
    renderEditor();
    renderOut();
    (R.mode === 'visual' ? $('#resumePaper') : $('#resumeText')).focus();
  });
  $('#resumeDelete').addEventListener('click', () => {
    const cur = current();
    if (!cur || !confirm(`Delete "${cur.name}"? This can't be undone.`)) return;
    S.state.resumes = resumes().filter((r) => r.id !== cur.id);
    for (const k of Object.keys(aiCache())) if (k.startsWith(`${cur.id}|`)) delete aiCache()[k];
    if (S.state.defaultResumeId === cur.id) S.state.defaultResumeId = S.state.resumes[0]?.id || null;
    S.state.activeResumeId = S.state.resumes[0]?.id || null;
    persist();
    renderEditor();
    renderOut();
  });
  $('#resumeDefault').addEventListener('click', () => {
    const cur = current();
    if (!cur) return;
    S.state.defaultResumeId = cur.id;
    persist();
    renderEditor();
    toast(`"${cur.name}" is now your default resume`);
  });
  $('#resumeUpload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    toast('Reading file…');
    try {
      const text = await fileToText(file);
      if (!text.trim()) throw new Error('No text found — if it is a scanned PDF, paste the text instead');
      newResume(file.name.replace(/\.[^.]+$/, ''), autoFormat(text));
      renderEditor();
      renderOut();
      toast('Resume imported — check the page and use the toolbar to fix any formatting');
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  });
  $('#resumeJob').addEventListener('change', (e) => {
    R.jobId = e.target.value;
    R.showDiff = false;
    renderJobPicker();
    renderOut();
  });
  $$('.subtab').forEach((b) => b.addEventListener('click', () => {
    R.sub = b.dataset.sub;
    R.showDiff = false;
    renderOut();
  }));

  $('#tab-resume').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-r]');
    if (!btn) return;
    const act = btn.dataset.r;
    const entry = aiCache()[cacheKey()] || {};
    if (act === 'run') return runAi(R.sub);
    if (act === 'view-job') { showTab('discover'); selectJob(R.jobId, { scroll: true }); return; }
    if (act === 'copy') return navigator.clipboard.writeText(btn.dataset.text).then(() => toast('Copied'));
    if (act === 'apply-bullet') {
      const b = entry.suggest.bullet_rewrites[Number(btn.dataset.i)];
      const cur = current();
      const strip = (s) => s.replace(/^\s*[-*•–]\s*/, '').trim();
      const target = cur.text.includes(b.original) ? b.original : cur.text.includes(strip(b.original)) ? strip(b.original) : null;
      if (!target) {
        await navigator.clipboard.writeText(b.improved).catch(() => {});
        return toast("Couldn't find that exact line — the rewrite is copied, paste it in yourself");
      }
      cur.text = cur.text.replace(target, strip(b.improved));
      cur.updatedAt = new Date().toISOString();
      persist();
      renderEditor();
      btn.textContent = 'Applied ✓';
      btn.disabled = true;
      return toast('Bullet updated in your resume');
    }
    const tailored = () => $('#tailoredText')?.value ?? entry.tailor?.draft ?? entry.tailor?.tailored_resume ?? '';
    if (act === 'toggle-diff') {
      if (!R.showDiff && $('#tailoredText')) entry.tailor.draft = $('#tailoredText').value;
      R.showDiff = !R.showDiff;
      return renderAiResult('tailor', entry.tailor);
    }
    if (act === 'save-version') {
      const job = findJob(R.jobId);
      const base = current();
      const r = newResume(`${base.name} → ${job.company || job.title}`, tailored(), base.style);
      r.basedOn = `${job.title} at ${job.company}`;
      persist();
      renderEditor();
      renderOut();
      return toast('Saved as a new resume profile — it is open in the editor on the left');
    }
    if (act === 'copy-tailored') return navigator.clipboard.writeText(tailored()).then(() => toast('Copied'));
    if (act === 'dl-md') return download(`${fileBase()}.md`, tailored(), 'text/markdown');
    if (act === 'dl-txt') return download(`${fileBase()}.txt`, stripMd(tailored()), 'text/plain');
    if (act === 'print') return printResume(tailored(), current()?.style, fileBase());
    if (act === 'dl-pdf') return downloadPdf(tailored(), current()?.style, fileBase()).catch((err) => toast(err.message));
    const cover = () => $('#coverText')?.value ?? '';
    if (act === 'copy-cover') return navigator.clipboard.writeText(cover()).then(() => toast('Copied'));
    if (act === 'dl-cover') return download(`cover-letter-${fileBase().slice(7)}.txt`, cover(), 'text/plain');
  });
  // Keep manual edits to generated text.
  $('#tab-resume').addEventListener('input', (e) => {
    const entry = aiCache()[cacheKey()];
    if (e.target.id === 'tailoredText' && entry?.tailor) { entry.tailor.draft = e.target.value; persist(); }
    if (e.target.id === 'coverText' && entry?.cover) { entry.cover.draft = e.target.value; persist(); }
  });

  // ---------------------------------------------------------------- page editor events

  $$('#editorMode button').forEach((b) => b.addEventListener('click', () => {
    const cur = current();
    // Carry unsaved page edits over before switching views.
    if (cur && R.mode === 'visual') { clearTimeout(R.syncTimer); cur.text = htmlToResume($('#resumePaper')); persist(); }
    if (cur) $('#resumeText').value = cur.text;
    R.mode = b.dataset.v;
    try { localStorage.setItem('resumeEditorMode', R.mode); } catch { /* storage unavailable */ }
    renderStyleControls();
    renderPage({ force: true });
    renderMeta();
  }));
  $('#tplSelect').addEventListener('change', (e) => setStyle({ template: e.target.value }));
  $('#tplSize').addEventListener('change', (e) => setStyle({ size: Number(e.target.value) }));
  $('#tplAccent').addEventListener('input', (e) => setStyle({ accent: e.target.value }));

  const paper = $('#resumePaper');
  paper.addEventListener('focus', () => document.execCommand('defaultParagraphSeparator', false, 'p'));
  paper.addEventListener('input', () => {
    if (!current()) newResume('My resume', '');
    syncFromPaper();
  });
  // Paste as plain text; pasting a whole resume into an empty page is auto-formatted.
  paper.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    if (text.includes('\n') && !paper.textContent.trim()) {
      paper.innerHTML = resumeToHtml(autoFormat(text));
    } else {
      document.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
    }
    syncFromPaper();
  });
  paper.addEventListener('blur', () => {
    clearTimeout(R.syncTimer);
    const cur = current();
    if (!cur) return;
    const text = htmlToResume(paper);
    if (text !== cur.text) { cur.text = text; cur.updatedAt = new Date().toISOString(); persist(); }
    renderMeta();
  });

  const formatBar = $('#formatBar');
  formatBar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); }); // keep the selection
  formatBar.addEventListener('click', (e) => {
    const fmt = e.target.closest('[data-fmt]')?.dataset.fmt;
    if (!fmt) return;
    if (fmt === 'autoformat') {
      const cur = current();
      if (!cur) return;
      R.undo = { id: cur.id, text: cur.text, label: 'Undo auto-format' };
      cur.text = autoFormat(htmlToResume(paper).replace(/^#{1,3}\s+/gm, ''));
      persist();
      renderStyleControls();
      return renderPage({ force: true });
    }
    paper.focus();
    if (['h1', 'h2', 'h3', 'p'].includes(fmt)) document.execCommand('formatBlock', false, fmt === 'p' ? 'P' : fmt.toUpperCase());
    else if (fmt === 'ul') document.execCommand('insertUnorderedList');
    else document.execCommand(fmt);
    syncFromPaper();
  });

  $('#resumeDup').addEventListener('click', () => {
    const cur = current();
    if (!cur) return;
    newResume(`${cur.name} (copy)`, cur.text, cur.style);
    renderEditor();
    renderOut();
    toast('Duplicated — edit this copy for a different kind of application');
  });

  const dlMenu = $('#resumeDlMenu');
  $('#resumeDl').addEventListener('click', (e) => { e.stopPropagation(); dlMenu.classList.toggle('hidden'); });
  document.addEventListener('click', (e) => { if (!dlMenu.contains(e.target)) dlMenu.classList.add('hidden'); });
  dlMenu.addEventListener('click', async (e) => {
    const kind = e.target.closest('[data-dl]')?.dataset.dl;
    const cur = current();
    if (!kind || !cur) return;
    dlMenu.classList.add('hidden');
    if (R.mode === 'visual') cur.text = htmlToResume(paper);
    const base = fileBaseFor(cur);
    if (kind === 'pdf') {
      toast('Preparing PDF…');
      try { await downloadPdf(cur.text, cur.style, base); } catch (err) { toast(`PDF failed: ${err.message}`); }
    }
    if (kind === 'print') printResume(cur.text, cur.style, base);
    if (kind === 'txt') download(`${base}.txt`, toPlainText(cur.text), 'text/plain');
    if (kind === 'md') download(`${base}.md`, cur.text, 'text/markdown');
  });

  // Ask Claude to edit the resume in place, with a one-step undo.
  $('#aiEditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const instruction = $('#aiEditInput').value.trim();
    const cur = current();
    if (!instruction || !cur) return;
    if (!S.meta.ai?.configured) return toast('AI editing needs ANTHROPIC_API_KEY in .env (then restart the server)');
    if (R.mode === 'visual') cur.text = htmlToResume(paper);
    const btn = $('#aiEditBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner dark"></span> Editing…';
    try {
      const job = findJob(R.jobId);
      const res = await api('/api/resume/edit', { method: 'POST', body: { resume: cur.text, instruction, job: job ? slimJob(job) : null } });
      R.undo = { id: cur.id, text: cur.text, label: 'Undo AI edit' };
      cur.text = res.resume;
      cur.autoFormatted = true;
      cur.updatedAt = new Date().toISOString();
      persist();
      $('#aiEditInput').value = '';
      renderStyleControls();
      renderPage({ force: true });
      renderOut();
      toast(res.changes?.length ? `Done: ${res.changes.slice(0, 2).join('; ')}` : 'Resume updated');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Edit';
    }
  });
  $('#aiUndoBtn').addEventListener('click', () => {
    const cur = current();
    if (!R.undo || !cur || R.undo.id !== cur.id) return;
    cur.text = R.undo.text;
    cur.updatedAt = new Date().toISOString();
    R.undo = null;
    persist();
    renderStyleControls();
    renderPage({ force: true });
    renderOut();
    toast('Undone');
  });
  window.addEventListener('resize', () => { if ($('#tab-resume').classList.contains('active')) fitPaper(); });

  // ---------------------------------------------------------------- public

  function renderStatus() {
    const ai = S.meta.ai || {};
    const el = $('#aiStatus');
    el.className = `ai-status ${ai.configured ? 'ok' : ''}`;
    el.textContent = ai.configured ? `AI ready · ${ai.model}` : 'AI off · instant match report only';
    el.title = ai.configured ? '' : 'Add ANTHROPIC_API_KEY to .env and restart to enable AI suggestions, tailoring and cover letters';
  }

  return {
    show(jobId) {
      if (jobId) R.jobId = jobId;
      renderStatus();
      renderEditor();
      renderJobPicker();
      renderOut();
    },
    defaultResume: () => resumes().find((r) => r.id === S.state.defaultResumeId) || resumes()[0] || null,
  };
}
