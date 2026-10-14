// Extracts structured info from a posting's text: skills, seniority, salary,
// years of experience, degree, visa/clearance notes, requirements and benefits.

// Skill dictionary. Each entry is "Display Name|alias|alias". Aliases are matched
// case-insensitively as whole tokens. Entries starting with "re:" are raw regexes.
const SKILL_DEFS = {
  Languages: [
    'Python', 'JavaScript|js|ecmascript', 'TypeScript', 'Java', 'C++|cpp', 'C#|csharp|c sharp',
    // Single-letter / common-word languages only count when they appear in a list-like context.
    'Golang|golang|re:(?:^|[\\s,(/])Go(?=\\s*[,)/;]|\\s+(?:or|and|\\(golang)\\b|\\.(?=\\s|$)|\\s*\\n|$)', 'Rust', 'Ruby', 'PHP', 'Kotlin', 'Swift', 'Scala',
    'R|re:(?:^|[\\s,(/])R(?=\\s*[,)/;]|\\s+(?:or|and)\\b|\\.(?=\\s|$)|\\s*\\n|$)',
    'C|re:(?:^|[\\s,(/])(?<!Series |Level |Grade |Tier |Plan )C(?=\\s*[,)/;]|\\s+(?:or|and)\\b|\\.(?=\\s|$)|\\s*\\n|$)',
    'SQL', 'Bash|shell scripting|shell', 'PowerShell', 'Perl', 'Elixir', 'Haskell', 'Clojure', 'Dart',
    'Objective-C|objective c', 'MATLAB', 'Solidity', 'Lua', 'Julia', 'Groovy', 'COBOL', 'Fortran', 'Zig',
  ],
  Frontend: [
    'React|react.js|reactjs', 'Next.js|nextjs|next js', 'Vue|vue.js|vuejs', 'Nuxt', 'Angular', 'Svelte|sveltekit',
    'HTML|html5', 'CSS|css3', 'Tailwind|tailwindcss|tailwind css', 'Sass|scss', 'Redux', 'jQuery',
    'Webpack', 'Vite', 'React Native', 'Flutter', 'SwiftUI', 'Jetpack Compose', 'Three.js|threejs', 'D3|d3.js',
    'Storybook', 'Accessibility|a11y|wcag', 'Web Components', 'Remix', 'Astro',
  ],
  Backend: [
    'Node.js|node|nodejs', 'Express.js|express.js|expressjs', 'NestJS', 'Django', 'Flask', 'FastAPI',
    'Spring Boot|spring framework|spring mvc', 'Ruby on Rails|rails', '.NET|dotnet|asp.net|.net core', 'Laravel',
    'GraphQL', 'REST APIs|restful|rest api|rest apis|re:\\bREST\\b',
    'gRPC', 'Microservices|microservice', 'Kafka|apache kafka', 'RabbitMQ', 'Celery', 'WebSockets|websocket',
    'Distributed Systems|distributed systems', 'System Design|system design', 'Event-Driven|event-driven|event driven',
  ],
  'Data & Databases': [
    'PostgreSQL|postgres', 'MySQL', 'MongoDB|mongo', 'Redis', 'Elasticsearch|elastic search|opensearch',
    'DynamoDB', 'Cassandra', 'SQLite', 'Oracle', 'SQL Server|mssql|microsoft sql server', 'Snowflake',
    'BigQuery', 'Redshift', 'Databricks', 'Spark|apache spark|pyspark', 'Hadoop', 'Airflow|apache airflow',
    'dbt', 'Flink', 'ETL|elt', 'Data Modeling|data modelling', 'Data Warehousing|data warehouse',
    'Pandas', 'NumPy', 'Excel|microsoft excel|ms excel|re:\\bExcel\\b', 'Tableau', 'Power BI|powerbi', 'Looker', 'Metabase',
    'Supabase', 'Firebase', 'ClickHouse', 'Kinesis', 'Fivetran',
  ],
  'AI / ML': [
    'Machine Learning|ml', 'Deep Learning', 'PyTorch', 'TensorFlow', 'Keras', 'scikit-learn|sklearn|scikit learn',
    'LLMs|llm|large language models|large language model', 'NLP|natural language processing',
    'Computer Vision', 'Generative AI|genai|gen ai', 'RAG|retrieval augmented generation|retrieval-augmented generation',
    'Hugging Face|huggingface|transformers', 'LangChain', 'OpenAI API|openai', 'MLOps', 'XGBoost',
    'Statistics|statistical', 'A/B Testing|a/b testing|ab testing|experimentation', 'Reinforcement Learning',
    'Vector Databases|vector database|pinecone|pgvector|weaviate', 'Prompt Engineering', 'CUDA', 'Jupyter',
  ],
  'Cloud & DevOps': [
    'AWS|amazon web services', 'GCP|google cloud|google cloud platform', 'Azure|microsoft azure',
    'Docker', 'Kubernetes|k8s', 'Terraform', 'Ansible', 'Helm', 'CI/CD|ci/cd|continuous integration|ci cd',
    'GitHub Actions', 'Jenkins', 'GitLab CI', 'CircleCI', 'Linux|unix', 'Nginx', 'Serverless|aws lambda|lambda',
    'Prometheus', 'Grafana', 'Datadog', 'Observability', 'Infrastructure as Code|iac|infrastructure-as-code',
    'Cloudflare', 'Vercel', 'Heroku', 'Pulumi', 'ArgoCD|argo cd',
    'Networking|tcp/ip|dns|network protocols|bgp|re:\\b[Nn]etworking (protocols|fundamentals|concepts|stack)',
  ],
  'Security': [
    'Penetration Testing|pen testing|pentesting', 'SIEM', 'Splunk', 'IAM|identity and access management',
    'OAuth|oauth2', 'Zero Trust', 'SOC 2|soc2', 'ISO 27001', 'NIST', 'Threat Modeling', 'Vulnerability Management',
    'Incident Response', 'Cryptography|encryption', 'OWASP', 'Burp Suite',
  ],
  'Tools & Practices': [
    'Git', 'GitHub', 'Jira', 'Confluence', 'Agile', 'Scrum', 'Kanban', 'TDD|test-driven development',
    'Unit Testing|unit tests', 'Jest', 'Cypress', 'Playwright', 'Selenium', 'Pytest', 'Postman',
    'Code Review|code reviews', 'Figma', 'Sketch', 'Adobe Creative Suite|photoshop|illustrator|adobe xd',
    'Salesforce', 'HubSpot', 'SAP', 'Workday', 'Zendesk', 'Google Analytics', 'SEO', 'Unity|unity3d|unity engine|re:\\bUnity\\b(?! of)', 'Unreal Engine|unreal',
  ],
  'Soft Skills': [
    'Communication|communication skills|written and verbal', 'Leadership', 'Mentoring|mentorship|mentor',
    'Collaboration|cross-functional|cross functional', 'Problem Solving|problem-solving',
    'Stakeholder Management|stakeholder', 'Project Management', 'Product Management|roadmap',
    'Customer Facing|customer-facing|client-facing', 'Ownership', 'Analytical|analytical skills',
  ],
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-compile one regex per skill.
const SKILLS = [];
for (const [category, entries] of Object.entries(SKILL_DEFS)) {
  for (const entry of entries) {
    // Everything after "|re:" is a single case-sensitive regex (it may itself contain "|").
    const reIdx = entry.indexOf('|re:');
    const regex = reIdx === -1 ? null : entry.slice(reIdx + 4);
    const [name, ...aliases] = (reIdx === -1 ? entry : entry.slice(0, reIdx)).split('|');
    // With a regex, only the explicit aliases are case-insensitive (so "excel" the verb != Excel).
    const terms = regex ? aliases : [name, ...aliases];
    const ci = terms.map((t) => `(?<![a-z0-9+#.])${escapeRe(t.toLowerCase())}(?![a-z0-9+#]|\\.[a-z])`);
    const cs = regex ? [regex] : [];
    SKILLS.push({
      name,
      category,
      ci: ci.length ? new RegExp(ci.join('|'), 'i') : null,
      cs: cs.length ? new RegExp(cs.join('|')) : null,
    });
  }
}

export const SKILL_CATALOG = SKILLS.map(({ name, category }) => ({ name, category }));

export function extractSkills(text) {
  const found = [];
  for (const s of SKILLS) {
    if ((s.ci && s.ci.test(text)) || (s.cs && s.cs.test(text))) found.push({ name: s.name, category: s.category });
  }
  return found;
}

export function detectSeniority(title = '') {
  const t = title.toLowerCase();
  if (/\b(intern|internship|co-?op)\b/.test(t)) return 'Intern';
  if (/\b(vp|vice president|head of|chief|cto|ceo|cfo)\b/.test(t)) return 'Executive';
  if (/\bdirector\b/.test(t)) return 'Director';
  if (/\bmanager\b/.test(t) && /(engineering|people|team)/.test(t)) return 'Manager';
  if (/\bprincipal\b|\bdistinguished\b|\bfellow\b/.test(t)) return 'Principal';
  if (/\bstaff\b/.test(t)) return 'Staff';
  if (/\blead\b/.test(t)) return 'Lead';
  if (/\b(senior|sr\.?|iii|iv)\b/.test(t)) return 'Senior';
  if (/\b(junior|jr\.?|entry[\s-]level|new grad|graduate|associate|early career|i)\b/.test(t)) return 'Entry';
  if (/\b(mid[\s-]level|ii)\b/.test(t)) return 'Mid';
  return null;
}

// Map board-specific labels ("Mid-level", "Entry-Level, Junior", "Senior Level") onto our set.
function normalizeSeniority(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (/intern/.test(s)) return 'Intern';
  if (/entry|junior|graduate/.test(s)) return 'Entry';
  if (/mid/.test(s)) return 'Mid';
  if (/senior/.test(s)) return 'Senior';
  if (/staff/.test(s)) return 'Staff';
  if (/principal/.test(s)) return 'Principal';
  if (/lead/.test(s)) return 'Lead';
  if (/director/.test(s)) return 'Director';
  if (/manag/.test(s)) return 'Manager';
  if (/exec|vp|chief/.test(s)) return 'Executive';
  return null;
}

export function extractExperience(text) {
  const re = /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2})\s*\+?)?\s*(?:years?|yrs?)(?:'|’)?\s*(?:of\s+)?(?:[\w/+#.,-]+\s+){0,5}?(?:experience|exp\b)/gi;
  const found = [];
  let m;
  while ((m = re.exec(text)) && found.length < 6) {
    const min = Number(m[1]);
    const max = m[2] ? Number(m[2]) : null;
    if (min <= 25 && (!max || max <= 30)) found.push({ min, max });
  }
  if (!found.length) return null;
  // The headline requirement is usually the smallest "N+ years" (later ones tend to be specific tools).
  found.sort((a, b) => a.min - b.min);
  const pick = found[0];
  return { min: pick.min, max: pick.max };
}

