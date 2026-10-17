// Job Scraper — local server. No dependencies; requires Node 18+.
//   npm start   ->  http://localhost:3000

import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(ROOT, '.env'));

const { SOURCES, DEFAULT_COMPANIES } = await import('./lib/sources.js');
const { ATS_INFO, detectCompany, fetchDetails } = await import('./lib/ats.js');
const { classifyCompanies } = await import('./lib/startups.js');
const { ROLE_PRESETS, resolveRole } = await import('./lib/roles.js');
const { enrichJob, SKILL_CATALOG } = await import('./lib/enrich.js');
const { clearCache, clearPersistentCache, usePersistentCache, normalizeKey, mapLimit } = await import('./lib/util.js');
// Resume tools need the Anthropic SDK (npm install). Load them so the job search
// still works if dependencies haven't been installed yet.
let resumeLib = null;
try {
  resumeLib = await import('./lib/resume.js');
} catch (e) {
  console.warn(`  Resume tools disabled: ${e.message}\n  Run "npm install" to enable them.`);
}

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.JOBSCOUT_DATA_DIR ? path.resolve(process.env.JOBSCOUT_DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const SEEN_FILE = path.join(DATA, 'seen.json');
const RESULTS_FILE = path.join(DATA, 'last-results.json');
usePersistentCache(path.join(DATA, 'api-cache.json'));
const SOURCE_TIMEOUT = 90_000;
const MAX_DESCRIPTION = 20_000;

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

// ---------------------------------------------------------------- persistence

const DEFAULT_STATE = {
  profile: {
    roles: ['software-engineer'],
    skills: [],
    location: '',
    workplace: 'any',
    sources: SOURCES.filter((s) => !s.needsKey).map((s) => s.id),
  },
  companies: DEFAULT_COMPANIES,
  tracker: {},
  hidden: [],
  savedSearches: [],
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

// Serialize writes so concurrent requests can't interleave and corrupt the file.
let writeChain = Promise.resolve();
function writeJson(file, value, { compact = false } = {}) {
  const write = writeChain.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
    await fs.rename(tmp, file);
  });
  // One failed write must not block every write after it.
  writeChain = write.catch(() => {});
  return write;
}

async function readState() {
  const s = await readJson(STATE_FILE, DEFAULT_STATE);
  return {
    ...structuredClone(DEFAULT_STATE),
    ...s,
    profile: { ...DEFAULT_STATE.profile, ...s.profile },
    companies: { ...DEFAULT_COMPANIES, ...s.companies },
  };
}

// ---------------------------------------------------------------- search

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

