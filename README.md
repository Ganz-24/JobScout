# JobScout

A personal job-search dashboard. Pick the positions you want, and JobScout pulls matching postings from
job boards and company career pages, extracts the skills and requirements from each one, scores how well
you match, and tracks your applications.

## Run it

Requires Node.js 18+ (no `npm install` needed — there are no dependencies).

```bash
npm start
```

Then open http://localhost:3000.

## Where jobs come from

| Source | Coverage |
|---|---|
| Remotive, Remote OK, Jobicy, Himalayas, Working Nomads | Remote jobs worldwide |
| The Muse | Large US employers |
| Arbeitnow | Europe / Germany |
| Hacker News "Who is Hiring" | Startups (latest monthly thread) |
| Greenhouse, Lever, Ashby career pages | ~65 tech companies by default (Stripe, Airbnb, OpenAI, Anthropic, Figma, Databricks, …). Edit the list in **Settings**. |
| JSearch *(optional key)* | LinkedIn, Indeed, Glassdoor, ZipRecruiter |
| Adzuna *(optional key)* | Broad aggregator, many countries |
| USAJOBS *(optional key)* | US federal government |

LinkedIn, Indeed and Glassdoor block scraping and prohibit it in their terms, so JobScout reaches them
through the JSearch API instead. Copy `.env.example` to `.env`, add a free key, and restart.

Results are cached in memory for 20–30 minutes so repeat searches are fast. Use **Force refresh** to bypass the cache.

## Features

- **Position picker**: 29 preset roles (engineering, data/AI, product, design, business, early-career) plus custom titles.
- **Skill extraction**: ~250 skills detected in each posting, grouped by category, plus years of experience,
  degree, seniority, salary (normalized to annual), workplace type, visa sponsorship, clearance and benefits.
- **Key requirements**: pulls the bullets from each posting's "Requirements / Qualifications" section.
- **Match score**: the share of a posting's technical skills that you have (must-haves count double).
  Click any skill in a posting to add it to your profile.
- **Filters**: location, remote/hybrid/on-site, date posted, seniority, minimum salary, visa sponsorship,
  clearance, excluded title words and companies, and "new since last visit".
- **De-duplication**: the same job on several boards is merged ("Also listed on…").
- **Application tracker**: a Kanban board (Saved → Applied → Interviewing → Offer / Rejected) with notes,
  drag and drop, response-rate stats and CSV export.
- **Insights**: most requested skills, skills to learn next, salary by seniority, experience levels, and top hiring companies.
- Keyboard shortcuts (`j`/`k`, `s`, `a`, `x`, `o`, `/`), dark mode, and a mobile layout.

Your data (profile, tracker, hidden jobs) is saved in `data/state.json`. You can back it up from **Settings**.
