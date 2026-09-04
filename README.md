# virgo-fleet

.env
```
CERTRESOLVER='le'
DOMAIN='your.domain'
DB_PASSWORD='your-db-password'
MFA_SECRET_KEY='a-long-random-string'
TURN_SECRET_KEY='a-long-random-string'
TURN_EXTERNAL_IP='your.public.ip.address'
TURN_INTERNAL_IP='the.host.lan.address'
TURN_TLS_PORT='443'
SMTP_HOST='smtp.your.provider'
SMTP_PORT='587'
SMTP_SECURE='false'
SMTP_USER='postmaster@your.domain'
SMTP_PASSWORD='your-smtp-password'
SMTP_FROM='fleet@your.domain'
VAPID_PUBLIC_KEY='generate-once-see-below'
VAPID_PRIVATE_KEY='generate-once-see-below'
VAPID_SUBJECT='mailto:fleet@your.domain'
```

Generate the VAPID keypair once (it powers Web Push update notifications to installed PWAs).
Never regenerate it — rotating the keys invalidates every existing push subscription:
```
npx web-push generate-vapid-keys
```

The Cloudflare credentials issue the DNS-01 wildcard certificates for nodes on the managed zone. Create a
token scoped to that one zone with `Zone:DNS:Edit`, and copy the zone id from the zone's overview page so
the token needs no `Zone:Read`. A Cloudflare token cannot be scoped below a zone, which is why nodes never
receive it and ask fleet to publish their challenge records instead.

## TURN server

When a browser opens a node's UI, the browser and the node hold a direct WebRTC data channel and
fleet only relays the signaling. A node on a public address is reached directly; a node behind
CGNAT is reached through a relay, which is what the `coturn` sidecar below provides. Fleet stays the
automatic fallback: a node that doesn't advertise support, a browser without WebRTC, or a data
channel that fails to establish all transparently keep using the Socket.IO proxy.

The relay only carries sessions where **neither** peer can be reached directly. A node behind CGNAT
usually still connects directly when the admin's own NAT is endpoint-independent, so the relay is
for both-ends-symmetric and UDP-blocked networks. The browser receives the UDP and TCP TURN URLs
(and the `turns` one when `TURN_TLS_PORT` is set), but the node deliberately keeps only UDP: the
packaged `node-datachannel` uses libjuice, whose TURN control over TCP/TLS needs a libnice build. So
a UDP-blocked browser can use TURN/TCP, while a UDP-blocked node remains on Socket.IO.

`coturn` runs as its own container in the compose stack — not inside the fleet image (a crash there
would take the app down and relay bandwidth would contend with the signaling loop). It uses
`use-auth-secret`: fleet derives a short-lived credential from `TURN_SECRET_KEY` per session, so nothing
is stored. Fleet advertises the relay at `relay.${DOMAIN}` — point a DNS **A record** for that name
at `TURN_EXTERNAL_IP`. Set `TURN_INTERNAL_IP` to the host's LAN address: on host networking coturn
would otherwise bind and allocate relays on every docker bridge and every alias, handing browsers a
pile of unreachable private candidates to time out on, so `--listening-ip`/`--relay-ip` pin it to
the one interface the router forwards to. `--external-ip` then advertises every relay as the public
address.

Deliberately *not* the two-part `--external-ip=public/private` form: coturn adds the private half to
its allowed-peer list (`Whitelisting external-ip private part` in the log), which cancels the
`--denied-peer-ip` entry covering the host's own LAN and turns the relay into a path to every
service on it. Pinning gives the same precision without that.

coturn holds no certificate of its own and terminates no TLS — the optional `turns` leg above is
terminated by Traefik and reaches coturn as plain TURN/TCP.
coturn runs on **host networking** rather than publishing ports: a TURN relay binds a fresh UDP
port per allocation out of `TURN_MIN_PORT`–`TURN_MAX_PORT`, and publishing a range that size
means a `docker-proxy` process and a DNAT rule per port. On the host network it just binds them.

The range is sized by concurrent browser sessions, not node count — an idle node holds no peer
connection. Allow several ports per relayed session: each advertised TURN URL gets its own
allocation (two, for the udp and tcp transports), both ends gather, and a client gathers per local
interface, so one session can transiently hold 4–8. Unused allocations are released once ICE
settles. `--total-quota` caps simultaneous allocations server-wide, so one misbehaving client
can't exhaust the range for everyone — any signed-in fleet user can mint a credential.

Those relay ports have to be reachable from the internet — the *peer* sends its connectivity
checks and data straight to `TURN_EXTERNAL_IP:<relay port>`, while `3477` only carries the
control channel (ALLOCATE, permissions, refresh). Relay allocations are always UDP: browsers
never request anything else (libwebrtc has no RFC 6062 TCP-allocation support). The `?transport=`
on the advertised TURN URLs is a separate thing — it picks the peer's own leg to coturn, and
fleet advertises both so a client on a network that blocks UDP can still reach `3477/tcp` and get
a UDP relay allocation behind it.

