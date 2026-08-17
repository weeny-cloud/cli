# weeny-cloud

**Give your coding agent a server.** Anything it builds goes live on a real URL in seconds.

weeny is a real, persistent Linux server — root, SSH, systemd, a normal computer —
wrapped in a tiny control plane that turns processes into managed apps with public
HTTPS URLs. No Docker, no YAML, no framework, no per-app billing. Flat plans from
$3/mo, 7-day free trial, no card.

→ [weeny.cloud](https://weeny.cloud)

## The loop

```bash
npx weeny-cloud login          # email + 6-digit code (agent-driveable)
npx weeny-cloud create         # your server, ~2 min
npx weeny-cloud push ./myapp   # build locally, ship it (re-push = update + restart)
npx weeny-cloud ssh            # your agent works ON the server:
```

Then, on the server:

```bash
weeny start myapp -- npm start   # supervised: survives crashes, reboots, disconnects
weeny expose myapp 3000          # → https://myapp-x7k2.onweeny.com
```

That's it. Live, on HTTPS, supervised, logged, backed up.

## Two CLIs, one job each

| Where | Command | Job |
|---|---|---|
| Laptop | `npx weeny-cloud` | gets code and people **to** the server — `login`, `create`, `push`, `ssh`, `token` |
| Server | `weeny` | operates apps — `start`, `expose`, `env`, `domain`, `allow` |

Everything else is bare Linux. Apps are systemd units named `weeny-<app>`, so logs are
`journalctl -u weeny-<app> -f` and process control is `systemctl restart weeny-<app>`.

Run either CLI bare — `npx weeny-cloud` or `weeny` — and it prints where you stand and
what to type next.

## For coding agents

Install the skill so your agent just knows how weeny works:

```bash
npx weeny-cloud skill
```

Or point it at the machine-readable docs directly:

- [`llms.txt`](https://weeny.cloud/llms.txt) — the deploy loop, compact
- [`llms-full.txt`](https://weeny.cloud/llms-full.txt) — full reference
- [`weeny-skill.md`](https://weeny.cloud/weeny-skill.md) — the Agent Skill
- [`recipes/`](./recipes) — worked deploys: Next.js, Python, Postgres, Docker, n8n, 1 GB boxes

Every weeny app also describes itself at `GET /__weeny` — what it is, whether it's
private, and how an agent should authenticate to it.

## Private apps

Share an app with named people instead of the whole internet:

```bash
weeny expose myapp 3000 --private
weeny allow myapp amy@acme.com     # or a whole domain: weeny allow myapp @acme.com
```

Viewers sign in with their email — no invite needed. Your app receives their address in
the `X-Weeny-User` header, so it always knows who is looking at it.

Agents can use a private app too, as any allowed user:

```bash
npx weeny-cloud token myapp-x7k2.onweeny.com
curl -H "Authorization: Bearer <token>" https://myapp-x7k2.onweeny.com/
```

Apps for humans, tools for agents — the same app, the same permissions, both ways in.

## This repository

The `weeny-cloud` CLI (the npm package), the Agent Skill, and the deploy recipes.
The weeny control plane and server payload are closed-source.

Issues and questions: [github issues](https://github.com/commandable/weeny-cloud/issues)
or hello@weeny.cloud.
