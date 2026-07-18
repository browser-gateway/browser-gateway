# docs/

This folder contains **developer-facing** documentation only. All user-facing docs live at:

- **Site**: https://docs.browsergateway.com
- **Source**: https://github.com/browser-gateway/docs

## What's here

| File | Purpose |
|---|---|
| `CODE-QUALITY.md` | The 7-gate quality stack (catalog / lint / dup / dead / api / mutation / tests) |
| `HELPER-CATALOG.md` | Auto-generated inventory of every exported helper. Regenerate with `npm run catalog:gen`. |
| `api/*.api.md` | api-extractor lockfiles for the public TypeScript API surface |
| `assets/` | Images embedded in code-repo docs (README, CODE-QUALITY, etc.) |

## Adding user-facing docs

Open a PR against https://github.com/browser-gateway/docs — that repo owns the site content. Every push to `main` there auto-deploys to `docs.browsergateway.com` via Vercel.

## Why the split

User docs and developer docs have different audiences, cadences, and deploy targets. Keeping them separate:

- Docs edits don't trigger code CI (~2min saved per PR)
- Community typo PRs don't touch the code repo
- Docs deploy independently on their own Vercel project
- Code repo stays focused on shippable artifact
