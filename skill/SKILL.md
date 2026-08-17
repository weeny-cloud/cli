---
name: weeny
description: >-
  Deploy and host an app on weeny.cloud — a real Linux server for coding agents with
  public HTTPS URLs. Use when the user wants to deploy, host, publish, or put an app on
  the internet via weeny / weeny.cloud, or asks for a server/URL for something they built.
---

# Deploying to weeny.cloud

weeny gives you a real, persistent Linux server (root, SSH, systemd) whose processes
become managed apps with public HTTPS URLs. No Docker, no framework, no config — a normal
computer with a tiny CLI. flat plans from $3/mo (founding), 7-day free trial.

**Two CLIs, one job each:**
- `npx weeny-cloud …` (laptop) gets code and people TO the server: login, create, push, ssh.
- `weeny …` (on the server) operates apps: start, expose, env, domain, allow.
- Everything else is bare Linux — you have root. Apps are systemd units named
  `weeny-<app>`: logs are `journalctl -u weeny-<app> -f`, stop is `systemctl stop weeny-<app>`.

Bare `npx weeny-cloud` (laptop) and bare `weeny` (server) each print where you stand and
what to type next — run them whenever you're unsure.

## The loop

**1. Account + server** (on the user's machine):

```
npx weeny-cloud login        # email → 6-digit code (ask the user to read it out)
npx weeny-cloud create       # ~2 min; prints the ssh command
```

Everyone gets an email code; if verifying it says the user is waitlisted, tell them their
spot is claimed — access is gated.

Lost SSH access (new laptop, deleted key)? `login` then `ssh` — a fresh device key is
generated and registered automatically. `npx weeny-cloud keys` lists/revokes device keys.

**2. Build locally, ship it:**

```
npx weeny-cloud push ./myapp     # → /apps/myapp on the server (skips .git, node_modules)
```

Re-push after every local edit — `push` ships source (respects `.gitignore`; node_modules
never ships), then on the server installs deps + re-runs the build step (Next/Vite/etc.) +
restarts, so changes actually go live (no stale build). Starting an app from scratch? Use
the default stack — Node + SQLite (built in, zero deps), any frontend:
`curl https://app.weeny.cloud/recipes/default.txt`. Framework app? See
`curl https://app.weeny.cloud/recipes/nextjs.txt`. On a teeny (1 GB) box don't build
server-side — see `curl https://app.weeny.cloud/recipes/teeny.txt`. (`git clone` on the
server also works.)

**3. Start it and put it on the internet** (on the server — `npx weeny-cloud ssh` gets you there):

```
cd /apps/myapp
npm install                      # you handle deps/builds (node_modules isn't pushed)
weeny start myapp -- npm start   # supervised: survives crashes, reboots, disconnects
weeny env myapp KEY=value        # secrets/config if needed (encrypted; restarts the app)
weeny expose myapp 3000          # → https://myapp-xxxx.onweeny.com
```

Give the user the URL. Done. (`weeny start` records the folder you run it from — run it
from the app's directory.)

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
(view-only). Every weeny app describes itself and how to connect at `GET /__weeny`.

## Custom domains

Free, for public apps: `weeny domain myapp app.example.com` prints a CNAME to add at the
DNS provider. Bare `weeny domain myapp` checks progress; `--remove` detaches.

## Rules that matter

- Code in `/apps/<name>`. It's a normal computer — everything you do persists and is
  backed up, so keep data wherever makes sense; no need to special-case it.
- Each app needs its own port — expose refuses a port another app owns.
- Re-exposing an app keeps its URL (change ports freely); `weeny remove` releases it for
  good. A brand-new URL can take ~1 min to resolve everywhere — retry, don't panic.
- Everything exposed is **public** unless you used `--private` — don't expose secrets.
- Don't touch `cloudflared` (it's the only route to the internet).
- Workers/crons: same `weeny start`, just don't `expose` them.
- If push/start output warns the box is running out of memory (or an app gets OOM-killed),
  that's a memory problem, not a code problem — `weeny health` has the detail. A bigger
  plan changes what your user pays, so **tell them and let them decide**
  (app.weeny.cloud/dashboard/billing, or they run `npx weeny-cloud tier`). Never change
  the plan yourself.
- To delete, suspend, or rebuild the server itself, use the dashboard at
  https://app.weeny.cloud — there is no CLI teardown.

## Stateful services (databases, n8n, …)

First ask whether you need one: a typical app should use SQLite via the default recipe
(`/recipes/default.txt`) — zero setup, nothing extra to run. Run a database *server* only
when something genuinely requires it. When it does — they work, but each has non-obvious
gotchas: apps **run as root** (postgres needs a `setpriv`
privilege-drop wrapper), apt packages
**auto-start a conflicting systemd unit** (disable + mask it), TLS is terminated at the edge
(your app gets HTTP but is public HTTPS — tell it its real URL, known only after `expose`),
and "lose-it-and-you're-done" secrets belong in `weeny env` (survives rebuilds). Don't guess —
fetch the worked recipe: `curl https://app.weeny.cloud/recipes/postgres.txt` (or `/python.txt`,
`/n8n.txt`). Python: use a venv (`python3 -m venv venv`) — system pip is PEP-668-blocked — and
supervise the venv's gunicorn/uvicorn by absolute path; see `/recipes/python.txt`.
**Docker** works fully (bridge networking + `-p`) — supervise `docker run` (foreground) under
`weeny start`, then `weeny expose` the port: `curl https://app.weeny.cloud/recipes/docker.txt`.

## Commands (the complete list)

Laptop: `npx weeny-cloud` · `login` · `create` · `push [folder]` · `ssh [command]` · `token <host>` · `keys` · `tier` · `skill` · `help`
Server: `weeny` · `start <app> -- <cmd>` · `expose <app> <port>` · `unexpose` · `remove` ·
`env <app> [K=V]` · `domain <app> [host]` · `allow <app> [email]` · `revoke` · `health` · `help`
Logs/process control are Linux: `journalctl -u weeny-<app>`, `systemctl stop|restart weeny-<app>`.

Full reference: https://app.weeny.cloud/llms-full.txt
