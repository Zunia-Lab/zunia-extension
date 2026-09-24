<p align="center">
  <img src="https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-256.png" alt="Zunia" width="96" />
</p>

# zunia-extension

> Zunia browser extension for the Cosmos ecosystem: **Chrome, Edge, Firefox and Safari**.

[![CI](https://github.com/Zunia-Lab/zunia-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/Zunia-Lab/zunia-extension/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Zunia-Lab/zunia-extension)](LICENSE)
[![Website](https://img.shields.io/badge/website-zunialab.com-FF1B0C)](https://zunialab.com)

## Status

Alpha. The extension is not published in any browser store yet. CI builds and checks all
four targets on every push; the table below says what has been verified in each browser.

## Overview

A non-custodial, multi-chain Cosmos wallet. The recovery phrase is sealed with the user's
password in extension storage and is only ever handled by the signing kernel,
[zunia-core](https://github.com/Zunia-Lab/zunia-core) compiled to WebAssembly, inside the
background worker. Web pages reach the wallet through `window.zunia`, a Keplr-compatible
provider, and every connection and signature needs the user's approval. Chain metadata comes
from [zunia-chain-registry](https://github.com/Zunia-Lab/zunia-chain-registry).

## Browser support

Every target is Manifest V3.

| Browser | Background | Build | Output | Verified |
| --- | --- | --- | --- | --- |
| Chrome, Brave, Opera | Service worker | `pnpm build:chrome` | `.output/chrome-mv3` | Automated: WASM kernel loads, provider injects under strict page CSPs |
| Edge | Service worker | `pnpm build:edge` | `.output/edge-mv3` | Same Chromium build as Chrome |
| Firefox 140+ (desktop) | Event page | `pnpm build:firefox` | `.output/firefox-mv3` | Automated: WASM kernel loads, provider injects under strict page CSPs, addons-linter reports no errors |
| Safari (macOS, iOS) | Service worker | `pnpm safari:build` | `.output/safari-mv3`, Xcode project in `safari/` | CI builds the macOS and iOS Simulator apps; not yet exercised inside Safari |

Firefox 140 is the floor because that is where Firefox shows its own data consent prompt,
which the manifest's `data_collection_permissions` relies on. Firefox for Android is not
tested. Details, store notes and the manual checklist are in
[docs/browsers.md](docs/browsers.md).

## Getting started

Requirements: Node 22, pnpm 9 (`corepack enable`), and for the kernel a Rust toolchain with
[`wasm-bindgen-cli`](https://github.com/wasm-bindgen/wasm-bindgen) at the version pinned in
zunia-core's `Cargo.lock`.

The `@zunialab/*` packages the extension uses are linked from sibling checkouts
(`pnpm.overrides` in `package.json`), so clone them side by side and build them first:

```bash
git clone https://github.com/Zunia-Lab/zunia-core
git clone https://github.com/Zunia-Lab/zunia-ui
git clone https://github.com/Zunia-Lab/zunia-sdk
git clone https://github.com/Zunia-Lab/zunia-extension

(cd zunia-core && ./scripts/build-wasm.sh)
(cd zunia-ui && pnpm install && pnpm --filter @zunialab/tokens build && pnpm --filter @zunialab/ui build)
(cd zunia-sdk && pnpm install && pnpm --filter @zunialab/interchain build)

cd zunia-extension
pnpm install
pnpm dev        # Chrome; also dev:edge, dev:firefox, dev:safari
```

`pnpm dev` keeps rebuilding `.output/chrome-mv3-dev`. Load it once and WXT reloads it in place:

- **Chrome, Edge, Brave, Opera:** `chrome://extensions`, turn on Developer mode, then
  Load unpacked and pick `.output/chrome-mv3-dev` (or a production folder).
- **Firefox:** `about:debugging#/runtime/this-firefox`, then Load Temporary Add-on and pick
  `manifest.json` in `.output/firefox-mv3`.
- **Safari:** see [docs/browsers.md](docs/browsers.md#safari).

The vault survives dev restarts because the Chromium profile lives in `.wxt/chrome-data`
(gitignored). You still unlock after a browser restart, since the decrypted phrase is only
kept in session storage.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Watch build for Chrome (`dev:edge`, `dev:firefox`, `dev:safari` for the others) |
| `pnpm build` | Production builds for Chrome, Edge, Firefox and Safari |
| `pnpm check:build` | Checks the production builds (MV3, CSP, one kernel binary, permissions, per-browser keys) |
| `pnpm lint:firefox` | Mozilla's addons-linter on the Firefox build |
| `pnpm safari:build` | Safari build, then the macOS and iOS Simulator apps (macOS and Xcode only) |
| `pnpm safari:open` | Open the Safari app project in Xcode |
| `pnpm typecheck` | TypeScript |
| `pnpm lint` | ESLint |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm zip:chrome`, `zip:edge`, `zip:firefox` | Store upload archives |

Stack: [WXT](https://wxt.dev), React 19, TypeScript, Tailwind CSS 4.

## Connecting a dApp

The provider is injected by an isolated content script into every HTTPS page and
`localhost`. The page script and the content script talk over a nonce-scoped
`MessageChannel` with origin checks on both sides; the background worker decides every
request by the page's origin. `window.keplr` is an opt-in alias, off by default.

```ts
await window.zunia.enable("cosmoshub-4");
const signer = window.zunia.getOfflineSigner("cosmoshub-4");
const [account] = await signer.getAccounts();
```

Most dApps should use the SDK instead of the raw provider:
[`@zunialab/sdk-web`](https://github.com/Zunia-Lab/zunia-sdk) handles detection, events and
the QR fallback to the mobile app. The full API is documented at
[docs.zunialab.com](https://docs.zunialab.com).

| Item | Location |
| --- | --- |
| Connect policy | `config/connect.ts` |
| Host permissions | `config/hosts.ts`, `wxt.config.ts` |
| Session and security policy | `config/session.yaml`, `config/security.yaml` |
| Provider types | `types/window.d.ts` |

Because the content script has to run on any site that might be a dApp, the install prompt
asks for access to all websites. The extension's own requests do not rely on it:
`host_permissions` cover `localhost` and the Zunia API hosts only, and balances and
broadcasts go to each chain's public REST endpoints, which answer cross-origin requests.

## Related repositories

| Repository | Description |
| --- | --- |
| [zunia-core](https://github.com/Zunia-Lab/zunia-core) | Signing kernel (Rust, compiled to WASM here) |
| [zunia-sdk](https://github.com/Zunia-Lab/zunia-sdk) | SDKs for dApps (web, React; Flutter planned) |
| [zunia-mobile](https://github.com/Zunia-Lab/zunia-mobile) | Mobile wallet |
| [zunia-ui](https://github.com/Zunia-Lab/zunia-ui) | Design tokens and components |
| [zunia-chain-registry](https://github.com/Zunia-Lab/zunia-chain-registry) | Chain metadata |
| [zunia-docs](https://github.com/Zunia-Lab/zunia-docs) | Documentation |

## Contributing

See [CONTRIBUTING.md](https://github.com/Zunia-Lab/.github/blob/main/CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md). Never paste a recovery phrase into an issue.

## License

Apache-2.0. See [LICENSE](LICENSE).
