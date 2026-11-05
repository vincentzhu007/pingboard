"use strict";

/* Issue monitoring shares the board scheduler and storage, but never PR actions. */
function validIssueNumber(number) {
  return /^(?:[1-9]\d*|[A-Za-z][A-Za-z0-9_-]*)$/.test(String(number));
}

function issuePinKey(repo, number) {
  return `${repo}#issue:${number}`;
}

function issueIsClosed(issue) {
  return ["closed", "rejected"].includes(String(issue.state).toLowerCase());
}

function parseIssueRefs(raw, repo) {
  const refs = [];
  for (const token of raw.trim().split(/[\s,]+/).filter(Boolean)) {
    let match;
    if (/^https?:\/\//i.test(token)) {
      let url;
      try { url = new URL(token); } catch { return null; }
      if (url.hostname !== (IS_GITCODE ? "gitcode.com" : "github.com")) return null;
      match = url.pathname.match(/^\/([\w.-]+\/[\w.-]+)\/issues\/([A-Za-z0-9_-]+)\/?$/);
      if (!match || !validIssueNumber(match[2])) return null;
      refs.push({ repo: match[1], number: match[2] });
    } else if ((match = token.match(/^([\w.-]+\/[\w.-]+)#([A-Za-z0-9_-]+)$/)) && validIssueNumber(match[2])) {
      refs.push({ repo: match[1], number: match[2] });
    } else if (repo && /^#?(?:[1-9]\d*|I[A-Za-z0-9_-]+)$/.test(token)) {
      refs.push({ repo, number: token.replace(/^#/, "") });
    } else return null;
  }
  return refs.length ? refs : null;
}

async function listIssues(repo, status = "open", isCurrent = () => true) {
  const items = new Map();
  for (let page = 1; page <= 100; page += 1) {
    if (!isCurrent()) return [];
    const query = new URLSearchParams({ state: status, sort: "updated", direction: "desc", per_page: "100", page: String(page) });
    const batch = await rest("GET", `/repos/${repo}/issues?${query}`);
    if (!Array.isArray(batch)) throw new Error("The platform returned an invalid issue list");
    for (const issue of batch) {
      // GitHub's Issues API also returns PRs; those stay in the PR workflow.
      if (!issue.pull_request && validIssueNumber(issue.number)) items.set(String(issue.number), issue);
    }
    if (batch.length < 100) return [...items.values()];
  }
  throw new Error("Issue list exceeded 100 pages; the scan was not applied");
}

async function fetchIssue(pin) {
  const path = `/repos/${pin.repo}/issues/${encodeURIComponent(pin.number)}`;
  const issue = await rest("GET", path);
  if (!issue || !validIssueNumber(issue.number) || issue.pull_request) throw new Error("Issue not found (this may be a pull request)");
  const comments = await rest("GET", `${path}/comments?per_page=30&page=1`);
  if (!Array.isArray(comments)) throw new Error("The platform returned invalid issue comments");
  const assignees = issue.assignees || (issue.assignee ? [issue.assignee] : []);
  return {
    key: pin.key, kind: "issue", repo: pin.repo, number: String(issue.number), title: issue.title,
    url: safeUrl(issue.html_url) || `https://${IS_GITCODE ? "gitcode.com" : "github.com"}/${pin.repo}/issues/${encodeURIComponent(pin.number)}`,
    state: issueIsClosed(issue) ? "CLOSED" : "OPEN",
    issueStatus: issue.issue_state_detail?.title || issue.issue_state || issue.state || "Unknown",
    body: issue.body || "", author: issue.user?.login || "ghost", updatedAt: issue.updated_at,
    assignees: assignees.map((user) => user.login).filter(Boolean),
    labels: (issue.labels || []).map((label) => ({ name: typeof label === "string" ? label : label.name, color: (label.color || "888888").replace(/^#/, "") })),
    commentCount: Number(issue.comments) || 0,
    comments: comments.map((comment) => ({ text: comment.body || "", login: comment.user?.login || "ghost", at: comment.created_at, url: safeUrl(comment.html_url) })),
    // The shared row renderer expects an empty CI summary. No CI is inferred for issues.
    ci: summarizeCi([], GENERIC_PROFILE), reviews: [], checks: []
  };
}

function openIssues(groupId = null) {
  const repo = IS_GITCODE ? state.prefs.activeRepo : state.prefs.defaultRepo;
  if (!repo) return chooseDefaultRepo(openIssues);
  let items = [];
  let loadedTab = null;
  let request = 0;
  const search = async (modal) => {
    if (parseIssueRefs(modal.query, repo)) return modal.update();
    if (loadedTab === modal.tab) return modal.update();
    const version = ++request;
    const tab = modal.tab;
    modal.loading = true;
    modal.error = "";
    items = [];
    modal.update();
    try {
      const result = await listIssues(repo, tab);
      if (version !== request) return;
      items = result;
      loadedTab = tab;
    } catch (error) {
      if (version === request) modal.error = error.message;
    } finally {
      if (version === request) { modal.loading = false; if (state.modal === modal) modal.update(); }
    }
  };
  const modal = openPicker({
    title: `Add issues · ${repo}`, placeholder: "Filter by title, or paste issue numbers / URLs",
    hint: "Click to pin or unpin. Issue pins are separate from PR pins.",
    tabs: [{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }, { id: "all", label: "All" }],
    onQuery: search, onTab: search,
    getItems(query, picker) {
      const refs = parseIssueRefs(query, repo);
      picker.emptyText = picker.error || (picker.loading ? "Loading issues…" : "No issues match");
      const shown = refs || items.filter((issue) => (issue.title || "").toLowerCase().includes(query.trim().toLowerCase())).map((issue) => ({ repo, number: String(issue.number), title: issue.title }));
      return shown.map((item) => {
        const id = issuePinKey(item.repo, item.number);
        return { ...item, id, node: el("div", { class: `result${pinByKey(id) ? " pinned" : ""}` }, [
          el("span", { class: "num", text: `Issue #${item.number}` }),
          el("span", { class: "title-text", text: item.title || item.repo }),
          el("span", { class: "pin-mark", text: pinByKey(id) ? "✓ Pinned" : "Pin" })
        ]) };
      });
    },
    onPick(item, picker) {
      if (!item) return;
      const refs = parseIssueRefs(picker.query, repo);
      const selected = refs || [item];
      if (IS_GITCODE && selected.some((ref) => ref.repo !== repo)) return toast("Switch to that repository board first", "error");
      for (const ref of selected) {
        const key = issuePinKey(ref.repo, ref.number);
        if (!refs && pinByKey(key)) removePin(key);
        else addPin(ref.repo, String(ref.number), boardGroups().find((group) => group.id === groupId)?.id || ensureGroup("Issues", IS_GITCODE ? ref.repo : undefined).id, "issue");
      }
      if (refs) { picker.query = ""; picker.input.value = ""; search(picker); }
      render();
    }
  });
  search(modal);
}

function renderIssueDetail(detail, issue, pin) {
  const button = (text, onclick) => el("button", { class: "btn", text, onclick });
  detail.replaceChildren(
    el("div", { class: "detail-head" }, [
      el("div", { class: "btn-row detail-tools" }, [
        button(`Open on ${PROVIDER_NAME} ↗`, () => openUrl(issue.url)),
        button("Copy issue link", () => copyItemLink(issue)),
        button("Move to group…", () => openGroupPicker(pin)),
        button("Refresh", () => queueRefresh(pin, { force: true })), button("Unpin", () => removePin(pin.key))
      ]),
      el("p", { class: "muted", text: `${issue.repo} · Issue #${issue.number} · ${issue.author} · updated ${ago(issue.updatedAt)} ago` }),
      el("h2", { text: issue.title }),
      el("p", { text: `Status: ${issue.issueStatus}` }),
      el("p", { text: `Assignees: ${issue.assignees.join(", ") || "Unassigned"}` }),
      el("div", { class: "label-wrap" }, issue.labels.map(labelChip))
    ]),
    panel("Description", [el("div", { style: "white-space:pre-wrap;overflow-wrap:anywhere", text: issue.body || "No description." })]),
    panel("Comments · first 30", issue.comments.length ? issue.comments.map((comment) => el("div", { class: "panel" }, [
      el("p", { class: "muted small", text: `${comment.login} · ${ago(comment.at)} ago` }),
      el("div", { style: "white-space:pre-wrap;overflow-wrap:anywhere", text: comment.text })
    ])) : [el("p", { class: "muted", text: "No comments." })])
  );
}