**Reaching the relay from a locked-down network.** `3477/tcp` and `3477/udp` are both blocked on
networks that permit nothing but 443, leaving such a browser with no relay at all. `TURN_TLS_PORT=443`
makes fleet advertise a third URL, `turns:relay.${DOMAIN}:443?transport=tcp`. coturn keeps `--no-tls`
and grows no listener: Traefik already owns 443, terminates the TLS, and proxies the plaintext
TURN/TCP to coturn's existing `3477/tcp`. The relay allocation behind it is still UDP.

This must go through Traefik's **file** provider, not Docker labels: coturn is on host networking, so
the Docker provider has no container IP to build a service from and drops it silently. The file
provider takes a literal address, which is why the compose below gives coturn a second
`--listening-ip=172.30.0.1` alongside the LAN one. That adds a control socket only — `--relay-ip`
stays pinned to `TURN_INTERNAL_IP`, so no new private candidate is advertised, and the relay still
cannot be aimed at that address because `--denied-peer-ip=172.16.0.0-172.31.255.255` covers it.

Drop `turns.yml` into the Traefik file-provider directory (`/messier/apps/traefik/config/`, mounted
and watched, so no restart). Keep it out of the Traefik stack's fetched config — it belongs only on a
host running fleet. Template **nothing** here: Traefik resolves `{{ env ... }}` against its own
`.env`, where `DOMAIN` is that host's name and `CERTRESOLVER` issues for that host's zone. Both
differ from the fleet stack's, and getting either wrong shows up as `TRAEFIK DEFAULT CERT` on the
wire while the dashboard still reads `Success`. Substitute your own values:
```
tcp:
  routers:
    turns:
      rule: "HostSNI(`relay.univrs.cloud`)"
      entryPoints:
        - "https"
      service: "turns"
      tls:
        certResolver: "le"
        domains:
          - main: "relay.univrs.cloud"

  services:
    turns:
      loadBalancer:
        servers:
          - address: "172.30.0.1:3477"
```
The name must match `relay.${DOMAIN}` as the *fleet* service sees `DOMAIN` — that is what `turn.js`
advertises to both peers — and the resolver must have authority over that zone, so use the one the
fleet service itself uses. `domains:` is stated rather than left for Traefik to derive from
`HostSNI`, and a specific `HostSNI` wins over the HTTP routers sharing the entrypoint, so
`fleet.${DOMAIN}` is unaffected.

Confirm before enabling. The dashboard's **TCP Routers** page should list `turns@file` with the rule
naming the FQDN you expect, then:
```
printf 'GET / HTTP/1.1\r\nHost: relay.${DOMAIN}\r\n\r\n' \
  | openssl s_client -connect relay.${DOMAIN}:443 -servername relay.${DOMAIN} -quiet
```
The certificate must cover `relay.${DOMAIN}` and the request must draw **no** HTTP response — coturn
closing on a non-TURN message. An `HTTP/1.1` status line means the HTTP catch-all took it. The
handshake alone proves nothing: the catch-all presents the same certificate and also sits idle.

Leave `TURN_TLS_PORT` unset until that passes. An advertised TURN URL that nothing answers is not
free — the browser gathers against it and waits out the timeout before ICE completes.

The relay is reachable by any signed-in fleet user (they read a 300s credential out of their
session ack), so `--denied-peer-ip` blocks the RFC1918 ranges **and loopback** — nodes are relayed
to on public addresses, so this costs nothing and keeps the relay from being an open path into the
docker networks, the host LAN, or anything bound to `127.0.0.1`. coturn does not deny loopback on
its own, and host networking puts the host's own loopback services one `CreatePermission` away, so
that entry is as load-bearing as the RFC1918 ones.

**Port choice.** coturn listens on `3477` rather than the standard `3478`, leaving 3478 free for
another TURN server sharing the host. That only holds with `--alt-listening-port=0`:
`--alt-listening-port` defaults to `listening-port + 1`, so a bare `--listening-port=3477` binds
3478 as well for RFC 5780 NAT discovery. That discovery needs two addresses anyway and is already
disabled here (`RFC5780 disabled` in the startup log). `TURN_*` are generic names, so keep this
stack's `.env` to itself rather than sharing one with another stack that uses them. Verify what
bound what after `docker compose up`:
```
ss -lntup | grep -E ':3478|:3477'
```

**Environment.**
```
TURN_SECRET_KEY      shared static-auth-secret (also set on the fleet service)
TURN_INTERNAL_IP     the host's LAN address; the only interface coturn binds and relays on
TURN_EXTERNAL_IP     the host's public IP, advertised in relay candidates
TURN_LISTENING_PORT  STUN/TURN over UDP and TCP (default 3477)
TURN_TLS_PORT        advertise turns:// on this port (unset = off; see the Traefik router above)
TURN_MIN_PORT        first UDP relay port (default 61000)
TURN_MAX_PORT        last UDP relay port (default 61500)
TURN_REALM           defaults to ${DOMAIN}
```

