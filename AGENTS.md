# AGENTS.md

Instructions for AI coding agents (e.g. pi coding agent) working in this repo.

## Keep this file short

This file is the **first rule**: keep `AGENTS.md` very short and concise -
prefer bullet points over prose. When adding or editing a rule, condense,
never expand.

## Language: English only

Everything in this repo is written in **English** and must stay English:
README/docs, code comments, user-facing strings, commit messages, CI config.
Never introduce German (or any other language) text; when touching an existing
string, keep it English. CI fails on umlauts anywhere in the repo.

## Project layout

- `extensions/` - the Pi extension (single entry point)
- `CHANGELOG.md` - user-facing changes per version (Keep a Changelog format)
- `.spec-flow/` - tooling state, not part of the extension

## Changelog is mandatory

- Every **user-facing** change/feature gets a bullet under `## [Unreleased]` in
  `CHANGELOG.md`, in the same commit that introduces it
  (categories: `Added`, `Changed`, `Fixed`, ...).
- Internal refactors, CI/tooling tweaks and docs-only fixes: no changelog entry.
- `README.md` shows the release notes of the current version in the marked
  block: generated from `CHANGELOG.md` via `npm run readme` (Gitea, the GitHub
  mirror and npm render the README). Never edit that block by hand.
- The release workflow rejects a tag without a matching `X.Y.Z` heading (the
  version links its GitHub release).

## Checks

- `npm run check` - README release-notes block is up to date, bundle smoke test,
  `npm pack --dry-run` (the same scripts run in CI via the shared reusable
  workflow, see `pi-extension-release-tool`).
- Visual: `pi -e ./extensions/realtime-provider-maxtokens.ts`
- Before committing: quick "no German" review of all touched strings/docs.

## Releasing

1. `CHANGELOG.md`: move `[Unreleased]` bullets into a heading
   `X.Y.Z - YYYY-MM-DD`, with the version as the link to its GitHub release
2. Bump `"version"` in `package.json` to `X.Y.Z`, run `npm run readme`, commit
   both (the README block then already shows the notes on Gitea)
3. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
   -> Gitea mirrors the tag -> GitHub Actions publishes to npm (provenance) and
   creates the GitHub release from the CHANGELOG section (tags are never created
   by a workflow - Gitea stays the source of truth for refs)
4. First release of a new repository only: publish manually (`npm login`,
   `npm publish --access public`), set the GitHub secret `NPM_TOKEN`
   afterwards, and do **not** push the tag of that version (the workflow
   rejects an already published version) - the first tag-driven release is the
   next patch.

## Repository: local Gitea + public GitHub mirror

- Everything committed here becomes publicly readable on GitHub.
- **Never commit sensitive data** (keys, tokens, passwords, personal data) -
  source, docs, examples and history included. Use env vars or untracked files.
- `origin` = Gitea (`ssh://git@gitea/FloezWerk/piagent-realtime-provider-maxtokens.git`), push target.
  Public GitHub URL: `git@github.com:FloezWerk/piagent-realtime-provider-maxtokens.git`.
- Install instructions always use the GitHub URL or the npm package, never the
  Gitea path (internal):
  `pi install git:git@github.com:FloezWerk/piagent-realtime-provider-maxtokens.git` or
  `pi install npm:@floez-werk/piagent-realtime-provider-maxtokens`
- Exception: refreshing the locally installed copy uses the Gitea source it
  came from: `pi update ssh://git@gitea/FloezWerk/piagent-realtime-provider-maxtokens.git`
- CI/CD lives in the shared workflows of
  [pi-extension-release-tool](https://github.com/FloezWerk/pi-extension-release-tool)
  (pinned via `@v0.1`); do not duplicate their logic here.