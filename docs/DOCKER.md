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

For an explicit local source build, add the source override:

```sh
docker compose -f compose.yml -f compose.source.yml up --build -d
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

## Published images and public packages

The `CI` workflow builds and publishes all repository-owned deployment images
to GHCR for `linux/amd64` and `linux/arm64`:

| Purpose                           | Image                                  |
| --------------------------------- | -------------------------------------- |
| OpenDots application              | `ghcr.io/mr0007oo/opendots/app`        |
| Browser gateway                   | `ghcr.io/mr0007oo/opendots/browser`    |
| Computer supervisor               | `ghcr.io/mr0007oo/opendots/supervisor` |
| Dynamically launched Dot computer | `ghcr.io/mr0007oo/opendots/computer`   |

Pushes to `main` publish `latest` and `sha-<full-commit-sha>` tags. A `v*`
version-tag push publishes the version tag and commit-SHA tag. Manual runs can
publish from `main` or a `v*` tag by enabling the `publish_images` input.
Pull-request and other branch builds do not publish. The workflow lowercases
`GITHUB_REPOSITORY` before constructing image names, so the repository's
mixed-case GitHub owner/name never produces uppercase GHCR references.

Publishing does **not** make packages public automatically. On 2026-11-08,
anonymous registry checks confirmed that the existing `app:latest` and
`browser:latest` packages are public and each manifest contains
`linux/amd64` and `linux/arm64`. The `supervisor` and `computer` references
were not anonymously readable, so their package existence and visibility
cannot be confirmed. After the first successful publish, verify all four and
make any non-public package public:

1. Open the repository owner's **Packages** page on GitHub and select the
   `opendots/app` package.
2. Open **Package settings**, choose **Change visibility**, select **Public**,
   and confirm the package name when prompted.
3. Repeat for `opendots/browser`, `opendots/supervisor`, and
   `opendots/computer`.
4. Confirm each package settings page shows **Public** before relying on
   anonymous pulls. If a package must remain private, authenticate Docker on
   the VPS using a GitHub token with read-package access instead.

The pinned `h4ckf0r0day/obscura` image is third-party and is not published by
this workflow. Its digest-pinned manifest was inspected for both required
architectures.

## Deploy published images on the VPS

Check out this repository on the VPS and configure `.env` using `.env.example`.
Keep the existing application/browser secrets and computer supervisor/token
secrets set. The Compose file does not make CopilotKit Intelligence credentials
newly required. The `freellm_0007-network` external Docker network must already
exist and be shared with the reverse proxy; the app retains its loopback
published port and its existing isolated service networks.

Pull every image, including the profiled image the supervisor launches for Dot
computers, then start the services without building locally:

```sh
docker compose \
  -f compose.yml \
  -f compose.selfhosted.yml \
  -f compose.computers.yml \
  -f compose.computers-app.yml \
  --profile computer-runtime \
  pull

docker compose \
  -f compose.yml \
  -f compose.selfhosted.yml \
  -f compose.computers.yml \
  -f compose.computers-app.yml \
  up -d --no-build app browser obscura computer-supervisor
```

The external reverse proxy can reach the app at `app:4310` on
`freellm_0007-network`. Ports `4311` and `9222` remain unpublished. The
`computer-image` profile service is a pull-only target and is intentionally
not started; the supervisor uses the same GHCR image for dynamically created
computer containers.

For later image updates, run the same `pull` command and then the same
`up -d --no-build` command. Do not pass `-v` to `docker compose down` unless
you intend to remove the persistent data volumes.

## Source updates

For a source deployment, update the repository and explicitly use its build
override:

```sh
git pull --ff-only
docker compose -f compose.yml -f compose.source.yml up --build -d
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
docker compose \
  -f compose.yml \
  -f compose.selfhosted.yml \
  -f compose.computers.yml \
  -f compose.computers-app.yml \
  config --quiet
docker compose -f compose.yml -f compose.source.yml config --quiet
```

The publishing workflow builds each of the four repository-owned images for
both requested platforms and checks the published manifest before succeeding.
That manifest check verifies architecture availability, not runtime behavior
on physical Ampere hardware; run the stack on the VPS to verify the final
deployment.
