# zunia-extension

> Zunia browser extension for the Cosmos ecosystem — **Chrome, Firefox, Edge, and Safari**.

[![License](https://img.shields.io/github/license/Zunia-Lab/zunia-extension)](LICENSE)
[![Website](https://img.shields.io/badge/website-zuniawallet.com-2050C4)](https://zuniawallet.com)

## Overview

Non-custodial multi-chain wallet as a browser extension (Manifest V3 on Chromium; MV2/MV3 per WXT defaults for Firefox/Safari). Speaks IBC natively and exposes a Cosmos-compatible provider via `window.zunia`. Default chain metadata comes from [zunia-chain-registry](https://github.com/Zunia-Lab/zunia-chain-registry).

## Secure dApp connect (config only)

Provider injection is **not implemented** yet. CSP, permissions, injection matches, and `externally_connectable` origins are configured:

| Item | Location |
|------|----------|
| Connect policy | `config/connect.ts` |
| Manifest / CSP | `wxt.config.ts` |
| Provider types | `types/window.d.ts` |
| Env template | `.env.example` |

```bash
cp .env.example .env
# set WXT_WALLETCONNECT_PROJECT_ID (same Cloud project as mobile)
```

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
| `npm run dev:chrome` | Watch Chrome |
| `npm run dev:firefox` | Watch Firefox |
| `npm run dev:edge` | Watch Edge |
| `npm run dev:safari` | Watch Safari |
| `npm run build` | Production builds for all browsers |
| `npm run zip:chrome` / `zip:firefox` / `zip:edge` | Store-ready zips |

Stack: [WXT](https://wxt.dev) + React + TypeScript.

## Deployment

Tag GitHub Releases with multi-browser artifacts. Publish to Chrome Web Store, AMO, Edge Add-ons, and Safari via Xcode when ready. Links will appear on [zuniawallet.com](https://zuniawallet.com).

## Contributing

See [CONTRIBUTING.md](https://github.com/Zunia-Lab/.github/blob/main/CONTRIBUTING.md).

## Security

See [SECURITY.md](https://github.com/Zunia-Lab/.github/blob/main/SECURITY.md). Never paste seed phrases into issues.

## License

Apache-2.0. See [LICENSE](LICENSE).
