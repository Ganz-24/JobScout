// Role presets. `query` is sent to job boards that support keyword search;
// `match` patterns decide whether a posting's TITLE belongs to the role.
// Custom roles typed by the user are matched by requiring every word in the title.

export const ROLE_PRESETS = [
  { id: 'software-engineer', label: 'Software Engineer', group: 'Engineering', query: 'software engineer', muse: ['Software Engineering'],
    match: [/software (engineer|developer|development engineer)/, /\bswe\b/, /\bsde\b/, /application (engineer|developer)/, /\bprogrammer\b/] },
  { id: 'frontend', label: 'Frontend Engineer', group: 'Engineering', query: 'frontend', muse: ['Software Engineering'],
    match: [/front[\s-]?end/, /\bui (engineer|developer)/, /\b(react|angular|vue)(\.js)? (engineer|developer)/, /web (engineer|developer)/] },
  { id: 'backend', label: 'Backend Engineer', group: 'Engineering', query: 'backend', muse: ['Software Engineering'],
    match: [/back[\s-]?end/, /\bapi (engineer|developer)/, /server[\s-]?side/, /\b(java|python|golang|go|node(\.js)?|ruby|rails|php|\.net|c#) (engineer|developer)/] },
  { id: 'fullstack', label: 'Full Stack Engineer', group: 'Engineering', query: 'full stack', muse: ['Software Engineering'],
    match: [/full[\s-]?stack/] },
  { id: 'mobile', label: 'Mobile Engineer', group: 'Engineering', query: 'mobile developer', muse: ['Software Engineering'],
    match: [/\bmobile\b.*(engineer|developer)/, /\b(ios|android|flutter|react native)\b.*(engineer|developer)/] },
  { id: 'devops', label: 'DevOps / SRE', group: 'Engineering', query: 'devops', muse: ['Software Engineering','Computer and IT'],
    match: [/dev[\s-]?ops/, /site reliability/, /\bsre\b/, /platform engineer/, /infrastructure engineer/, /cloud engineer/, /devsecops/] },
  { id: 'data-engineer', label: 'Data Engineer', group: 'Data & AI', query: 'data engineer', muse: ['Data and Analytics','Software Engineering'],
    match: [/data (engineer|platform engineer)/, /analytics engineer/, /\betl\b/, /big data/] },
  { id: 'data-scientist', label: 'Data Scientist', group: 'Data & AI', query: 'data scientist', muse: ['Data and Analytics','Science and Engineering'],
    match: [/data scien/, /applied scientist/, /research scientist/, /\bstatistician\b/, /quantitative (analyst|researcher)/] },
  { id: 'data-analyst', label: 'Data Analyst', group: 'Data & AI', query: 'data analyst', muse: ['Data and Analytics'],
    match: [/data analyst/, /business intelligence/, /\bbi (analyst|developer|engineer)/, /analytics (analyst|specialist)/, /reporting analyst/, /business analyst/, /insights analyst/] },
  { id: 'ml-engineer', label: 'ML / AI Engineer', group: 'Data & AI', query: 'machine learning', muse: ['Software Engineering','Data and Analytics'],
    match: [/machine learning/, /\bml\b/, /\bai (engineer|developer|researcher)/, /\bmlops\b/, /deep learning/, /\bnlp\b/, /computer vision/, /\bllm\b/, /\bgenai\b/] },
  { id: 'qa', label: 'QA / Test Engineer', group: 'Engineering', query: 'qa engineer', muse: ['Software Engineering'],
    match: [/\bqa\b/, /quality (assurance|engineer)/, /\btest(ing)? (engineer|automation|analyst)/, /\bsdet\b/, /automation engineer/] },
  { id: 'security', label: 'Cybersecurity', group: 'Engineering', query: 'security engineer', muse: ['Computer and IT','Software Engineering'],
    match: [/security (engineer|analyst|architect|specialist|researcher)/, /cyber ?security/, /\bsoc analyst/, /penetration tester/, /\bappsec\b/, /information security/, /\bgrc\b/] },
  { id: 'embedded', label: 'Embedded / Firmware', group: 'Engineering', query: 'embedded engineer', muse: ['Science and Engineering','Software Engineering'],
    match: [/embedded/, /firmware/, /\bfpga\b/, /hardware engineer/] },
  { id: 'game-dev', label: 'Game Developer', group: 'Engineering', query: 'game developer', muse: ['Software Engineering'],
    match: [/game (developer|engineer|programmer|designer)/, /gameplay/, /\bunity (developer|engineer)/, /unreal/] },
  { id: 'eng-manager', label: 'Engineering Manager', group: 'Engineering', query: 'engineering manager', muse: ['Software Engineering'],
    match: [/engineering manager/, /manager,? (software )?engineering/, /head of engineering/, /director,? (of )?engineering/, /\bvp,? engineering/] },
  { id: 'solutions', label: 'Solutions / Sales Engineer', group: 'Engineering', query: 'solutions engineer', muse: ['Software Engineering','Sales'],
    match: [/solutions? (engineer|architect)/, /sales engineer/, /customer engineer/, /forward deployed/, /technical account manager/, /implementation engineer/] },
  { id: 'product-manager', label: 'Product Manager', group: 'Product & Design', query: 'product manager', muse: ['Product Management'],
    match: [/product manager/, /product owner/,/head of product/, /director,? (of )?product/, /\bvp,? product/, /group product manager/] },
  { id: 'program-manager', label: 'Program / Project Manager', group: 'Product & Design', query: 'project manager', muse: ['Project Management'],
    match: [/program manager/, /project manager/, /\btpm\b/, /scrum master/, /delivery manager/] },
  { id: 'designer', label: 'Product / UX Designer', group: 'Product & Design', query: 'product designer', muse: ['Design and UX'],
    match: [/(product|ux|ui|interaction|visual|web) designer/, /ux research/, /user research/, /design (lead|manager)/, /\bux\b/] },
  { id: 'technical-writer', label: 'Technical Writer', group: 'Product & Design', query: 'technical writer', muse: ['Writing and Editing'],
    match: [/technical writer/, /documentation (engineer|specialist)/, /developer advocate/, /developer relations/, /devrel/] },
  { id: 'it-support', label: 'IT / Systems Admin', group: 'Operations', query: 'it support', muse: ['Computer and IT'],
    match: [/\bit (support|specialist|administrator|technician|analyst|engineer)/, /help ?desk/, /system(s)? (administrator|admin|engineer)/, /network (engineer|administrator)/, /desktop support/] },
  { id: 'marketing', label: 'Marketing', group: 'Business', query: 'marketing', muse: ['Advertising and Marketing'],
    match: [/marketing/, /\bseo\b/, /growth (manager|marketer|lead)/, /content (strategist|manager|marketer)/, /brand manager/, /social media/] },
  { id: 'sales', label: 'Sales / Account Exec', group: 'Business', query: 'account executive', muse: ['Sales'],
    match: [/account executive/, /sales (representative|manager|development|director)/, /\bsdr\b/, /\bbdr\b/, /business development/, /account manager/] },
  { id: 'customer-success', label: 'Customer Success / Support', group: 'Business', query: 'customer success', muse: ['Customer Service'],
    match: [/customer (success|support|experience|service)/, /support (specialist|engineer|agent|representative)/, /client success/] },
  { id: 'finance', label: 'Finance / Accounting', group: 'Business', query: 'finance', muse: ['Accounting and Finance'],
    match: [/financ(e|ial) (analyst|manager|planning)/, /accountant/, /accounting/, /\bfp&a\b/, /controller/, /bookkeep/, /tax (manager|analyst|associate)/] },
  { id: 'operations', label: 'Operations', group: 'Business', query: 'operations', muse: ['Business Operations'],
    match: [/operations (manager|analyst|associate|specialist|lead)/, /business operations/, /\bbizops\b/, /strategy (and|&) operations/, /supply chain/, /logistics/] },
  { id: 'hr', label: 'HR / Recruiting', group: 'Business', query: 'recruiter', muse: ['Human Resources and Recruitment'],
    match: [/recruit(er|ing)/, /talent (acquisition|partner)/, /people (partner|operations)/, /\bhr\b/, /human resources/] },
  { id: 'intern', label: 'Internships', group: 'Early Career', query: 'intern', muse: ['Software Engineering','Data and Analytics','Business Operations'],
    match: [/\bintern(ship)?\b/, /co-?op\b/, /summer (analyst|associate)/] },
  { id: 'new-grad', label: 'New Grad / Entry Level', group: 'Early Career', query: 'entry level', muse: ['Software Engineering','Data and Analytics'],
    match: [/new grad/, /entry[\s-]level/, /\bjunior\b/, /\bjr\.?\b/, /graduate (engineer|program|developer)/, /early career/, /university grad/, /associate (software|engineer|developer)/] },
];

const PRESET_BY_ID = new Map(ROLE_PRESETS.map((r) => [r.id, r]));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Turn a role id (preset) or free-text role into { id, label, query, test(title) }.
export function resolveRole(role) {
  const preset = PRESET_BY_ID.get(role);
  if (preset) {
    return {
      id: preset.id,
      label: preset.label,
      query: preset.query,
      muse: preset.muse,
      test: (title) => preset.match.some((re) => re.test(title.toLowerCase())),
    };
  }
  const text = String(role).trim();
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const res = words.map((w) => new RegExp(`(^|[^a-z0-9])${escapeRe(w)}`, 'i'));
  return {
    id: `custom:${text.toLowerCase()}`,
    label: text,
    query: text,
    muse: ['Software Engineering'],
    test: (title) => res.every((re) => re.test(title)),
  };
}
