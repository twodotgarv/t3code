const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const branch = "gg/sync-t3-upstream";
const title = "[Garv] - Sync T3 upstream";
const upstreamUrl = "https://github.com/pingdotgg/t3code.git";

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options }).trim();
}

function git(cwd, ...args) {
  return run("git", args, { cwd });
}

function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

// Keep prior conflict resolutions and fork commits. A regular push rejects races.
function mergeCandidate(cwd, { base, upstream, previous }) {
  if (isAncestor(cwd, upstream, base)) return null;
  git(cwd, "checkout", "--detach", previous || base);
  for (const ref of [base, upstream]) {
    try {
      git(cwd, "merge", "--no-edit", "--no-ff", ref);
    } catch (error) {
      const files = git(cwd, "diff", "--name-only", "--diff-filter=U");
      git(cwd, "merge", "--abort");
      throw new Error(
        `Cannot merge ${ref}. Resolve these files on ${branch}:\n${files || error.message}`,
        { cause: error },
      );
    }
  }
  return git(cwd, "rev-parse", "HEAD");
}

function api(endpoint, method = "GET", data) {
  const args = ["api", endpoint, "--method", method];
  if (data) args.push("--input", "-");
  return JSON.parse(run("gh", args, { input: data ? JSON.stringify(data) : undefined }));
}

function setDraft(pr, draft) {
  if (pr.draft === draft) return;
  api("graphql", "POST", {
    query: `mutation($id: ID!) { ${draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview"}(input: {pullRequestId: $id}) { pullRequest { id } } }`,
    variables: { id: pr.node_id },
  });
}

function body({ base, upstream, head, status, url }) {
  return `## User stories\n\n- As the fork owner, I want to review upstream updates while keeping my fork changes.\n\n## Desired behaviour\n\nMerge pingdotgg/t3code main into this fork only after owner review.\n\n## Behavioural change\n\n- Before: fork main is based on \`${base}\`.\n- After: this branch includes upstream \`${upstream}\` and preserves the fork history.\n\n## Validation\n\n${status}\n\nCandidate: \`${head || "not prepared"}\`. Base: \`${base}\`.\n\n[Workflow run](${url}). Fast checks do not replace the full CI suite or owner review.\n\nGenerated with GPT-6.1 Sol through Codex.\n`;
}

function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo !== "twodotgarv/t3code" || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Run this workflow only from twodotgarv/t3code main.");
  }
  const url = `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const cwd = process.cwd();
  const endpoint = `repos/${repo}/pulls`;
  if (process.argv[2] === "prepare") {
    git(cwd, "fetch", "origin", "+refs/heads/main:refs/remotes/origin/main");
    git(cwd, "fetch", upstreamUrl, "main");
    const base = git(cwd, "rev-parse", "origin/main");
    const upstream = git(cwd, "rev-parse", "FETCH_HEAD");
    let pr = api(`${endpoint}?state=open&head=twodotgarv:${branch}&base=main`)[0];
    const details = { base, upstream, url, head: pr?.head.sha };
    if (pr) {
      setDraft(pr, true);
      api(`${endpoint}/${pr.number}`, "PATCH", {
        title,
        body: body({
          ...details,
          status: "Update in progress. Previous validation does not apply to this run.",
        }),
      });
    }
    try {
      if (isAncestor(cwd, upstream, base)) {
        if (pr) api(`${endpoint}/${pr.number}`, "PATCH", { state: "closed" });
        fs.appendFileSync(process.env.GITHUB_OUTPUT, "active=false\n");
        summary(`Fork main already contains upstream ${upstream}. No update is needed.`);
        return;
      }
      let previous;
      if (git(cwd, "ls-remote", "--heads", "origin", `refs/heads/${branch}`)) {
        git(cwd, "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        previous = git(cwd, "rev-parse", `origin/${branch}`);
      }
      git(cwd, "config", "user.name", "github-actions[bot]");
      git(cwd, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
      details.head = mergeCandidate(cwd, { base, upstream, previous });
      git(
        cwd,
        "-c",
        "credential.helper=",
        "-c",
        "credential.https://github.com.helper=!gh auth git-credential",
        "push",
        "origin",
        `HEAD:refs/heads/${branch}`,
      );
      const data = {
        title,
        body: body({
          ...details,
          status: "Pending validation. Keep this PR in draft until the exact candidate passes.",
        }),
      };
      pr = pr
        ? api(`${endpoint}/${pr.number}`, "PATCH", data)
        : api(endpoint, "POST", { ...data, head: branch, base: "main", draft: true });
      fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `active=true\nbase=${base}\nupstream=${upstream}\nhead=${details.head}\npr=${pr.number}\n`,
      );
      summary(
        `Prepared [PR #${pr.number}](${pr.html_url}) at ${details.head}. Validation is pending.`,
      );
    } catch (error) {
      const message = `Sync stopped. The published sync branch was not force-replaced.\n\n${error.message}\n\nResolve conflicts on ${branch}, push the resolution, then run this workflow again from main.`;
      if (pr)
        api(`${endpoint}/${pr.number}`, "PATCH", { body: body({ ...details, status: message }) });
      summary(message);
      throw error;
    }
  } else if (process.argv[2] === "finish") {
    const {
      SYNC_BASE: base,
      SYNC_UPSTREAM: upstream,
      SYNC_HEAD: head,
      SYNC_PR: number,
    } = process.env;
    const pr = api(`${endpoint}/${number}`);
    const currentBase = api(`repos/${repo}/git/ref/heads/main`).object.sha;
    const passed = process.env.VALIDATION_RESULT === "success";
    const current = pr.state === "open" && pr.head.sha === head && currentBase === base;
    const status = !current
      ? "Stale validation. The PR or main changed during this run. Run the workflow again."
      : passed
        ? "Passed on the candidate above: sync integration tests and `vp run check:changed` against the explicit fork base. This is a focused check, not the full CI suite. Owner review is still required."
        : "Validation failed or was cancelled. See the workflow logs. Fix the sync branch and run the workflow again.";
    if (pr.state === "open") {
      setDraft(pr, true);
      api(`${endpoint}/${number}`, "PATCH", { body: body({ base, upstream, head, url, status }) });
      if (passed && current) setDraft({ ...pr, draft: true }, false);
    }
    summary(`${status}\n\n[PR #${number}](${pr.html_url}), candidate ${head}.`);
    if (!passed || !current) process.exitCode = 1;
  } else {
    throw new Error("Expected prepare or finish.");
  }
}

module.exports = { mergeCandidate };
if (require.main === module)
  main().catch((error) => {
    summary(`Upstream sync failed: ${error.message}`);
    process.exitCode = 1;
  });
