# syntax=docker/dockerfile:1
# Generated from plexus-ms/template-app-nextjs.
# The image build of a Next.js standalone app in the monorepo, from its root or a pruned context (PLX-App/Dockerfile).
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS builder
ARG APP
WORKDIR /repo
ENV CI=1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# package.json comes along so that corepack runs the pnpm its packageManager pins.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The npmrc secret is the token of the tenant's private package registry, for a repo that installs
# from one (§ 5 PLX-Delivery); a build without the secret mounts nothing.
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm fetch
COPY turbo.json ./
COPY packages packages
COPY apps/${APP} apps/${APP}
# public/ is optional; an empty one lets the runner stage copy it unconditionally.
RUN mkdir -p apps/${APP}/public
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install --frozen-lockfile --prefer-offline
# pnpm, not Turbo, whose strict environment would hide BUILD_HASH and the key from `next build`;
# the filter's trailing `...` builds the app's workspace dependencies first, as `^build` would.
ARG BUILD_HASH
RUN --mount=type=secret,id=next-server-actions-encryption-key,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
    BUILD_HASH=${BUILD_HASH} pnpm --filter "{./apps/${APP}}..." run build

FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runner
ARG APP
WORKDIR /repo
ENV NODE_ENV=production
# The standalone output keeps the monorepo's layout; the static files and public/ go in beside it.
COPY --from=builder --chown=node:node /repo/apps/${APP}/.next/standalone ./
COPY --from=builder --chown=node:node /repo/apps/${APP}/.next/static ./apps/${APP}/.next/static
COPY --from=builder --chown=node:node /repo/apps/${APP}/public ./apps/${APP}/public
WORKDIR /repo/apps/${APP}
USER node
EXPOSE 3000
ENV HOSTNAME=0.0.0.0
ENTRYPOINT ["node", "server.js"]
