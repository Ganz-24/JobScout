// Job sources. Every source exposes:
//   { id, name, kind, homepage, needsKey?, configured(), search(ctx) }
// where ctx = { roles: ResolvedRole[], location, companies } and search() returns
// raw postings: { id, title, company, location, url, postedAt, description, ... }.
// Each posting is tagged with the roles whose title matcher it satisfies.
//
// We only use public JSON APIs / feeds that the boards provide for this purpose.
// Sites like LinkedIn and Indeed prohibit scraping, so they are reached through the
// optional JSearch / Adzuna APIs instead (free keys, see .env.example).

import { fetchJson, cached, cachedPersistent, htmlToText, toISO, mapLimit } from './util.js';
import { normalizeSalary } from './enrich.js';
import { ATS_SOURCES, ATS_DEFAULTS } from './ats.js';
import { STARTUP_SOURCES } from './startups.js';

const FEED_TTL = 30 * 60 * 1000; // whole-board feeds
const SEARCH_TTL = 20 * 60 * 1000; // keyword searches
const PAID_TTL = 6 * 60 * 60 * 1000; // quota-limited APIs, cached on disk

const env = (k) => (process.env[k] || '').trim();

export function tagRoles(jobs, roles) {
  const out = [];
  for (const job of jobs) {
    if (!job.title) continue;
    const matched = [...new Set(roles.filter((r) => r.test(job.title)).map((r) => r.id))];
    if (matched.length) out.push({ ...job, roles: matched });
  }
  return out;
}

// mapLimit returns Error objects for failed requests. Keep the successes, but if
// every request failed, surface the error instead of silently reporting 0 jobs.
export function okResults(results) {
  const ok = results.filter(Array.isArray);
  if (!ok.length && results.length) throw results.find((r) => r instanceof Error) || new Error('No results');
  return ok;
}

export function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v); } catch { /* fall through */ }
  }
  return v ? [v] : [];
}

// ---------------------------------------------------------------- Remote boards

const remotive = {
  id: 'remotive',
  name: 'Remotive',
  kind: 'Remote job board',
  homepage: 'https://remotive.com',
  configured: () => true,
  async search({ roles }) {
    const lists = await mapLimit(roles, 3, (role) =>
      cached(`remotive:${role.query}`, SEARCH_TTL, async () => {
        const data = await fetchJson(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(role.query)}&limit=200`);
        return data.jobs || [];
      }),
    );
    const jobs = okResults(lists).flat().map((j) => ({
      id: `remotive:${j.id}`,
      title: j.title,
      company: (j.company_name || '').trim(),
      companyLogo: j.company_logo_url || j.company_logo,
      location: j.candidate_required_location || 'Remote',
      workplace: 'Remote',
      url: j.url,
      postedAt: toISO(j.publication_date),
      employmentType: (j.job_type || '').replace(/_/g, ' '),
      salaryText: j.salary || null,
      tags: arr(j.tags),
      description: htmlToText(j.description),
    }));
    return tagRoles(jobs, roles);
  },
};

const remoteok = {
  id: 'remoteok',
  name: 'Remote OK',
  kind: 'Remote job board',
  homepage: 'https://remoteok.com',
  configured: () => true,
  async search({ roles }) {
    const data = await cached('remoteok:feed', FEED_TTL, () => fetchJson('https://remoteok.com/api'));
    const jobs = data.filter((j) => j && j.id && j.position).map((j) => ({
      id: `remoteok:${j.id}`,
      title: j.position,
      company: j.company,
      companyLogo: j.company_logo || j.logo || null,
      location: j.location || 'Remote',
      workplace: 'Remote',
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug}`,
      applyUrl: j.apply_url || null,
      postedAt: toISO(j.date || j.epoch),
      salary: normalizeSalary(j.salary_min || null, j.salary_max || null, 'year', 'USD', null),
      tags: j.tags || [],
      description: htmlToText(j.description),
    }));
    return tagRoles(jobs, roles);
  },
};

