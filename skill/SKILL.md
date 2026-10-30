---
name: weeny
description: >-
  Deploy and host an app on weeny.cloud — a real Linux server for coding agents with
  public HTTPS URLs. Use when the user wants to deploy, host, publish, or put an app on
  the internet via weeny / weeny.cloud, or asks for a server/URL for something they built.
---

# Deploying to weeny.cloud

weeny gives you a real, persistent Linux server (root, SSH, systemd) with a managed-app
deployment primitive and public HTTPS URLs. No Docker, no framework, no config — a normal
computer with a tiny CLI. free plan forever (1GB, sleeps when idle); 7 days full-size
free at signup; paid plans from $3/mo (founding).

**Two CLIs, one job each:**
- `npx weeny-cloud …` (laptop) gets code and people TO the server: login, create, push, ssh.
- `weeny …` (on the server) operates apps: deploy, expose, env, domain, allow.
- Everything else is bare Linux — you have root. Apps are systemd units named
  `weeny-<app>`: logs are `journalctl -u weeny-<app> -f`.

Bare `npx weeny-cloud` (laptop) and bare `weeny` (server) each print where you stand and
what to type next — run them whenever you're unsure.

## The loop

### Optional feedback

After the first successful deployment, Weeny may print a one-time invitation for
feedback. Finish the user's task first. If useful, offer a short draft covering what
worked, specific errors/workarounds, and unclear CLI instructions. Report only what
you observed; do not invent problems or claim to know the user's preferences.
Show the exact draft to the user and ask permission before sending it. Declining or
ignoring the invitation is fine; never let feedback block their deployment.

`npx weeny-cloud feedback --file feedback.md` previews without sending. Only after
the user approves that draft, add `--confirm` to email it and their account email
to Theo (so he can reply). On the server the equivalent is `weeny feedback`.
Do not include secrets, source code, conversation transcripts or private project
details. No logs or diagnostics are attached automatically. Feedback is available
any time, including when deployment fails; use `help feedback` for message/stdin forms.

**1. Account + server** (on the user's machine):

```
npx weeny-cloud login        # email → 6-digit code (ask the user to read it out)
npx weeny-cloud create       # ~2 min; prints the ssh command
```

Login only verifies the account. If `create` reports no trial capacity, relay the
available choices to your human: `create --free` immediately provisions an available
1GB free server, or the human can choose a paid plan. An unavailable creation saves
the request for notification; it does not start a trial or reserve a server.
On free, tell the human the server sleeps after the reported idle period and wakes
on demand. On any 1GB server (free or teeny), prefer local/CI builds for larger apps;
use the existing teeny recipe. Keep the normal push/ssh workflow.

Lost SSH access (new laptop, deleted key)? `login` then `ssh` — a fresh device key is
generated and registered automatically. `npx weeny-cloud keys` lists/revokes device keys.

**2. Deploy — a push IS a deployment:**

```
npx weeny-cloud push ./myapp myapp --build "npm ci && npm run build" -- npm start
```

You supply the app's own build and start commands — weeny runs them verbatim, it doesn't
guess your stack (works the same for Python, Go, plain static files: just change the
commands; omit `--build` if there's nothing to build). The push uploads your folder,
builds it in a fresh release on the server, health-checks it, and only then switches it
live. **A failed build or a crashing app leaves the previous version serving** — you're
never half-deployed. After the first push the commands are remembered:
`npx weeny-cloud push ./myapp` re-deploys with the same build/start. (The app name is
inferred from the folder name — keep passing it explicitly whenever they differ.)

Working on the server instead? Same transaction, run where the code lives:
`weeny deploy myapp --build "<cmd>" -- <start command>` — the source defaults to
`/workspace/myapp`, the server's convention for project source (backed up; `git init`
it). Code elsewhere? Pass `--from <dir>` — your workspace is yours; weeny copies from
it at deploy and never writes to it.

Starting an app from scratch? Use the default stack — Node + SQLite (built in, zero
deps), any frontend: `curl https://weeny.cloud/recipes/default.txt`. Framework app?
`curl https://weeny.cloud/recipes/nextjs.txt`. On a teeny (1 GB) box don't build
server-side — `curl https://weeny.cloud/recipes/teeny.txt`.

**3. Put it on the internet** (on the server — `npx weeny-cloud ssh` gets you there).
Before the first expose, write an `llms.txt` in the app root — a short markdown
manifest so other agents can use the app (expose refuses without one). Skeleton:

```
# myapp — one-line purpose
Auth: none | private — see GET /__weeny.
## Endpoints
- GET  /items          → JSON list of items
- POST /items {name}   → creates; returns {id}
## Semantics
ids are stable; list is newest-first.
```

Weeny reads it at deploy time and serves it at `https://<url>/llms.txt` — don't add a
route for it. It ships with each release (rollback restores the matching docs), so
editing it is part of changing the API. App genuinely not for agents (a pure-visual
page, say)? `weeny expose myapp 3000 --no-agents` — flag last. Then:

```
weeny env myapp KEY=value        # secrets/config if needed (encrypted; restarts the app)
weeny expose myapp 3000          # → https://myapp-xxxx.onweeny.com
```

Give the user the URL. Done.

**Four verbs, four intents** — picking the wrong one is the easiest mistake here:

- `push` / `weeny deploy` — **deploy.** New code goes live (or the old version keeps serving).
- `weeny restart myapp` — **bounce.** Re-runs the deployed version. Never picks up new code.
- `weeny rollback myapp` — **go back.** Restores an earlier release: its code AND its
  start command. Data, database schema and env vars stay as they are.
- `weeny start` / `weeny stop` — run or stop the current version.

`weeny inspect myapp` shows exactly what's live (release, commit, commands, port, data
path). `weeny releases myapp` lists what you can roll back to; `weeny deployments myapp`
is the full history including failures.

