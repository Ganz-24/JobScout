// Company career sites beyond Greenhouse/Lever/Ashby: the applicant-tracking systems
// most large employers use (Workday, iCIMS/Jibe, SmartRecruiters, Oracle, Workable,
// Recruitee) plus Amazon's and Google's own career sites. Also detects which system
// a company uses from a careers URL or a company name.

import { fetchJson, cached, htmlToText, toISO, mapLimit } from './util.js';
import { tagRoles, okResults, collect, parseEntry, prettyCompany } from './sources.js';
import { ycDetail } from './startups.js';

const LIST_TTL = 30 * 60 * 1000;
const DETAIL_TTL = 6 * 60 * 60 * 1000;
// Fetch full descriptions for this many matches per company during a search; the rest
// load on demand when opened (see fetchDetails), which keeps searches fast.
const DETAILS_PER_COMPANY = 8;

export const ATS_DEFAULTS = {
  workday: [
    'NVIDIA=nvidia.wd5/NVIDIAExternalCareerSite', 'Intel=intel.wd1/External', 'Salesforce=salesforce.wd12/External_Career_Site',
    'Adobe=adobe.wd5/external_experienced', 'Workday=workday.wd5/Workday', 'HP=hp.wd5/ExternalCareerSite',
    'Hewlett Packard Enterprise=hpe.wd5/Jobsathpe', 'Micron=micron.wd1/External', 'Broadcom=broadcom.wd1/External_Career',
    'Capital One=capitalone.wd12/Capital_One', 'Mastercard=mastercard.wd1/CorporateCareers', 'PayPal=paypal.wd1/jobs',
    'Target=target.wd5/targetcareers', 'Disney=disney.wd5/disneycareer', 'Bank of America=ghr.wd1/Lateral-US',
    'Wells Fargo=wf.wd1/WellsFargoJobs', 'Boeing=boeing.wd1/EXTERNAL_CAREERS', 'Northrop Grumman=ngc.wd1/Northrop_Grumman_External_Site',
    'RTX=globalhr.wd5/REC_RTX_Ext_Gateway', 'General Motors=generalmotors.wd5/Careers_GM', '3M=3m.wd1/Search',
    'CrowdStrike=crowdstrike.wd5/crowdstrikecareers', 'Zoom=zoom.wd5/Zoom', 'Nike=nike.wd1/nke', 'Autodesk=autodesk.wd1/Ext',
    'Sony=sonyglobal.wd1/SonyGlobalCareers', 'Motorola Solutions=motorolasolutions.wd5/Careers', 'Analog Devices=analogdevices.wd1/External',
    'Marvell=marvell.wd1/MarvellCareers', 'KLA=kla.wd1/Search', 'Applied Materials=amat.wd1/External', 'Red Hat=redhat.wd5/jobs',
    'Accenture=accenture.wd103/AccentureCareers', 'PwC=pwc.wd3/Global_Experienced_Careers', 'Citi=citi.wd5/2',
    'Morgan Stanley=ms.wd5/External', 'Fidelity=fmr.wd1/targeted', 'T-Mobile=tmobile.wd1/External', 'Pfizer=pfizer.wd1/PfizerCareers',
    'Johnson & Johnson=jj.wd5/JJ', 'Humana=humana.wd5/Humana_External_Career_Site', 'CVS Health=cvshealth.wd1/CVS_Health_Careers',
    'Philips=philips.wd3/jobs-and-careers', 'Caterpillar=cat.wd5/CaterpillarCareers', 'Snap=snapchat.wd1/snap', 'Cisco=cisco.wd5/Cisco_Careers',
    'Warner Bros. Discovery=warnerbros.wd5/global', 'Medtronic=medtronic.wd1/MedtronicCareers', "Lowe's=lowes.wd5/LWS_External_CS",
    'The Home Depot=homedepot.wd5/CareerDepot', 'Chevron=chevron.wd5/jobs', 'Leidos=leidos.wd5/External', 'Cadence=cadence.wd1/External_Careers',
  ],
  jibe: ['AMD=careers.amd.com'],
  smartrecruiters: [
    'ServiceNow=ServiceNow', 'Bosch=BoschGroup', 'Canva=Canva', 'Experian=Experian', 'Wise=Wise', 'Ubisoft=Ubisoft2',
    'NBCUniversal=NBCUniversal3', 'Western Digital=WesternDigital', 'Nagarro=Nagarro1',
  ],
  oracle: ['JPMorgan Chase=jpmc.fa.oraclecloud.com/CX_1001', 'Oracle=eeho.fa.us2.oraclecloud.com/CX_45001', 'Dell=enterpriseplatform.dell.com/careers'],
  workable: ['Hugging Face=huggingface'],
  recruitee: ['bunq=bunq'],
};

