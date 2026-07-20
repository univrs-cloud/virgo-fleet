# virgo-fleet

.env
```
CERTRESOLVER='le'
DOMAIN='your.domain'
DB_PASSWORD='your-db-password'
MFA_SECRET_KEY='a-long-random-string'
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
      - SMTP_HOST=${SMTP_HOST}
      - SMTP_PORT=${SMTP_PORT:-587}
      - SMTP_SECURE=${SMTP_SECURE:-false}
      - SMTP_USER=${SMTP_USER}
      - SMTP_PASSWORD=${SMTP_PASSWORD}
      - SMTP_FROM=${SMTP_FROM}
      - VAPID_PUBLIC_KEY=${VAPID_PUBLIC_KEY}
      - VAPID_PRIVATE_KEY=${VAPID_PRIVATE_KEY}
      - VAPID_SUBJECT=${VAPID_SUBJECT}
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

networks:
  internal:
    internal: true
  virgo:
    external: true
```
