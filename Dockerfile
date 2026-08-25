# Set the target at build time:
#   docker buildx build --platform linux/arm64 -t <tag> .
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg xz-utils \
    && curl -s --compressed "https://packages.univrs.cloud/public.key" \
        | gpg --dearmor -o /etc/apt/trusted.gpg.d/virgo-packages.gpg \
    && curl -s --compressed -o /etc/apt/sources.list.d/virgo.list "https://packages.univrs.cloud/virgo.list" \
    && apt-get update \
    && curl -fsSL -o /usr/local/bin/n https://raw.githubusercontent.com/tj/n/master/bin/n \
    && chmod 0755 /usr/local/bin/n \
    && n 24 \
    && n prune \
    && apt-get install -y --no-install-recommends virgo-ui \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /var/www/virgo-api/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

# Database connection. State lives in Postgres now (the sqlite /data volume is gone); provide real
# values at runtime via compose `environment:`. Defaults match the compose `db` service.
#   DB_HOST      Postgres hostname (the compose service name, e.g. "db")
#   DB_PORT      Postgres port (optional; defaults to 5432)
#   DB_NAME      database name
#   DB_USER      database user
#   DB_PASSWORD  database password
#   DB_POOL_MAX  max pooled connections (default 10)
ENV DB_HOST="db" \
    DB_NAME="fleet" \
    DB_USER="fleet"

# Email verification (signup) configuration. Provide real values at runtime via
# `docker run -e` / compose `environment:` — these declarations only document the contract
# and give safe empty defaults; secrets must never be baked into the image.
#   DOMAIN       base domain; the verification link is built as https://fleet.$DOMAIN,
#                matching the Traefik Host(`fleet.$DOMAIN`) route
#   SMTP_HOST    SMTP relay hostname
#   SMTP_PORT    SMTP port (587 for STARTTLS, 465 for implicit TLS)
#   SMTP_SECURE  "true" for implicit TLS (port 465), otherwise STARTTLS is used
#   SMTP_USER    SMTP username (optional if the relay accepts unauthenticated mail)
#   SMTP_PASSWORD    SMTP password
#   SMTP_FROM    From address for verification emails (defaults to SMTP_USER)
ENV DOMAIN="" \
    SMTP_HOST="" \
    SMTP_PORT="587" \
    SMTP_SECURE="false" \
    SMTP_USER="" \
    SMTP_FROM=""

# Two-factor (TOTP). MFA_SECRET_KEY encrypts TOTP secrets at rest (AES-256-GCM); any string works
# (it's hashed to a 32-byte key). Strongly recommended — without it, TOTP secrets are stored
# unencrypted and a DB dump would expose them. Runtime only, never baked into the image.
#   MFA_SECRET_KEY   at-rest encryption key for TOTP secrets

# Web Push (update notifications to installed PWAs). VAPID keypair, generated ONCE with
# `npx web-push generate-vapid-keys` and provided at runtime — never baked into the image, and
# never regenerated: rotating the keypair invalidates every stored push subscription (the push
# service rejects sends with 403), silently killing notifications for all existing installs.
#   VAPID_PUBLIC_KEY   public key; also served to the client for PushManager.subscribe()
#   VAPID_PRIVATE_KEY  private key (secret); signs push messages
#   VAPID_SUBJECT      contact URL required by spec, e.g. "mailto:admin@$DOMAIN"
ENV VAPID_PUBLIC_KEY="" \
    VAPID_PRIVATE_KEY="" \
    VAPID_SUBJECT=""

# DNS-01 certificates for nodes on the managed zone. Fleet holds the Cloudflare credential so that
# nodes never do: a node asks fleet to publish its `_acme-challenge` TXT record over the control
# socket it already holds, and fleet verifies the name belongs to that node before touching DNS. A
# Cloudflare token cannot be scoped below a zone, so one token means one zone — CLOUDFLARE_ZONE is a
# single domain, not a list. Runtime only; the empty defaults below declare the contract, secrets are
# never baked into the image.
#   CLOUDFLARE_API_TOKEN  API token scoped to CLOUDFLARE_ZONE with Zone:DNS:Edit
#   CLOUDFLARE_ZONE       the one managed domain, e.g. "univrs.cloud"
#   CLOUDFLARE_ZONE_ID    zone id from the zone's overview page; supplying it means the token needs
#                         no Zone:Read and fleet performs no zone lookup at all
ENV CLOUDFLARE_API_TOKEN="" \
    CLOUDFLARE_ZONE="" \
    CLOUDFLARE_ZONE_ID=""

# Migrations run first, in the entrypoint; a failure there stops the container rather than starting
# the app against a schema it does not match. CMD stays overridable and still gets migrated first.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "index.js"]
