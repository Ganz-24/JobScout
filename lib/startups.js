// Startup job sources: Y Combinator's job board and VC portfolio job boards (Getro),
// plus the company-type classification behind the "Startups / Big companies" filter.

import { fetchJson, cached, htmlToText, toISO, mapLimit, decodeEntities, normalizeKey } from './util.js';
import { tagRoles, okResults } from './sources.js';

const TTL = 60 * 60 * 1000;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US' };

const STAGE_LABELS = {
  pre_seed: 'Pre-seed', seed: 'Seed', series_a: 'Series A', series_b: 'Series B', series_c: 'Series C',
  series_d: 'Series D', series_e: 'Series E+', early_stage: 'Early stage', growth: 'Growth stage',
  late_stage: 'Late stage', ipo: 'Public', public: 'Public', acquired: 'Acquired',
};
const EARLY_STAGES = ['pre_seed', 'seed', 'series_a', 'series_b', 'series_c', 'series_d', 'early_stage'];

// ---------------------------------------------------------------- Y Combinator

// YC's pages are server-rendered with their data in a data-page="{json}" attribute.
async function ycPage(path) {
  const res = await fetch(`https://www.ycombinator.com${path}`, { headers: { ...UA, Accept: 'text/html' }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ycombinator.com`);
  const m = (await res.text()).match(/data-page="([^"]+)"/);
  if (!m) throw new Error('Unexpected page format from ycombinator.com');
  return JSON.parse(decodeEntities(m[1])).props;
}

const YC_ROLES = ['software-engineer', 'designer', 'product-manager', 'science', 'operations', 'marketing', 'sales-manager', 'support', 'recruiting-hr'];
// YC ignores ?page=, so each role is read per city to see more than one page of postings.
const YC_LOCATIONS = ['', 'remote', 'san-francisco', 'new-york', 'los-angeles', 'seattle', 'austin', 'chicago', 'india'];

const yc = {
  id: 'ycombinator',
  name: 'Y Combinator startups',
  kind: 'Startup job board (YC-funded companies)',
  homepage: 'https://www.ycombinator.com/jobs',
  configured: () => true,
  async search({ roles }) {
    const pages = YC_ROLES.flatMap((slug) => YC_LOCATIONS.map((loc) => `/jobs/role/${slug}${loc ? `/${loc}` : ''}`));
    const lists = await mapLimit(pages, 6, (path) =>
      cached(`yc:${path}`, TTL, async () => (await ycPage(path)).jobPostings || []));
    const byId = new Map();
    for (const p of okResults(lists).flat()) {
      if (byId.has(p.id)) continue;
      const salary = p.salaryRange ? p.salaryRange : '';
      byId.set(p.id, {
        id: `yc:${p.id}`,
        title: p.title,
        company: p.companyName,
        companyLogo: p.companyLogoUrl || null,
        location: p.location || null,
        workplace: /remote/i.test(p.location || '') && !/,/.test(p.location.replace(/remote.*$/i, '')) ? 'Remote' : null,
        url: `https://www.ycombinator.com${p.url}`,
        postedAt: null,
        employmentType: p.type || null,
        salaryText: salary || null,
        tags: [p.prettyRole, p.roleSpecificType, p.minExperience].filter(Boolean),
        visa: /citizen|no visa|will not sponsor/i.test(p.visa || '') ? 'No sponsorship' : /sponsor/i.test(p.visa || '') ? 'Sponsorship mentioned' : null,
        description: [p.companyOneLiner, salary && `Salary: ${salary}`, p.equityRange && `Equity: ${p.equityRange}`,
          p.minExperience && `Experience: ${p.minExperience}`].filter(Boolean).join('\n'),
        startup: true,
        companyStage: p.companyBatchName ? `YC ${p.companyBatchName}` : 'YC startup',
        companyBlurb: p.companyOneLiner || null,
        needsDetail: true,
        detailRef: { ats: 'url', url: `https://www.ycombinator.com${p.url}` },
      });
    }
    return tagRoles([...byId.values()], roles);
  },
};

// Job page: full description plus company facts (team size, founding year).
export async function ycDetail(url) {
  const path = new URL(url).pathname;
  const props = await cached(`yc:job:${path}`, 6 * TTL, () => ycPage(path));
  const job = props.job || {};
  const c = props.company || {};
  return {
    description: htmlToText([c.one_liner, job.description, c.long_description && `<h3>About ${c.name}</h3>${c.long_description}`]
      .filter(Boolean).join('\n\n')),
    companySize: c.team_size ? `${c.team_size} people` : null,
    companyFounded: c.year_founded || null,
    companyBlurb: c.one_liner || null,
  };
}

// ---------------------------------------------------------------- VC portfolio boards (Getro)

export const VC_NETWORKS = [
  { id: 8672, name: 'Accel' }, { id: 222, name: 'General Catalyst' }, { id: 257, name: 'Khosla Ventures' },
  { id: 2105, name: 'Thrive Capital' }, { id: 1005, name: '8VC' }, { id: 340, name: 'Craft Ventures' },
  { id: 880, name: 'SV Angel' }, { id: 89, name: 'Techstars' }, { id: 166, name: 'Real Ventures' }, { id: 810, name: 'Maveron' },
];