const jobicy = {
  id: 'jobicy',
  name: 'Jobicy',
  kind: 'Remote job board',
  homepage: 'https://jobicy.com',
  configured: () => true,
  async search({ roles }) {
    const data = await cached('jobicy:feed', FEED_TTL, () => fetchJson('https://jobicy.com/api/v2/remote-jobs?count=100'));
    const jobs = (data.jobs || []).map((j) => ({
      id: `jobicy:${j.id}`,
      title: decodeTitle(j.jobTitle),
      company: j.companyName,
      companyLogo: j.companyLogo,
      location: j.jobGeo ? `Remote (${j.jobGeo})` : 'Remote',
      workplace: 'Remote',
      url: j.url,
      postedAt: toISO(j.pubDate),
      employmentType: arr(j.jobType).join(', '),
      seniority: j.jobLevel && j.jobLevel !== 'Any' ? j.jobLevel : null,
      salary: normalizeSalary(j.salaryMin ?? j.annualSalaryMin ?? null, j.salaryMax ?? j.annualSalaryMax ?? null,
        periodFrom(j.salaryPeriod), j.salaryCurrency || 'USD', null),
      tags: arr(j.jobIndustry),
      description: htmlToText(j.jobDescription),
    }));
    return tagRoles(jobs, roles);
  },
};

