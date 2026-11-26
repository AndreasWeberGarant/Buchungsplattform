FROM node:24-alpine
WORKDIR /app
COPY server.mjs ./
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production DB_PATH=/app/data/bookings.sqlite PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