// Human-readable info for the Settings page.
export const ATS_INFO = [
  { id: 'greenhouse', label: 'Greenhouse', example: 'boards.greenhouse.io/stripe → stripe' },
  { id: 'lever', label: 'Lever', example: 'jobs.lever.co/palantir → palantir' },
  { id: 'ashby', label: 'Ashby', example: 'jobs.ashbyhq.com/openai → openai' },
  { id: 'workday', label: 'Workday', example: 'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite → nvidia.wd5/NVIDIAExternalCareerSite' },
  { id: 'jibe', label: 'iCIMS / Jibe career sites', example: 'careers.amd.com/careers-home/jobs → careers.amd.com' },
  { id: 'smartrecruiters', label: 'SmartRecruiters', example: 'jobs.smartrecruiters.com/ServiceNow → ServiceNow' },
  { id: 'oracle', label: 'Oracle Recruiting', example: 'jpmc.fa.oraclecloud.com/.../sites/CX_1001 → jpmc.fa.oraclecloud.com/CX_1001' },
  { id: 'workable', label: 'Workable', example: 'apply.workable.com/huggingface → huggingface' },
  { id: 'recruitee', label: 'Recruitee', example: 'bunq.recruitee.com → bunq' },
];

const entriesFor = (companies, key) => (companies?.[key] ?? ATS_DEFAULTS[key]).map(parseEntry);

// Search each company once per role (for ATSs with keyword search), keep title matches,
// and fetch details for the best few.
async function perCompanyRoles(entries, roles, concurrency, fn) {
  const perCompany = await mapLimit(entries, concurrency, async (entry) => {
    const lists = await mapLimit(roles, 3, (role) => fn(entry, role));
    const byId = new Map();
    for (const list of okResults(lists)) for (const j of list) if (!byId.has(j.id)) byId.set(j.id, j);
    return tagRoles([...byId.values()], roles);
  });
  return collect(perCompany, entries.map((e) => e.name || e.token), 'company sites');
}

async function withDetails(jobs, loader) {
  const top = jobs.slice(0, DETAILS_PER_COMPANY);
  const details = await mapLimit(top, 4, (j) => loader(j));
  return jobs.map((j, i) => (i < top.length && !(details[i] instanceof Error) ? { ...j, ...details[i], needsDetail: false } : j));
}

// ---------------------------------------------------------------- Workday

function workdayParts(token) {
  // "nvidia.wd5/Site" -> nvidia.wd5.myworkdayjobs.com ; "wd5.myworkdaysite.com/tenant/Site" also supported
  const parts = token.split('/');
  if (parts[0].includes('myworkdaysite.com')) return { host: parts[0], tenant: parts[1], site: parts[2] };
  return { host: `${parts[0]}.myworkdayjobs.com`, tenant: parts[0].split('.')[0], site: parts[1] };
}

function parseWorkdayPosted(text) {
  const t = String(text || '').toLowerCase();
  const day = 86400000;
  if (t.includes('today')) return new Date().toISOString();
  if (t.includes('yesterday')) return new Date(Date.now() - day).toISOString();
  const m = t.match(/(\d+)\+?\s*days?/);
  return m ? new Date(Date.now() - Number(m[1]) * day).toISOString() : null;
}