**Firewall.** `3477/tcp`, `3477/udp` and `61000-61500/udp` must reach the host, and a router in
front of it must forward them 1:1 — coturn advertises the relay port it bound and cannot know
about a remap.

Nothing to do on a host with the usual default-ACCEPT `INPUT` policy. Because coturn is on host
networking these ports are delivered locally rather than DNAT'd into a container, so unlike the
published ports of the other services they *do* traverse `INPUT` — on a default-DROP host:
```
sudo iptables -A INPUT -p tcp --dport 3477 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 3477 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 61000:61500 -j ACCEPT
sudo netfilter-persistent save
```
A `RELATED,ESTABLISHED` rule does not cover the relay range: those ports are inbound-first, so the
peer's first connectivity check is `NEW` and hits the drop. A cloud security group, if the host has
one, needs all three too.

Each connected node holds a control socket open, so the default 1024 fd limit is exhausted well
before a few hundred nodes (plus proxied user sessions); the fleet service raises `nofile` to keep
the accept path off `EMFILE` during a reconnect storm.

docker-compose.yml
```
services:
  fleet:
    image: ghcr.io/univrs-cloud/virgo-fleet:latest
    environment:
      - DOMAIN=${DOMAIN}
      - DB_HOST=db
      - DB_NAME=${DB_NAME:-fleet}
      - DB_USER=${DB_USER:-fleet}
      - DB_PASSWORD=${DB_PASSWORD}
      - MFA_SECRET_KEY=${MFA_SECRET_KEY}
      - TURN_SECRET_KEY=${TURN_SECRET_KEY}
      - TURN_LISTENING_PORT=${TURN_LISTENING_PORT:-3477}
      - TURN_TLS_PORT=${TURN_TLS_PORT:-}
      - SMTP_HOST=${SMTP_HOST}
      - SMTP_PORT=${SMTP_PORT:-587}
      - SMTP_SECURE=${SMTP_SECURE:-false}
      - SMTP_USER=${SMTP_USER}
      - SMTP_PASSWORD=${SMTP_PASSWORD}
      - SMTP_FROM=${SMTP_FROM}
      - VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
      - VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
      - VAPID_SUBJECT=${VAPID_SUBJECT}
      - CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN}
      - CLOUDFLARE_ZONE=${CLOUDFLARE_ZONE}
      - CLOUDFLARE_ZONE_ID=${CLOUDFLARE_ZONE_ID}
    labels:
      - "traefik.enable=true"
      - "traefik.docker.allowNonRunning=true"
      - "traefik.http.services.fleet.loadbalancer.server.port=3000"
      - "traefik.http.routers.fleet.service=fleet"
      - "traefik.http.routers.fleet.rule=Host(`fleet.${DOMAIN}`)"
      - "traefik.http.routers.fleet.entrypoints=https"
      - "traefik.http.routers.fleet.tls.certresolver=${CERTRESOLVER:+${CERTRESOLVER}}"
      - "traefik.http.routers.fleet.middlewares=secure-headers@file"
    networks:
      - internal
      - virgo
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
    ulimits:
      nofile:
        soft: 65536
        hard: 65536

  db:
    image: postgres:18-alpine
    environment:
      - POSTGRES_DB=${DB_NAME:-fleet}
      - POSTGRES_USER=${DB_USER:-fleet}
      - POSTGRES_PASSWORD=${DB_PASSWORD}
    volumes:
      - /messier/apps/fleet/db:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-fleet} -d ${DB_NAME:-fleet}"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks:
      - internal
    restart: unless-stopped

  coturn:
    image: coturn/coturn:latest
    network_mode: host
    command:
      - --realm=${TURN_REALM:-${DOMAIN}}
      - --use-auth-secret
      - --static-auth-secret=${TURN_SECRET_KEY}
      - --listening-ip=${TURN_INTERNAL_IP}
      - --listening-ip=172.30.0.1
      - --relay-ip=${TURN_INTERNAL_IP}
      - --listening-port=${TURN_LISTENING_PORT:-3477}
      - --alt-listening-port=0
      - --min-port=${TURN_MIN_PORT:-61000}
      - --max-port=${TURN_MAX_PORT:-61500}
      - --total-quota=400
      - --no-tls
      - --no-multicast-peers
      - --denied-peer-ip=0.0.0.0-0.255.255.255
      - --denied-peer-ip=10.0.0.0-10.255.255.255
      - --denied-peer-ip=127.0.0.0-127.255.255.255
      - --denied-peer-ip=100.64.0.0-100.127.255.255
      - --denied-peer-ip=169.254.0.0-169.254.255.255
      - --denied-peer-ip=172.16.0.0-172.31.255.255
      - --denied-peer-ip=192.168.0.0-192.168.255.255
      - --denied-peer-ip=224.0.0.0-255.255.255.255
      - --external-ip=${TURN_EXTERNAL_IP}
      - --no-software-attribute
      - --log-file=stdout
    volumes:
      - /messier/apps/fleet/coturn:/var/lib/coturn
    restart: unless-stopped

networks:
  internal:
    internal: true
  virgo:
    external: true
```