function dedupe(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const key = `${normalizeKey(job.company || '')}|${normalizeKey(job.title)}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...job, alsoOn: [] });
      continue;
    }
    // Keep the richer posting as primary; remember where else it was listed.
    const [keep, other] = (job.description?.length || 0) > (prev.description?.length || 0) ? [{ ...job, alsoOn: prev.alsoOn }, prev] : [prev, job];
    if (keep.source !== other.source && !keep.alsoOn.some((a) => a.source === other.source)) {
      keep.alsoOn.push({ source: other.source, sourceName: other.sourceName, url: other.url });
    }
    keep.roles = [...new Set([...(keep.roles || []), ...(other.roles || [])])];
    keep.salary = keep.salary || other.salary;
    keep.startup ??= other.startup;
    keep.companyStage ||= other.companyStage;
    keep.companyBlurb ||= other.companyBlurb;
    keep.postedAt = [keep.postedAt, other.postedAt].filter(Boolean).sort().pop() || null;
    byKey.set(key, keep);
  }
  return [...byKey.values()];
}

// When the user only wants internships / entry-level roles, ask keyword-search sites for
// those specifically ("software intern") instead of "software", which mostly returns senior roles.
const LEVEL_SUFFIX = { Intern: 'intern', Entry: 'new grad' };
function levelVariants(resolved, levels = []) {
  const suffixes = levels.length && levels.every((l) => LEVEL_SUFFIX[l]) ? levels.map((l) => LEVEL_SUFFIX[l]) : [];
  if (!suffixes.length) return resolved;
  return resolved.flatMap((r) => suffixes.map((s) => (r.query.toLowerCase().includes(s) ? r : { ...r, query: `${r.query} ${s}` })));
}

async function runSearch({ roles = [], sources = [], location = '', levels = [] }) {
  const state = await readState();
  const resolved = levelVariants(roles.map(resolveRole), levels);
  if (!resolved.length) return { jobs: [], sources: [], fetchedAt: new Date().toISOString() };

  const active = SOURCES.filter((s) => sources.includes(s.id) && s.configured());
  const ctx = { roles: resolved, location, companies: state.companies };

  const results = await Promise.all(active.map(async (src) => {
    const started = Date.now();
    try {
      const jobs = await withTimeout(src.search(ctx), SOURCE_TIMEOUT, src.name);
      return { src, jobs, ms: Date.now() - started, warning: jobs.warning || null };
    } catch (e) {
      console.warn(`[${src.id}] ${e.message}`);
      return { src, jobs: [], ms: Date.now() - started, error: e.message };
    }
  }));

  const all = [];
  for (const r of results) {
    for (const j of r.jobs) {
      const description = (j.description || '').slice(0, MAX_DESCRIPTION);
      // Aggregators (JSearch) say which site the posting came from, e.g. "LinkedIn via JSearch".
      const sourceName = j.publisher ? `${j.publisher} via ${r.src.name.split(' ')[0]}` : r.src.name;
      all.push(enrichJob({ ...j, description, source: r.src.id, sourceName }));
    }
  }
  const jobs = classifyCompanies(dedupe(all));

  // Record when each posting was first seen; the client compares this with the
  // user's previous visit to badge postings as "new".
  const seen = await readJson(SEEN_FILE, {});
  const now = new Date().toISOString();
  for (const j of jobs) {
    seen[j.id] ||= now;
    j.firstSeen = seen[j.id];
  }
  const cutoff = Date.now() - 90 * 86400 * 1000;
  for (const [id, ts] of Object.entries(seen)) if (new Date(ts).getTime() < cutoff) delete seen[id];
  await writeJson(SEEN_FILE, seen);

  const result = {
    jobs,
    fetchedAt: now,
    roles,
    sources: results.map((r) => ({
      id: r.src.id, name: r.src.name, count: r.jobs.length, ms: r.ms, error: r.error || null, warning: r.warning || null,
    })),
  };
  // Keep the latest results on disk so reopening the app shows them without searching again.
  await writeJson(RESULTS_FILE, result, { compact: true });
  return result;
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readBody(req, limitMb = 20) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limitMb * 1024 * 1024) throw new Error('Body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// ---------------------------------------------------------------- snapshots

// A snapshot is a saved copy of a search's results (data/snapshots/<id>.json) that can be
// reopened later without searching again — and still read after postings are taken down.
const SNAP_DIR = path.join(DATA, 'snapshots');
const SNAP_INDEX = path.join(SNAP_DIR, 'index.json');
const MAX_SNAPSHOT_DETAILS = 300;

async function listSnapshots() {
  return readJson(SNAP_INDEX, []);
}

// Fill in full descriptions for postings that were listed without one (Workday etc.).
async function fillDetails(job) {
  const full = await fetchDetails(job);
  const description = (full.description || '').slice(0, MAX_DESCRIPTION);
  return { ...enrichJob({ ...full, description }), source: job.source, sourceName: job.sourceName,
    roles: job.roles, alsoOn: job.alsoOn, firstSeen: job.firstSeen };
}

async function saveSnapshot({ name, jobs = [], sources = [], fetchedAt, roles = [], location = '', detailIds = [] }) {
  const wanted = new Set(detailIds.slice(0, MAX_SNAPSHOT_DETAILS));
  const toFill = jobs.filter((j) => j.needsDetail && wanted.has(j.id));
  const filled = await mapLimit(toFill, 6, fillDetails);
  const byId = new Map(toFill.map((j, i) => [j.id, filled[i] instanceof Error ? j : filled[i]]));
  const finalJobs = jobs.map((j) => {
    const { _match, isNew, ...rest } = byId.get(j.id) || j;
    return rest;
  });
  const meta = {
    id: `s${Date.now().toString(36)}`,
    name: String(name || 'Snapshot').slice(0, 120),
    createdAt: new Date().toISOString(),
    fetchedAt: fetchedAt || null,
    count: finalJobs.length,
    detailsFetched: filled.filter((f) => !(f instanceof Error)).length,
    roles,
    location,
  };
  await writeJson(path.join(SNAP_DIR, `${meta.id}.json`), { meta, jobs: finalJobs, sources }, { compact: true });
  await writeJson(SNAP_INDEX, [meta, ...(await listSnapshots())]);
  return meta;
}

async function deleteSnapshot(id) {
  if (!/^s[a-z0-9]+$/.test(id)) throw new Error('Bad snapshot id');
  await writeJson(SNAP_INDEX, (await listSnapshots()).filter((s) => s.id !== id));
  await fs.rm(path.join(SNAP_DIR, `${id}.json`), { force: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/meta' && req.method === 'GET') {
      return send(res, 200, {
        roles: ROLE_PRESETS.map(({ id, label, group }) => ({ id, label, group })),
        sources: SOURCES.map((s) => ({
          id: s.id, name: s.name, kind: s.kind, homepage: s.homepage, needsKey: !!s.needsKey, configured: s.configured(),
        })),
        skills: SKILL_CATALOG,
        defaultCompanies: DEFAULT_COMPANIES,
        atsInfo: ATS_INFO,
        ai: {
          installed: !!resumeLib,
          configured: !!resumeLib?.aiConfigured(),
          model: resumeLib?.AI_MODEL || null,
        },
      });
    }
    if (url.pathname.startsWith('/api/resume/') && req.method === 'POST') {
      if (!resumeLib) return send(res, 503, { error: 'Resume tools need dependencies — run "npm install" and restart.' });
      const { resume = '', job = {}, tone } = await readBody(req);
      if (!resume.trim()) return send(res, 400, { error: 'Add your resume first.' });
      const action = url.pathname.slice('/api/resume/'.length);
      if (action === 'analyze') return send(res, 200, resumeLib.analyzeResume(resume, job));
      const ai = { suggest: resumeLib.suggestEdits, tailor: resumeLib.tailorResume, 'cover-letter': resumeLib.writeCoverLetter }[action];
      if (!ai) return send(res, 404, { error: 'Not found' });
      if (!resumeLib.aiConfigured()) {
        return send(res, 400, { error: 'AI features need an Anthropic API key. Add ANTHROPIC_API_KEY to .env and restart the server.' });
      }
      try {
        return send(res, 200, await ai(resume, job, tone));
      } catch (e) {
        console.error(`[resume/${action}]`, e);
        return send(res, 502, { error: resumeLib.friendlyAiError(e) });
      }
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return send(res, 200, await readState());
    if (url.pathname === '/api/state' && req.method === 'PUT') {
      const body = await readBody(req);
      const current = await readState();
      const next = { ...current, ...body };
      await writeJson(STATE_FILE, next);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/search' && req.method === 'POST') {
      return send(res, 200, await runSearch(await readBody(req)));
    }
    if (url.pathname === '/api/companies/detect' && req.method === 'POST') {
      const { input } = await readBody(req);
      return send(res, 200, { found: await detectCompany(input) });
    }
    if (url.pathname === '/api/job/details' && req.method === 'POST') {
      // Load the full description for a posting that was listed without one (Workday etc.).
      const { job } = await readBody(req);
      return send(res, 200, { job: await fillDetails(job) });
    }
    if (url.pathname === '/api/snapshots' && req.method === 'GET') return send(res, 200, await listSnapshots());
    if (url.pathname === '/api/snapshots' && req.method === 'POST') {
      return send(res, 200, await saveSnapshot(await readBody(req, 300)));
    }
    const snap = url.pathname.match(/^\/api\/snapshots\/(s[a-z0-9]+)$/);
    if (snap && req.method === 'GET') {
      const data = await readJson(path.join(SNAP_DIR, `${snap[1]}.json`), null);
      return data ? send(res, 200, data) : send(res, 404, { error: 'Snapshot not found' });
    }
    if (snap && req.method === 'DELETE') {
      await deleteSnapshot(snap[1]);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/results/last' && req.method === 'GET') {
      return send(res, 200, await readJson(RESULTS_FILE, { jobs: [], sources: [], fetchedAt: null }));
    }
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      // Free feeds are always re-fetched; quota-limited APIs only when explicitly asked.
      const { includePaid = false } = await readBody(req);
      clearCache();
      if (includePaid) clearPersistentCache();
      return send(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });

    // Static files
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
    try {
      const data = await fs.readFile(file);
      return send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    } catch {
      return send(res, 404, 'Not found', 'text/plain');
    }
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — JobScout may already be running at http://localhost:${PORT}.`);
    console.error(`  Close the other instance, or start on another port:  $env:PORT=3001; npm start  (PowerShell)\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  const keyed = SOURCES.filter((s) => s.needsKey);
  console.log(`\n  Job Scraper running at http://localhost:${PORT}\n`);
  console.log(`  Sources: ${SOURCES.filter((s) => !s.needsKey).length} free` +
    `, ${keyed.filter((s) => s.configured()).length}/${keyed.length} optional API sources configured (see .env.example)\n`);
});
