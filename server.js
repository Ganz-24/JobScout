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
const { ROLE_PRESETS, resolveRole } = await import('./lib/roles.js');
const { enrichJob, SKILL_CATALOG } = await import('./lib/enrich.js');
const { clearCache, normalizeKey } = await import('./lib/util.js');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA, 'state.json');
const SEEN_FILE = path.join(DATA, 'seen.json');
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
function writeJson(file, value) {
  writeChain = writeChain.then(async () => {
    await fs.mkdir(DATA, { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2));
    await fs.rename(tmp, file);
  });
  return writeChain;
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
    keep.postedAt = [keep.postedAt, other.postedAt].filter(Boolean).sort().pop() || null;
    byKey.set(key, keep);
  }
  return [...byKey.values()];
}

async function runSearch({ roles = [], sources = [], location = '' }) {
  const state = await readState();
  const resolved = roles.map(resolveRole);
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
      all.push(enrichJob({ ...j, description, source: r.src.id, sourceName: r.src.name }));
    }
  }
  const jobs = dedupe(all);

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

  return {
    jobs,
    fetchedAt: now,
    sources: results.map((r) => ({
      id: r.src.id, name: r.src.name, count: r.jobs.length, ms: r.ms, error: r.error || null, warning: r.warning || null,
    })),
  };
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

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new Error('Body too large');
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
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
      });
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
    if (url.pathname === '/api/refresh' && req.method === 'POST') {
      clearCache();
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
