FROM caddy:2-builder AS builder
RUN xcaddy build \
    --with github.com/caddy-dns/route53@v1.6.2 \
    --with github.com/ss098/certmagic-s3

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
