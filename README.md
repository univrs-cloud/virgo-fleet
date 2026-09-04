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

When a browser opens a node's UI, fleet no longer proxies the node's namespace/API traffic through its
own event loop — the browser and the node hold a direct WebRTC data channel and fleet only relays the
signaling. A node on a public address is reached directly; a node behind CGNAT is reached through a
relay, which is what the `coturn` sidecar below provides. Fleet stays the automatic fallback: a node
that doesn't advertise support, a browser without WebRTC, or a data channel that fails to establish
all transparently keep using the Socket.IO proxy.

The page always opens the Socket.IO proxy first and prepares the data channel in parallel. A hard
five-second browser deadline leaves the page on Socket.IO if negotiation is slow. Once both paths
are ready, each WebRTC namespace is explicitly activated, new operations use it, and the old proxy
is disconnected after acknowledged operations have drained within their existing timeouts. Until that
activation the node suppresses the prepared namespace's events, so the UI has only one active event
source. A node that does not advertise the capability is refused at `webrtc:session:request`, and a
failed attempt puts that node on a one-minute cooldown for the page.

Fleet and the node record negotiation monotonically as `REQUESTED` → `OPEN_SENT` →
`OFFER_RECEIVED` → `ANSWERED` → `CONNECTED` → `CLOSING` → `CLOSED`. Fleet keeps a 30-second
negotiation cleanup timer as a server-side safety net; it is separate from the five-second browser
experience deadline.

The relay only carries sessions where **neither** peer can be reached directly. A node behind CGNAT
usually still connects directly when the admin's own NAT is endpoint-independent, so the relay is
for both-ends-symmetric and UDP-blocked networks. The browser receives both UDP and TCP TURN URLs,
but the node deliberately keeps only UDP. The packaged `node-datachannel` uses libjuice: although
its binding exposes `TurnTcp`/`TurnTls` enum values, TURN control over TCP/TLS requires a libnice
build. Thus a UDP-blocked browser can use TURN/TCP, while a UDP-blocked node remains on Socket.IO.

HTML and static assets stay on the HTTP/Socket.IO bootstrap path because they are needed before a
data channel can exist. Asset chunks are binary Socket.IO attachments, streamed one at a time with
an acknowledgement and HTTP response backpressure; they are never JSON-stringified into WebRTC
control frames. The data channel carries the smaller namespace control/event protocol.
Both data-channel writers use an ordered queue, pause above a 1 MiB native buffer, resume from the
buffered-amount-low callback, and close the session rather than exceed an 8 MiB aggregate bound.

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

Like `nextcloud-hpb`'s `aio-talk`, Traefik isn't involved and there is no TLS (no certificate).
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

The relay is reachable by any signed-in fleet user (they read a 300s credential out of their
session ack), so `--denied-peer-ip` blocks the RFC1918 ranges **and loopback** — nodes are relayed
to on public addresses, so this costs nothing and keeps the relay from being an open path into the
docker networks, the host LAN, or anything bound to `127.0.0.1`. coturn does not deny loopback on
its own, and host networking puts the host's own loopback services one `CreatePermission` away, so
that entry is as load-bearing as the RFC1918 ones.

**Nextcloud Talk HPB coexistence.** If this host also runs `nextcloud-hpb`, its `aio-talk` container
already binds `3478/tcp+udp`. coturn's `3477` clears it only with `--alt-listening-port=0`:
`--alt-listening-port` defaults to `listening-port + 1`, so a bare `--listening-port=3477` would
bind 3478 as well for RFC 5780 NAT discovery and collide with aio-talk. That discovery needs two
addresses anyway and is already disabled here (`RFC5780 disabled` in the startup log). The fleet
stack also keeps its own `.env`, separate from the `nextcloud-hpb` stack's, so the shared `TURN_*`
names don't cross. Verify after `docker compose up` — 3477 should be this stack's and 3478 should
still be aio-talk's:
```
ss -lntup | grep -E ':3478|:3477'
```

**Environment.**
```
TURN_SECRET_KEY      shared static-auth-secret (also set on the fleet service)
TURN_INTERNAL_IP     the host's LAN address; the only interface coturn binds and relays on
TURN_EXTERNAL_IP     the host's public IP, advertised in relay candidates
TURN_LISTENING_PORT  STUN/TURN over UDP and TCP (default 3477)
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
    # Each connected node holds a control socket open; the default 1024 fd limit is exhausted
    # well before a few hundred nodes (plus proxied user sessions). Raise it so the accept path
    # doesn't hit EMFILE during a reconnect storm.
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

  # Relays the browser <-> node WebRTC data channel for nodes that can't be reached directly (CGNAT).
  # Mirrors nextcloud-hpb's aio-talk: no Traefik, no TLS, and a control port of 3477 (which also
  # clears aio-talk's 3478). Host networking because relay allocations are UDP (the only kind
  # browsers ask for) and a published range costs a docker-proxy process per port; --listening-ip
  # and --relay-ip pin it to the forwarded interface, and --denied-peer-ip keeps the relay off the
  # docker networks and the host LAN.
  coturn:
    image: coturn/coturn:latest
    network_mode: host
    command:
      - --realm=${TURN_REALM:-${DOMAIN}}
      - --use-auth-secret
      - --static-auth-secret=${TURN_SECRET_KEY}
      - --listening-ip=${TURN_INTERNAL_IP}
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
