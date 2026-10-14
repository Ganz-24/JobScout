// JobScout frontend. Plain JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUSES = [
  { id: 'saved', label: 'Saved' },
  { id: 'applied', label: 'Applied' },
  { id: 'interviewing', label: 'Interviewing' },
  { id: 'offer', label: 'Offer' },
  { id: 'rejected', label: 'Rejected' },
];
const SENIORITIES = ['Intern', 'Entry', 'Mid', 'Senior', 'Staff', 'Lead', 'Principal', 'Manager', 'Director', 'Executive'];
const DEFAULT_FILTERS = {
  location: '', workplace: 'any', posted: '0', seniority: [], minSalary: '', hasSalary: false,
  sponsor: false, clearance: false, newOnly: false, exclude: '', excludeCo: '', sort: 'match',
};
const PAGE = 60;

const S = {
  meta: null,
  state: null,
  jobs: [],
  sourceResults: [],
  fetchedAt: null,
  filtered: [],
  selectedId: null,
  showCount: PAGE,
  loading: false,
  text: '',
  sinceVisit: null,
};

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  if (d < 31) return `${d}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}
function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}
const CUR = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };
function money(n, cur = 'USD') {
  const sym = CUR[cur] ?? `${cur} `;
  if (n >= 1000) return `${sym}${Math.round(n / 1000)}k`;
  return `${sym}${Math.round(n)}`;
}
function fmtSalary(sal) {
  if (!sal) return null;
  if (sal.period === 'hour') {
    const lo = sal.min ? `${CUR[sal.currency] ?? ''}${Math.round(sal.min / 2080)}` : '';
    const hi = sal.max ? `${CUR[sal.currency] ?? ''}${Math.round(sal.max / 2080)}` : '';
    return `${[lo, hi].filter(Boolean).join('–')}/hr`;
  }
  return [sal.min, sal.max].filter(Boolean).map((n) => money(n, sal.currency)).join('–');
}
function salaryTop(sal) {
  return sal ? sal.max || sal.min || 0 : 0;
}
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function initials(name = '?') {
  return esc((name.trim()[0] || '?').toUpperCase());
}
function splitList(s) {
  return String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status})`);
  return res.json();
}

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api('/api/state', { method: 'PUT', body: S.state }).catch((e) => toast(`Could not save: ${e.message}`));
  }, 400);
}

const profile = () => S.state.profile;
const filters = () => profile().filters;
const tracker = () => S.state.tracker;

// ---------------------------------------------------------------- matching

function mySkillSet() {
  return new Set(profile().skills.map((s) => s.toLowerCase()));
}

// Score = share of the posting's technical skills you have. Skills named in the
// requirements bullets count double, since those are the must-haves.
function matchInfo(job, mine = mySkillSet()) {
  const tech = (job.skills || []).filter((s) => s.category !== 'Soft Skills');
  const have = tech.filter((s) => mine.has(s.name.toLowerCase()));
  const missing = tech.filter((s) => !mine.has(s.name.toLowerCase()));
  if (!mine.size || !tech.length) return { score: null, rank: -1, have, missing };
  const req = (job.requirements || []).join(' ').toLowerCase();
  const weight = (s) => (req.includes(s.name.toLowerCase()) ? 2 : 1);
  const total = tech.reduce((n, s) => n + weight(s), 0);
  const got = have.reduce((n, s) => n + weight(s), 0);
  const score = Math.round((got / total) * 100);
  // For sorting, trust scores less when only a couple of skills were detected,
  // so "2 of 2" doesn't outrank "9 of 10".
  const rank = score * (0.5 + 0.5 * Math.min(1, tech.length / 6));
  return { score, rank, have, missing };
}

function matchRing(score, large = false) {
  const cls = score == null ? 'none' : score >= 60 ? 'hi' : score >= 30 ? 'mid' : 'lo';
  const label = score == null ? '–' : `${score}%`;
  const title = score == null ? 'Add your skills to see a match score' : `You have ${score}% of the listed skills`;
  return `<div class="match ${cls} ${large ? 'match-lg' : ''}" style="--p:${score ?? 0}" title="${title}"><span>${label}</span></div>`;
}

// ---------------------------------------------------------------- filtering

function applyFilters() {
  const f = filters();
  const hidden = new Set(S.state.hidden);
  const locTerms = splitList(f.location);
  const excl = splitList(f.exclude);
  const exclCo = splitList(f.excludeCo);
  const maxAge = Number(f.posted) * 86400 * 1000;
  const minSal = Number(f.minSalary) || 0;
  const sen = new Set(f.seniority);
  const text = S.text.trim().toLowerCase();
  const mine = mySkillSet();

  const out = [];
  for (const j of S.jobs) {
    if (hidden.has(j.id)) continue;
    if (f.workplace !== 'any' && j.workplace !== f.workplace) continue;
    if (locTerms.length) {
      const loc = (j.location || '').toLowerCase();
      const ok = locTerms.some((t) => loc.includes(t) || (t === 'remote' && j.workplace === 'Remote'));
      if (!ok) continue;
    }
    if (maxAge && j.postedAt && Date.now() - new Date(j.postedAt).getTime() > maxAge) continue;
    if (sen.size && !sen.has(j.seniority || 'Unspecified')) continue;
    if (f.hasSalary && !j.salary) continue;
    if (minSal && j.salary && salaryTop(j.salary) < minSal) continue;
    if (minSal && !j.salary && f.hasSalary) continue;
    if (f.sponsor && j.visa === 'No sponsorship') continue;
    if (f.clearance && j.clearance) continue;
    if (f.newOnly && !j.isNew) continue;
    const title = j.title.toLowerCase();
    if (excl.some((w) => title.includes(w))) continue;
    if (exclCo.some((c) => (j.company || '').toLowerCase().includes(c))) continue;
    if (text) {
      const hay = `${j.title} ${j.company} ${j.location} ${(j.skills || []).map((s) => s.name).join(' ')}`.toLowerCase();
      if (!text.split(/\s+/).every((w) => hay.includes(w))) continue;
    }
    j._match = matchInfo(j, mine);
    out.push(j);
  }

  const byDate = (a, b) => (b.postedAt || '').localeCompare(a.postedAt || '');
  const sorters = {
    match: (a, b) => b._match.rank - a._match.rank || byDate(a, b),
    newest: byDate,
    salary: (a, b) => salaryTop(b.salary) - salaryTop(a.salary) || byDate(a, b),
    company: (a, b) => (a.company || '').localeCompare(b.company || '') || byDate(a, b),
  };
  out.sort(sorters[f.sort] || sorters.match);
  S.filtered = out;
}