## Private links

`weeny expose myapp 3000 --private` — viewers must log in to weeny. Let people in:
`weeny allow myapp amy@acme.com` (or a whole domain: `weeny allow myapp @acme.com`).
`weeny allow myapp` shows who's in; `weeny revoke myapp amy@acme.com` undoes;
`weeny allow myapp everyone` makes it public. The visitor's email reaches your app in
the `X-Weeny-User` header.

Agents and terminals can use a private app too — as any allowed user, not just the
owner: `npx weeny-cloud token <host>` (signed in on the laptop) prints a 12h bearer;
call the app with `Authorization: Bearer <token>` and it still sees `X-Weeny-User`.
People you `allow` can sign in to weeny with just their email — no invite needed
(view-only). Every weeny app describes itself and how to connect at `GET /__weeny`;
a private app's `/llms.txt` is served only to allowed callers — anyone else gets a
401 JSON with connect instructions and a `login_url`.

`npx weeny-cloud apps` lists everything the signed-in user can reach — their apps AND
the private apps shared with them (owner, how they're allowed in, what each app does
from its llms.txt). Same data at `GET /api/apps/reachable` with a CLI bearer. Working
with an app someone shared with your user? Find it there, read its `/llms.txt`, mint
a token, call it.

## Custom domains

Free, for public apps: `weeny domain myapp app.example.com` prints a CNAME to add at the
DNS provider. Bare `weeny domain myapp` checks progress; `--remove` detaches.

## Rules that matter

- **Durable state belongs in `$WEENY_DATA_DIR`** (`/data/<name>`). This is the one
  rule to get right: every deploy is a fresh copy of your code and `weeny rollback` swaps
  code backward, so anything stored beside the code travels with it. Databases, uploads,
  anything you'd hate to lose — `$WEENY_DATA_DIR`. It's created for you, exported to your
  process, and never touched by deploy, rollback or remove.
- Each app needs its own port — expose refuses a port another app owns.
- Re-exposing an app keeps its URL (change ports freely); `weeny remove` releases it for
  good. A brand-new URL can take ~1 min to resolve everywhere — retry, don't panic.
