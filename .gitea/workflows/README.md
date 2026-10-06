# Why this directory exists (it contains no workflow on purpose)

Gitea looks for workflows in `.gitea/workflows` first and only falls back to
`.github/workflows` when the first directory does not exist (`[actions]
WORKFLOW_DIRS`, default `.gitea/workflows,.github/workflows`).

This repository is developed on Gitea and mirrored to GitHub, where the
workflows in `.github/workflows/` run. Gitea has no runner, so without this
directory every push would end up as a queued run with the error "No runner is
online to pick up this job".

Because `.gitea/workflows` exists, Gitea stops here, finds no workflow and never
schedules the GitHub workflows. Git does not track empty directories, which is
why this file is here.

Do not add `*.yml`/`*.yaml` files to this directory unless they are meant to run
on Gitea.