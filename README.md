# virgo-fleet

.env
```
CERTRESOLVER='le'
DOMAIN='your.domain'
```

docker-compose.yml
```
services:
  fleet:
    image: ghcr.io/univrs-cloud/virgo-fleet:latest
    environment:
      - PUID=1000
      - PGID=100
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

networks:
  virgo:
    external: true
```