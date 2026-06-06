# casey + arnie on Hetzner (move off the dev box)

Runs casey + arnie as containers on the always-on Hetzner box, **reusing the
existing dario** on the `askalf_askalf-net` network. casey is fronted by the
existing **casey-console** Cloudflare Tunnel + CF Access (same `casey.askalf.org`,
DNS + Access app unchanged — only the *connector* moves here). Nothing depends on
the dev box after cutover.

> Hetzner prod-writes are gated for the assistant, so **you run the steps below**
> (via `!` or on the box). They're idempotent.

## One-time: add the connector token to the box env

On the **dev box**, read the connector token:
```
type C:\Users\masterm1nd\casey-live\.cf-tunnel-token
```
On **Hetzner**, append it to the platform env (DARIO_API_KEY is already there):
```
echo "CASEY_TUNNEL_TOKEN=<paste-token>" >> /root/.askalf/.env
```

## Deploy (idempotent — safe to re-run)

```
mkdir -p /root/.askalf/src && cd /root/.askalf/src
git clone https://github.com/askalf/casey 2>/dev/null || git -C casey pull --ff-only
bash casey/deploy/deploy-casey-hetzner.sh
```
This clones casey + arnie (siblings), builds both images, and brings up
casey + arnie + the casey cloudflared connector against the shared dario.

## Verify (before touching the dev box)

```
docker compose --env-file /root/.askalf/.env -f /root/.askalf/src/casey/deploy/docker-compose.hetzner.yml ps
curl -sI https://casey.askalf.org/        # expect 302 -> askalf.cloudflareaccess.com/cdn-cgi/access/login
docker logs casey-cloudflared --tail 20   # expect "Registered tunnel connection"
```
Then log in at https://casey.askalf.org as hello@askalf.org — you should land in the Owner view.

## Cut over (only after the above is green)

A tunnel's connector should run in one place. Once Hetzner is verified, **stop the
dev-box stack** so routing + data are unambiguous:
```
C:\Users\masterm1nd\casey-live\stop-stack.bat
```
…and stop the dev-box tunnel loop (the cmd running start-tunnel.bat) + its cloudflared child.
After this, casey/arnie/dario/tunnel run only on Hetzner.

## Notes / rollback

- **Rollback:** if the Hetzner deploy isn't green, just don't stop the dev box — it keeps serving.
- **Data:** starts fresh on Hetzner (the dev-box tickets were test data). To carry data over,
  copy the dev box `C:\Users\masterm1nd\.casey\*` into `/root/.askalf/casey-data/` before first up.
- **Add staff:** edit `/root/.askalf/casey-data/roles.json` (email→role) **and** the CF Access
  "casey staff" policy allow-list.
- **dario billing** is now shared with the platform (same Claude Max pool) — expected.
- **arnie reach** is unchanged: a cloud box still can't touch client LANs; real Tier-3
  remediation still needs a per-client connector/runner (separate workstream).
- **Reboot-proof:** all services use `restart: unless-stopped`, so they survive box reboots
  (unlike the dev-box bats).
