# Pingboard

One board for the pull requests you are shepherding through CI. Pin the PRs you care about and each one tells you, in plain words, where it stands and what it needs next — instead of a browser tab per PR. The usual maintainer actions (update branch, run or retry CI, labels, approve, merge) are buttons on the board.

<img width="1668" height="1027" alt="Screenshot 2026-10-08 at 12 57 06 PM" src="https://github.com/user-attachments/assets/458d4cbf-d81b-4962-937f-36c99a792ed9" />

It is a static page that talks to the GitHub or GitCode API from your browser: no server, no build step, no dependencies. It is tuned for [vllm-project/vllm](https://github.com/vllm-project/vllm) and supports other repositories through workflow profiles.

## GitCode

Choose **GitCode** on the sign-in screen and enter a GitCode personal access token. No GitCode repository is preselected. The first time you add PRs or start monitoring, enter `owner/repo`; change it later in **Settings → Default repository**. Pin PRs using `42`, `owner/repo#42`, or `https://gitcode.com/owner/repo/pull/42` (also accepts `/pulls/` and `/merge_requests/`). Sign out to choose another platform.

For maintainer monitoring, click **Monitor repository** after signing in. All currently open PRs are pinned in a repository group, and each refresh discovers new PRs automatically. Closed and merged PRs remain visible until you clear them. Unpinning a PR excludes it from future discovery; manually pin it again to resume tracking. **Stop monitoring** stops discovery without removing pins. Monitoring resumes after reload and runs only while this page is open (background tabs refresh more slowly); it is not a server-side monitor. Scans are paginated, and failures appear in the top bar without applying a partial list. The watched repository stays fixed even if you change the default; stop and restart monitoring to watch the new default.

GitCode support includes:

- PR discovery (Mine, Review requested, Following, quick label, All recent), title filtering and `@author`. Lists read every page of open PRs; All recent is the default view.
- Pinned PR refresh, open/closed/merged and draft states, conflicts, review requirements, labels and the latest 30 ordinary comments.
- Configured CI comment commands, approval and merge with confirmation. Squash maps to GitCode's `merge_method: merge` plus `squash: true`. Forced merge is never requested. Before merging, the head commit and merge permission are rechecked; GitCode's merge API does not support an atomic expected-head-SHA guard, so a concurrent push can still race that check.
- Separate tokens, boards, preferences and backups for each platform. Existing GitHub storage stays compatible. Tokens are sent in authorization headers only to the selected platform's fixed API host, never in URLs or backups. Backups cannot be imported into the other platform.

GitCode merge gates are shown separately from CI results: a satisfied CI gate does **not** imply jobs ran or passed. Individual jobs, base-branch failure history, branch-behind counts, branch updates and auto-merge are not available in this integration. Label editing opens the PR on GitCode. The GitCode board has Needs review, CI gate, Conflicts, Blocked and Merge allowed filters. Configure comment commands only if your repository's bot supports them.

The adapter uses [GitCode REST v5 authentication](https://docs.gitcode.com/en/docs/guide/), [PR details](https://docs.gitcode.com/en/docs/apis/get-api-v-5-repos-owner-repo-pulls-number/) and the [merge API](https://docs.gitcode.com/docs/apis/put-api-v-5-repos-owner-repo-pulls-number-merge/). As a static app it requires the API to allow browser cross-origin requests; connection errors are displayed on the sign-in screen.

## The board

Each row is one pull request with a status and, where there is an obvious next step, a button for it.

| Status | Meaning | Button |
| --- | --- | --- |
| **CI not started** | no build on the latest commit | Run CI, or Update branch & run CI when the branch is behind |
| **CI running** | jobs in progress, with any failures so far | — |
| **N failures to look at** | failing jobs not seen failing anywhere else | — |
| **N failures, likely unrelated** | every failing job also fails on the base branch or on other pinned PRs | Retry failed jobs |
| **CI passed · needs review** | green, waiting on a review | — |
| **Ready to merge** | green and approved | Merge… |
| **Merge conflicts** | the author has to resolve them | — |

A blue dot marks a PR that changed since you last selected it. Drag rows to reorder them or move them between groups, and drag the divider to resize the list.

Selecting a row opens the detail pane: the status with a one-line explanation, the failing and running jobs (each links to its Buildkite job), branch freshness, reviews, labels, and the latest comments — which is where the CI bot answers `/ci` commands.

**+ Add PRs** lists open pull requests in your default repository (yours, review requested, reviewed, involved, `ready`, all recent) and narrows as you type. Click to pin; pasting PR numbers or URLs works too. Type `@name` to see one author's PRs. To keep an eye on particular people, **Follow** them from a PR (or list them in Settings): their names are highlighted everywhere and Add PRs gets a **Following** list.

## Related or unrelated failures

Pingboard does not read logs — Buildkite logs are not reachable from a static page. It sorts failing jobs using what GitHub already knows:

- **N/M on base** — the same job failed on N of the last M base-branch commits that ran CI.
- **also #123 #456** — the same job is failing on other PRs on your board.

A job with either kind of evidence is listed as "likely unrelated". Everything else is "to look at".

## Actions

Everything is done as you, with your token.

- **Comments** (`/ci run`, `/ci retry`, `/ci cancel`) and **branch updates** wait three seconds behind an Undo bar before they are sent.
- **Update branch & run CI** merges the base branch in, waits for the new commit, then posts `/ci run`.
- **Approve** and **Merge** ask for confirmation. **Labels** apply immediately.

Keyboard shortcuts exist for all of it; press `?` for the list.

## GitHub token

Pingboard takes a **classic** personal access token with the `repo` scope (`public_repo` is enough for public repositories). It is sent only from your browser to `api.github.com`, and is kept in `sessionStorage` — or `localStorage` if you tick "Keep token after closing this tab". The board itself (pins, groups, preferences) lives in `localStorage` per GitHub login, so it belongs to one browser and one address. Settings has **Export board + settings** and **Import board + settings** buttons to back it up or move it. The backup never includes the GitHub token.

## GitHub refresh and rate limits

Open PRs refresh every 60 seconds by default (configurable), background tabs five times slower, at one GraphQL request per PR. The base-branch baseline covers the last 30 commits and is re-read every 10 minutes. Remaining API quota is shown in the top bar, and polling pauses if it runs low.

## Other repositories

`owner/repo#123` or a URL pins a PR from anywhere. The Settings button also lets you configure a repository's workflow directly in the browser: which checks count as CI, the gating pipeline, comment commands, quick labels, and merge method. Profiles are selectable from a dropdown and can be deleted; deleting a built-in profile override restores its built-in defaults. These overrides are cached in `localStorage` with the rest of that GitHub user's preferences, so they work on the published site and survive reloads. Built-in defaults live in `REPO_PROFILES` at the top of `app.js`; repositories without a saved or built-in profile start with every check treated as CI and no CI commands.

## Run it

Open `index.html`, or serve the folder:

```bash
python3 -m http.server 8080
```

The included workflow publishes the folder to GitHub Pages on every push to `main`.

## Tests

```bash
./tests/run
```

Runs the checks every pull request has to pass. It needs [Bun](https://bun.sh) and installs everything else itself.

If Bun is unavailable, install the test dependencies with `cd tests && npm install --ignore-scripts --no-package-lock`, run `npx playwright install chromium`, then `node state-compat.mjs --head ..` and `node gitcode.mjs --head ..`. The GitCode browser tests mock all API requests; they never modify a real repository.

To reuse an installed browser, set `PINGBOARD_BROWSER` to its executable path when running the Node test commands. Tests launch a separate temporary profile.
