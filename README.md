# weeny-cloud

A teeny weeny, simple wimple cloud for coding agents. Give your agent a real
Linux server; anything it builds goes live on a public URL in seconds.

```
npx weeny-cloud login          # email + code, agent-driveable
npx weeny-cloud create         # your server, ~2 min
npx weeny-cloud push ./demo demo --build "npm ci" -- npm start
                               # a push IS a deployment: fresh release, built +
                               # health-checked on the server; re-push = new release
npx weeny-cloud ssh "weeny expose demo 3000"   # → https://demo-xxxx.onweeny.com
```

## Two CLIs, one job each

- `npx weeny-cloud …` — this package, on your **laptop**. It gets code and people
  to the server: `login` · `create` · `push` · `ssh` · `skill`. Bare `npx weeny-cloud`
  shows where you stand.
- `weeny …` — on the **server**. It operates apps: `deploy` · `rollback` · `expose` ·
  `env` · `domain` · `allow`. Bare `weeny` there explains itself.

Everything else is bare Linux — you have root. Apps are systemd units named
`weeny-<app>`, so logs are `journalctl -u weeny-<app> -f`.

## What you get

- A real, persistent Linux server: root, SSH, systemd. No Docker, no framework,
  no config — install anything, run anything.
- **Env vars**: `weeny env myapp KEY=value` — encrypted, survive rebuilds.
- **Private links**: `weeny expose myapp 3000 --private`, then
  `weeny allow myapp amy@acme.com`.
- **Custom domains**: free for public apps — `weeny domain myapp app.example.com`.
- Supervision, HTTPS, and off-machine backups of the whole machine, all included.

## Coding agent?

`npx weeny-cloud skill` teaches Claude Code the whole flow.
Docs for agents: https://weeny.cloud/llms.txt

Once you have the skill installed, normal CLI commands check its SHA-256 against
the hosted guide before running, at most once every 24 hours, with a three-second
timeout. That invocation shows a notice on stderr only when an update is available,
at most daily. Run `npx weeny-cloud@latest skill` to refresh, then have your agent
re-read the file.
The check never overwrites your skill or updates the server CLI. Failed or timed-out
checks stay silent and let the command continue; later commands use the daily cache.
CI and internal SSH relay processes skip the check.
Existing installs are detected without reinstalling the skill; this feature requires
an updated laptop CLI.

## Pricing

flat plans from $3/mo (founding), no usage metering. Start free with 7 days at 4GB,
then the same server automatically continues on the forever-free 1GB plan.
No card needed, no automatic charge; your apps and data stay.
Login verifies the account without allocating compute. `create` requests this trial
when available (recommended); the seven days start when the server is ready.
`create --free` skips the trial and starts directly on the 1GB sleeping free plan;
this account cannot start a trial later. An unavailable creation saves a server
request for notification.

## Testing an unpublished release

Use a checkout of the candidate CLI with `WEENY_ENV=staging` and
`WEENY_API=https://staging.weeny.cloud`. Set `WEENY_CONFIG_DIR` to a dedicated test
profile, or let the CLI choose a separate profile for that API origin. Run
`node /path/to/candidate/cli.mjs <command>` rather than the public npm release.
Staging refuses the production API, binds saved tokens to their origin, and uses
separate SSH keys/config, known-hosts and skill files. The `skill` command fetches
staging instructions and rewrites their CLI commands to invoke this exact candidate
with the staging environment, without modifying your installed production skill.

## Windows setup and SSH troubleshooting

Use Node.js and the Windows **OpenSSH Client** optional feature from a normal user
terminal. Weeny stores its account under your home directory's `.weeny` folder;
it passes the generated SSH configuration explicitly, including for tunnel aliases.

If profile creation fails with `EPERM` or `EACCES`, choose a private writable location
in PowerShell, then repeat login:

```powershell
$env:WEENY_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'Weeny'
npx weeny-cloud login
```

Keep that setting in later terminals; the override uses its own account and SSH
files. It does not migrate or delete the old profile. Use another directory for
staging. The CLI checks profile writes before requesting or consuming a login code.

