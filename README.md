# Being Agile — design prototype

A clickable, browser-based design prototype for **Being Agile**: turning planning
documents (PRD, design doc, API spec) into human-reviewed user stories, test
assets, execution results, and requirement-level proof.

**Live demo:** https://rgstack.github.io/being-agile/app/ — no build step, no server.

## The flow

`Start → Clarify → Stories → Test Plan → Test Cases → Run → Report`

- **Start** — attach the PRD, design doc, API spec, and any supporting documents
- **Clarify** — the AI reads every document through a delivery lens (timeline,
  stakeholders, value stream, business area), fills a ledger with what it could
  place, and asks about the rest one question at a time. Nothing it asks blocks
  you: **Generate stories** is always available, and open questions become stated
  assumptions inside the stories
- **Stories** — AI-drafted stories, each sized in story points to fit one 2-week sprint, with inline editing, per-story AI revision,
  Jira-style detail panel, subtasks, CSV export for Jira import
- **Test Plan / Test Cases** — human-revised, traceable to requirements
- **Run / Report** — simulated execution with requirement-level proof

Nothing reaches Jira without explicit human approval.

## Example data

The prototype ships with a realistic example built around the public
[CMS NPPES NPI Registry API](https://npiregistry.cms.hhs.gov/) (no key needed):
13 requirements, 8 stories, a test plan, 15 test cases. Source docs live in
[`docs/`](docs/).

## Status

Design prototype for stakeholder review — not production code. Single HTML file
(one file, internally organized Model / View / Controller).