async function workdayDetail(job) {
  const { host, tenant, site } = workdayParts(job.detailRef.token);
  const d = await cached(`wd:job:${host}${job.detailRef.path}`, DETAIL_TTL, () =>
    fetchJson(`https://${host}/wday/cxs/${tenant}/${site}${job.detailRef.path}`));
  const info = d.jobPostingInfo || {};
  return {
    description: htmlToText(info.jobDescription),
    postedAt: toISO(info.startDate) || job.postedAt,
    employmentType: info.timeType || null,
    url: info.externalUrl || job.url,
    location: info.location || job.location,
  };
}

const workday = {
  id: 'workday',
  name: 'Workday career sites',
  kind: 'Company career pages (NVIDIA, Intel, Salesforce, Cisco, Capital One…)',
  homepage: 'https://www.workday.com',
  configured: () => true,
  async search({ roles, companies }) {
    const entries = entriesFor(companies, 'workday');
    const jobs = await perCompanyRoles(entries, roles, 8, async ({ token, name }, role) => {
      const { host, tenant, site } = workdayParts(token);
      const data = await cached(`wd:${token}:${role.query}`, LIST_TTL, () =>
        fetchJson(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
          method: 'POST', body: { appliedFacets: {}, limit: 20, offset: 0, searchText: role.query },
        }));
      return (data.jobPostings || []).filter((p) => p.title && p.externalPath).map((p) => ({
        id: `workday:${tenant}:${p.bulletFields?.[0] || p.externalPath}`,
        title: p.title,
        company: name || prettyCompany(tenant),
        location: p.locationsText || null,
        url: `https://${host}/${site}${p.externalPath}`,
        postedAt: parseWorkdayPosted(p.postedOn),
        description: '',
        needsDetail: true,
        detailRef: { ats: 'workday', token, path: p.externalPath },
      }));
    });
    return withCompanyDetails(jobs, workdayDetail);
  },
};

// Fetch details for the first N matches of each company.
async function withCompanyDetails(jobs, loader) {
  const byCompany = new Map();
  for (const j of jobs) (byCompany.get(j.company) || byCompany.set(j.company, []).get(j.company)).push(j);
  const out = await mapLimit([...byCompany.values()], 6, (list) => withDetails(list, loader));
  const merged = out.filter(Array.isArray).flat();
  merged.warning = jobs.warning;
  return merged;
}

// ---------------------------------------------------------------- iCIMS / Jibe (e.g. careers.amd.com)

const jibe = {
  id: 'jibe',
  name: 'iCIMS / Jibe career sites',
  kind: 'Company career pages (AMD…)',
  homepage: 'https://www.icims.com',
  configured: () => true,
  async search({ roles, companies }) {
    const entries = entriesFor(companies, 'jibe');
    return perCompanyRoles(entries, roles, 4, async ({ token, name }, role) => {
      const host = token.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const data = await cached(`jibe:${host}:${role.query}`, LIST_TTL, () =>
        fetchJson(`https://${host}/api/jobs?keywords=${encodeURIComponent(role.query)}&page=1&limit=100&sortBy=posted_date&descending=true`));
      return (data.jobs || []).map(({ data: j }) => ({
        id: `jibe:${host}:${j.req_id || j.slug}`,
        title: j.title,
        company: name || j.hiring_organization || prettyCompany(host.split('.')[1] || host),
        companyLogo: j.hiring_organization_logo || null,
        location: j.full_location || j.location_name || null,
        url: `https://${host}/careers-home/jobs/${j.slug}`,
        applyUrl: j.apply_url || null,
        postedAt: toISO(j.posted_date || j.create_date),
        employmentType: (j.employment_type || '').replace(/_/g, ' ').toLowerCase(),
        tags: (j.categories || []).map((c) => c.name),
        description: htmlToText([j.description, j.responsibilities && `<h3>Responsibilities</h3>${j.responsibilities}`,
          j.qualifications && `<h3>Qualifications</h3>${j.qualifications}`].filter(Boolean).join('\n')),
      }));
    });
  },
};

// ---------------------------------------------------------------- SmartRecruiters

