FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium xvfb x11vnc novnc websockify ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

EXPOSE 80

CMD ["node", "server.mjs"]
