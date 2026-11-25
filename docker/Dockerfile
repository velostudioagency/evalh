# evalh Linux sandbox image.
# Build from the repository root (not from docker/):
#   docker build -f docker/Dockerfile -t evalh:latest .
# The base image is pulled on first build; prefetch with `docker pull node:22-slim`.
#
# The harness resolves pi packages from npm (no monorepo checkout needed).
# Credentials are not baked in: docker/run.sh forwards EVALH_* variables and can
# mount a host pi agent directory read-only at /app/.pi-agent. Cloud providers
# that only need an API key work without that mount. For a local LM Studio
# endpoint, set its baseUrl to http://host.docker.internal:1234/v1 in models.json
# and use docker/run.sh, which adds the host-gateway mapping.
FROM node:22-slim

# ca-certificates: HTTPS provider calls. git: baseline commit and captureDiff.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# node:22-slim ships npm 10, which fails with "Cannot read properties of null
# (reading 'edgesOut')" on this dependency graph. npm 11 resolves it cleanly.
RUN npm install -g npm@11

# Install deps first for layer caching. We do not copy package-lock.json: it
# still contains local file: links, while package.json uses registry packages.
COPY package.json ./
RUN npm install --ignore-scripts

# Source and data needed at build and run time. tsconfig.build.json is required
# by `npm run build`; tsconfig.json is included for editor/type-check parity.
COPY src/ ./src/
COPY templates/ ./templates/
COPY docs/ ./docs/
COPY tasks/ ./tasks/
COPY tsconfig.json tsconfig.build.json ./

RUN npm run build

# v1 runs as root. Future work: create a non-root user and drop capabilities.
# No EXPOSE: the image is used with one-shot `docker run` invocations.
CMD ["node", "dist/cli.js", "--help"]
