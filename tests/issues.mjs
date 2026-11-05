import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const arg = process.argv.indexOf("--head");
const root = path.resolve(arg < 0 ? ".." : process.argv[arg + 1]);
const browser = await chromium.launch({ executablePath: process.env.PINGBOARD_BROWSER || undefined });
const origin = "http://pingboard.test";
try {
  for (const provider of ["gitcode", "github"]) {
    const context = await browser.newContext();
    const requests = [];
    const errors = [];
    let closed = false;
    let failList = false;
    let extra = false;
    const repo = "example-org/project";
    const issue = (number = "42") => ({ number, title: `Issue ${number}`, body: "<script>unsafe()</script>\nDescription", state: closed ? "closed" : provider === "gitcode" ? "opened" : "open", user: { login: "author" }, assignee: { login: "maintainer" }, labels: [{ name: "bug", color: "#ff0000" }], updated_at: "2026-11-04T10:00:00Z", comments: 1, html_url: `https://${provider}.com/${repo}/issues/${number}` });
    await context.route("**/*", (route) => route.abort());
    await context.route(`${origin}/**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/blank") return route.fulfill({ contentType: "text/html", body: "<!doctype html>" });
      const file = pathname === "/" ? "index.html" : pathname.slice(1);
      await route.fulfill({ contentType: file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html", body: await readFile(path.join(root, file)) });
    });
    await context.route(`https://api.${provider}.com/**`, async (route) => {
      const request = route.request();
      requests.push({ method: request.method(), url: request.url() });
      const url = new URL(request.url());
      let json;
      if (url.pathname.endsWith("/user")) json = { login: "tester" };
      else if (url.pathname.endsWith("/comments")) json = [{ body: "Comment text", user: { login: "reviewer" }, created_at: "2026-11-04T10:00:00Z" }];
      else if (/\/issues\/[A-Za-z0-9]+$/.test(url.pathname)) json = issue(url.pathname.split("/").pop());
      else if (url.pathname.endsWith("/issues")) {
        if (failList && url.searchParams.get("page") === "2") return route.fulfill({ status: 500, json: { message: "List unavailable" } });
        json = url.searchParams.get("page") === "1" ? Array.from({ length: 100 }, () => issue()) : [issue("IABC9"), ...(extra ? [issue("43")] : []), ...(provider === "github" ? [{ ...issue("90"), pull_request: {} }] : [])];
      } else if (url.pathname.endsWith("/pulls/42")) json = { number: 42, title: "PR 42", state: "open", user: { login: "author" }, head: { sha: "abc" }, base: { ref: "main" }, mergeable_state: { conflict_passed: true } };
      else if (url.pathname.endsWith("/graphql")) json = { data: { repository: { ref: null, pullRequest: { number: 42, title: "PR 42", state: "OPEN", baseRefName: "main", commits: { nodes: [] }, labels: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, comments: { nodes: [] } } } } };
      else throw new Error(`Unexpected API request ${url}`);
      await route.fulfill({ json, headers: { "access-control-allow-origin": "*" } });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/blank`);
    await page.evaluate(({ provider, repo }) => {
      localStorage.setItem("pingboard.provider", provider);
      localStorage.setItem(provider === "gitcode" ? "pingboard.gitcodeToken" : "pingboard.githubToken", "mock-token");
      localStorage.setItem(`pingboard.v3.${provider === "gitcode" ? "gitcode." : ""}tester.prefs`, JSON.stringify({ defaultRepo: repo, activeRepo: repo }));
    }, { provider, repo });
    await page.goto(origin);
    await page.locator("header").getByRole("button", { name: "+ Add Issues", exact: true }).waitFor();
    await page.evaluate(() => addPin("example-org/project", 42));
    await page.waitForFunction(() => state.data.has("example-org/project#42"));
    await page.locator("header").getByRole("button", { name: "+ Add Issues", exact: true }).click();
    await page.getByText("Issue IABC9", { exact: true }).waitFor();
    if (provider === "github") assert.equal(await page.getByText("Issue 90", { exact: true }).count(), 0);
    await page.locator(".picker-item").filter({ has: page.getByText("Issue #42", { exact: true }) }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForFunction(() => state.data.has("example-org/project#issue:42"));
    await page.evaluate(() => setCursor("example-org/project#issue:42"));
    await page.getByRole("button", { name: "Copy issue link", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
    assert.match(await page.locator("#detail").innerText(), /maintainer/);
    assert.match(await page.locator("#detail").innerText(), /<script>unsafe\(\)<\/script>/);
    assert.equal(await page.locator("#detail script").count(), 0);
    await page.screenshot({ path: `/tmp/pingboard-${provider}-issues.png`, fullPage: true });
    await page.evaluate(() => { approve(); mergeMenu(); ciCommand("run"); updateBranch(); });
    assert.ok(requests.every((request) => request.method === "GET" || request.url.endsWith("/graphql")));
    assert.equal(await page.evaluate(() => FILTERS.find((item) => item.id === "issues-open").test(cursorPR())), true);
    await page.locator("header").getByRole("button", { name: "+ Add Issues", exact: true }).click();
    await page.getByText("Issue IABC9", { exact: true }).waitFor();
    await page.locator(".picker-item").filter({ has: page.getByText("Issue #IABC9", { exact: true }) }).click();
    await page.locator(".picker-item").filter({ has: page.getByText("Issue #42", { exact: true }) }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForFunction(() => state.data.has("example-org/project#issue:IABC9"));
    extra = true;
    await page.evaluate(() => refreshAll());
    assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/project#issue:42"))), false);
    assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/project#42"))), true);
    assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/project#issue:43"))), false);
    failList = true;
    await page.locator("header").getByRole("button", { name: "+ Add Issues", exact: true }).click();
    await page.getByText(/List unavailable/).waitFor();
    assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/project#issue:43"))), false);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    failList = false;
    closed = true;
    await page.evaluate(async () => { const pin = pinByKey("example-org/project#issue:IABC9"); await refreshPin(pin); setCursor(pin.key); });
    await page.waitForFunction(() => cursorPR()?.state === "CLOSED");
    assert.equal(await page.evaluate(() => FILTERS.find((item) => item.id === "issues-closed").test(cursorPR())), true);
    await page.reload();
    await page.waitForFunction(() => state.user && state.data.has("example-org/project#issue:IABC9"));
    assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/project#42"))), true);
    assert.equal(await page.evaluate(() => Boolean(pinByKey("example-org/project#issue:42"))), false);
    assert.equal(await page.evaluate(() => pinByKey("example-org/project#issue:IABC9").kind), "issue");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${provider}: issue monitoring regression checks passed.`);
  }
} finally {
  await browser.close();
}