function refresh({ resetPage = false } = {}) {
  if (resetPage) S.showCount = PAGE;
  applyFilters();
  renderResults();
  if ($('#tab-insights').classList.contains('active')) renderInsights();
}

// ---------------------------------------------------------------- sidebar

function roleLabel(id) {
  return S.meta.roles.find((r) => r.id === id)?.label || id;
}

function renderRoles() {
  const roles = profile().roles;
  $('#selectedRoles').innerHTML = roles.length
    ? roles.map((r) => `<span class="chip on">${esc(roleLabel(r))}<button class="x" data-remove-role="${esc(r)}" aria-label="Remove ${esc(roleLabel(r))}">×</button></span>`).join('')
    : '<span class="hint">No positions selected — click Edit.</span>';

  const groups = {};
  for (const r of S.meta.roles) (groups[r.group] ||= []).push(r);
  $('#rolePicker').innerHTML = Object.entries(groups).map(([g, list]) => `
    <div class="role-group"><h3>${esc(g)}</h3><div class="chips">
      ${list.map((r) => `<button class="chip ${roles.includes(r.id) ? 'on' : ''}" data-toggle-role="${r.id}">${esc(r.label)}</button>`).join('')}
    </div></div>`).join('');
}

function toggleRole(id) {
  const roles = profile().roles;
  const i = roles.indexOf(id);
  if (i === -1) roles.push(id);
  else roles.splice(i, 1);
  persist();
  renderRoles();
}

function renderSkills() {
  const skills = profile().skills;
  $('#mySkills').innerHTML = skills.length
    ? skills.map((s) => `<span class="chip have">${esc(s)}<button class="x" data-remove-skill="${esc(s)}" aria-label="Remove ${esc(s)}">×</button></span>`).join('')
    : '<span class="hint">No skills yet.</span>';
  $('#skillCount').textContent = skills.length ? `${skills.length}` : '';
}

function addSkill(raw) {
  const name = raw.trim();
  if (!name) return;
  const canonical = S.meta.skills.find((s) => s.name.toLowerCase() === name.toLowerCase())?.name || name;
  if (!profile().skills.some((s) => s.toLowerCase() === canonical.toLowerCase())) {
    profile().skills.push(canonical);
    persist();
  }
  renderSkills();
  refresh();
  if (S.selectedId) renderDetail();
}

function removeSkill(name) {
  profile().skills = profile().skills.filter((s) => s !== name);
  persist();
  renderSkills();
  refresh();
  if (S.selectedId) renderDetail();
}

function renderFilterControls() {
  const f = filters();
  $('#fLocation').value = f.location;
  $$('#fWorkplace button').forEach((b) => b.classList.toggle('on', b.dataset.v === f.workplace));
  $('#fPosted').value = f.posted;
  $('#fSeniority').innerHTML = [...SENIORITIES, 'Unspecified']
    .map((s) => `<button class="chip ${f.seniority.includes(s) ? 'on' : ''}" data-sen="${s}">${s}</button>`).join('');
  $('#fSalary').value = f.minSalary;
  $('#fHasSalary').checked = f.hasSalary;
  $('#fSponsor').checked = f.sponsor;
  $('#fClearance').checked = f.clearance;
  $('#fNewOnly').checked = f.newOnly;
  $('#fExclude').value = f.exclude;
  $('#fExcludeCo').value = f.excludeCo;
  $('#sortBy').value = f.sort;
}

// ---------------------------------------------------------------- search

