FROM --platform=linux/arm64 debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl xz-utils \
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
RUN chmod 0755 /var/www/virgo-api/app/docker-entrypoint.sh

VOLUME ["/data"]

EXPOSE 3000

CMD ["/var/www/virgo-api/app/docker-entrypoint.sh"]
