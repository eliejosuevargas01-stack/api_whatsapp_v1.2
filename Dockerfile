FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY db.js ./
COPY jwt.js ./
COPY instagramManager.js ./
COPY public ./public
COPY migrations ./migrations
COPY scripts ./scripts

RUN mkdir -p /app/data /app/sessions

EXPOSE 3000

CMD ["npm", "start"]