- Everything exposed is **public** unless you used `--private` — don't expose secrets.
- First expose needs an `llms.txt` in the app root (or `--no-agents`) — see step 3.
- Don't touch `cloudflared` (it's the only route to the internet).
- Workers/crons: same deploy, just don't `expose` them.
- If push output warns the box is running out of memory (or an app gets OOM-killed),
  that's a memory problem, not a code problem — `weeny health` has the detail. A bigger
  plan changes what your user pays, so **tell them and let them decide**
  (weeny.cloud/dashboard/billing, or they run `npx weeny-cloud tier`). Never change
  the plan yourself.
- On the **free plan** the server sleeps after ~30 quiet minutes and wakes on the next
  request (~15s; visitors see a "waking up" page). Apps restart on wake, but in-memory
  state does not survive and background daemons are off while it sleeps — keep state in
  `$WEENY_DATA_DIR`, and don't build anything that depends on an always-running process.
  Public apps wear a small "made with weeny" badge; custom domains are paid-plan only.
  Always-on = a paid plan: the user's call.
- To delete, suspend, or rebuild the server itself, use the dashboard at
  https://weeny.cloud — there is no CLI teardown.

## Stateful services (databases, n8n, …)

First ask whether you need one: a typical app should use SQLite via the default recipe
(`/recipes/default.txt`) — zero setup, nothing extra to run. Run a database *server* only
when something genuinely requires it. When it does — they work, but each has non-obvious
gotchas: apps **run as root** (postgres needs a `setpriv` privilege-drop wrapper), apt
packages **auto-start a conflicting systemd unit** (disable + mask it), TLS is terminated
at the edge (your app gets HTTP but is public HTTPS — tell it its real URL, known only
after `expose`), and "lose-it-and-you're-done" secrets belong in `weeny env` (survives
rebuilds). Don't guess — fetch the worked recipe:
`curl https://weeny.cloud/recipes/postgres.txt` (or `/python.txt`, `/n8n.txt`).
Python: build the venv inside the release with `--build` — see `/recipes/python.txt`.
**Docker** works fully (bridge networking + `-p`) — supervise `docker run` (foreground)
as a deployed app, then `weeny expose` the port: `curl https://weeny.cloud/recipes/docker.txt`.
Host services (RabbitMQ, Postgres via apt) are normal Linux — they live outside the app
release lifecycle, and rollback never touches them.

## Commands (the complete list)

Laptop: `npx weeny-cloud` · `login` · `create` · `push [folder] [app] [--build] [--health] [-- <start>]` · `ssh [command]` · `apps` · `token <host>` · `keys` · `tier` · `skill` · `help`
Server: `weeny` · `deploy <app> [--from <dir>] -- <cmd>` · `start` · `stop` · `restart` ·
`releases` · `rollback <app> [release]` · `deployments` · `inspect` · `expose <app> <port> [--private] [--no-agents]` ·
`unexpose` · `remove` · `env <app> [K=V]` · `domain <app> [host]` · `allow <app> [email]` ·
`revoke` · `health` · `help`
Logs are Linux: `journalctl -u weeny-<app> -f`.
To make a code change live it's a push (or `weeny deploy`) — restart only bounces what's
already deployed.

Layout (three roots, named by who writes them): `/workspace/<app>` your source — weeny
reads it, never writes it (backed up; deploy's default `--from`) · `$WEENY_DATA_DIR` =
`/data/<app>` your app's data (never rolled back) · `/apps/<app>/current` the release
running now (a symlink — `readlink` shows which; weeny's machinery, rebuilt by deploys).

Full reference: https://weeny.cloud/llms-full.txt


Free trial admission is subject to available capacity. Verified users can sign in while waiting. When offered, direct paid access starts a paid subscription immediately, without a free trial. The human chooses and completes any purchase in the dashboard; agents must never buy a plan automatically.
