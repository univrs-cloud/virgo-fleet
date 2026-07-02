FROM --platform=linux/arm64 debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg nodejs npm xz-utils \
    && curl -s --compressed "https://packages.univrs.cloud/public.key" \
        | gpg --dearmor -o /etc/apt/trusted.gpg.d/virgo-packages.gpg \
    && curl -s --compressed -o /etc/apt/sources.list.d/virgo.list "https://packages.univrs.cloud/virgo.list" \
    && apt-get update \
    && npm install -g n \
    && n 24 \
    && n prune \
    && apt-get install -y --no-install-recommends virgo-ui \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
