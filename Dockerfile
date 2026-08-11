# Static site — no build step, no server code, no secrets.
FROM nginx:alpine

LABEL org.opencontainers.image.title="Solana Coin Pick" \
      org.opencontainers.image.description="One-button Solana meme coin picker" \
      org.opencontainers.image.source="https://github.com/bnichols024/solana-coin-pick"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html styles.css /usr/share/nginx/html/
COPY src /usr/share/nginx/html/src

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
