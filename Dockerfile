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
# su-exec drops to the unprivileged user from the entrypoint, after it has
# fixed the ownership of the mounted volume. See docker-entrypoint.sh.
RUN apk add --no-cache tini su-exec

WORKDIR /app

# The server hosts both pages, so the trainer comes too. It sits beside server/
# rather than inside it, which is where index.mjs looks for it and where it
# lives in the repository — same relative path in both places, so there is no
# "works locally" gap. The tests and the workflow are not part of the image.
COPY package.json ./
COPY index.html ./index.html
COPY server ./server

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The image's own /data only matters when nothing is mounted over it. When a
# volume IS mounted there — which is the whole point on a real deployment — it
# arrives root-owned and replaces this directory entirely, so the entrypoint
# has to fix the ownership at boot. This container therefore starts as root and
# drops to `node` there, rather than dropping here with USER.
RUN mkdir -p /data && chown -R node:node /data /app

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

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/index.mjs"]