async function smartDetail(job) {
  const d = await cached(`sr:job:${job.detailRef.ref}`, DETAIL_TTL, () => fetchJson(job.detailRef.ref));
  const s = d.jobAd?.sections || {};
  return {
    description: htmlToText(['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
      .map((k) => s[k] && `<h3>${s[k].title || ''}</h3>${s[k].text || ''}`).filter(Boolean).join('\n')),
    url: d.postingUrl || job.url,
    applyUrl: d.applyUrl || null,
  };
}

const smartrecruiters = {
  id: 'smartrecruiters',
  name: 'SmartRecruiters career sites',
  kind: 'Company career pages (ServiceNow, Bosch, Canva…)',
  homepage: 'https://www.smartrecruiters.com',
  configured: () => true,
  async search({ roles, companies }) {
    const entries = entriesFor(companies, 'smartrecruiters');
    const jobs = await perCompanyRoles(entries, roles, 6, async ({ token, name }, role) => {
      const data = await cached(`sr:${token}:${role.query}`, LIST_TTL, () =>
        fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?q=${encodeURIComponent(role.query)}&limit=100`));
      return (data.content || []).map((p) => ({
        id: `smartrecruiters:${token}:${p.id}`,
        title: p.name,
        company: name || p.company?.name || token,
        location: [p.location?.city, p.location?.region, p.location?.country?.toUpperCase()].filter(Boolean).join(', ') || null,
        workplace: p.location?.remote ? 'Remote' : p.location?.hybrid ? 'Hybrid' : null,
        url: `https://jobs.smartrecruiters.com/${token}/${p.id}`,
        postedAt: toISO(p.releasedDate),
        employmentType: p.typeOfEmployment?.label || null,
        seniority: p.experienceLevel?.label || null,
        tags: [p.department?.label, p.function?.label].filter(Boolean),
        description: '',
        needsDetail: true,
        detailRef: { ats: 'smartrecruiters', ref: p.ref },
      }));
    });
    return withCompanyDetails(jobs, smartDetail);
  },
};

// ---------------------------------------------------------------- Oracle Recruiting Cloud

function oracleParts(token) {
  const [host, site] = token.split('/');
  return { host, site };
}

async function oracleDetail(job) {
  const { host, site } = oracleParts(job.detailRef.token);
  const data = await cached(`ora:job:${host}:${job.detailRef.reqId}`, DETAIL_TTL, () => fetchJson(
    `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${job.detailRef.reqId}%22,siteNumber=${site}`));
  const d = data.items?.[0] || {};
  return {
    description: htmlToText([d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr && `<h3>Responsibilities</h3>${d.ExternalResponsibilitiesStr}`,
      d.ExternalQualificationsStr && `<h3>Qualifications</h3>${d.ExternalQualificationsStr}`].filter(Boolean).join('\n')),
  };
}

const oracle = {
  id: 'oracle',
  name: 'Oracle Recruiting career sites',
  kind: 'Company career pages (JPMorgan Chase, Oracle…)',
  homepage: 'https://www.oracle.com/human-capital-management/recruiting/',
  configured: () => true,
  async search({ roles, companies }) {
    const entries = entriesFor(companies, 'oracle');
    const jobs = await perCompanyRoles(entries, roles, 4, async ({ token, name }, role) => {
      const { host, site } = oracleParts(token);
      const data = await cached(`ora:${token}:${role.query}`, LIST_TTL, () => fetchJson(
        `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations` +
        `&finder=findReqs;siteNumber=${site},keyword=%22${encodeURIComponent(role.query)}%22,limit=50,offset=0,sortBy=POSTING_DATES_DESC`));
      return (data.items?.[0]?.requisitionList || []).map((r) => ({
        id: `oracle:${host}:${r.Id}`,
        title: r.Title,
        company: name || prettyCompany(host.split('.')[0]),
        location: [r.PrimaryLocation, ...(r.secondaryLocations || []).map((l) => l.Name)].filter(Boolean).slice(0, 4).join(' · ') || null,
        workplace: /remote/i.test(r.WorkplaceType || '') ? 'Remote' : /hybrid/i.test(r.WorkplaceType || '') ? 'Hybrid' : null,
        url: `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${r.Id}`,
        postedAt: toISO(r.PostedDate),
        employmentType: r.JobSchedule || null,
        tags: [r.JobFamily, r.JobFunction].filter(Boolean),
        description: htmlToText([r.ShortDescriptionStr, r.ExternalResponsibilitiesStr, r.ExternalQualificationsStr].filter(Boolean).join('\n')),
        needsDetail: true,
        detailRef: { ats: 'oracle', token, reqId: r.Id },
      }));
    });
    return withCompanyDetails(jobs, oracleDetail);
  },
};

