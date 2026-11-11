FROM node:22.23.5-alpine3.24

# Tools used by the optional SSH collectors, Git view and backup jobs. No npm dependencies.
RUN apk add --no-cache git openssh-client rsync python3
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/data /app/private /app/state /app/local \
    && chown node:node /app /app/data /app/private /app/state /app/local \
    && chmod 700 /app/data /app/private /app/state

ENV NODE_ENV=production \
    PORT=8781 \
    BIND_HOST=0.0.0.0 \
    HTTP_BEHIND_PROXY=1 \
    DATA_DIR=/app/data \
    STATE_DIR=/app/state \
    AUTH_FILE=/app/private/auth.json
USER node
VOLUME ["/app/data", "/app/private", "/app/state"]
EXPOSE 8781
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