const himalayas = {
  id: 'himalayas',
  name: 'Himalayas',
  kind: 'Remote job board',
  homepage: 'https://himalayas.app',
  configured: () => true,
  async search({ roles }) {
    const pages = [1, 2, 3];
    const lists = await mapLimit(roles.flatMap((r) => pages.map((p) => [r, p])), 4, ([role, page]) =>
      cached(`himalayas:${role.query}:${page}`, SEARCH_TTL, async () => {
        const data = await fetchJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(role.query)}&page=${page}`);
        return data.jobs || [];
      }),
    );
    const jobs = okResults(lists).flat().map((j) => ({
      id: `himalayas:${j.guid}`,
      title: j.title,
      company: j.companyName,
      companyLogo: j.companyLogo,
      location: arr(j.locationRestrictions).length ? `Remote (${arr(j.locationRestrictions).join(', ')})` : 'Remote (Worldwide)',
      workplace: 'Remote',
      url: j.applicationLink || j.guid,
      postedAt: toISO(j.pubDate),
      employmentType: j.employmentType,
      seniority: arr(j.seniority)[0] || null,
      salary: normalizeSalary(j.minSalary, j.maxSalary, periodFrom(j.salaryPeriod), j.currency || 'USD', null),
      tags: arr(j.categories).map((c) => c.replace(/-/g, ' ')).slice(0, 8),
      description: htmlToText(j.description),
    }));
    return tagRoles(jobs, roles);
  },
};

const workingnomads = {
  id: 'workingnomads',
  name: 'Working Nomads',
  kind: 'Remote job board',
  homepage: 'https://www.workingnomads.com',
  configured: () => true,
  async search({ roles }) {
    const data = await cached('workingnomads:feed', FEED_TTL, () => fetchJson('https://www.workingnomads.com/api/exposed_jobs/'));
    const jobs = (data || []).map((j) => ({
      id: `workingnomads:${j.url}`,
      title: j.title,
      company: j.company_name,
      location: j.location ? `Remote (${j.location})` : 'Remote',
      workplace: 'Remote',
      url: j.url,
      postedAt: toISO(j.pub_date),
      tags: (j.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      description: htmlToText(j.description),
    }));
    return tagRoles(jobs, roles);
  },
};

// ---------------------------------------------------------------- General boards

const arbeitnow = {
  id: 'arbeitnow',
  name: 'Arbeitnow',
  kind: 'Job board (Europe / Germany)',
  homepage: 'https://www.arbeitnow.com',
  configured: () => true,
  async search({ roles }) {
    const pages = await mapLimit([1, 2, 3], 3, (p) =>
      cached(`arbeitnow:${p}`, FEED_TTL, async () => (await fetchJson(`https://www.arbeitnow.com/api/job-board-api?page=${p}`)).data || []),
    );
    const jobs = okResults(pages).flat().map((j) => ({
      id: `arbeitnow:${j.slug}`,
      title: j.title,
      company: j.company_name,
      location: j.remote ? `${j.location} (Remote)` : j.location,
      workplace: j.remote ? 'Remote' : null,
      url: j.url,
      postedAt: toISO(j.created_at),
      employmentType: (j.job_types || []).join(', '),
      tags: j.tags || [],
      description: htmlToText(j.description),
    }));
    return tagRoles(jobs, roles);
  },
};

const themuse = {
  id: 'themuse',
  name: 'The Muse',
  kind: 'Job board (US-heavy)',
  homepage: 'https://www.themuse.com',
  configured: () => true,
  async search({ roles }) {
    const categories = [...new Set(roles.flatMap((r) => r.muse || []))];
    const pages = [0, 1, 2, 3, 4];
    const lists = await mapLimit(categories.flatMap((c) => pages.map((p) => [c, p])), 5, ([cat, page]) =>
      cached(`muse:${cat}:${page}`, FEED_TTL, async () => {
        const data = await fetchJson(`https://www.themuse.com/api/public/jobs?page=${page}&descending=true&category=${encodeURIComponent(cat)}`);
        return data.results || [];
      }),
    );
    const jobs = okResults(lists).flat().map((j) => {
      const locs = (j.locations || []).map((l) => l.name);
      return {
        id: `themuse:${j.id}`,
        title: j.name,
        company: j.company?.name,
        location: locs.join(' · ') || null,
        workplace: locs.some((l) => /flexible|remote/i.test(l)) ? 'Remote' : null,
        url: j.refs?.landing_page,
        postedAt: toISO(j.publication_date),
        seniority: museLevel(j.levels?.[0]?.short_name),
        tags: (j.categories || []).map((c) => c.name),
        description: htmlToText(j.contents),
      };
    });
    return tagRoles(jobs, roles);
  },
};

function museLevel(l) {
  return { internship: 'Intern', entry: 'Entry', mid: 'Mid', senior: 'Senior', management: 'Manager' }[l] || null;
}

const hackernews = {
  id: 'hackernews',
  name: 'HN: Who is Hiring',
  kind: 'Community thread (startups)',
  homepage: 'https://news.ycombinator.com',
  configured: () => true,
  async search({ roles }) {
    const comments = await cached('hn:thread', FEED_TTL, async () => {
      const search = await fetchJson('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10');
      const story = (search.hits || []).find((h) => /who is hiring/i.test(h.title));
      if (!story) return [];
      const thread = await fetchJson(`https://hn.algolia.com/api/v1/items/${story.objectID}`, { timeout: 45000 });
      return (thread.children || []).filter((c) => c.text);
    });
    const out = [];
    for (const c of comments) {
      const text = htmlToText(c.text.replace(/<p>/g, '\n'));
      const header = text.split('\n')[0];
      if (!header.includes('|') || header.length > 300) continue;
      const parts = header.split('|').map((p) => p.trim()).filter(Boolean);
      const titleParts = parts.slice(1).filter((p) => roles.some((r) => r.test(p)));
      if (!titleParts.length) continue;
      const matched = roles.filter((r) => titleParts.some((p) => r.test(p))).map((r) => r.id);
      const locationPart = parts.find((p, i) => i > 0 && /remote|onsite|on-site|hybrid|\b[A-Z]{2}\b|,|london|nyc|sf|berlin|anywhere/i.test(p) && !titleParts.includes(p));
      const link = (c.text.match(/href="([^"]+)"/) || [])[1];
      out.push({
        id: `hn:${c.id}`,
        title: titleParts[0].slice(0, 140),
        company: parts[0].replace(/\(.*?\)/g, '').trim().slice(0, 80),
        location: locationPart || null,
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        applyUrl: link ? decodeTitle(link) : null,
        postedAt: toISO(c.created_at),
        description: text,
        roles: matched,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------- Company career pages (ATS)

export const DEFAULT_COMPANIES = {
  greenhouse: [
    'airbnb', 'anthropic', 'stripe', 'figma', 'databricks', 'cloudflare', 'coinbase', 'robinhood', 'reddit',
    'discord', 'dropbox', 'gitlab', 'asana', 'instacart', 'pinterest', 'lyft', 'datadog', 'twilio', 'duolingo',
    'brex', 'affirm', 'roblox', 'elastic', 'okta', 'samsara', 'gusto', 'vercel', 'scaleai', 'toast', 'waymo',
    'spacex', 'twitch', 'zscaler', 'grafanalabs', 'nuro', 'faire', 'chime', 'peloton', 'sofi', 'webflow',
  ],
  lever: ['palantir', 'spotify', 'shieldai', 'zoox', 'wealthfront', 'outreach', 'matchgroup'],
  ashby: [
    'openai', 'notion', 'ramp', 'linear', 'vanta', 'replit', 'cursor', 'supabase', 'posthog', 'modal',
    'perplexity', 'elevenlabs', 'sentry', 'clickhouse', 'snowflake', 'cohere', 'harvey', 'watershed', 'zapier',
  ],
};

// Lever and Ashby don't return the employer's display name, so map the known ones.
const COMPANY_NAMES = {
  openai: 'OpenAI', posthog: 'PostHog', elevenlabs: 'ElevenLabs', clickhouse: 'ClickHouse', scaleai: 'Scale AI',
  grafanalabs: 'Grafana Labs', shieldai: 'Shield AI', matchgroup: 'Match Group', spacex: 'SpaceX', gitlab: 'GitLab',
  doordash: 'DoorDash', sofi: 'SoFi', mongodb: 'MongoDB', hubspot: 'HubSpot',
};

// Company list entries are either a bare token ("stripe") or "Display Name=token".
export function parseEntry(entry) {
  const i = String(entry).indexOf('=');
  if (i === -1) return { token: String(entry).trim(), name: null };
  const name = entry.slice(0, i).trim();
  const token = entry.slice(i + 1).trim();
  if (name) COMPANY_NAMES[token.toLowerCase()] = name;
  return { token, name };
}

export function prettyCompany(token) {
  return COMPANY_NAMES[token.toLowerCase()] || token.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const greenhouse = {
  id: 'greenhouse',
  name: 'Greenhouse career pages',
  kind: 'Company career pages',
  homepage: 'https://www.greenhouse.com',
  configured: () => true,
  async search({ roles, companies }) {
    const tokens = (companies?.greenhouse ?? DEFAULT_COMPANIES.greenhouse).map((e) => parseEntry(e).token);
    const perCompany = await mapLimit(tokens, 8, async (token) => {
      const list = await cached(`gh:list:${token}`, FEED_TTL, () =>
        fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`).then((d) => d.jobs || []));
      const matches = tagRoles(list.map((j) => ({ ...j })), roles).slice(0, 30);
      // Descriptions only come with the per-job endpoint; fetch just the matching ones.
      const detailed = await mapLimit(matches, 6, (j) =>
        cached(`gh:job:${token}:${j.id}`, FEED_TTL, () => fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${j.id}`)));
      return matches.map((j, i) => {
        const d = detailed[i] instanceof Error ? j : detailed[i];
        return {
          id: `greenhouse:${token}:${j.id}`,
          title: j.title,
          company: COMPANY_NAMES[token.toLowerCase()] || d.company_name || j.company_name || prettyCompany(token),
          location: j.location?.name || null,
          url: j.absolute_url,
          postedAt: toISO(j.first_published || j.updated_at),
          tags: (d.departments || []).map((x) => x.name.replace(/^\d+\s*/, '')),
          description: htmlToText(d.content || ''),
          roles: j.roles,
        };
      });
    });
    return collect(perCompany, tokens, 'greenhouse');
  },
};

const lever = {
  id: 'lever',
  name: 'Lever career pages',
  kind: 'Company career pages',
  homepage: 'https://www.lever.co',
  configured: () => true,
  async search({ roles, companies }) {
    const tokens = (companies?.lever ?? DEFAULT_COMPANIES.lever).map((e) => parseEntry(e).token);
    const perCompany = await mapLimit(tokens, 6, async (token) => {
      const list = await cached(`lever:${token}`, FEED_TTL, () => fetchJson(`https://api.lever.co/v0/postings/${token}?mode=json`, { timeout: 40000 }));
      const jobs = (list || []).map((j) => ({
        id: `lever:${token}:${j.id}`,
        title: j.text,
        company: prettyCompany(token),
        location: j.categories?.allLocations?.join(' · ') || j.categories?.location || null,
        workplace: { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' }[j.workplaceType] || null,
        url: j.hostedUrl,
        applyUrl: j.applyUrl,
        postedAt: toISO(j.createdAt),
        employmentType: j.categories?.commitment || null,
        tags: [j.categories?.team, j.categories?.department].filter(Boolean),
        salary: j.salaryRange
          ? normalizeSalary(j.salaryRange.min, j.salaryRange.max, periodFrom(j.salaryRange.interval), j.salaryRange.currency || 'USD', null)
          : null,
        description: [
          j.descriptionPlain,
          ...(j.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`),
          j.additionalPlain,
        ].filter(Boolean).join('\n\n'),
      }));
      return tagRoles(jobs, roles);
    });
    return collect(perCompany, tokens, 'lever');
  },
};

const ashby = {
  id: 'ashby',
  name: 'Ashby career pages',
  kind: 'Company career pages',
  homepage: 'https://www.ashbyhq.com',
  configured: () => true,
  async search({ roles, companies }) {
    const tokens = (companies?.ashby ?? DEFAULT_COMPANIES.ashby).map((e) => parseEntry(e).token);
    const perCompany = await mapLimit(tokens, 6, async (token) => {
      const data = await cached(`ashby:${token}`, FEED_TTL, () =>
        fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`, { timeout: 40000 }));
      const jobs = (data.jobs || []).filter((j) => j.isListed !== false).map((j) => {
        const comp = j.compensation?.compensationTiers?.[0]?.components?.find((c) => c.compensationType === 'Salary');
        return {
          id: `ashby:${token}:${j.id}`,
          title: j.title,
          company: prettyCompany(token),
          location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join(' · '),
          workplace: j.isRemote ? 'Remote' : ({ Remote: 'Remote', Hybrid: 'Hybrid', OnSite: 'On-site' }[j.workplaceType] || null),
          url: j.jobUrl,
          applyUrl: j.applyUrl,
          postedAt: toISO(j.publishedAt),
          employmentType: j.employmentType?.replace(/([a-z])([A-Z])/g, '$1 $2'),
          tags: [j.department, j.team].filter((v, i, a) => v && a.indexOf(v) === i),
          salary: comp
            ? normalizeSalary(comp.minValue, comp.maxValue, periodFrom(comp.interval), comp.currencyCode || 'USD', j.compensation?.scrapeableCompensationSalarySummary || null)
            : null,
          salaryText: j.compensation?.scrapeableCompensationSalarySummary || null,
          description: htmlToText(j.descriptionHtml) || j.descriptionPlain,
        };
      });
      return tagRoles(jobs, roles);
    });
    return collect(perCompany, tokens, 'ashby');
  },
};

// Merge per-company results; a few bad company tokens shouldn't fail the whole source.
export function collect(perCompany, tokens, label) {
  const failed = tokens.filter((_, i) => perCompany[i] instanceof Error);
  if (failed.length === tokens.length && tokens.length) throw perCompany[0];
  const jobs = perCompany.filter(Array.isArray).flat();
  if (failed.length) jobs.warning = `${label}: could not load ${failed.join(', ')}`;
  return jobs;
}

// ---------------------------------------------------------------- Optional keyed APIs

const jsearch = {
  id: 'jsearch',
  name: 'JSearch (LinkedIn, Indeed, Glassdoor, ZipRecruiter…)',
  kind: 'Aggregator API · needs RAPIDAPI_KEY',
  homepage: 'https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch',
  needsKey: true,
  configured: () => !!env('RAPIDAPI_KEY'),
  async search({ roles, location }) {
    // The free plan allows 200 requests/month and each results page (10 jobs) costs one,
    // so fetch JSEARCH_PAGES pages per role (default 1) and cache for 6 hours.
    const pages = Math.min(Math.max(Number(env('JSEARCH_PAGES')) || 1, 1), 5);
    // One request per role (not per query variant) to protect the monthly quota.
    const uniqueRoles = roles.filter((r, i) => roles.findIndex((x) => x.id === r.id) === i);
    // The location box may hold several comma-separated places; JSearch wants one.
    const place = (location || '').split(',')[0].trim();
    const country = env('JSEARCH_COUNTRY') || inferCountry(location);
    const lists = await mapLimit(uniqueRoles, 2, (role) => {
      const query = place ? `${role.query} in ${place}` : role.query;
      return cachedPersistent(`jsearch:${query}:${pages}:${country || ''}`, 6 * 60 * 60 * 1000, async () => {
        const params = new URLSearchParams({ query, num_pages: String(pages), date_posted: 'month' });
        if (country) params.set('country', country);
        try {
          const data = await fetchJson(`https://jsearch.p.rapidapi.com/search-v2?${params}`, {
            headers: { 'X-RapidAPI-Key': env('RAPIDAPI_KEY'), 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' },
            timeout: 60000,
          });
          // search-v2 returns { data: { jobs: [...] } }; the old endpoint returned { data: [...] }.
          return Array.isArray(data.data) ? data.data : data.data?.jobs || [];
        } catch (e) {
          if (/HTTP 429/.test(e.message)) throw new Error('JSearch monthly quota used up (or rate-limited)');
          if (/HTTP 40[13]/.test(e.message)) throw new Error('JSearch rejected the key — check RAPIDAPI_KEY and that you subscribed to JSearch on RapidAPI');
          throw e;
        }
      });
    });
    const jobs = okResults(lists).flat().map((j) => {
      const hl = j.job_highlights || {};
      const extra = Object.entries(hl).map(([k, v]) => `${k}\n${(v || []).map((x) => `• ${x}`).join('\n')}`).join('\n\n');
      return {
        id: `jsearch:${j.job_id}`,
        title: j.job_title,
        company: j.employer_name,
        companyLogo: j.employer_logo,
        location: j.job_location || [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ') || null,
        workplace: j.job_is_remote ? 'Remote' : null,
        url: j.job_apply_link,
        postedAt: toISO(j.job_posted_at_datetime_utc || j.job_posted_at_timestamp),
        employmentType: (j.job_employment_type || '').replace(/_/g, ' '),
        salary: normalizeSalary(j.job_min_salary, j.job_max_salary, periodFrom(j.job_salary_period), 'USD', j.job_salary_string || null),
        publisher: j.job_publisher || null,
        tags: j.job_publisher ? [`via ${j.job_publisher}`] : [],
        description: [j.job_description, extra].filter(Boolean).join('\n\n'),
      };
    });
    return tagRoles(jobs, roles);
  },
};

const adzuna = {
  id: 'adzuna',
  name: 'Adzuna (aggregates Indeed-style listings)',
  kind: 'Aggregator API · needs ADZUNA_APP_ID/KEY',
  homepage: 'https://developer.adzuna.com',
  needsKey: true,
  configured: () => !!(env('ADZUNA_APP_ID') && env('ADZUNA_APP_KEY')),
  async search({ roles, location }) {
    const country = env('ADZUNA_COUNTRY') || inferCountry(location) || 'us';
    const lists = await mapLimit(roles, 3, (role) =>
      cachedPersistent(`adzuna:${country}:${role.query}:${location}`, PAID_TTL, async () => {
        const params = new URLSearchParams({
          app_id: env('ADZUNA_APP_ID'), app_key: env('ADZUNA_APP_KEY'), what: role.query,
          results_per_page: '50', max_days_old: '30', sort_by: 'date',
        });
        if (location && !/remote/i.test(location)) params.set('where', location);
        const data = await fetchJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params}`);
        return data.results || [];
      }),
    );
    const jobs = okResults(lists).flat().map((j) => ({
      id: `adzuna:${j.id}`,
      title: htmlToText(j.title),
      company: j.company?.display_name,
      location: j.location?.display_name || null,
      url: j.redirect_url,
      postedAt: toISO(j.created),
      employmentType: [j.contract_time, j.contract_type].filter(Boolean).join(', ').replace(/_/g, ' '),
      salary: j.salary_is_predicted === '1' ? null : normalizeSalary(j.salary_min, j.salary_max, 'year', 'USD', null),
      tags: j.category?.label ? [j.category.label] : [],
      description: htmlToText(j.description),
      descriptionTruncated: true,
    }));
    return tagRoles(jobs, roles);
  },
};

const usajobs = {
  id: 'usajobs',
  name: 'USAJOBS (US federal)',
  kind: 'Government API · needs USAJOBS_KEY',
  homepage: 'https://developer.usajobs.gov',
  needsKey: true,
  configured: () => !!(env('USAJOBS_KEY') && env('USAJOBS_EMAIL')),
  async search({ roles, location }) {
    const lists = await mapLimit(roles, 3, (role) =>
      cachedPersistent(`usajobs:${role.query}:${location}`, PAID_TTL, async () => {
        const params = new URLSearchParams({ Keyword: role.query, ResultsPerPage: '100', DatePosted: '30' });
        if (location && !/remote/i.test(location)) params.set('LocationName', location);
        const data = await fetchJson(`https://data.usajobs.gov/api/search?${params}`, {
          headers: { Host: 'data.usajobs.gov', 'User-Agent': env('USAJOBS_EMAIL'), 'Authorization-Key': env('USAJOBS_KEY') },
        });
        return data.SearchResult?.SearchResultItems || [];
      }),
    );
    const jobs = okResults(lists).flat().map(({ MatchedObjectDescriptor: d }) => {
      const pay = d.PositionRemuneration?.[0];
      const details = d.UserArea?.Details || {};
      return {
        id: `usajobs:${d.PositionID}`,
        title: d.PositionTitle,
        company: d.OrganizationName,
        location: d.PositionLocationDisplay,
        workplace: details.TeleworkEligible ? 'Hybrid' : null,
        url: d.PositionURI,
        applyUrl: d.ApplyURI?.[0],
        postedAt: toISO(d.PublicationStartDate),
        employmentType: d.PositionSchedule?.[0]?.Name,
        salary: pay ? normalizeSalary(Number(pay.MinimumRange), Number(pay.MaximumRange), pay.RateIntervalCode === 'PH' ? 'hour' : 'year', 'USD', null) : null,
        description: [
          details.JobSummary,
          details.MajorDuties?.length ? `Duties\n${details.MajorDuties.map((x) => `• ${x}`).join('\n')}` : '',
          d.QualificationSummary ? `Qualifications\n${d.QualificationSummary}` : '',
        ].filter(Boolean).join('\n\n'),
      };
    });
    return tagRoles(jobs, roles);
  },
};

export function periodFrom(p) {
  const s = String(p || '').toLowerCase();
  if (/hour/.test(s)) return 'hour';
  if (/day|daily/.test(s)) return 'day';
  if (/week/.test(s)) return 'week';
  if (/month/.test(s)) return 'month';
  return 'year';
}

function decodeTitle(s = '') {
  return htmlToText(s);
}

// ---------------------------------------------------------------- Internship & new-grad lists

// Community-maintained lists (SimplifyJobs on GitHub) of internships and new-grad roles,
// updated daily from company career pages. Postings link to the company's own page.
const SIMPLIFY_LISTS = [
  { key: 'intern', seniority: 'Intern', urls: ['Summer2027-Internships', 'Summer2026-Internships'] },
  { key: 'newgrad', seniority: 'Entry', urls: ['New-Grad-Positions'] },
];

async function loadSimplifyList(list) {
  for (const repo of list.urls) {
    try {
      return await fetchJson(`https://raw.githubusercontent.com/SimplifyJobs/${repo}/dev/.github/scripts/listings.json`, { timeout: 60000 });
    } catch { /* try the next repo name */ }
  }
  throw new Error('Could not load SimplifyJobs listings');
}

const simplify = {
  id: 'simplify',
  name: 'Internship & new-grad lists',
  kind: 'SimplifyJobs community lists (thousands of internships and new-grad roles)',
  homepage: 'https://github.com/SimplifyJobs',
  configured: () => true,
  async search({ roles }) {
    const lists = await mapLimit(SIMPLIFY_LISTS, 2, (list) =>
      cached(`simplify:${list.key}`, FEED_TTL, async () => (await loadSimplifyList(list)).filter((x) => x.active && x.is_visible !== false)));
    const jobs = [];
    SIMPLIFY_LISTS.forEach((list, i) => {
      if (!Array.isArray(lists[i])) return;
      for (const x of lists[i]) {
        jobs.push({
          id: `simplify:${x.id}`,
          title: x.title,
          company: x.company_name,
          location: (x.locations || []).join(' · ') || null,
          workplace: (x.locations || []).every((l) => /remote/i.test(l)) && x.locations?.length ? 'Remote' : null,
          url: x.url,
          postedAt: toISO(x.date_posted),
          seniority: list.seniority,
          tags: [x.category, ...(x.terms || []).filter((t) => t !== 'N/A')].filter(Boolean),
          visa: /does not|no sponsorship|citizenship/i.test(x.sponsorship || '') ? 'No sponsorship'
            : /offers sponsorship/i.test(x.sponsorship || '') ? 'Sponsorship mentioned' : null,
          description: '',
          needsDetail: true,
          detailRef: { ats: 'url', url: x.url },
        });
      }
    });
    okResults(lists);
    return tagRoles(jobs, roles);
  },
};

// Infer a country code from the location the user typed (JSearch/Adzuna default to the US).
const CA = /\b(canada|ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|toronto|vancouver|montreal|ottawa|calgary|edmonton|waterloo|markham|vaughan|mississauga|richmond hill|brampton|winnipeg|halifax)\b|,\s*(on|qc|bc|ab|mb|sk|ns)\b/i;
const GB = /\b(united kingdom|england|scotland|wales|london|manchester|edinburgh|uk)\b/i;
export function inferCountry(location = '') {
  if (CA.test(location)) return 'ca';
  if (GB.test(location)) return 'gb';
  return null;
}

export const SOURCES = [
  remotive, remoteok, jobicy, himalayas, workingnomads, arbeitnow, themuse, hackernews, ...STARTUP_SOURCES,
  simplify, greenhouse, lever, ashby, ...ATS_SOURCES, jsearch, adzuna, usajobs,
];

// Company lists for the other career-site systems live in ats.js.
Object.assign(DEFAULT_COMPANIES, ATS_DEFAULTS);
