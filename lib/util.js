// Shared helpers: HTTP fetching with timeouts, a small TTL cache, and HTML -> text.

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; PersonalJobScraper/1.0)',
  Accept: 'application/json',
};

export async function fetchJson(url, { headers = {}, timeout = 25000 } = {}) {
  const res = await fetch(url, {
    headers: { ...DEFAULT_HEADERS, ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Simple in-memory TTL cache so repeated searches don't hammer the job boards.
const cache = new Map();
export async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
export function clearCache() {
  cache.clear();
}

// Run async tasks with a concurrency limit.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = e instanceof Error ? e : new Error(String(e));
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', euro: '€', pound: '£',
};

export function decodeEntities(str = '') {
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

// Convert job-description HTML into readable plain text, keeping paragraph
// breaks and turning list items into "• " bullets. The frontend renders this
// as text (never as HTML), so nothing from a job board can inject markup.
export function htmlToText(html = '') {
  if (!html) return '';
  let s = String(html);
  // Some APIs (Greenhouse, Arbeitnow) entity-escape some or all of their HTML.
  if (/&lt;\/?[a-z][\s\S]*?&gt;/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|section)>/gi, '\n')
    .replace(/<(h[1-6])[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n•\s*\n/g, '\n')
    .replace(/\n+•/g, '\n•')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

export function toISO(value) {
  if (value == null || value === '') return null;
  let d;
  if (typeof value === 'number') d = new Date(value < 1e12 ? value * 1000 : value);
  else d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeKey(s = '') {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|gmbh|corp|corporation|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
