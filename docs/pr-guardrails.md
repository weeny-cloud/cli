# PR prompt and version guardrails

Every PR gets a native **Prompt size** check and one updated GitHub Actions
comment with small token/word badges, inventory totals, and before/after counts
for changed files. A no-prompt-change PR gets a zero-delta report too. The report
never sends private file contents or counts to a third-party badge service.

## Inventory and measurement

`.github/prompt-files.json` is the maintained inventory. It covers agent policy,
skills, dedicated prompt directories and this repository's agent-facing surfaces.
Add new prompt locations here; common nested AGENTS.md/CLAUDE.md/SKILL.md files
are already covered by globs. The PR template reminds authors to update it.

- Tokens use pinned `tiktoken==0.12.0` and `o200k_base` for a consistent comparison.
  These are exact counts for that encoding, not universal counts for every model.
- Words are nonempty whitespace-separated strings; bytes are UTF-8 bytes in the JSON artifact.
- The entire matched file is counted. Mixed MCP TypeScript files include code,
  schemas and error text; this report does not claim to reconstruct a runtime prompt.
- Totals sum the inventory, including authored and served/mirrored copies. They
  do not represent a single model request. Token/word increases are informational,
  with no arbitrary growth limit or opt-in requirement.
- Prompt changes compare the PR merge-base with the PR head, so unrelated main
  changes are not charged to the PR. The report names all compared SHAs.
- Added/deleted/renamed files count; base and head inventory patterns are combined,
  so removing a manifest entry does not hide that PR's changes. Non-text files,
  symlinks and files over 2 MB fail clearly instead of silently reporting zero.
- The comment/check show up to 100 changed rows; the workflow JSON artifact has
  all rows and totals. Check the manifest in this repo for the exact current list.

## Automation and trust

`pr-guardrails.yml` handles PR updates, main pushes and manual dispatch. Each run
sweeps every open PR (unchanged reported snapshots are skipped), including a CLI
version collision on an unchanged PR head after main advances. Manual dispatch
forces a refresh. Sweeping all PRs means GitHub replacing an older pending run
does not drop that PR’s report. It uses current API SHAs, cancels superseded snapshots and retries if a
base/head moves while measuring. Writers are serialised and existing bot comments
are updated instead of adding a comment on every push.

The write-capable workflow checks out only trusted default-branch code. It fetches
PR Git objects and reads regular blobs as data; it never checks out or executes
PR code, installs PR dependencies, or follows PR symlinks. This also permits
reports on fork PRs. Test workflows execute candidate code with read-only access.

The reporting workflow first becomes active when merged to the default branch.
These bootstrap PRs validate its implementation; they cannot run their own
privileged workflow from unmerged candidate code. After merging, dispatch **PR
guardrails** once to backfill all open PRs, or wait for the main-push refresh.
Fork reporting also remains subject to GitHub's own Actions approval policies.

## Local checks

```sh
python3 -m venv /tmp/weeny-guardrails
/tmp/weeny-guardrails/bin/python -m pip install -r .github/guardrails-requirements.txt
/tmp/weeny-guardrails/bin/python -m unittest discover -s .github/scripts -p 'test_*.py' -v
/tmp/weeny-guardrails/bin/python .github/scripts/pr_guardrails.py --base origin/main --head HEAD
```

Local metrics read committed Git blobs. Commit candidate changes first; untracked
or unstaged working-tree edits are not part of HEAD. No API key, model request or
production/staging access is involved in token counting.

## Required CLI version

Every PR must raise `package.json` to a valid SemVer higher than current main,
including docs/CI-only PRs. Equality, downgrades, invalid versions and build-metadata-only
changes fail. Prereleases use SemVer precedence. Committed package-lock.json or
npm-shrinkwrap.json root versions must match; ignored local lockfiles are not used.

The native **CLI version bump** check is regenerated on PR updates and whenever
main advances. It always uses current main, even for a PR targeting another branch.
It flags a version collision; it does not rewrite or auto-bump the PR branch, merge
anything, or publish npm. Choose the release version in the candidate branch.
The existing read-only Checks workflow also has a **CLI version candidate** job,
so the bootstrap PR already tests its own version bump without elevated access.

To make the native check a merge requirement, after merging this PR run:

```sh
python3 .github/scripts/enable_version_gate.py          # inspect the proposed rule
python3 .github/scripts/enable_version_gate.py --apply  # use your gh admin login
```

The installer refuses to apply before the workflow exists on main. It creates or
updates only the named CLI-version ruleset and preserves other repository rules.
The rule has no bypass actors and requires **CLI version bump** with an up-to-date
branch, preventing an old success from authorizing a merge after main advances.
GitHub may therefore require Update branch/rebase after another PR lands; the
report refresh is automatic, but branch content is never rewritten automatically.
This up-to-date requirement is intentional for the version gate; it does not
request extra local test reruns when an unchanged candidate is handed over.

The rule is not enabled by committing its JSON. It needs that one admin command
once the workflow is on main. Keep npm publication under the existing explicit
release approval policy. For a local version-only check (no tokenizer needed):

```sh
python3 .github/scripts/pr_guardrails.py --version-only --base origin/main --head HEAD
```
