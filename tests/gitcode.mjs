/* GitCode contract and browser regression tests; all remote requests are mocked. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const at = process.argv.indexOf("--head");
const root = path.resolve(at < 0 ? ".." : process.argv[at + 1]);
const origin = "http://pingboard.test";
const browser = await chromium.launch({ executablePath: process.env.PINGBOARD_BROWSER || undefined });
const context = await browser.newContext();
const requests = [];
const errors = [];
let gate = { state: false, conflict_passed: true, ci_state_passed: false,
  approval_reviewers_required_passed: false, approval_approvers_required_passed: true };
let sha = "abc123";
let unauthorized = false;
let monitorPages = false;
let newPR = false;
let failScan = false;
const pr = () => ({ id: 10, number: 42, title: "GitCode test PR", state: "open", draft: false,
  html_url: "https://gitcode.com/example-org/sample-project/pull/42", user: { login: "alice" },
  head: { sha }, base: { ref: "master" }, updated_at: new Date().toISOString(),
  labels: [{ name: "ready", color: "#ff0000" }], assignees: [{ login: "reviewer", accept: false }],
  mergeable_state: gate });
await context.route("**/*", (route) => route.abort());
await context.route(`${origin}/**`, async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === "/blank") return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  await route.fulfill({ contentType: file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html", body: await readFile(path.join(root, file)) });
});
await context.route("https://api.gitcode.com/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  requests.push({ path: url.pathname, query: url.search, method: request.method(), body: request.postDataJSON(), headers: request.headers() });
  const headers = { "access-control-allow-origin": "*" };
  if (unauthorized) return route.fulfill({ status: 401, headers, json: { message: "Bad token" } });
  let json;
  if (url.pathname === "/api/v5/user") json = { login: "tester" };
  else if (url.pathname.endsWith("/comments")) json = request.method() === "POST" ? {} : [{ body: "CI pending", user: { login: "bot" }, created_at: new Date().toISOString() }];
  else if (url.pathname.endsWith("/review")) json = {};
  else if (url.pathname.endsWith("/merge")) json = { merged: true };
  else if (/\/pulls\/\d+$/.test(url.pathname)) json = { ...pr(), number: Number(url.pathname.split("/").pop()) };
  else if (url.pathname.endsWith("/pulls")) {
    if (failScan && url.searchParams.get("page") === "2") return route.fulfill({ status: 500, headers, json: { message: "Scan unavailable" } });
    json = !monitorPages ? [pr()] : url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, () => pr())
      : [{ ...pr(), number: 43 }, ...(newPR ? [{ ...pr(), number: 44 }] : [])];
  }
  else throw new Error(`Unexpected GitCode API: ${request.method()} ${url}`);
  await route.fulfill({ headers, json });
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${origin}/blank`);
  await page.evaluate(() => {
    localStorage.setItem("pingboard.provider", "gitcode");
    localStorage.setItem("pingboard.githubToken", "github-secret");
    localStorage.setItem("pingboard.v3.tester.board", JSON.stringify({ groups: [{ id: "gh", name: "GitHub only" }], pins: [] }));
  });
  await page.goto(origin);
  await page.locator("#token").fill("gitcode-secret");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForFunction(() => Boolean(state.user));
  assert.equal(await page.evaluate(() => state.board.groups[0].name), "Tracking");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("pingboard.gitcodeSessionToken")), "gitcode-secret");
  assert.equal(await page.evaluate(() => localStorage.getItem("pingboard.githubToken")), "github-secret");
  const refs = await page.evaluate(() => [parseRefs("https://gitcode.com/example-org/sample-project/pull/42/files?x=1#note"), parseRefs("https://github.com/example-org/sample-project/pull/42"), parseRefs("https://gitcode.com.evil.test/example-org/sample-project/pull/42"), parseRefs("https://"), parseRefs("example-org/sample-project#42")]);
  assert.deepEqual(refs, [[{ repo: "example-org/sample-project", number: 42 }], null, null, null, [{ repo: "example-org/sample-project", number: 42 }]]);
  assert.equal(await page.evaluate(() => state.prefs.defaultRepo), "");
  assert.equal(await page.evaluate(() => parseRefs("42")), null);
  assert.equal(requests.filter((request) => request.path.includes("/repos/")).length, 0);
  await page.evaluate(() => openAdd());
  await page.getByRole("textbox", { name: "Choose a repository" }).fill("example-org/sample-project");
  await page.getByRole("button", { name: "Use repository", exact: true }).click();
  await page.waitForFunction(() => searchCache.size > 0);
  await page.getByText("GitCode test PR", { exact: true }).click();
  await page.evaluate(() => closeModal());
  await page.waitForFunction(() => state.data.has("example-org/sample-project#42"));
  assert.match(await page.locator("#app").innerText(), /CI gate not satisfied/);
  assert.doesNotMatch(await page.locator("#app").innerText(), /CI passed|undefined/);
  assert.equal(await page.evaluate(() => state.data.get("example-org/sample-project#42").labels[0].color), "ff0000");
  assert.equal(await page.evaluate(() => FILTERS.some((filter) => filter.id === "noci")), false);
  await page.evaluate(() => searchGitCodePRs("example-org/sample-project", { tab: "requested", query: "@alice test" }));
  const search = requests.findLast((request) => request.path.endsWith("/pulls"));
  assert.match(search.query, /author=alice/);
  assert.match(search.query, /reviewer=tester/);
  await page.evaluate(() => postComment(cursorPR(), "/ci run"));
  await page.waitForFunction(() => state.pending.length === 0);
  await page.waitForTimeout(100);
  assert.deepEqual(requests.find((request) => request.method === "POST" && request.path.endsWith("/comments"))?.body, { body: "/ci run" });
  await page.evaluate(() => approve());
  await page.getByRole("button", { name: "Submit approving review" }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(requests.find((request) => request.path.endsWith("/review"))?.body, { force: false });
  gate = { ...gate, state: true, ci_state_passed: true, approval_reviewers_required_passed: true };
  await page.evaluate(async () => { const pin = pinByKey("example-org/sample-project#42"); state.data.set(pin.key, await fetchPR(pin)); render(); });
  await page.evaluate(() => mergeMenu());
  assert.equal(await page.getByText(/Enable auto-merge/).count(), 0);
  await page.getByRole("button", { name: "Squash and merge now" }).click();
  await page.waitForTimeout(150);
  assert.deepEqual(requests.find((request) => request.path.endsWith("/merge"))?.body, { merge_method: "merge", squash: true, force_merge: false });
  const verdicts = await page.evaluate(() => {
    const pr = cursorPR();
    return [
      verdict({ ...pr, state: "MERGED" }).text,
      verdict({ ...pr, state: "CLOSED" }).text,
      verdict({ ...pr, isDraft: true }).text,
      verdict({ ...pr, mergeable: "CONFLICTING" }).text,
      verdict({ ...pr, gitcodeGate: {} }).text,
      verdict({ ...pr, gitcodeGate: { ci_state_passed: true } }).text
    ];
  });
  assert.deepEqual(verdicts, ["Merged", "Closed", "Draft", "Merge conflicts", "Check merge requirements", "Check merge requirements"]);
  await page.screenshot({ path: "/tmp/pingboard-gitcode-test.png", fullPage: true });
  const mergeCount = requests.filter((request) => request.path.endsWith("/merge")).length;
  sha = "changed-commit";
  await page.evaluate(() => mergeMenu());
  await page.getByRole("button", { name: "Squash and merge now" }).click();
  await page.waitForTimeout(150);
  assert.equal(requests.filter((request) => request.path.endsWith("/merge")).length, mergeCount);
  await page.evaluate(() => importBoard({ name: "github.json", text: async () => JSON.stringify({ provider: "github", board: state.board }) }));
  assert.equal(await page.evaluate(() => state.modal), null);
  await page.reload();
  await page.waitForFunction(() => Boolean(state.user) && state.data.has("example-org/sample-project#42"));
  assert.equal(await page.evaluate(() => state.board.pins.length), 1);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pingboard.v3.tester.board")).groups[0].name), "GitHub only");
  assert.ok(requests.every((request) => request.headers.authorization === "Bearer gitcode-secret"));
  assert.ok(requests.every((request) => !request.query.includes("secret") && !request.path.includes("graphql") && !request.path.includes("/issues/")));
  monitorPages = true;
  await page.getByRole("button", { name: "Monitor repository", exact: true }).click();
  await page.waitForFunction(() => !repoMonitor.loading && state.data.has("example-org/sample-project#43"));
  assert.equal(await page.evaluate(() => state.board.pins.length), 2);
  assert.ok(requests.some((request) => request.path.endsWith("/pulls") && request.query.includes("page=2")));
  await page.evaluate(() => removePin("example-org/sample-project#43"));
  await page.evaluate(() => refreshRepoMonitor(true));
  assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/sample-project#43"))), false);
  newPR = true;
  failScan = true;
  await page.evaluate(() => refreshRepoMonitor(true));
  assert.match(await page.evaluate(() => repoMonitor.error), /Scan unavailable/);
  assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/sample-project#44"))), false);
  failScan = false;
  await page.evaluate(() => refreshRepoMonitor(true));
  await page.waitForFunction(() => state.data.has("example-org/sample-project#44"));
  assert.equal(await page.evaluate(() => repoMonitor.error), "");
  await page.reload();
  await page.waitForFunction(() => Boolean(state.user) && repoMonitor.at > 0 && !repoMonitor.loading);
  assert.equal(await page.evaluate(() => state.prefs.monitoredRepo), "example-org/sample-project");
  assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/sample-project#43"))), false);
  await page.screenshot({ path: "/tmp/pingboard-monitor-test.png", fullPage: true });
  await page.getByRole("button", { name: "Stop monitoring", exact: true }).click();
  assert.equal(await page.evaluate(() => state.prefs.monitoredRepo), null);
  assert.equal(await page.evaluate(() => state.board.pins.length), 2);
  unauthorized = true;
  await page.evaluate(() => rest("GET", "/user").catch(() => {}));
  await page.waitForFunction(() => !state.user);
  await page.getByText("GitCode rejected the token.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem("pingboard.gitcodeSessionToken")), null);
  assert.deepEqual(errors, []);
  console.log("GitCode browser regression checks passed.");
} finally {
  await browser.close();
}
