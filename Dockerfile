ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node shared/ ./shared/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node LICENSE.md THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
