<p align="center">
  <img src="https://raw.githubusercontent.com/Zunia-Lab/zunia-brand/main/png/icons/app/zunia-icon-256.png" alt="Zunia" width="96" />
</p>

# zunia-extension

> Zunia browser extension for the Cosmos ecosystem — **Chrome, Firefox, Edge, and Safari**.

[![License](https://img.shields.io/github/license/Zunia-Lab/zunia-extension)](LICENSE)
[![Website](https://img.shields.io/badge/website-zuniawallet.com-FF1B0C)](https://zuniawallet.com)

## Overview

Non-custodial multi-chain wallet as a browser extension (Manifest V3 on Chromium; MV2/MV3 per WXT defaults for Firefox/Safari). Speaks IBC natively and exposes a Cosmos-compatible provider via `window.zunia`. Default chain metadata comes from [zunia-chain-registry](https://github.com/Zunia-Lab/zunia-chain-registry).

## Secure dApp connect

Provider injection is implemented via a MAIN-world `window.zunia` script and an
isolated content-script bridge (nonce-scoped MessageChannel, origin checks both
sides). Keplr alias `window.keplr` is **off by default** (opt-in in popup settings).

| Item | Location |
|------|----------|
| Connect policy | `config/connect.ts` |
| Host permissions | `config/hosts.ts`, `wxt.config.ts` |
| Session / security policy | `config/session.yaml`, `config/security.yaml` |
| Provider types | `types/window.d.ts` |
| Env template | `.env.example` |

`host_permissions` are limited to localhost and Zunia API hosts. dApp RPC is not
fetched under broad `https://*/*`; CosmJS runs in the page, and first-party sites
use `externally_connectable` / user-granted origins.
## Status

In development (alpha). Not published to browser stores yet.

## Supported browsers

| Browser | Build command | Output | Store |
|---------|---------------|--------|-------|
| Chrome | `npm run build:chrome` | `.output/chrome-mv3` | Chrome Web Store |
| Firefox | `npm run build:firefox` | `.output/firefox-mv2` or mv3 | Firefox Add-ons (AMO) |
| Edge | `npm run build:edge` | `.output/edge-mv3` | Microsoft Edge Add-ons |
| Safari | `npm run build:safari` | `.output/safari-mv2` | App Store (needs Xcode conversion) |

Opera and Brave load the Chrome build (Chromium).

### Safari packaging

After `npm run build:safari`, convert with Apple’s tooling on macOS:

```bash
xcrun safari-web-extension-converter .output/safari-mv2 \
  --project-location ./safari \
  --app-name Zunia \
  --bundle-identifier com.zuniawallet.extension
```

Then open the generated Xcode project, set signing, and archive for the Mac App Store / Safari Extensions gallery.

## Related repositories

| Repository | Description |
|------------|-------------|
| [zunia-mobile](https://github.com/Zunia-Lab/zunia-mobile) | Mobile wallet (same keys) |
| [zunia-dashboard](https://github.com/Zunia-Lab/zunia-dashboard) | Web portfolio |
| [zunia-chain-registry](https://github.com/Zunia-Lab/zunia-chain-registry) | Chain metadata |
| [zunia-docs](https://github.com/Zunia-Lab/zunia-docs) | Documentation |
| [zunia-website](https://github.com/Zunia-Lab/zunia-website) | Marketing site |
| [zunia-brand](https://github.com/Zunia-Lab/zunia-brand) | Brand assets |
| [zunia-ui](https://github.com/Zunia-Lab/zunia-ui) | UI kit (not required for connect) |
| [zunia-sdk](https://github.com/Zunia-Lab/zunia-sdk) | Developer SDKs for web / React / Flutter |

## Quick start

```bash
npm install
npm run dev:chrome     # or: dev:firefox | dev:edge | dev:safari
```

Leave `dev:chrome` running while you edit. WXT hot-reloads the extension in place.
The sealed vault lives in `chrome.storage.local` inside a persistent Chromium
profile at `.wxt/chrome-data` (gitignored), so stop/start no longer wipes the wallet.
You still unlock after a full browser restart because the mnemonic only sits in
`chrome.storage.session`.

Load unpacked:

- **Chrome / Edge / Brave / Opera:** `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3` (or edge)
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json` under `.output/firefox-*`

## Provider API

```typescript
await window.zunia.enable(chainId);
const offlineSigner = window.zunia.getOfflineSigner(chainId);
const accounts = await offlineSigner.getAccounts();
```

See [docs](https://docs.zuniawallet.com/docs/connect/dapp-api) for the full surface.

## Development

| Command | Description |
|---------|-------------|
| `pnpm dev:chrome` | Watch Chrome |
| `pnpm dev:firefox` | Watch Firefox |
| `pnpm dev:edge` | Watch Edge |
| `pnpm dev:safari` | Watch Safari |
| `pnpm test` | Unit tests (vitest) |
| `pnpm typecheck` | TypeScript check |
| `pnpm build` | Production builds for all browsers |
| `pnpm zip:chrome` / `zip:firefox` / `zip:edge` | Store-ready zips |

Stack: [WXT](https://wxt.dev) + React + TypeScript.

## Deployment

Tag GitHub Releases with multi-browser artifacts. Publish to Chrome Web Store, AMO, Edge Add-ons, and Safari via Xcode when ready. Links will appear on [zuniawallet.com](https://zuniawallet.com).

## Contributing

See [CONTRIBUTING.md](https://github.com/Zunia-Lab/.github/blob/main/CONTRIBUTING.md).

## Security

See [SECURITY.md](https://github.com/Zunia-Lab/.github/blob/main/SECURITY.md). Never paste seed phrases into issues.

## License

Apache-2.0. See [LICENSE](LICENSE).
