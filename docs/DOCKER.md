# Docker deployment

OpenDots runs as a Node.js application container with a small browser gateway and
the upstream Obscura browser service. Docker Compose keeps the app, gateway, and
browser engine on private networks; only the application is published, bound to
host loopback by default.

## Browser architecture

- The app uses `BROWSER_URL` and `BROWSER_SECRET` to reach its isolated browser
  gateway. The environment variable names remain compatible with existing
  deployments.
- The gateway connects to Obscura over authenticated Chrome DevTools Protocol
  (CDP), using `OBSCURA_CDP_URL` and `OBSCURA_CDP_TOKEN`.
- The gateway creates an isolated Obscura context per research request. Website
  requests are intercepted and fetched through the gateway, which validates
  public IPs, pins DNS resolution, blocks redirects, and limits requests to
  public `GET` resources. Downloads, WebSockets, private addresses, and write
  requests are blocked.
- Obscura's upstream image is pinned by digest and provides `linux/amd64` and
  `linux/arm64`. The Playwright dependency is `playwright-core`, used only as a
  CDP client; the OpenDots image no longer downloads Chromium.
- Persistent interactive Dot computers remain the separate OpenBot integration.
  Their browser profiles, computer files, permissions, and human takeover
  continue to use the existing per-Dot computer service. Obscura replaces the
  isolated public-page reader, not that distinct computer lifecycle.

Obscura is a browser engine, not a drop-in replacement for every Chromium API.
This adapter uses navigation, DOM text extraction, and screenshots. Some
long-tail Web APIs, native media, service workers, and advanced CSS/compositor
behavior remain incomplete compared with Chromium. See the
[Obscura Playwright guide](https://github.com/h4ckf0r0day/obscura/blob/main/docs/Use-with-Playwright.md)
for its current limits.

## Configuration

Copy the example and set private, independent secrets:

```sh
cp .env.example .env
```

Required by the Compose deployment:

| Variable            | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `OWNER_TOKEN`       | App access token, at least 24 characters                              |
| `BROWSER_SECRET`    | Authenticates app-to-browser-gateway requests, at least 24 characters |
| `OBSCURA_CDP_TOKEN` | Authenticates browser-gateway-to-Obscura CDP, at least 32 characters  |

Use distinct randomly generated values; never commit `.env`. Compose sets the
internal service URL `ws://obscura:9222`. The app and browser gateway retain the
existing `BROWSER_URL`/`BROWSER_SECRET` interface. Other app settings, including
`OPENAI_API_KEY`, `OPENAI_MODEL`, and the Intelligence key, are documented in
[Setup](SETUP.md#connection-settings).

## Build and run from source

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 app browser obscura
```

The app's published port defaults to `127.0.0.1:4310`; set `OPENDOTS_PORT` in
`.env` to another host port if it is already occupied. Put an HTTPS reverse
proxy in front of it and set `APP_ORIGIN` to the exact public origin. Do not
publish ports `4311` or `9222`. The Obscura CDP network is internal and has no
egress; the gateway has outbound access so it can fetch public resources
through the validated, DNS-pinned transport.

Compose health checks cover the app HTTP endpoint and a real CDP connection from
the gateway to Obscura. The Obscura upstream image is non-root and read-only with
only a temporary writable directory; all services drop Linux capabilities and
enable `no-new-privileges`.

## Persistence

`opendots-data` persists SQLite pages, workspace metadata, and thread bindings
across container recreation:

```sh
docker compose down
docker compose up -d
```

Do not pass `-v` to `docker compose down` unless you explicitly intend to delete
the named data volume. Conversation history remains in the configured
CopilotKit Intelligence deployment. Obscura's per-request research contexts are
ephemeral; persistent per-Dot browser profiles remain in the OpenBot computer
volumes.

## Published image

The application image is intended to be published as
[`docker.io/mr0007oo/opendots:latest`](https://hub.docker.com/r/mr0007oo/opendots).
The repository's application version is `0.1.0`. Published version tags include
the application version and the exact source commit, for example
`v0.1.0-a1b2c3d4e5f6`; this avoids moving a plain semver tag when upstream
changes do not bump the application version.
The project Compose file builds the browser gateway from source and pulls the
pinned Obscura image.

After the source tests and both target builds pass, authenticate locally and
publish both supported architectures:

```sh
docker login --username Mr0007oo
GIT_SHA="$(git rev-parse --short=12 HEAD)"
APP_VERSION="$(node -p "require('./package.json').version" | tr '[:upper:]' '[:lower:]')"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --target app \
  --tag docker.io/mr0007oo/opendots:latest \
  --tag "docker.io/mr0007oo/opendots:v${APP_VERSION}-${GIT_SHA}" \
  --push .
docker buildx imagetools inspect docker.io/mr0007oo/opendots:latest
docker buildx imagetools inspect "docker.io/mr0007oo/opendots:v${APP_VERSION}-${GIT_SHA}"
```

`docker login` prompts for a Docker Hub access token; do not put it in a command
line or repository file. For a fresh deployment from the published app image, check out this repository
for its Compose configuration, build the small browser gateway, then start with
the pulled app image:

```sh
docker compose pull app
docker compose build browser
docker compose up -d --no-build
```

The app service uses the published image when available and retains a build
target for source deployments. For source deployments, run
`docker compose up --build -d`.

## Updating

For source deployments, update the repository and rebuild:

```sh
git pull --ff-only
docker compose up --build -d
```

For image deployments, pull and recreate without deleting persistent volumes:

```sh
docker compose pull
docker compose up -d --no-build
```

## Troubleshooting

- `BROWSER_SECRET must be at least 24 characters`: set a private `BROWSER_SECRET`
  in `.env`; Compose requires it for both the app and browser gateway.
- `OBSCURA_CDP_TOKEN must be at least 32 characters`: set the same private token
  for the browser gateway and Obscura container.
- Browser health remains unhealthy: inspect `docker compose logs browser obscura`.
  Confirm the CDP endpoint is `ws://obscura:9222`, the token matches, and the
  two services share the internal `obscura-link` network.
- A page is rejected: supply its canonical public HTTP(S) URL. Private/special
  IPs, redirects, nonstandard ports, WebSockets, and non-GET traffic are blocked.
- SQLite data is missing: verify that `opendots-data` is mounted at `/data` and
  that `DATABASE_PATH` points inside that directory.
- Port 4310 is already occupied: set `OPENDOTS_PORT` in `.env`; the container
  still listens on 4310 and the browser/CDP services remain unpublished.

## Verification

Run the app tests and builds before publishing:

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
docker compose config
docker compose build app browser
docker compose up -d
docker compose ps
```

Latest Codespace verification:

- `npm test`: 57 files and 360 tests passed.
- Formatting, lint, typecheck, and production build passed.
- The Compose app, browser gateway, and Obscura services started; app and
  gateway health checks passed. A live `POST /browse` to `https://example.com/`
  returned the page title, text, and screenshot.
- A SQLite test row survived app container recreation in the named volume.
- The local app image was verified as `linux/amd64` and runs as the non-root
  `node` user. The Codespace Buildx worker does not advertise ARM64, so an
  ARM64 app build/start and Ampere runtime remain unverified.
- Docker Hub manifest inspection returned `insufficient_scope`; no image was
  published. The GitHub CLI is not authenticated, so no commit or push was
  attempted.

Multi-platform image manifests verify architecture availability, but an
amd64-only Codespace cannot prove that the image starts on physical Ampere
hardware. The `linux/arm64` Obscura image is available upstream; the app image
must still be built and started for ARM64 before claiming runtime verification.
