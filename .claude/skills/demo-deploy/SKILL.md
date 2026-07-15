---
name: demo-deploy
description: Rebuild and redeploy the public demo at demo.vis-ionary.com (the graphy-backend container in deploy/demo/docker-compose.yml) after changes have been merged to main. Use when the user asks to "rebuild the demo", "redeploy the demo", "反映して", "デモを再ビルド", "デモを再デプロイ", or asks why demo.vis-ionary.com doesn't reflect a recently merged change.
---

# Demo rebuild & redeploy (demo.vis-ionary.com)

The public demo runs as a Docker Compose stack (`deploy/demo/docker-compose.yml`)
on a single physical home server. `graphy-backend` is a single image that bundles
**both** the Spring Boot backend and the built frontend (the Dockerfile's Maven
build runs `frontend-maven-plugin`/copy-resources internally) — rebuilding that
one service picks up frontend-only and backend-only changes alike. No separate
frontend deploy step exists or is needed.

## 0. Preconditions — do these before anything else

1. **Confirm the target changes are already merged to `main` on GitHub.** This
   skill only builds and deploys whatever is currently checked out in the repo
   root; it does not merge PRs. If asked to deploy something still in a draft
   PR, say so and stop — don't merge it yourself.
2. **Server identity check — mandatory, every time:**
   ```bash
   cd <repo-root>   # the ORIGINAL checkout, not a worktree — see step 1 below
   bash deploy/demo/check-server-identity.sh
   ```
   - Exit 0: continue.
   - Exit 1: it prints a warning that this machine is probably not the demo
     host. Stop, show the user that exact warning, and only continue if they
     explicitly say to proceed anyway on this machine.
   - This mirrors the hard rule already documented in `deploy/demo/CLAUDE.md`
     for any operation under `deploy/demo/` (compose up/down, `.env`, cron,
     Cloudflare config) — deploying is one of those operations.

## 1. Make sure the repo root is on the merged commit

The Docker build context is the **working tree**, not a git ref — it `COPY`s
whatever files are physically present under `backend/` and `frontend/` at
build time. Run everything from the main checkout at the repo root (not a
`.claude/worktrees/*` worktree — those are for isolated feature branches, not
for what gets deployed).

```bash
cd <repo-root>
git status --short        # must be empty — if not, STOP and ask the user
                           # (don't discard their uncommitted work)
git fetch origin main -q
git log -1 --oneline               # local HEAD
git log -1 --oneline origin/main   # should match after a fast-forward
```

If local `main` is behind `origin/main` and the working tree is clean:
```bash
git merge --ff-only origin/main
```
Never force-push, reset --hard, or otherwise rewrite history here — this
checkout is also the live deploy source.

## 2. Rebuild the backend image

```bash
docker compose -f deploy/demo/docker-compose.yml build graphy-backend
```

This runs the full Maven build (`mvn -B clean package -DskipTests`, which in
turn builds the Vite frontend and copies `frontend/dist` into the jar's
`static/` resources) inside the build stage, then produces the final
`eclipse-temurin` runtime image. Expect ~15-30s if Maven/npm caches are warm,
longer on a cold cache. Watch for `BUILD SUCCESS` and `graphy-backend  Built`
at the end; a Maven `BUILD FAILURE` means stop here and report the error
instead of deploying a stale/broken image.

## 3. Redeploy (recreate just that one container)

```bash
docker compose -f deploy/demo/docker-compose.yml up -d graphy-backend
```

Only `graphy-backend` gets recreated — `arc`/`db`/`ldap`/`proxy`/`cloudflared`
are untouched. While the new container is starting, `proxy` (nginx) detects
the brief unavailability and serves `maintenance.html` automatically, so
there's no hard downtime window for users beyond a few seconds of a
maintenance page.

## 4. Verify before declaring success

```bash
sleep 8
docker compose -f deploy/demo/docker-compose.yml ps graphy-backend
docker compose -f deploy/demo/docker-compose.yml logs --tail=30 graphy-backend
```
Look for `Started GraphyNextApplication ... in N seconds` with no stack trace
after it. Then confirm it's reachable from inside the compose network (the
host has no published port for this service by design — see the network
comment at the top of `deploy/demo/docker-compose.yml`):

```bash
docker compose -f deploy/demo/docker-compose.yml exec proxy wget -qO- http://graphy-backend:8090/actuator/health
```
Expect `{"status":"UP"}`. Optionally tail `proxy` logs briefly to confirm real
requests are getting `200`s again:
```bash
docker compose -f deploy/demo/docker-compose.yml logs --tail=10 proxy
```

## Don'ts

- Don't run any of this on a machine that fails the identity check.
- Don't touch `ldap`/`db`/`arc` data or run `reset-demo.sh` as part of a
  routine deploy — that's a separate nightly snapshot-restore operation, not
  needed here.
- Don't `docker compose down` (tears down the tunnel/network) when `up -d
  graphy-backend` (recreate one service) is all that's needed.
- Don't deploy uncommitted or unmerged local changes — only what's on `main`.