export function extractDegree(text) {
  const t = text.toLowerCase();
  let level = null;
  if (/\b(ph\.?d|doctorate)\b/.test(t)) level = 'PhD';
  else if (/\b(master'?s|m\.?s\.? (degree|in)|mba|msc)\b/.test(t)) level = "Master's";
  if (/\b(bachelor'?s|b\.?s\.? (degree|in)|b\.?a\.? (degree|in)|bsc|undergraduate degree|4-year degree|college degree|university degree)\b/.test(t)) {
    // If both are mentioned, the lower one is usually the requirement and higher is "preferred".
    level = level ? `Bachelor's (${level} preferred)` : "Bachelor's";
  }
  if (!level) return null;
  const equivalent = /equivalent (practical |work |professional )?experience|or equivalent|degree or (relevant )?experience/.test(t);
  return equivalent ? `${level} or equivalent experience` : level;
}

const CURRENCY = { $: 'USD', '€': 'EUR', '£': 'GBP', 'CA$': 'CAD', 'C$': 'CAD', 'A$': 'AUD', 'US$': 'USD' };

function parseAmount(raw) {
  if (!raw) return null;
  let s = raw.toLowerCase().replace(/\s/g, '');
  // "50.000" is European thousands notation; "50,000" is US.
  s = /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s.replace(/,/g, '');
  let mult = 1;
  if (s.endsWith('k')) { mult = 1000; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1_000_000; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * mult : null;
}

// Normalize to annual figures so salaries can be compared and filtered.
export function normalizeSalary(min, max, period = 'year', currency = 'USD', text = null) {
  if (min == null && max == null) return null;
  const factor = { hour: 2080, day: 260, week: 52, month: 12, year: 1 }[period] ?? 1;
  let lo = min != null ? Math.round(min * factor) : null;
  let hi = max != null ? Math.round(max * factor) : null;
  if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
  // Throw away obvious garbage (e.g. "$5 - $10 million revenue").
  const top = hi ?? lo;
  if (!top || top < 10000 || top > 2_000_000) return null;
  return { min: lo, max: hi, currency, period, text };
}

export function extractSalary(text) {
  const re = /(US\$|CA\$|C\$|A\$|\$|€|£)\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?\s?[kKmM]?)\s*(?:USD|CAD|EUR|GBP)?\s*(?:-|–|—|to)\s*(?:US\$|CA\$|C\$|A\$|\$|€|£)?\s?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?\s?[kKmM]?)(?:\s*(?:USD|CAD|EUR|GBP))?(\s*(?:\/|per|an|a)\s*(?:hour|hr|year|yr|annum|month|mo))?/;
  const m = text.match(re);
  if (!m) {
    const single = text.match(/(\$|€|£)\s?(\d{1,3}(?:,\d{3})+|\d+\s?[kK])\s*(\/|per|an|a)\s*(hour|hr|year|yr|annum)/);
    if (!single) return null;
    const amt = parseAmount(single[2]);
    const period = /h/.test(single[4]) ? 'hour' : 'year';
    return normalizeSalary(amt, null, period, CURRENCY[single[1]] || 'USD', single[0].trim());
  }
  let lo = parseAmount(m[2]);
  let hi = parseAmount(m[3]);
  // "$120-150k" -> both in thousands
  if (/k$/i.test(m[3].trim()) && !/k$/i.test(m[2].trim()) && lo < 1000) lo *= 1000;
  // Look a little past the range too: "$8,250 - $11,000 per month" / "... monthly".
  const after = `${m[4] || ''} ${text.slice(m.index + m[0].length, m.index + m[0].length + 40)}`.toLowerCase();
  let period = 'year';
  if (/^\s*(\/|per|an|a)?\s*(hour|hr)\b|hourly/.test(after) || (hi && hi < 300)) period = 'hour';
  else if (/^\s*(\/|per|a)?\s*(month|mo)\b|monthly/.test(after)) period = 'month';
  return normalizeSalary(lo, hi, period, CURRENCY[m[1]] || 'USD', m[0].trim());
}

export function detectWorkplace(location = '', text = '', hint = null) {
  if (hint) return hint;
  const loc = location.toLowerCase();
  if (/hybrid/.test(loc)) return 'Hybrid';
  if (/remote|anywhere|worldwide|work from home|wfh/.test(loc)) return 'Remote';
  const t = text.slice(0, 3000).toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'Hybrid';
  if (/fully remote|100% remote|remote-first|remote first|this (role|position) is remote|work from anywhere/.test(t)) return 'Remote';
  if (location) return 'On-site';
  return null;
}

export function detectVisa(text) {
  const t = text.toLowerCase();
  const idx = t.search(/visa sponsorship|sponsor(ship)? (a |an |for )?(work )?(visa|h-?1b)|h-?1b|work authorization sponsorship|sponsor employment/);
  if (idx === -1) return null;
  const window = t.slice(Math.max(0, idx - 80), idx + 80);
  if (/\b(not|no|unable|cannot|can't|won't|will not|does not|doesn't|without)\b/.test(window)) return 'No sponsorship';
  return 'Sponsorship mentioned';
}

export function detectClearance(text) {
  return /security clearance|\bts\/sci\b|top secret|secret clearance|active clearance|public trust/i.test(text);
}

const BENEFITS = [
  ['Equity', /\b(equity|stock options|rsus?|esop)\b/i],
  ['401(k)', /401\(?k\)?/i],
  ['Health insurance', /(health|medical|dental|vision) (insurance|coverage|benefits|plans?)/i],
  ['Unlimited PTO', /unlimited (pto|vacation|paid time off|time off)/i],
  ['Parental leave', /(parental|maternity|paternity) leave/i],
  ['Learning budget', /(learning|education|professional development|training) (budget|stipend|allowance)/i],
  ['Remote stipend', /(home office|remote work|wfh|co-?working) (stipend|budget|allowance)/i],
  ['4-day week', /4[- ]day (work)?week|four[- ]day (work)?week/i],
  ['Bonus', /\b(annual|performance|signing|sign-on) bonus\b/i],
  ['Relocation', /relocation (assistance|support|package|bonus)/i],
  ['Visa support', /visa (support|assistance)/i],
];

export function detectBenefits(text) {
  return BENEFITS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// Pull bullet points from a "Requirements / Qualifications / What you'll bring" section.
const REQ_HEADING = /^(.{0,40})(requirements|qualifications|what we require|(your|required|relevant) (expertise|skills)|you('ll)? (need|should have)|what you('ll| will)? (bring|need|have)|what we('re| are) looking for|you (have|bring|might be a fit)|about you|must[- ]haves?|who you are|skills( and|&) experience|your (background|experience|profile)|minimum qualifications|basic qualifications|ideal candidate)\b.{0,40}$/i;
const ANY_HEADING = /^[A-Z][^.!?•]{2,70}:?$/;

export function extractRequirements(text) {
  // Treat plain-text "- " / "* " bullets the same as converted <li> bullets.
  const lines = text.split('\n').map((l) => l.trim().replace(/^[-*–·]\s+/, '• ')).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length && out.length < 10; i++) {
    if (!REQ_HEADING.test(lines[i]) || lines[i].startsWith('•') || lines[i].length > 90) continue;
    for (let j = i + 1; j < lines.length && out.length < 10; j++) {
      const l = lines[j];
      if (l.startsWith('•')) {
        const item = l.replace(/^•\s*/, '').trim();
        if (item.length > 8 && item.length < 400) out.push(item);
      } else if (ANY_HEADING.test(l) && out.length) {
        break;
      } else if (out.length && l.length > 200) {
        break;
      }
    }
    if (out.length) break;
  }
  return out;
}

export function enrichJob(job) {
  // Drop the employer's own name so e.g. "Snowflake" the company isn't counted as a Snowflake skill.
  let text = `${job.title}\n${job.description || ''}`;
  if (job.company && job.company.length > 2) {
    text = text.replace(new RegExp(job.company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  const skills = extractSkills(text);
  const salary = job.salary || extractSalary(job.salaryText ? `${job.salaryText}` : '') || extractSalary(job.description || '');
  return {
    ...job,
    skills,
    seniority: detectSeniority(job.title) || normalizeSeniority(job.seniority),
    experience: extractExperience(job.description || ''),
    degree: extractDegree(job.description || ''),
    salary,
    workplace: detectWorkplace(job.location || '', job.description || '', job.workplace),
    visa: detectVisa(job.description || ''),
    clearance: detectClearance(job.description || ''),
    benefits: detectBenefits(job.description || ''),
    requirements: extractRequirements(job.description || ''),
  };
}
