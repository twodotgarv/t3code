const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mergeCandidate } = require("./sync-upstream.cjs");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-upstream-sync-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Sync test");
  git("config", "user.email", "sync@example.invalid");
  const commit = (file, content) => {
    fs.writeFileSync(path.join(cwd, file), content);
    git("add", file);
    git("commit", "-m", `Update ${file}`);
    return git("rev-parse", "HEAD");
  };
  const root = commit("shared.txt", "base\n");
  git("branch", "upstream", root);
  return { cwd, git, commit };
}

test("does nothing when fork main already contains upstream", (t) => {
  const { cwd, git, commit } = fixture(t);
  const upstream = git("rev-parse", "upstream");
  const base = commit("webhook.txt", "custom feature\n");
  assert.equal(mergeCandidate(cwd, { base, upstream }), null);
  assert.equal(git("rev-parse", "HEAD"), base);
});

test("merges upstream while preserving fork changes and repeated updates", (t) => {
  const { cwd, git, commit } = fixture(t);
  const base = commit("webhook.txt", "custom feature\n");
  git("checkout", "upstream");
  const upstream = commit("upstream.txt", "first\n");
  const first = mergeCandidate(cwd, { base, upstream });
  assert.equal(fs.readFileSync(path.join(cwd, "webhook.txt"), "utf8"), "custom feature\n");
  assert.equal(fs.readFileSync(path.join(cwd, "upstream.txt"), "utf8"), "first\n");
  assert.equal(mergeCandidate(cwd, { base, upstream, previous: first }), first);
  const resolution = commit("resolution.txt", "owner changes on sync branch\n");
  git("checkout", "main");
  const nextBase = commit("fork-next.txt", "next fork change\n");
  git("checkout", "upstream");
  const nextUpstream = commit("upstream.txt", "second\n");
  const second = mergeCandidate(cwd, {
    base: nextBase,
    upstream: nextUpstream,
    previous: resolution,
  });
  for (const ancestor of [first, resolution, nextBase, nextUpstream]) {
    assert.doesNotThrow(() => git("merge-base", "--is-ancestor", ancestor, second));
  }
  assert.equal(fs.readFileSync(path.join(cwd, "webhook.txt"), "utf8"), "custom feature\n");
  assert.equal(
    fs.readFileSync(path.join(cwd, "resolution.txt"), "utf8"),
    "owner changes on sync branch\n",
  );
});

test("aborts a conflicting merge without changing either source branch", (t) => {
  const { cwd, git, commit } = fixture(t);
  const base = commit("shared.txt", "fork version\n");
  git("checkout", "upstream");
  const upstream = commit("shared.txt", "upstream version\n");
  assert.throws(
    () => mergeCandidate(cwd, { base, upstream }),
    /Resolve these files.*\nshared\.txt/,
  );
  assert.equal(git("rev-parse", "main"), base);
  assert.equal(git("rev-parse", "upstream"), upstream);
  assert.equal(git("rev-parse", "HEAD"), base);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(fs.existsSync(path.join(cwd, ".git", "MERGE_HEAD")), false);
  // An owner can resolve on the dedicated branch, then the next run preserves it.
  try {
    git("merge", "--no-edit", upstream);
  } catch {}
  commit("shared.txt", "resolved version\n");
  const resolved = git("rev-parse", "HEAD");
  assert.equal(mergeCandidate(cwd, { base, upstream, previous: resolved }), resolved);
  assert.equal(fs.readFileSync(path.join(cwd, "shared.txt"), "utf8"), "resolved version\n");
});

function finishFixture(t, overrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-upstream-finish-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const state = {
    pr: {
      number: 23,
      state: "open",
      draft: true,
      node_id: "PR_node",
      head: { sha: "candidate" },
      html_url: "https://github.com/twodotgarv/t3code/pull/23",
    },
    main: "base",
    validation: "success",
    ...overrides,
  };
  fs.writeFileSync(path.join(cwd, "state.json"), JSON.stringify(state));
  // The real CLI script runs with a fake gh binary. No network or repository writes.
  fs.writeFileSync(
    path.join(cwd, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.env.SYNC_TEST_DIR;
const state = JSON.parse(fs.readFileSync(path.join(cwd, "state.json"), "utf8"));
const endpoint = process.argv[3];
const method = process.argv[5];
const body = process.argv.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : null;
fs.appendFileSync(path.join(cwd, "calls.jsonl"), JSON.stringify({ endpoint, method, body }) + "\\n");
if (endpoint.endsWith("/pulls/23")) console.log(JSON.stringify(state.pr));
else if (endpoint.endsWith("/git/ref/heads/main")) console.log(JSON.stringify({ object: { sha: state.main } }));
else if (endpoint === "graphql") console.log("{}");
else throw new Error("Unexpected endpoint " + endpoint);
`,
    { mode: 0o755 },
  );
  const result = require("node:child_process").spawnSync(
    process.execPath,
    [path.join(__dirname, "sync-upstream.cjs"), "finish"],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${cwd}${path.delimiter}${process.env.PATH}`,
        SYNC_TEST_DIR: cwd,
        GITHUB_REPOSITORY: "twodotgarv/t3code",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "42",
        GITHUB_STEP_SUMMARY: path.join(cwd, "summary.md"),
        SYNC_BASE: "base",
        SYNC_UPSTREAM: "upstream",
        SYNC_HEAD: "candidate",
        SYNC_PR: "23",
        VALIDATION_RESULT: state.validation,
      },
    },
  );
  const calls = fs
    .readFileSync(path.join(cwd, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, calls, summary: fs.readFileSync(path.join(cwd, "summary.md"), "utf8") };
}

test("makes the exact passing candidate ready and records its proof", (t) => {
  const { result, calls, summary } = finishFixture(t);
  assert.equal(result.status, 0, result.stderr);
  const changes = calls.filter((call) => call.method !== "GET");
  assert.equal(changes.length, 2);
  assert.equal(changes[0].method, "PATCH");
  assert.match(changes[0].body.body, /Candidate: `candidate`\. Base: `base`/);
  assert.match(changes[0].body.body, /Passed on the candidate/);
  assert.match(changes[1].body.query, /markPullRequestReadyForReview/);
  assert.match(summary, /Owner review is still required/);
});

for (const [name, overrides, message] of [
  ["failed validation", { validation: "failure" }, /Validation failed/],
  ["cancelled validation", { validation: "cancelled" }, /Validation failed or was cancelled/],
  ["main moved", { main: "new-base" }, /Stale validation/],
  [
    "candidate moved",
    { pr: { state: "open", draft: false, node_id: "PR_node", head: { sha: "new-head" } } },
    /Stale validation/,
  ],
]) {
  test(`keeps an update in draft when ${name}`, (t) => {
    const { result, calls, summary } = finishFixture(t, overrides);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(
      calls.some((call) => call.body?.query?.includes("markPullRequestReadyForReview")),
      false,
    );
    const update = calls.find((call) => call.method === "PATCH");
    assert.match(update.body.body, message);
    assert.match(summary, message);
    if (overrides.pr) {
      assert.equal(
        calls.some((call) => call.body?.query?.includes("convertPullRequestToDraft")),
        true,
      );
    }
  });
}

test("does not edit or reopen a PR closed during validation", (t) => {
  const { result, calls, summary } = finishFixture(t, {
    pr: { state: "closed", draft: false, node_id: "PR_node", head: { sha: "candidate" } },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    calls.every((call) => call.method === "GET"),
    true,
  );
  assert.match(summary, /Stale validation/);
});