// ---------------------------------------------------------------- Workable & Recruitee

async function workableDetail(job) {
  const d = await cached(`wk:job:${job.detailRef.account}:${job.detailRef.shortcode}`, DETAIL_TTL, () =>
    fetchJson(`https://apply.workable.com/api/v2/accounts/${job.detailRef.account}/jobs/${job.detailRef.shortcode}`));
  return {
    description: htmlToText([d.description, d.requirements && `<h3>Requirements</h3>${d.requirements}`,
      d.benefits && `<h3>Benefits</h3>${d.benefits}`].filter(Boolean).join('\n')),
  };
}

const workable = {
  id: 'workable',
  name: 'Workable career sites',
  kind: 'Company career pages',
  homepage: 'https://www.workable.com',
  configured: () => true,
  async search({ roles, companies }) {
    const entries = entriesFor(companies, 'workable');
    const jobs = await perCompanyRoles(entries, roles, 6, async ({ token, name }, role) => {
      const data = await cached(`wk:${token}:${role.query}`, LIST_TTL, () =>
        fetchJson(`https://apply.workable.com/api/v3/accounts/${token}/jobs`, { method: 'POST', body: { query: role.query } }));
      return (data.results || []).map((j) => ({
        id: `workable:${token}:${j.shortcode}`,
        title: j.title,
        company: name || prettyCompany(token),
        location: [j.location?.city, j.location?.country].filter(Boolean).join(', ') || null,
        workplace: j.remote ? 'Remote' : ({ hybrid: 'Hybrid', on_site: 'On-site' }[j.workplace] || null),
        url: `https://apply.workable.com/${token}/j/${j.shortcode}/`,
        postedAt: toISO(j.published),
        employmentType: j.type || null,
        description: '',
        needsDetail: true,
        detailRef: { ats: 'workable', account: token, shortcode: j.shortcode },
      }));
    });
    return withCompanyDetails(jobs, workableDetail);
  },
};

const recruitee = {
  id: 'recruitee',
  name: 'Recruitee career sites',
  kind: 'Company career pages',
  homepage: 'https://recruitee.com',
  configured: () => true,
  async search({ roles, companies }) {
    const entries = entriesFor(companies, 'recruitee');
    const perCompany = await mapLimit(entries, 6, async ({ token, name }) => {
      const data = await cached(`rc:${token}`, LIST_TTL, () => fetchJson(`https://${token}.recruitee.com/api/offers/`));
      return tagRoles((data.offers || []).map((o) => ({
        id: `recruitee:${token}:${o.id}`,
        title: o.title,
        company: name || o.company_name || prettyCompany(token),
        location: o.location || [o.city, o.country].filter(Boolean).join(', ') || null,
        workplace: o.remote ? 'Remote' : o.hybrid ? 'Hybrid' : null,
        url: o.careers_url,
        applyUrl: o.careers_apply_url || null,
        postedAt: toISO(o.published_at || o.created_at),
        employmentType: o.employment_type_code || null,
        description: htmlToText(`${o.description || ''}<h3>Requirements</h3>${o.requirements || ''}`),
      })), roles);
    });
    return collect(perCompany, entries.map((e) => e.token), 'recruitee');
  },
};

// ---------------------------------------------------------------- Amazon & Google (own sites)