const vcBoards = {
  id: 'vcboards',
  name: 'VC portfolio startups',
  kind: 'Startup jobs from Accel, General Catalyst, Khosla, Thrive, Techstars, Real Ventures… portfolios',
  homepage: 'https://www.getro.com',
  configured: () => true,
  async search({ roles }) {
    const tasks = VC_NETWORKS.flatMap((n) => roles.flatMap((r) => [0, 1, 2].map((page) => [n, r, page])));
    const lists = await mapLimit(tasks, 8, ([net, role, page]) =>
      cached(`getro:${net.id}:${role.query}:${page}`, TTL, async () => {
        const d = await fetchJson(`https://api.getro.com/api/v2/collections/${net.id}/search/jobs`, {
          method: 'POST',
          // Only early/growth-stage companies; portfolio boards also list public giants.
          body: { hitsPerPage: 20, page, query: role.query, filters: { 'organization.stage': EARLY_STAGES } },
        });
        return (d.results?.jobs || []).map((j) => ({ ...j, network: net.name }));
      }));
    const byId = new Map();
    for (const j of okResults(lists).flat()) {
      if (byId.has(j.id)) continue;
      const org = j.organization || {};
      const cents = (v) => (v ? v / 100 : null);
      byId.set(j.id, {
        id: `getro:${j.id}`,
        title: j.title,
        company: org.name,
        companyLogo: org.logo_url || null,
        location: (j.locations || []).join(' · ') || null,
        workplace: { remote: 'Remote', hybrid: 'Hybrid', on_site: 'On-site' }[j.work_mode] || null,
        url: j.url,
        postedAt: toISO(j.created_at),
        salary: j.compensation_amount_min_cents || j.compensation_amount_max_cents
          ? { min: cents(j.compensation_amount_min_cents), max: cents(j.compensation_amount_max_cents), currency: j.compensation_currency || 'USD',
            period: j.compensation_period === 'hourly' ? 'hour' : 'year', text: null }
          : null,
        tags: [j.network && `${j.network} portfolio`, ...(org.industry_tags || []).slice(0, 3)].filter(Boolean),
        description: '',
        startup: true,
        companyStage: STAGE_LABELS[org.stage] || null,
        needsDetail: true,
        detailRef: { ats: 'url', url: j.url },
      });
    }
    return tagRoles([...byId.values()], roles);
  },
};

export const STARTUP_SOURCES = [yc, vcBoards];

// ---------------------------------------------------------------- classification

// Sources whose companies are large employers.
const ESTABLISHED_SOURCES = new Set(['workday', 'oracle', 'amazon', 'google', 'jibe', 'smartrecruiters', 'themuse', 'usajobs']);
// Sources that are (almost) all startups.
const STARTUP_SOURCE_LABELS = { hackernews: 'Startup (HN)' };

// Well-known companies in the default Greenhouse/Lever/Ashby lists.
const ESTABLISHED = new Set(['airbnb', 'stripe', 'figma', 'databricks', 'cloudflare', 'coinbase', 'robinhood', 'reddit', 'discord',
  'dropbox', 'gitlab', 'asana', 'instacart', 'pinterest', 'lyft', 'datadog', 'twilio', 'duolingo', 'affirm', 'roblox', 'elastic',
  'okta', 'samsara', 'gusto', 'toast', 'waymo', 'spacex', 'twitch', 'zscaler', 'chime', 'peloton', 'sofi', 'palantir', 'spotify',
  'snowflake', 'match group', 'zoox', 'openai', 'anthropic', 'scale ai', 'brex', 'outreach', 'nuro']);
const KNOWN_STARTUPS = new Set(['vercel', 'grafana labs', 'faire', 'webflow', 'linear', 'vanta', 'replit', 'cursor', 'supabase',
  'posthog', 'modal', 'perplexity', 'elevenlabs', 'sentry', 'clickhouse', 'cohere', 'harvey', 'watershed', 'zapier', 'shield ai',
  'wealthfront', 'ramp', 'notion', 'hugging face']);

// Tag every posting as startup (true), established (false) or unknown (null). A company
// identified as a startup by any source (YC, a VC board) is tagged on all its postings.
export function classifyCompanies(jobs) {
  const known = new Map();
  for (const j of jobs) {
    if (j.startup === true) {
      const key = normalizeKey(j.company || '');
      const prev = known.get(key);
      if (!prev || (!prev.companyStage && j.companyStage)) known.set(key, { startup: true, companyStage: j.companyStage, companyBlurb: j.companyBlurb });
    }
  }
  for (const j of jobs) {
    const key = normalizeKey(j.company || '');
    if (j.startup === true) continue;
    const k = known.get(key);
    if (k) Object.assign(j, { startup: true, companyStage: j.companyStage || k.companyStage, companyBlurb: j.companyBlurb || k.companyBlurb });
    else if (KNOWN_STARTUPS.has(key)) Object.assign(j, { startup: true, companyStage: j.companyStage || 'VC-backed' });
    else if (ESTABLISHED.has(key) || ESTABLISHED_SOURCES.has(j.source)) j.startup = false;
    else if (STARTUP_SOURCE_LABELS[j.source]) Object.assign(j, { startup: true, companyStage: j.companyStage || STARTUP_SOURCE_LABELS[j.source] });
    else j.startup ??= null;
  }
  return jobs;
}
