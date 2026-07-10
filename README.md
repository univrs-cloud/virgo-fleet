# virgo-fleet

.env
```
CERTRESOLVER='le'
DOMAIN='your.domain'
SMTP_HOST='smtp.your.provider'
SMTP_PORT='587'
SMTP_SECURE='false'
SMTP_USER='postmaster@your.domain'
SMTP_PASS='your-smtp-password'
SMTP_FROM='fleet@your.domain'
```

docker-compose.yml
```
services:
  fleet:
    image: ghcr.io/univrs-cloud/virgo-fleet:latest
    environment:
      - PUID=1000
      - PGID=100
      - DOMAIN=${DOMAIN}
      - SMTP_HOST=${SMTP_HOST}
      - SMTP_PORT=${SMTP_PORT:-587}
      - SMTP_SECURE=${SMTP_SECURE:-false}
      - SMTP_USER=${SMTP_USER}
      - SMTP_PASS=${SMTP_PASS}
      - SMTP_FROM=${SMTP_FROM}
    volumes:
      - /messier/apps/fleet/data:/data
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
      - virgo
    restart: unless-stopped
    # Each connected node holds a control socket open; the default 1024 fd limit is exhausted
    # well before a few hundred nodes (plus proxied user sessions). Raise it so the accept path
    # doesn't hit EMFILE during a reconnect storm.
    ulimits:
      nofile:
        soft: 65536
        hard: 65536

networks:
  virgo:
    external: true
```