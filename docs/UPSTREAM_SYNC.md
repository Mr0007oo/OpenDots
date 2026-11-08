# Upstream sync and Docker publishing

This repository includes an upstream synchronization workflow for `CopilotKit/OpenDots`. It prepares an ordinary merge candidate and does not update `main` or publish an image until CI passes for that exact candidate.

## What the workflow does

- Detects when the upstream `main` branch gains commits.
- Compares the upstream branch to the fork before synchronizing.
- Creates a uniquely named candidate branch from the current fork `main` and merges upstream `main` with Git's normal merge behavior.
- Stops on conflicts; it never chooses ours/theirs, hard-resets, rebases, or force-pushes.
- Checks that the candidate contains the fetched upstream commit and that the Obscura integration, app/browser Docker targets, tool/browser tests, deployment docs, and required custom README sections still exist.
- Pushes the candidate branch, explicitly dispatches the regular CI workflow for its exact commit, and waits for that run to succeed.
- Fast-forwards fork `main` only after CI passes and only if `main` has not advanced independently.
- Publishes the existing Docker Hub application image after the tested candidate is on `main`.
- Dispatches `ci.yml` for promoted `main` to publish the app, browser gateway, computer supervisor, and computer runtime images to GHCR, and waits for each multi-platform manifest check.
- Writes a summary to the GitHub Actions job output so upstream changes and any blockers are visible.

## Preservation and failure behavior

- A normal three-way merge retains upstream commits and fork changes; conflicting edits stop before the candidate is pushed.
- README reconciliation is guarded by exact fork-specific heading, Obscura feature description, and Docker documentation link checks. Upstream README edits are merged rather than replaced wholesale.
- The Obscura service adapter and tests, agent/tool tests, deployment docs, Docker stages, and Compose service are checked before CI.
- A failed/missing CI run, a concurrent non-fast-forward change to fork `main`, missing Docker Hub credentials, a failed image build/push, or a failed manifest check prevents a successful publish.
- The candidate branch is retained on failure for investigation. The workflow never force-pushes or deletes fork branches.

These are explicit sentinel checks plus the normal merge and CI suite, not a proof that every future upstream edit is semantically compatible. Review upstream changes and the workflow run summary; a passing CI run does not replace code review.

## Trigger behavior

The workflow runs on:

- a new upstream commit via repository dispatch or scheduled polling
- a timed schedule every 6 hours
- `workflow_dispatch` for manual execution

A sync is skipped when the upstream branch has no new commits and the manual run is not forcing a check.

Because a push made with `GITHUB_TOKEN` does not start another `push`-triggered workflow, the sync workflow explicitly dispatches `ci.yml` on its candidate branch and waits for CI. After promoting the tested candidate to `main`, it dispatches `ci.yml` again with image publishing enabled and waits for all GHCR image builds and manifest checks. `ci.yml` also runs on normal pushes and pull requests.

## Required GitHub Secrets

Configure these repository secrets in GitHub:

1. Open the repository on GitHub.
2. Go to Settings → Secrets and variables → Actions.
3. Add the following values:
   - `DOCKERHUB_USERNAME`: your Docker Hub username
   - `DOCKERHUB_TOKEN`: a Docker Hub access token with permission to push to the target repository

Set `DOCKERHUB_USERNAME` to your Docker Hub login name (for this account, `Mr0007oo`). The workflow compares its lowercase form with the explicitly configured namespace `mr0007oo`; the actual login action receives the secret unchanged. The image repository is fixed to lowercase `opendots` and is not constructed from `GITHUB_REPOSITORY`, whose canonical GitHub spelling is `Mr0007oo/OpenDots`.

The workflow token also needs repository `Actions: write` and `Contents: write` permissions. The workflow declares these for CI dispatch, candidate branch creation, and the guarded fast-forward of `main`. Repository or organization policy must allow these token permissions. No Issues permission is requested.

Before Docker login, the workflow checks that the username matches the configured namespace, both secrets are present, and each generated image reference is valid and lowercase. It does not print credentials and uses the official Docker login action with the secret-backed username and token.

## Docker Hub repository

The workflow publishes to:

- `docker.io/mr0007oo/opendots:latest`
- `docker.io/mr0007oo/opendots:v<package-version>-<candidate-short-sha>` (for example `v0.1.0-a1b2c3d4e5f6`)

The image namespace and repository are explicitly fixed as lowercase `mr0007oo/opendots`; they are not derived from the mixed-case GitHub owner/repository identifier. The commit-qualified version tag identifies the exact merged candidate and avoids silently moving a plain semver tag on every upstream sync. `latest` is intentionally updated on each successful publication. Buildx publishes the Dockerfile's `app` target as a multi-platform manifest. Compose uses separately published GHCR browser, supervisor, and computer images, and pulls the pinned Obscura image from its upstream publisher. The final workflow step verifies both `linux/amd64` and `linux/arm64` descriptors for both Docker Hub app tags.

The separate GHCR image workflow lowercases `GITHUB_REPOSITORY` and publishes
`ghcr.io/mr0007oo/opendots/{app,browser,supervisor,computer}`. Each image gets a
full commit-SHA tag and, for main or version-tag releases, the appropriate
`latest` or version tag. The workflow verifies both architecture descriptors
for every published tag. Package visibility is not changed by Actions; use the
manual GHCR package settings steps in [Docker deployment](DOCKER.md#published-images-and-public-packages)
to make all four packages public.

## Manual intervention for conflicts

If a merge cannot complete safely, the workflow stops and lists the conflicting files in its job summary. Resolve the merge manually in a reviewable branch, then rerun the workflow. The workflow does not create GitHub issues.

If CI or publication fails after the candidate was pushed, inspect the candidate branch and run logs. A failed CI or concurrent update leaves `main` unchanged. If Docker Hub publication fails after the tested candidate was fast-forwarded to `main`, correct the credentials/repository issue and use `workflow_dispatch` with `force_sync` enabled to validate and publish that source again.

## Important note for a fork

This workflow is intentionally conservative. A merge conflict or failed sentinel check requires human reconciliation; no claim is made that an unexecuted upstream sync or Docker publication succeeded.
