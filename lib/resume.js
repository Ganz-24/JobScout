// Resume tools: an instant offline match report, plus Claude-powered suggestions,
// auto-tailoring and cover letters (these need ANTHROPIC_API_KEY in .env).

import Anthropic from '@anthropic-ai/sdk';
import { extractSkills } from './enrich.js';

// ---------------------------------------------------------------- offline analysis

const STOPWORDS = new Set(`a an and are as at be by for from has have in into is it its of on or that the to with you your our we will
  who what this their they them able ability work working strong experience experienced years year using use including include such
  other etc plus preferred required requirements must should would could also well across within about more than least
  knowledge understanding skills skill familiarity proven track record demonstrated excellent good great team teams`.split(/\s+/));

const WEAK_PHRASES = [
  'responsible for', 'helped', 'worked on', 'duties included', 'assisted with', 'tasked with', 'involved in',
  'participated in', 'various', 'etc.', 'team player', 'hard worker', 'detail-oriented', 'go-getter',
];

function words(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9+#.\-/]{2,}/g) || [])
    .map((w) => w.replace(/[.\-/]+$/, ''))
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

export function analyzeResume(resume = '', job = {}) {
  const text = String(resume);
  const lower = text.toLowerCase();
  const resumeSkills = new Set(extractSkills(text).map((s) => s.name));
  const jobSkills = (job.skills || []).filter((s) => s.category !== 'Soft Skills');
  const found = jobSkills.filter((s) => resumeSkills.has(s.name)).map((s) => s.name);
  const missing = jobSkills.filter((s) => !resumeSkills.has(s.name)).map((s) => s.name);
  const keywordScore = jobSkills.length ? found.length / jobSkills.length : null;

  // Requirement coverage: skills named in the bullet if any, otherwise its key words.
  const requirements = (job.requirements || []).map((req) => {
    const reqSkills = extractSkills(req).filter((s) => s.category !== 'Soft Skills').map((s) => s.name);
    let terms;
    let have;
    if (reqSkills.length) {
      terms = reqSkills;
      have = reqSkills.filter((s) => resumeSkills.has(s));
    } else {
      terms = [...new Set(words(req))];
      have = terms.filter((w) => lower.includes(w));
    }
    const ratio = terms.length ? have.length / terms.length : 0;
    return {
      text: req,
      status: ratio >= 0.6 ? 'covered' : ratio >= 0.3 ? 'partial' : 'missing',
      missingTerms: terms.filter((t) => !have.includes(t)).slice(0, 6),
    };
  });
  const reqScore = requirements.length
    ? requirements.reduce((n, r) => n + (r.status === 'covered' ? 1 : r.status === 'partial' ? 0.5 : 0), 0) / requirements.length
    : null;

  // Resume health checks.
  const wordCount = (text.match(/\S+/g) || []).length;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let bullets = lines.filter((l) => /^([•\-*–▪●◦]|\d+\.)\s/.test(l));
  // PDF/Word imports often drop the bullet glyphs; fall back to sentence-like lines
  // (long enough, not a heading, not a contact or "Title — Company (dates)" line).
  if (bullets.length < 3) {
    bullets = lines.filter((l) => l.length >= 35 && l.length <= 400 && !/[|@]|:$/.test(l)
      && !/\(\s*\d{4}|\b(19|20)\d{2}\s*[–-]\s*((19|20)\d{2}|present)\b/i.test(l) && /^[A-Z]/.test(l)
      && (l.match(/,/g) || []).length < 3 && !/^(B\.?S|B\.?A|M\.?S|MBA|Ph\.?D|Bachelor|Master|Associate)/i.test(l));
  }
  const quantified = bullets.filter((l) => /\d|%|\$/.test(l));
  const weak = WEAK_PHRASES.filter((p) => lower.includes(p));
  const longBullets = bullets.filter((b) => b.length > 220);
  const titleWords = words(job.title || '').filter((w) => !['senior', 'junior', 'staff', 'lead', 'principal'].includes(w));
  const titleHit = titleWords.length ? titleWords.filter((w) => lower.includes(w)).length / titleWords.length : 1;

  const checks = [
    { label: 'Contact email', ok: /[\w.+-]+@[\w-]+\.[\w.]+/.test(text) },
    { label: 'Phone number', ok: /(\+?\d[\d\s().-]{8,}\d)/.test(text) },
    { label: 'LinkedIn / portfolio link', ok: /linkedin\.com|github\.com|portfolio|https?:\/\//i.test(text) },
    { label: 'Experience section', ok: /\b(experience|employment|work history)\b/i.test(text) },
    { label: 'Education section', ok: /\beducation\b/i.test(text) },
    { label: 'Skills section', ok: /\b(skills|technologies|tech stack|tools)\b/i.test(text) },
    {
      label: 'Length',
      ok: wordCount >= 300 && wordCount <= 1000,
      detail: `${wordCount} words${wordCount < 300 ? ' — likely too thin' : wordCount > 1000 ? ' — consider trimming to 1–2 pages' : ''}`,
    },
    {
      label: 'Quantified achievements',
      ok: bullets.length ? quantified.length / bullets.length >= 0.4 : false,
      detail: bullets.length ? `${quantified.length} of ${bullets.length} bullets include a number` : 'No bullet points detected',
    },
    { label: 'No weak phrases', ok: !weak.length, detail: weak.length ? `Found: ${weak.map((w) => `"${w}"`).join(', ')}` : '' },
    { label: 'No first-person pronouns', ok: !/(^|[\s(])(I|me|my)\b/.test(text), detail: '' },
  ];
  const healthScore = checks.filter((c) => c.ok).length / checks.length;

  const tips = [];
  if (missing.length) {
    tips.push(`The posting mentions ${missing.length} skill${missing.length > 1 ? 's' : ''} your resume doesn't: ${missing.slice(0, 8).join(', ')}. Add the ones you genuinely have — ideally inside a bullet that shows how you used them, not only in a skills list.`);
  }
  if (titleHit < 0.5 && job.title) tips.push(`Your resume barely echoes the job title "${job.title}". If it's accurate, use similar wording in your summary or headline.`);
  const missingReqs = requirements.filter((r) => r.status === 'missing');
  if (missingReqs.length) tips.push(`${missingReqs.length} key requirement${missingReqs.length > 1 ? 's aren\'t' : ' isn\'t'} reflected in your resume — see the list below.`);
  if (bullets.length && quantified.length / bullets.length < 0.4) tips.push('Quantify more bullets (users, %, $, latency, time saved, team size). Recruiters skim for numbers.');
  if (weak.length) tips.push(`Replace weak phrasing (${weak.slice(0, 3).join(', ')}) with strong action verbs: built, led, shipped, reduced, automated, designed.`);
  if (longBullets.length) tips.push(`${longBullets.length} bullet${longBullets.length > 1 ? 's are' : ' is'} over ~2 lines. Tighten to one idea and one result each.`);
  if (wordCount > 1000) tips.push('Your resume is long. Cut older or less relevant roles down to 1–2 bullets.');

  const parts = [
    [keywordScore, 0.55],
    [reqScore, 0.3],
    [healthScore, 0.15],
  ].filter(([v]) => v != null);
  const totalWeight = parts.reduce((n, [, w]) => n + w, 0);
  const score = Math.round((parts.reduce((n, [v, w]) => n + v * w, 0) / totalWeight) * 100);

  return {
    score,
    keywordScore: keywordScore == null ? null : Math.round(keywordScore * 100),
    skills: { found, missing, resumeOnly: [...resumeSkills].filter((s) => !jobSkills.some((j) => j.name === s)) },
    requirements,
    checks,
    tips,
    stats: { wordCount, bullets: bullets.length, quantified: quantified.length },
  };
}

// ---------------------------------------------------------------- Claude

export const AI_MODEL = 'claude-opus-5-5';

export function aiConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client;
function getClient() {
  client ||= new Anthropic();
  return client;
}

const SYSTEM = `You are an expert technical recruiter and resume writer helping a job seeker tailor their resume to a specific posting.

Ground rules:
- Never invent experience, employers, titles, dates, degrees, certifications, metrics or skills. Every claim must be supported by the original resume. Rephrasing, reordering, emphasizing and using the posting's terminology for things the candidate already did is encouraged.
- When a posting asks for something the resume doesn't show, say so plainly and suggest how the candidate could address it truthfully (e.g. "if you have used X, add it to the bullet about Y").
- Prefer concrete, quantified, action-verb bullets. Keep the candidate's voice; avoid buzzword stuffing and clichés.
- Optimize for both applicant tracking systems (exact keyword matches for real skills) and a human recruiter skimming for 10 seconds.`;

function jobBlock(job) {
  const skills = (job.skills || []).map((s) => s.name).join(', ');
  const reqs = (job.requirements || []).map((r) => `- ${r}`).join('\n');
  return `<job_posting>
Title: ${job.title || ''}
Company: ${job.company || ''}
Location: ${job.location || ''}
${job.seniority ? `Seniority: ${job.seniority}\n` : ''}${skills ? `Skills mentioned: ${skills}\n` : ''}${reqs ? `Key requirements:\n${reqs}\n` : ''}
Full description:
${String(job.description || '').slice(0, 15000)}
</job_posting>`;
}

const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const str = { type: 'string' };
const strList = { type: 'array', items: str };

const SUGGEST_SCHEMA = obj({
  fit_summary: str,
  fit_score: { type: 'integer' },
  strengths: strList,
  gaps: { type: 'array', items: obj({ gap: str, suggestion: str }) },
  keywords_to_add: { type: 'array', items: obj({ keyword: str, where: str, only_if_true: { type: 'boolean' } }) },
  bullet_rewrites: { type: 'array', items: obj({ original: str, improved: str, reason: str }) },
  summary_rewrite: str,
  other_tips: strList,
});

const TAILOR_SCHEMA = obj({
  tailored_resume: str,
  changes: strList,
  not_added: strList,
});

const COVER_SCHEMA = obj({ cover_letter: str });

async function callJson(userContent, schema, effort = 'medium') {
  const response = await getClient().beta.messages.create({
    model: AI_MODEL,
    max_tokens: 16000,
    // If a safety classifier declines, let the API re-run the request on its recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema } },
    system: SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error(`Claude declined this request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}.`);
  }
  if (response.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try a shorter resume or posting.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

export function friendlyAiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Your ANTHROPIC_API_KEY was rejected. Check the key in .env and restart the server.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'This API key does not have access to the model.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API — wait a minute and try again.';
  if (e instanceof Anthropic.BadRequestError) return `The Anthropic API rejected the request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection.';
  if (e instanceof Anthropic.APIError) return `Anthropic API error (${e.status ?? 'unknown'}): ${e.message}`;
  return e.message;
}

export function suggestEdits(resume, job) {
  return callJson(`${jobBlock(job)}

<resume>
${resume}
</resume>

Review this resume against the job posting and give specific, actionable suggestions.
- fit_summary: 2–3 sentences on how well the candidate fits and the biggest lever for improving the resume.
- fit_score: 0–100, how well the resume (as written) matches this posting.
- strengths: what already matches well (max 5).
- gaps: requirements the resume doesn't demonstrate, each with a truthful way to address it (max 6).
- keywords_to_add: important posting terms missing from the resume and which section/bullet to put them in. Set only_if_true=true when the resume doesn't show the candidate has that skill.
- bullet_rewrites: 3–6 existing bullets that would benefit most from rewriting for this posting. "original" must be copied verbatim from the resume.
- summary_rewrite: a 2–3 sentence professional summary tailored to this role, using only facts from the resume.
- other_tips: formatting, ordering or content tips specific to this application (max 5).`, SUGGEST_SCHEMA);
}

export function tailorResume(resume, job) {
  return callJson(`${jobBlock(job)}

<resume>
${resume}
</resume>

Rewrite this resume so it is as strong as possible for this specific posting, without inventing anything.
- Keep every employer, title, date, degree and fact accurate. Do not add skills or tools the resume doesn't show.
- Reorder sections and bullets so the most relevant experience comes first; rephrase bullets with the posting's terminology where it truthfully applies; tighten wording; lead with impact.
- Add or rewrite a short summary at the top targeted to this role.
- Keep roughly the same length (one page stays one page).
- Format as Markdown: "# Name", contact line, "## Section" headings, "### Role — Company (dates)" for jobs, and "- " bullets.
- changes: a short list of what you changed and why.
- not_added: posting requirements you deliberately did NOT add because the original resume doesn't support them (so the candidate can add them if they're true).`, TAILOR_SCHEMA);
}

const EDIT_SCHEMA = obj({ resume: str, changes: strList });

// Apply a free-form instruction ("fit on one page", "emphasize security work") to the resume.
export function editResume(resume, job, instruction) {
  const hasJob = job && (job.title || job.description);
  return callJson(`${hasJob ? `${jobBlock(job)}\n\n` : ''}<resume>
${resume}
</resume>

<instruction>
${String(instruction || '').slice(0, 2000)}
</instruction>

Edit the resume according to the instruction${hasJob ? ' (the job posting above is the role it is being prepared for)' : ''}.
- Change only what the instruction asks for, plus anything needed to keep it consistent. Never invent experience, employers, titles, dates, metrics or skills.
- Return the complete resume in this exact Markdown format: "# Name", the contact line as a plain line under it, "## SECTION" headings,
  "### Role — Company   Month Year – Month Year" lines (dates at the end), "- " bullets, **bold** and *italic* only. No other Markdown.
- If the instruction is about length (e.g. one page), tighten wording and trim the least relevant bullets rather than deleting whole roles.
- changes: a short list of what you changed.`, EDIT_SCHEMA);
}

export function writeCoverLetter(resume, job, tone = 'professional') {
  return callJson(`${jobBlock(job)}

<resume>
${resume}
</resume>

Write a cover letter for this application in a ${tone} tone.
- 250–350 words, 3–4 short paragraphs, addressed to the hiring team at the company.
- Open with a specific hook about why this role/company, connect 2–3 concrete accomplishments from the resume to the posting's needs, close with a confident call to action.
- Use only facts from the resume. No placeholders like [Your Name] except where the resume lacks the information; take the name and contact details from the resume.
- Return plain text with blank lines between paragraphs.`, COVER_SCHEMA, 'low');
}