async function search({ force = false } = {}) {
  if (S.loading) return;
  if (!profile().roles.length) {
    toast('Pick at least one position first');
    $('#rolePicker').classList.remove('hidden');
    return;
  }
  const sources = profile().sources;
  if (!sources.length) {
    toast('Enable at least one source in Settings');
    return;
  }
  S.loading = true;
  const btn = $('#searchBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span class="btn-label">Searching…</span>';
  $('#resultsTitle').textContent = 'Searching job boards…';
  const started = Date.now();
  const tick = setInterval(() => {
    $('#resultsSub').textContent = `Scanning ${sources.length} sources · ${Math.round((Date.now() - started) / 1000)}s`;
  }, 500);
  $('#jobList').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton"></div>').join('');
  $('#listFooter').innerHTML = '';
  $('#sourceStrip').innerHTML = '';

  try {
    if (force) await api('/api/refresh', { method: 'POST' });
    const res = await api('/api/search', {
      method: 'POST',
      body: { roles: profile().roles, sources, location: filters().location },
    });
    // "New" = first seen after the user's previous visit (nothing is new on the very first visit).
    for (const j of res.jobs) j.isNew = !!S.sinceVisit && j.firstSeen > S.sinceVisit;
    S.jobs = res.jobs;
    S.sourceResults = res.sources;
    S.fetchedAt = res.fetchedAt;
    refresh({ resetPage: true });
    const fresh = res.jobs.filter((j) => j.isNew).length;
    toast(`Found ${res.jobs.length.toLocaleString()} postings${fresh ? ` · ${fresh} new` : ''}`);
  } catch (e) {
    $('#jobList').innerHTML = `<div class="empty"><b>Search failed</b>${esc(e.message)}</div>`;
  } finally {
    clearInterval(tick);
    S.loading = false;
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">Search jobs</span>';
  }
}

// ---------------------------------------------------------------- results list

function renderSourceStrip() {
  $('#sourceStrip').innerHTML = S.sourceResults.map((s) => {
    if (s.error) return `<span class="src-badge err" title="${esc(s.error)}">${esc(s.name)} · failed</span>`;
    return `<span class="src-badge ${s.warning ? 'warn' : ''}" title="${esc(s.warning || `${(s.ms / 1000).toFixed(1)}s`)}">${esc(s.name)} <b>${s.count}</b></span>`;
  }).join('');
}

function logoHtml(job) {
  const src = job.companyLogo && safeUrl(job.companyLogo);
  return `<div class="logo">${src ? `<img src="${esc(src)}" alt="" loading="lazy" data-fallback="${initials(job.company)}" />` : initials(job.company)}</div>`;
}

function cardHtml(job) {
  const t = tracker()[job.id];
  const sal = fmtSalary(job.salary);
  const m = job._match || matchInfo(job);
  const haveSet = new Set(m.have.map((s) => s.name));
  const topSkills = [...m.have, ...m.missing].slice(0, 7);
  return `
  <article class="job-card ${job.id === S.selectedId ? 'active' : ''} ${t ? `status-${t.status}` : ''}" data-id="${esc(job.id)}" tabindex="0">
    ${logoHtml(job)}
    <div class="job-main">
      <div class="job-title">${esc(job.title)}</div>
      <div class="job-company">${esc(job.company || 'Unknown company')}</div>
      <div class="job-meta">
        ${job.location ? `<span>📍 ${esc(job.location.length > 60 ? `${job.location.slice(0, 60)}…` : job.location)}</span>` : ''}
        ${sal ? `<span class="sal">${esc(sal)}</span>` : ''}
        ${job.postedAt ? `<span>${timeAgo(job.postedAt)}</span>` : ''}
        <span>${esc(job.sourceName)}${job.alsoOn?.length ? ` +${job.alsoOn.length}` : ''}</span>
      </div>
      ${topSkills.length ? `<div class="job-skills">${topSkills.map((s) => `<span class="chip ${haveSet.has(s.name) ? 'have' : ''}">${esc(s.name)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="job-side">
      ${matchRing(m.score)}
      <div class="row gap">
        ${job.isNew ? '<span class="badge new">New</span>' : ''}
        ${job.workplace ? `<span class="badge wp">${esc(job.workplace)}</span>` : ''}
        ${t ? `<span class="badge status">${esc(STATUSES.find((s) => s.id === t.status)?.label)}</span>` : ''}
      </div>
      <div class="card-actions">
        <button data-act="save" class="${t ? 'on' : ''}" title="${t ? 'In tracker' : 'Save to tracker (s)'}" aria-label="Save">${t ? '★' : '☆'}</button>
        <button data-act="hide" title="Hide (x)" aria-label="Hide">✕</button>
      </div>
    </div>
  </article>`;
}

function renderResults() {
  renderSourceStrip();
  const total = S.jobs.length;
  const shown = S.filtered.length;
  if (!total) {
    $('#resultsTitle').textContent = S.fetchedAt ? 'No postings found' : 'Find your next role';
    $('#resultsSub').innerHTML = S.fetchedAt
      ? 'Try adding more positions or enabling more sources.'
      : 'Pick positions on the left and hit <b>Search jobs</b>.';
    $('#jobList').innerHTML = '';
    $('#listFooter').innerHTML = '';
    return;
  }
  $('#resultsTitle').textContent = `${shown.toLocaleString()} matching postings`;
  const newCount = S.filtered.filter((j) => j.isNew).length;
  $('#resultsSub').textContent = `${total.toLocaleString()} found across ${S.sourceResults.filter((s) => s.count).length} sources` +
    `${newCount ? ` · ${newCount} new` : ''} · updated ${timeAgo(S.fetchedAt)}`;

  if (!shown) {
    $('#jobList').innerHTML = '<div class="empty"><b>Nothing matches your filters</b>Loosen a filter or reset them.</div>';
    $('#listFooter').innerHTML = '';
    return;
  }
  $('#jobList').innerHTML = S.filtered.slice(0, S.showCount).map(cardHtml).join('');
  $('#listFooter').innerHTML = shown > S.showCount
    ? `<button class="btn" id="showMore">Show more (${(shown - S.showCount).toLocaleString()} remaining)</button>`
    : `<span>That's everything · ${shown.toLocaleString()} postings</span>`;
}

function updateCard(id) {
  const el = $(`.job-card[data-id="${CSS.escape(id)}"]`);
  const job = S.jobs.find((j) => j.id === id);
  if (el && job) el.outerHTML = cardHtml(job);
}

// ---------------------------------------------------------------- detail

function findJob(id) {
  return S.jobs.find((j) => j.id === id) || tracker()[id]?.job || null;
}

function selectJob(id, { scroll = false } = {}) {
  const prev = S.selectedId;
  S.selectedId = id;
  if (prev) $(`.job-card[data-id="${CSS.escape(prev)}"]`)?.classList.remove('active');
  const el = $(`.job-card[data-id="${CSS.escape(id)}"]`);
  el?.classList.add('active');
  if (scroll) el?.scrollIntoView({ block: 'nearest' });
  renderDetail();
  $('#detail').classList.add('open');
  $('#detail').scrollTop = 0;
}

function fact(label, value, cls = '') {
  return value ? `<div class="fact"><dt>${label}</dt><dd class="${cls}">${value}</dd></div>` : '';
}

function renderDetail() {
  const job = findJob(S.selectedId);
  const el = $('#detail');
  if (!job) {
    el.innerHTML = '<div class="empty-detail"><div class="empty-icon">⌕</div><p>Select a job to see the details, required skills and how well you match.</p></div>';
    return;
  }
  const t = tracker()[job.id];
  const m = matchInfo(job);
  const haveSet = new Set(m.have.map((s) => s.name));
  const byCat = {};
  for (const s of job.skills || []) (byCat[s.category] ||= []).push(s);
  const exp = job.experience
    ? `${job.experience.min}${job.experience.max ? `–${job.experience.max}` : '+'} years`
    : null;
  const yrs = Number(profile().years);
  let expCls = '';
  if (exp && profile().years !== '' && profile().years != null && Number.isFinite(yrs)) {
    expCls = yrs >= job.experience.min ? 'good' : yrs + 2 >= job.experience.min ? 'warn' : 'bad';
  }
  const applyUrl = safeUrl(job.applyUrl) || safeUrl(job.url);
  const postUrl = safeUrl(job.url);
  const company = encodeURIComponent(job.company || '');
  const descLong = (job.description || '').length > 1500;

  el.innerHTML = `
  <div class="detail-inner">
    <button class="btn small back-btn" data-act="close-detail">← Back to results</button>
    <div class="detail-head">
      ${logoHtml(job)}
      <div>
        <div class="detail-title">${esc(job.title)}</div>
        <div class="detail-company">${esc(job.company || 'Unknown company')} ${job.location ? `· ${esc(job.location)}` : ''}</div>
      </div>
      ${matchRing(m.score, true)}
    </div>

    <div class="detail-actions">
      ${applyUrl ? `<a class="btn primary" href="${esc(applyUrl)}" target="_blank" rel="noopener noreferrer" data-act="apply-link">Apply ↗</a>` : ''}
      ${postUrl && postUrl !== applyUrl ? `<a class="btn" href="${esc(postUrl)}" target="_blank" rel="noopener noreferrer">View posting ↗</a>` : ''}
      <select data-act="status" aria-label="Tracker status">
        <option value="">${t ? 'Remove from tracker' : '☆ Save to tracker…'}</option>
        ${STATUSES.map((s) => `<option value="${s.id}" ${t?.status === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
      </select>
      <button class="btn" data-act="hide">Hide</button>
    </div>

    ${job.isNew ? '<div class="callout">🆕 New since your last search.</div>' : ''}

    <dl class="facts">
      ${fact('Salary', esc(fmtSalary(job.salary) || ''), 'good')}
      ${fact('Workplace', esc(job.workplace || ''))}
      ${fact('Seniority', esc(job.seniority || ''))}
      ${fact('Experience', esc(exp || ''), expCls)}
      ${fact('Education', esc(job.degree || ''))}
      ${fact('Type', esc(job.employmentType || ''))}
      ${fact('Posted', job.postedAt ? `${fmtDate(job.postedAt)} <span class="muted small">(${timeAgo(job.postedAt)})</span>` : '')}
      ${fact('Visa', esc(job.visa || ''), job.visa === 'No sponsorship' ? 'bad' : '')}
      ${job.clearance ? fact('Clearance', 'Required', 'warn') : ''}
      ${fact('Source', esc(job.sourceName || ''))}
    </dl>
    ${job.alsoOn?.length ? `<p class="also-on">Also listed on: ${job.alsoOn.map((a) => safeUrl(a.url) ? `<a href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${esc(a.sourceName)}</a>` : esc(a.sourceName)).join(', ')}</p>` : ''}

    <div class="section">
      <h2>Skills mentioned
        <span class="legend"><span class="chip have">you have</span><span class="chip missing">to learn</span></span>
      </h2>
      ${Object.keys(byCat).length ? Object.entries(byCat).map(([cat, list]) => `
        <div class="skill-cat"><h3>${esc(cat)}</h3><div class="chips">
          ${list.map((s) => haveSet.has(s.name)
            ? `<span class="chip have">✓ ${esc(s.name)}</span>`
            : `<button class="chip missing" data-add-skill="${esc(s.name)}" title="Click if you have this skill">${esc(s.name)}</button>`).join('')}
        </div></div>`).join('') : '<p class="hint">No specific skills detected in this posting.</p>'}
      ${m.score == null && profile().skills.length === 0 ? '<p class="hint">Tip: click a skill you have to add it to your profile and get match scores.</p>' : ''}
    </div>

    ${job.requirements?.length ? `
    <div class="section">
      <h2>Key requirements</h2>
      <ul class="req-list">${job.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </div>` : ''}

    ${job.benefits?.length ? `
    <div class="section">
      <h2>Benefits mentioned</h2>
      <div class="chips">${job.benefits.map((b) => `<span class="chip">${esc(b)}</span>`).join('')}</div>
    </div>` : ''}

    <div class="section">
      <h2>Your notes</h2>
      <textarea class="notes" data-act="notes" placeholder="Recruiter name, referral, follow-up date…">${esc(t?.notes || '')}</textarea>
      ${t ? `<p class="hint">Saved ${fmtDate(t.savedAt)}${t.appliedAt ? ` · Applied ${fmtDate(t.appliedAt)}` : ''}</p>` : '<p class="hint">Typing a note saves this job to your tracker.</p>'}
    </div>

    <div class="section">
      <h2>Research</h2>
      <div class="row gap wrap">
        <a class="btn small" target="_blank" rel="noopener noreferrer" href="https://www.glassdoor.com/Search/results.htm?keyword=${company}">Glassdoor reviews ↗</a>
        <a class="btn small" target="_blank" rel="noopener noreferrer" href="https://www.linkedin.com/search/results/companies/?keywords=${company}">LinkedIn ↗</a>
        <a class="btn small" target="_blank" rel="noopener noreferrer" href="https://www.levels.fyi/companies/${encodeURIComponent((job.company || '').toLowerCase().replace(/\s+/g, '-'))}/salaries">Levels.fyi pay ↗</a>
        <button class="btn small" data-act="copy">Copy summary</button>
      </div>
    </div>

    <div class="section">
      <h2>Full description</h2>
      ${job.descriptionTruncated ? '<p class="hint">This source only provides a snippet — open the posting for the full text.</p>' : ''}
      <div class="description ${descLong ? 'collapsed' : ''}" id="descText">${esc(job.description || 'No description provided.')}</div>
      ${descLong ? '<button class="link-btn" data-act="expand">Show full description</button>' : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- tracker actions

function snapshot(job) {
  const { _match, ...rest } = job;
  return { ...rest, description: (rest.description || '').slice(0, 12000) };
}

function setStatus(id, status) {
  const job = findJob(id);
  if (!job) return;
  const now = new Date().toISOString();
  if (!status) {
    delete tracker()[id];
  } else {
    const prev = tracker()[id];
    tracker()[id] = {
      ...(prev || { savedAt: now, notes: '' }),
      status,
      updatedAt: now,
      appliedAt: prev?.appliedAt || (['applied', 'interviewing', 'offer'].includes(status) ? now : null),
      job: snapshot(job),
    };
  }
  persist();
  updateCard(id);
  renderTrackerCount();
  if (S.selectedId === id) renderDetail();
  if ($('#tab-tracker').classList.contains('active')) renderTracker();
}

function toggleSave(id) {
  if (tracker()[id]) {
    setStatus(id, null);
    toast('Removed from tracker');
  } else {
    setStatus(id, 'saved');
    toast('Saved to tracker');
  }
}

function hideJob(id) {
  if (!S.state.hidden.includes(id)) S.state.hidden.push(id);
  persist();
  const idx = S.filtered.findIndex((j) => j.id === id);
  const next = S.filtered[idx + 1] || S.filtered[idx - 1];
  refresh();
  $('#hiddenCount').textContent = S.state.hidden.length;
  if (S.selectedId === id) {
    if (next) selectJob(next.id, { scroll: true });
    else { S.selectedId = null; renderDetail(); }
  }
  toast('Job hidden — undo in Settings');
}

function renderTrackerCount() {
  $('#trackerCount').textContent = Object.keys(tracker()).length;
}

function renderTracker() {
  const q = $('#trackerSearch').value.trim().toLowerCase();
  const entries = Object.entries(tracker())
    .map(([id, t]) => ({ id, ...t }))
    .filter((t) => !q || `${t.job.title} ${t.job.company} ${t.notes}`.toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  const all = Object.values(tracker());
  const applied = all.filter((t) => t.appliedAt).length;
  const progressed = all.filter((t) => ['interviewing', 'offer'].includes(t.status)).length;
  const weekAgo = Date.now() - 7 * 86400 * 1000;
  const thisWeek = all.filter((t) => t.appliedAt && new Date(t.appliedAt).getTime() > weekAgo).length;
  $('#trackerStats').innerHTML = `
    <div class="stat"><div class="label">Tracked</div><div class="value">${all.length}</div></div>
    <div class="stat"><div class="label">Applied</div><div class="value">${applied}</div><div class="sub">${thisWeek} in the last 7 days</div></div>
    <div class="stat"><div class="label">Interviewing / offer</div><div class="value">${progressed}</div>
      <div class="sub">${applied ? `${Math.round((progressed / applied) * 100)}% response rate` : 'Apply to start tracking'}</div></div>
    <div class="stat"><div class="label">Offers</div><div class="value">${all.filter((t) => t.status === 'offer').length}</div></div>`;

  $('#board').innerHTML = STATUSES.map((st) => {
    const items = entries.filter((t) => t.status === st.id);
    return `<div class="column" data-status="${st.id}">
      <div class="column-head"><span>${st.label}</span><span class="pill">${items.length}</span></div>
      ${items.map((t) => {
        const url = safeUrl(t.job.applyUrl) || safeUrl(t.job.url);
        return `<div class="t-card" draggable="true" data-id="${esc(t.id)}">
          <div class="job-title">${esc(t.job.title)}</div>
          <div class="job-company">${esc(t.job.company || '')}</div>
          <div class="t-date">${t.appliedAt ? `Applied ${fmtDate(t.appliedAt)}` : `Saved ${fmtDate(t.savedAt)}`}${t.job.salary ? ` · ${esc(fmtSalary(t.job.salary))}` : ''}</div>
          ${t.notes ? `<div class="notes-preview">${esc(t.notes)}</div>` : ''}
          <div class="t-card-actions">
            <select data-t-status="${esc(t.id)}" aria-label="Status">
              ${STATUSES.map((s) => `<option value="${s.id}" ${s.id === t.status ? 'selected' : ''}>${s.label}</option>`).join('')}
              <option value="">Remove</option>
            </select>
            <button class="link-btn" data-t-open="${esc(t.id)}">Details</button>
            ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}
          </div>
        </div>`;
      }).join('') || '<p class="hint center">Drop jobs here</p>'}
    </div>`;
  }).join('');
}

function exportCsv() {
  const rows = [['Status', 'Title', 'Company', 'Location', 'Salary', 'Saved', 'Applied', 'URL', 'Notes']];
  for (const t of Object.values(tracker())) {
    rows.push([
      t.status, t.job.title, t.job.company, t.job.location, fmtSalary(t.job.salary) || '',
      t.savedAt?.slice(0, 10) || '', t.appliedAt?.slice(0, 10) || '', t.job.applyUrl || t.job.url || '', t.notes || '',
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  download(`applications-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- insights

function barList(rows, total, { mine } = {}) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return `<div class="bars">${rows.map((r) => {
    const pct = Math.round((r.count / total) * 100);
    const tip = `${r.name}: ${r.count.toLocaleString()} of ${total.toLocaleString()} postings (${pct}%)${mine?.has(r.name.toLowerCase()) ? ' · you have this' : ''}`;
    return `<div class="bar-row" data-tip="${esc(tip)}">
      <span class="bar-label">${esc(r.name)}${mine?.has(r.name.toLowerCase()) ? '<span class="tick" aria-label="you have this">✓</span>' : ''}</span>
      <span class="bar-track"><span class="bar-fill" style="display:block;width:${(r.count / max) * 100}%"></span></span>
      <span class="bar-value">${pct}% · ${r.count.toLocaleString()}</span>
    </div>`;
  }).join('')}</div>`;
}

function renderInsights() {
  const jobs = S.filtered;
  const el = $('#insights');
  if (!jobs.length) {
    el.innerHTML = '<div class="empty"><b>No data yet</b>Run a search on the Discover tab first.</div>';
    return;
  }
  $('#insightsSub').textContent = `Based on ${jobs.length.toLocaleString()} postings matching your current filters.`;
  const mine = mySkillSet();
  const counts = new Map();
  const softCounts = new Map();
  for (const j of jobs) {
    for (const s of j.skills || []) {
      const target = s.category === 'Soft Skills' ? softCounts : counts;
      target.set(s.name, (target.get(s.name) || 0) + 1);
    }
  }
  const top = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const learn = top.filter((s) => !mine.has(s.name.toLowerCase())).slice(0, 8);

  const withSal = jobs.filter((j) => j.salary && j.salary.currency === 'USD');
  const mids = withSal.map((j) => ((j.salary.min || j.salary.max) + (j.salary.max || j.salary.min)) / 2);
  const remote = jobs.filter((j) => j.workplace === 'Remote').length;
  const scores = jobs.map((j) => j._match?.score).filter((s) => s != null);

  const bySen = {};
  for (const j of withSal) (bySen[j.seniority || 'Unspecified'] ||= []).push(j.salary);
  const senRows = [...SENIORITIES, 'Unspecified'].filter((s) => bySen[s]?.length).map((s) => {
    const list = bySen[s];
    return `<tr><td>${s}</td><td class="num">${list.length}</td>
      <td class="num">${money(median(list.map((x) => x.min || x.max)))}</td>
      <td class="num">${money(median(list.map((x) => x.max || x.min)))}</td></tr>`;
  }).join('');

  const companies = new Map();
  for (const j of jobs) if (j.company) companies.set(j.company, (companies.get(j.company) || 0) + 1);
  const topCompanies = [...companies].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12);

  const expBuckets = { '0–1 yrs': 0, '2–3 yrs': 0, '4–6 yrs': 0, '7+ yrs': 0, 'Not stated': 0 };
  for (const j of jobs) {
    const y = j.experience?.min;
    if (y == null) expBuckets['Not stated']++;
    else if (y <= 1) expBuckets['0–1 yrs']++;
    else if (y <= 3) expBuckets['2–3 yrs']++;
    else if (y <= 6) expBuckets['4–6 yrs']++;
    else expBuckets['7+ yrs']++;
  }

  el.innerHTML = `
  <div class="stat-row">
    <div class="stat"><div class="label">Postings</div><div class="value">${jobs.length.toLocaleString()}</div><div class="sub">${new Set(jobs.map((j) => j.company)).size.toLocaleString()} companies</div></div>
    <div class="stat"><div class="label">Remote</div><div class="value">${Math.round((remote / jobs.length) * 100)}%</div><div class="sub">${remote.toLocaleString()} postings</div></div>
    <div class="stat"><div class="label">Median salary (USD)</div><div class="value">${mids.length ? money(median(mids)) : '—'}</div><div class="sub">${withSal.length.toLocaleString()} list pay (${Math.round((withSal.length / jobs.length) * 100)}%)</div></div>
    <div class="stat"><div class="label">Your average match</div><div class="value">${scores.length ? `${Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)}%` : '—'}</div><div class="sub">${scores.length ? `${scores.filter((s) => s >= 60).length} strong matches (60%+)` : 'Add skills to see this'}</div></div>
  </div>
  <div class="insight-grid">
    <section class="panel">
      <h2>Most requested skills</h2>
      <p class="hint">Share of postings that mention each skill. ✓ = on your profile.</p>
      ${barList(top.slice(0, 20), jobs.length, { mine })}
    </section>
    <section class="panel">
      <h2>Skills to learn next</h2>
      <p class="hint">The most in-demand skills you haven't listed. Click "I have this" if you already do.</p>
      <div class="learn-list">${learn.map((s) => `
        <div class="learn-item">
          <div><b>${esc(s.name)}</b><div class="why">In ${s.count.toLocaleString()} postings (${Math.round((s.count / jobs.length) * 100)}%)</div></div>
          <button class="btn small" data-add-skill="${esc(s.name)}">I have this</button>
        </div>`).join('') || '<p class="hint">You have every top skill. Nice.</p>'}
      </div>
      <h2 style="margin-top:18px">Soft skills mentioned</h2>
      ${barList([...softCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6), jobs.length)}
    </section>
    <section class="panel">
      <h2>Salary by seniority (USD, annualized)</h2>
      ${senRows ? `<table class="data"><thead><tr><th>Level</th><th class="num">Postings</th><th class="num">Median low</th><th class="num">Median high</th></tr></thead><tbody>${senRows}</tbody></table>` : '<p class="hint">No salary data in these results.</p>'}
      <h2 style="margin-top:18px">Experience required</h2>
      ${barList(Object.entries(expBuckets).map(([name, count]) => ({ name, count })), jobs.length)}
    </section>
    <section class="panel">
      <h2>Top hiring companies</h2>
      ${barList(topCompanies, jobs.length)}
    </section>
  </div>`;
}

// tooltip for bar rows
const tip = document.createElement('div');
tip.className = 'tooltip hidden';
document.body.appendChild(tip);
document.addEventListener('mousemove', (e) => {
  const row = e.target.closest?.('[data-tip]');
  if (!row) { tip.classList.add('hidden'); return; }
  tip.textContent = row.dataset.tip;
  tip.classList.remove('hidden');
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

// ---------------------------------------------------------------- settings

function renderSettings() {
  const enabled = new Set(profile().sources);
  $('#sourceList').innerHTML = S.meta.sources.map((s) => `
    <label class="source-row">
      <input type="checkbox" data-source="${s.id}" ${enabled.has(s.id) ? 'checked' : ''} ${s.configured ? '' : 'disabled'} />
      <div><div class="name">${esc(s.name)}</div><div class="kind">${esc(s.kind)}</div></div>
      <span class="status-dot ${s.configured ? 'ok' : 'off'}">${s.configured ? 'ready' : 'needs key'}</span>
    </label>`).join('');
  const co = S.state.companies;
  $('#coGreenhouse').value = (co.greenhouse || []).join(', ');
  $('#coLever').value = (co.lever || []).join(', ');
  $('#coAshby').value = (co.ashby || []).join(', ');
  $('#hiddenCount').textContent = S.state.hidden.length;
}

// ---------------------------------------------------------------- tabs, theme, events

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'tracker') renderTracker();
  if (name === 'insights') renderInsights();
  if (name === 'settings') renderSettings();
}

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function bindEvents() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('theme', next); } catch { /* storage unavailable */ }
  });

  const help = $('#helpModal');
  $('#helpBtn').addEventListener('click', () => help.classList.remove('hidden'));
  help.addEventListener('click', (e) => { if (e.target === help || e.target.matches('[data-close]')) help.classList.add('hidden'); });

  // roles
  $('#editRolesBtn').addEventListener('click', () => {
    const p = $('#rolePicker');
    p.classList.toggle('hidden');
    $('#editRolesBtn').textContent = p.classList.contains('hidden') ? 'Edit' : 'Done';
  });
  $('#filters').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle-role]');
    if (t) toggleRole(t.dataset.toggleRole);
    const r = e.target.closest('[data-remove-role]');
    if (r) toggleRole(r.dataset.removeRole);
    const sk = e.target.closest('[data-remove-skill]');
    if (sk) removeSkill(sk.dataset.removeSkill);
    const sen = e.target.closest('[data-sen]');
    if (sen) {
      const list = filters().seniority;
      const i = list.indexOf(sen.dataset.sen);
      if (i === -1) list.push(sen.dataset.sen); else list.splice(i, 1);
      sen.classList.toggle('on', i === -1);
      persist();
      refresh({ resetPage: true });
    }
    const wp = e.target.closest('#fWorkplace button');
    if (wp) {
      filters().workplace = wp.dataset.v;
      $$('#fWorkplace button').forEach((b) => b.classList.toggle('on', b === wp));
      persist();
      refresh({ resetPage: true });
    }
  });
  $('#customRoleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#customRoleInput').value.trim();
    if (v && !profile().roles.includes(v)) {
      profile().roles.push(v);
      persist();
      renderRoles();
    }
    $('#customRoleInput').value = '';
  });
  $('#skillForm').addEventListener('submit', (e) => {
    e.preventDefault();
    for (const s of $('#skillInput').value.split(',')) addSkill(s);
    $('#skillInput').value = '';
  });
  $('#fYears').addEventListener('input', (e) => {
    profile().years = e.target.value;
    persist();
    if (S.selectedId) renderDetail();
  });

  $('#searchBtn').addEventListener('click', () => search());
  $('#forceRefreshBtn').addEventListener('click', () => search({ force: true }));

  // filters
  const bindInput = (sel, key, transform = (el) => el.value) => {
    $(sel).addEventListener(sel.startsWith('#f') && $(sel).type === 'checkbox' ? 'change' : 'input', (e) => {
      filters()[key] = transform(e.target);
      persist();
      refresh({ resetPage: true });
    });
  };
  bindInput('#fLocation', 'location');
  bindInput('#fPosted', 'posted');
  bindInput('#fSalary', 'minSalary');
  bindInput('#fHasSalary', 'hasSalary', (el) => el.checked);
  bindInput('#fSponsor', 'sponsor', (el) => el.checked);
  bindInput('#fClearance', 'clearance', (el) => el.checked);
  bindInput('#fNewOnly', 'newOnly', (el) => el.checked);
  bindInput('#fExclude', 'exclude');
  bindInput('#fExcludeCo', 'excludeCo');
  bindInput('#sortBy', 'sort');
  $('#resetFilters').addEventListener('click', () => {
    profile().filters = { ...structuredClone(DEFAULT_FILTERS), sort: filters().sort };
    persist();
    renderFilterControls();
    refresh({ resetPage: true });
  });
  $('#fText').addEventListener('input', (e) => {
    S.text = e.target.value;
    refresh({ resetPage: true });
  });

  // results
  $('#jobList').addEventListener('click', (e) => {
    const card = e.target.closest('.job-card');
    if (!card) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') return toggleSave(card.dataset.id);
    if (act === 'hide') return hideJob(card.dataset.id);
    selectJob(card.dataset.id);
  });
  $('#jobList').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.job-card')) selectJob(e.target.dataset.id);
  });
  $('#listFooter').addEventListener('click', (e) => {
    if (e.target.id === 'showMore') {
      S.showCount += PAGE;
      renderResults();
    }
  });
  // Broken company logos fall back to the company's initial.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.fallback) img.parentElement.textContent = img.dataset.fallback;
  }, true);

  // detail
  const detail = $('#detail');
  detail.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add-skill]');
    if (add) return addSkill(add.dataset.addSkill);
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = S.selectedId;
    if (act === 'hide') hideJob(id);
    if (act === 'close-detail') detail.classList.remove('open');
    if (act === 'expand') {
      $('#descText').classList.remove('collapsed');
      e.target.remove();
    }
    if (act === 'apply-link' && !tracker()[id]) {
      // Opening the apply link is a strong signal — offer to log it.
      setTimeout(() => {
        if (confirm('Did you apply? Mark this job as Applied in your tracker.')) setStatus(id, 'applied');
      }, 600);
    }
    if (act === 'copy') {
      const job = findJob(id);
      const text = [
        `${job.title} — ${job.company}`, job.location, fmtSalary(job.salary), job.applyUrl || job.url,
        job.skills?.length ? `Skills: ${job.skills.map((s) => s.name).join(', ')}` : '',
      ].filter(Boolean).join('\n');
      await navigator.clipboard.writeText(text).then(() => toast('Copied'), () => toast('Clipboard unavailable'));
    }
  });
  detail.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'status') {
      setStatus(S.selectedId, e.target.value || null);
      toast(e.target.value ? `Marked as ${e.target.selectedOptions[0].text}` : 'Removed from tracker');
    }
  });
  detail.addEventListener('input', (e) => {
    if (e.target.dataset.act !== 'notes') return;
    const id = S.selectedId;
    if (!tracker()[id]) {
      setStatus(id, 'saved');
      // setStatus re-rendered the panel; put the cursor back in the notes box.
      const box = $('#detail [data-act="notes"]');
      box.value = e.target.value;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
    tracker()[id].notes = e.target.value;
    tracker()[id].updatedAt = new Date().toISOString();
    persist();
  });

  // tracker
  $('#trackerSearch').addEventListener('input', renderTracker);
  $('#exportCsv').addEventListener('click', exportCsv);
  const board = $('#board');
  board.addEventListener('change', (e) => {
    const id = e.target.dataset.tStatus;
    if (id) setStatus(id, e.target.value || null);
  });
  board.addEventListener('click', (e) => {
    const id = e.target.dataset.tOpen;
    if (!id) return;
    showTab('discover');
    selectJob(id, { scroll: true });
  });
  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.t-card');
    if (card) e.dataTransfer.setData('text/plain', card.dataset.id);
  });
  board.addEventListener('dragover', (e) => {
    const col = e.target.closest('.column');
    if (!col) return;
    e.preventDefault();
    $$('.column', board).forEach((c) => c.classList.toggle('drag-over', c === col));
  });
  board.addEventListener('dragleave', (e) => {
    if (!board.contains(e.relatedTarget)) $$('.column', board).forEach((c) => c.classList.remove('drag-over'));
  });
  board.addEventListener('drop', (e) => {
    const col = e.target.closest('.column');
    const id = e.dataTransfer.getData('text/plain');
    $$('.column', board).forEach((c) => c.classList.remove('drag-over'));
    if (col && id) {
      e.preventDefault();
      setStatus(id, col.dataset.status);
    }
  });

  // insights
  $('#insights').addEventListener('click', (e) => {
    const add = e.target.closest('[data-add-skill]');
    if (add) {
      addSkill(add.dataset.addSkill);
      renderInsights();
      toast(`Added ${add.dataset.addSkill} to your skills`);
    }
  });

  // settings
  $('#sourceList').addEventListener('change', (e) => {
    const id = e.target.dataset.source;
    if (!id) return;
    const set = new Set(profile().sources);
    if (e.target.checked) set.add(id); else set.delete(id);
    profile().sources = [...set];
    persist();
  });
  const parseTokens = (s) => [...new Set(s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  $('#saveCompanies').addEventListener('click', () => {
    S.state.companies = {
      greenhouse: parseTokens($('#coGreenhouse').value),
      lever: parseTokens($('#coLever').value),
      ashby: parseTokens($('#coAshby').value),
    };
    persist();
    toast('Companies saved — run a search to include them');
  });
  $('#resetCompanies').addEventListener('click', () => {
    S.state.companies = structuredClone(S.meta.defaultCompanies);
    persist();
    renderSettings();
    toast('Company lists reset');
  });
  $('#exportState').addEventListener('click', () => {
    download(`jobscout-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(S.state, null, 2), 'application/json');
  });
  $('#importState').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.profile || !data.tracker) throw new Error('Not a JobScout backup');
      S.state = data;
      normalizeState();
      persist();
      renderAll();
      toast('Backup restored');
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
    e.target.value = '';
  });
  $('#clearHidden').addEventListener('click', () => {
    S.state.hidden = [];
    persist();
    renderSettings();
    refresh();
    toast('All hidden jobs restored');
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      help.classList.add('hidden');
      $('#detail').classList.remove('open');
      if (document.activeElement?.blur) document.activeElement.blur();
      return;
    }
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!$('#tab-discover').classList.contains('active')) return;
    const idx = S.filtered.findIndex((j) => j.id === S.selectedId);
    const go = (i) => {
      const job = S.filtered[i];
      if (!job) return;
      if (i >= S.showCount) { S.showCount = i + PAGE; renderResults(); }
      selectJob(job.id, { scroll: true });
    };
    if (e.key === 'j') go(idx + 1);
    else if (e.key === 'k') go(Math.max(0, idx - 1));
    else if (e.key === '/') { e.preventDefault(); $('#fText').focus(); }
    else if (e.key === '?') help.classList.remove('hidden');
    else if (!S.selectedId) return;
    else if (e.key === 's') toggleSave(S.selectedId);
    else if (e.key === 'a') { setStatus(S.selectedId, 'applied'); toast('Marked as applied'); }
    else if (e.key === 'x') hideJob(S.selectedId);
    else if (e.key === 'o') {
      const job = findJob(S.selectedId);
      const url = safeUrl(job?.applyUrl) || safeUrl(job?.url);
      if (url) window.open(url, '_blank', 'noopener');
    }
  });
}

// ---------------------------------------------------------------- boot

function normalizeState() {
  const st = S.state;
  st.profile ||= {};
  st.profile.roles ||= [];
  st.profile.skills ||= [];
  st.profile.sources ||= S.meta.sources.filter((s) => !s.needsKey).map((s) => s.id);
  st.profile.filters = { ...structuredClone(DEFAULT_FILTERS), ...(st.profile.filters || {}) };
  st.profile.years ??= '';
  st.tracker ||= {};
  st.hidden ||= [];
  st.companies ||= structuredClone(S.meta.defaultCompanies);
}

function renderAll() {
  renderRoles();
  renderSkills();
  renderFilterControls();
  $('#fYears').value = profile().years;
  renderTrackerCount();
  renderResults();
  renderDetail();
}

async function init() {
  try {
    const saved = localStorage.getItem('theme');
    if (saved) applyTheme(saved);
  } catch { /* storage unavailable */ }

  try {
    [S.meta, S.state] = await Promise.all([api('/api/meta'), api('/api/state')]);
  } catch (e) {
    document.body.innerHTML = `<div class="empty"><b>Can't reach the JobScout server</b>Start it with <code>npm start</code> and reload. (${esc(e.message)})</div>`;
    return;
  }
  normalizeState();
  // Postings first seen after this timestamp get a "New" badge during this visit.
  S.sinceVisit = S.state.lastVisit || null;
  S.state.lastVisit = new Date().toISOString();
  persist();
  $('#skillCatalog').innerHTML = S.meta.skills.map((s) => `<option value="${esc(s.name)}">${esc(s.category)}</option>`).join('');
  bindEvents();
  renderAll();
  if (profile().roles.length) search();
}

init();
