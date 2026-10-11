# syntax=docker/dockerfile:1

# The backend as a container image: plain JavaScript, no build step, no native modules, so the
# image is just production dependencies plus the source. Runs as the unprivileged "node" user.
#
# Not built or run in CI yet. Attachments are still written to local disk (uploads/attachments),
# which is ephemeral in a container: move them to object storage before running more than one
# instance or trusting a redeploy not to lose them.
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN mkdir -p uploads/attachments && chown -R node:node uploads
USER node
EXPOSE 3000

# Healthy means "can serve a sign-in": the server's own ready flag, not just an open port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>r.json()).then(b=>process.exit(b.ready===false?1:0)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
