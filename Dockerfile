# The relay half of the booth: serves the guest app and parks prints until the
# MacBook's agent collects them. No printer, no CUPS, no npm dependencies.
FROM node:22-alpine

ENV NODE_ENV=production \
    MODE=relay \
    PORT=8080 \
    PRINTS_DIR=/data/prints \
    PHOTOBOOTH_CONFIG=/data/photobooth.config.json

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# /data holds the guest gallery and host settings. Mount a volume to keep them
# across deploys; without one the booth still works, it just starts fresh.
#
# Deliberately left running as root: volumes on Fly and Render are mounted
# root-owned, and a container that cannot write its own /data fails at the
# worst possible moment. Nothing here is exposed but the relay itself.
RUN mkdir -p /data/prints
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
