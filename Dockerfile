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
#   SMTP_PASS    SMTP password
#   SMTP_FROM    From address for verification emails (defaults to SMTP_USER)
ENV DOMAIN="" \
    SMTP_HOST="" \
    SMTP_PORT="587" \
    SMTP_SECURE="false" \
    SMTP_USER="" \
    SMTP_FROM=""

CMD ["node", "index.js"]