const amazon = {
  id: 'amazon',
  name: 'Amazon Jobs',
  kind: 'Company career site (Amazon, AWS, Audible, Zoox…)',
  homepage: 'https://www.amazon.jobs',
  configured: () => true,
  async search({ roles }) {
    const lists = await mapLimit(roles, 3, (role) =>
      cached(`amazon:${role.query}`, LIST_TTL, async () =>
        (await fetchJson(`https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(role.query)}&result_limit=100&sort=recent`)).jobs || []));
    const jobs = okResults(lists).flat().map((j) => ({
      id: `amazon:${j.id_icims || j.id}`,
      title: j.title,
      company: j.company_name || 'Amazon',
      location: j.normalized_location || j.location || null,
      url: `https://www.amazon.jobs${j.job_path}`,
      postedAt: toISO(j.posted_date),
      employmentType: j.job_schedule_type || null,
      tags: [j.job_category, j.business_category].filter(Boolean),
      description: htmlToText([j.description, j.basic_qualifications && `<h3>Basic qualifications</h3>${j.basic_qualifications}`,
        j.preferred_qualifications && `<h3>Preferred qualifications</h3>${j.preferred_qualifications}`].filter(Boolean).join('\n')),
    }));
    return tagRoles(jobs, roles);
  },
};

// Google's careers site embeds results as JSON in the page (AF_initDataCallback ds:1).
function parseGooglePage(html) {
  const i = html.indexOf("AF_initDataCallback({key: 'ds:1'");
  if (i === -1) return [];
  const start = html.indexOf('data:', i) + 5;
  const end = html.indexOf(', sideChannel:', start);
  const data = JSON.parse(html.slice(start, end));
  return (data[0] || []).map((j) => {
    const slug = String(j[1] || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
      id: `google:${j[0]}`,
      title: j[1],
      company: j[7] || 'Google',
      location: (j[9] || []).map((l) => l[0]).join(' · ') || null,
      url: `https://www.google.com/about/careers/applications/jobs/results/${j[0]}-${slug}`,
      postedAt: j[12]?.[0] ? toISO(j[12][0]) : null,
      description: htmlToText([j[10]?.[1], j[3]?.[1] && `<h3>Responsibilities</h3>${j[3][1]}`, j[4]?.[1]].filter(Boolean).join('\n')),
    };
  });
}

const google = {
  id: 'google',
  name: 'Google Careers',
  kind: 'Company career site (Google, YouTube, DeepMind…)',
  homepage: 'https://www.google.com/about/careers/applications/',
  configured: () => true,
  async search({ roles }) {
    const lists = await mapLimit(roles.flatMap((r) => [[r, 1], [r, 2]]), 3, ([role, page]) =>
      cached(`google:${role.query}:${page}`, LIST_TTL, async () => {
        const res = await fetch(`https://www.google.com/about/careers/applications/jobs/results?q=${encodeURIComponent(role.query)}&page=${page}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US' },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} from google.com`);
        return parseGooglePage(await res.text());
      }));
    return tagRoles(okResults(lists).flat(), roles);
  },
};

export const ATS_SOURCES = [workday, jibe, smartrecruiters, oracle, workable, recruitee, amazon, google];

// ---------------------------------------------------------------- on-demand details