An SSH alias such as `weeny-<id>` is a local config entry, not a public DNS name.
Use `npx weeny-cloud ssh`. If a separate `ssh` invocation fails to find the alias,
`Get-Command ssh -All` identifies competing Windows/Git executables. Run
`npx weeny-cloud help ssh` for the exact config path and an `ssh -G -F` diagnostic.
Paths with spaces are supported; keep host checking enabled and preserve existing keys.

## Founder feedback

Preview a short report with `npx weeny-cloud feedback --file feedback.md` (or pass
a quoted message, or `-` for stdin). Nothing is sent by default. After reviewing
and approving the exact draft, add `--confirm` to email it and your account email
to Theo, Weeny's founder, so he can reply.

Coding agents: finish the user's task, show the draft and ask permission before
sending. Describe observed successes, errors, workarounds and unclear instructions.
Exclude secrets, source code, conversation transcripts and private project details.
No logs or diagnostics are attached automatically. `npx weeny-cloud help feedback`
explains all forms; feedback is optional and never blocks deployment.


## Deploying from GitHub Actions

The candidate CLI supports `WEENY_TOKEN`, `WEENY_SSH_KEY_FILE` and
`WEENY_KNOWN_HOSTS_FILE` for noninteractive deployments. With these set, it never
stores the token or registers a new SSH device; missing keys/host pins fail closed.
CI uses a dedicated SSH configuration with strict checking, independent of existing
`Host`, `Match` or `Include` rules. Credential file paths may contain spaces.
Set `WEENY_CONFIG_DIR` to a runner-local directory so generated SSH configuration
is isolated, including for production accounts. This support must be published
before using it with the npm package; until then test the exact CLI commit.

Prepare once from a trusted machine: create a dedicated login/profile with
`login --label github-actions`, generate an SSH key, and register it with
`keys --register --key-file /path/to/ci_ed25519`. Run one trusted SSH connection
using that key and copy the verified known-hosts entry into the environment secret.
Store the dedicated login token, private key and known-hosts contents as GitHub
**environment secrets**, never in repository files. These credentials are currently
account/server-wide, not app-scoped; use a dedicated account/server where isolation
is required. Revoking a device key and revoking its CLI token are separate operations.

See [the Actions example](examples/github-actions.yml). It runs only after an
explicit main-branch dispatch, uses an exact CLI SHA, serializes deployments and
uses the normal transactional `push` health/rollback flow. Use a protected GitHub
production environment with required reviewers where your plan supports it.
Staging and production apps/credentials should have separate environments. Test
PRs without secrets; do not deploy untrusted forks using `pull_request_target`.

### Account controls for agents

- `weeny-cloud server status --json`: read state without waking; `resume` wakes a
  suspended server. `suspend`, `rebuild`, `delete` require explicit human approval
  and `--confirm`. Rebuild restores the latest snapshot and may lose newer changes;
  delete destroys all server data. `--wait` waits for the queued action to complete.
- `weeny-cloud widget APP --branding off --json`: paid/trial owners can remove the
  badge; free keeps it. `--position bottom` sets its starting position.
- `weeny-cloud tier NAME --preview --json`: inspect a change without billing. Apply
  only after the human chooses, with `--confirm`; `--force` overrides a memory warning.
- `weeny-cloud billing portal`: human payment/invoice/cancellation link.
  `billing checkout TIER --confirm` prepares a link without paying; `--direct-paid`
  buys a first server without a trial, after the human chooses that path.
- `weeny-cloud logout`: revoke this token and remove local credentials. `--local`
  removes only the local copy when offline.

`server`, `widget`, `tier`, `billing`, `logout`, `apps` and key listing support
`--json`. Errors with this flag are JSON on stderr and exit nonzero. Poll server
status after an interrupted request before retrying a disruptive operation.
Full API and credential reference: https://weeny.cloud/agent-api.md.

New paid server disk allowances are Teeny 10 GiB, Weeny 20 GiB and Meany 60 GiB, including the OS and tools. `tier` reads current plan specs from the API and shows the existing server’s actual disk separately. Existing larger disk promises survive renewals, rebuilds and downgrades. `tier NAME --preview` reports the resulting disk before a human confirms a change.
