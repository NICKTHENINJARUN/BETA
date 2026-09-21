# The app has no runtime dependency, so there is nothing to install and no
# build step — this image is Node plus the source. That is also why it is
# small and why it starts instantly.
#
# It is a plain Dockerfile rather than anything platform-specific so the same
# image runs on Fly, Railway, Render, Cloud Run or a box you own. Switching
# providers should be a DNS change, not a rewrite.
FROM node:22-alpine

# Tini reaps zombies and, more importantly here, passes SIGTERM through to
# Node so the graceful shutdown in index.mjs actually runs. Without an init,
# PID 1 ignores the default signal handlers and the platform ends up killing
# the process mid-write.
RUN apk add --no-cache tini

WORKDIR /app

# The server hosts both pages, so the trainer comes too. It sits beside server/
# rather than inside it, which is where index.mjs looks for it and where it
# lives in the repository — same relative path in both places, so there is no
# "works locally" gap. The tests and the workflow are not part of the image.
COPY package.json ./
COPY index.html ./index.html
COPY server ./server

# The database lives on a mounted volume, owned by the user we drop to.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DB_PATH=/data/table.db \
    TRUST_PROXY=1

EXPOSE 8080

# Touches the database rather than just the port, so an instance that has lost
# its disk is reported unhealthy instead of quietly serving a broken table.
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.mjs"]