// Postings from lists like SimplifyJobs only carry a link; read the description from the
// company's job page when it's on a system we understand.
async function urlDetail(job) {
  const url = String(job.detailRef.url || '').split('?')[0];
  if (/ycombinator\.com\/companies\/[^/]+\/jobs\//.test(url)) return ycDetail(url);
  let m = url.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (m) {
    const d = await cached(`gh:job:${m[1]}:${m[2]}`, DETAIL_TTL, () => fetchJson(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`));
    return { description: htmlToText(d.content || '') };
  }
  m = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/);
  if (m) {
    const d = await cached(`lever:job:${m[2]}`, DETAIL_TTL, () => fetchJson(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`));
    return {
      description: [d.descriptionPlain, ...(d.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`), d.additionalPlain].filter(Boolean).join('\n\n'),
      employmentType: d.categories?.commitment || job.employmentType,
    };
  }
  m = url.match(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)(\/job\/.+)$/);
  if (m) return workdayDetail({ ...job, detailRef: { token: `${m[1]}.${m[2]}/${m[3]}`, path: m[4] } });
  m = url.match(/apply\.workable\.com\/([^/]+)\/j\/([A-Z0-9]+)/i);
  if (m) return workableDetail({ ...job, detailRef: { account: m[1], shortcode: m[2] } });
  m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([0-9a-f-]{36})/);
  if (m) {
    const board = await cached(`ashby:${m[1]}`, LIST_TTL, () => fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`, { timeout: 40000 }));
    const j = (board.jobs || []).find((x) => x.id === m[2]);
    if (j) return { description: htmlToText(j.descriptionHtml) || j.descriptionPlain };
  }
  throw new Error('Description not available from this site');
}

const DETAIL_LOADERS = { workday: workdayDetail, smartrecruiters: smartDetail, oracle: oracleDetail, workable: workableDetail, url: urlDetail };

export async function fetchDetails(job) {
  const loader = DETAIL_LOADERS[job.detailRef?.ats];
  if (!loader) return job;
  try {
    return { ...job, ...(await loader(job)), needsDetail: false };
  } catch {
    // Unknown or unreachable job page: stop retrying and point the user at the posting.
    return { ...job, needsDetail: false, descriptionTruncated: true };
  }
}

// ---------------------------------------------------------------- detection

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'en-US' };

// Recognize an ATS from a URL (or any text containing one).
function matchUrls(text) {
  const found = [];
  const add = (ats, token) => token && !found.some((f) => f.ats === ats && f.token === token) && found.push({ ats, token });
  for (const m of text.matchAll(/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/g)) {
    if (!['wday', 'login'].includes(m[3])) add('workday', `${m[1]}.${m[2]}/${m[3]}`);
  }
  for (const m of text.matchAll(/(wd\d+\.myworkdaysite\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?recruiting\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)/g)) add('workday', `${m[1]}/${m[2]}/${m[3]}`);
  for (const m of text.matchAll(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/gi)) if (m[1] !== 'embed') add('greenhouse', m[1].toLowerCase());
  for (const m of text.matchAll(/jobs\.lever\.co\/([a-z0-9_-]+)/gi)) add('lever', m[1].toLowerCase());
  for (const m of text.matchAll(/jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/g)) add('ashby', m[1]);
  for (const m of text.matchAll(/(?:careers|jobs)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/g)) add('smartrecruiters', m[1]);
  for (const m of text.matchAll(/apply\.workable\.com\/([a-z0-9_-]+)/gi)) if (m[1] !== 'api') add('workable', m[1].toLowerCase());
  for (const m of text.matchAll(/([a-z0-9-]+)\.recruitee\.com/gi)) if (!['www', 'app', 'api'].includes(m[1])) add('recruitee', m[1].toLowerCase());
  // Oracle Recruiting, on oraclecloud.com or a company's own domain (e.g. enterpriseplatform.dell.com).
  for (const m of text.matchAll(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/hcmUI\/CandidateExperience\/[a-z-]+\/sites\/([A-Za-z0-9_]+)/g)) add('oracle', `${m[1]}/${m[2]}`);
  return found;
}

// Check that a candidate actually returns jobs, and get a count.
async function verify({ ats, token }) {
  try {
    if (ats === 'workday') {
      const { host, tenant, site } = workdayParts(token);
      const d = await fetchJson(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, { method: 'POST', body: { appliedFacets: {}, limit: 1, offset: 0, searchText: '' }, timeout: 15000 });
      return d.total ?? null;
    }
    if (ats === 'greenhouse') return (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`, { timeout: 15000 })).jobs?.length ?? null;
    if (ats === 'lever') return (await fetchJson(`https://api.lever.co/v0/postings/${token}?mode=json&limit=200`, { timeout: 15000 })).length;
    if (ats === 'ashby') return (await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`, { timeout: 15000 })).jobs?.length ?? null;
    if (ats === 'smartrecruiters') {
      const n = (await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=1`, { timeout: 15000 })).totalFound;
      return n > 0 ? n : null;
    }
    if (ats === 'workable') return (await fetchJson(`https://apply.workable.com/api/v3/accounts/${token}/jobs`, { method: 'POST', body: { query: '' }, timeout: 15000 })).total ?? null;
    if (ats === 'recruitee') return (await fetchJson(`https://${token}.recruitee.com/api/offers/`, { timeout: 15000 })).offers?.length ?? null;
    if (ats === 'jibe') {
      const d = await fetchJson(`https://${token}/api/jobs?page=1&limit=1`, { timeout: 15000 });
      return typeof d.totalCount === 'number' ? d.totalCount : null;
    }
    if (ats === 'oracle') {
      const { host, site } = oracleParts(token);
      const d = await fetchJson(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=${site},limit=1`, { timeout: 15000 });
      return d.items?.[0]?.TotalJobsCount ?? null;
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: { ...UA, Accept: 'text/html' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
    return { finalUrl: res.url, html: res.ok ? (await res.text()).slice(0, 3_000_000) : '' };
  } catch {
    return { finalUrl: url, html: '' };
  }
}

const WORKDAY_SITE_GUESSES = (slug, Cap) => ['External', 'Careers', 'External_Careers', 'ExternalCareers', 'External_Career_Site',
  'ExternalCareerSite', `${Cap}Careers`, `${Cap}_Careers`, Cap, slug, 'Search', 'jobs'];

// Find where a company posts jobs, from a careers URL or a company name.
export async function detectCompany(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const candidates = [];
  const pushAll = (list) => list.forEach((c) => !candidates.some((x) => x.ats === c.ats && x.token === c.token) && candidates.push(c));
  const isUrl = /^https?:\/\//i.test(raw) || (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(raw) && !/\s/.test(raw));

  if (isUrl) {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    pushAll(matchUrls(url));
    if (!candidates.length) {
      const { finalUrl, html } = await fetchPage(url);
      pushAll(matchUrls(finalUrl));
      pushAll(matchUrls(html.replace(/\\\//g, '/')));
      const host = new URL(finalUrl).host;
      if (!candidates.length) candidates.push({ ats: 'jibe', token: host });
    }
  } else {
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const dashed = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const Cap = raw.replace(/[^A-Za-z0-9]+/g, '');
    for (const t of new Set([slug, dashed])) {
      pushAll([{ ats: 'greenhouse', token: t }, { ats: 'lever', token: t }, { ats: 'ashby', token: t },
        { ats: 'workable', token: t }, { ats: 'recruitee', token: t }]);
    }
    pushAll([{ ats: 'smartrecruiters', token: Cap }, { ats: 'jibe', token: `careers.${slug}.com` }, { ats: 'jibe', token: `jobs.${slug}.com` }]);
    // Scan the company's careers pages for links to its job system.
    const pages = await Promise.all([`https://careers.${slug}.com`, `https://jobs.${slug}.com`, `https://www.${slug}.com/careers`, `https://${slug}.com/careers`].map(fetchPage));
    for (const p of pages) { pushAll(matchUrls(p.finalUrl)); pushAll(matchUrls(p.html.replace(/\\\//g, '/'))); }
    // Workday's site name can't be looked up, so try the common ones.
    for (const wd of ['wd1', 'wd3', 'wd5', 'wd12', 'wd103']) {
      for (const site of WORKDAY_SITE_GUESSES(slug, Cap)) candidates.push({ ats: 'workday', token: `${slug}.${wd}/${site}`, guess: true });
    }
  }

  const counts = await mapLimit(candidates, 10, verify);
  const found = candidates.map((c, i) => ({ ...c, jobs: counts[i] })).filter((c) => typeof c.jobs === 'number' && c.jobs > 0);
  // One Workday guess is enough per tenant.
  const seen = new Set();
  return found.filter((c) => {
    const key = c.ats === 'workday' ? `workday:${c.token.split('/')[0]}` : `${c.ats}:${c.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ ats, token, jobs }) => ({ ats, token, jobs, label: ATS_INFO.find((a) => a.id === ats)?.label || ats }));
}
