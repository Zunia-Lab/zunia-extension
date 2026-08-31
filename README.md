# zunia-extension

> Zunia browser extension for the Cosmos ecosystem (Chrome and Firefox, Manifest V3).

[![License](https://img.shields.io/github/license/zunialab/zunia-extension)](LICENSE)
[![Website](https://img.shields.io/badge/website-zuniawallet.com-2050C4)](https://zuniawallet.com)

## Overview

Non-custodial multi-chain wallet as a browser extension. Speaks IBC natively and exposes a Cosmos-compatible provider via `window.zunia`. Default chain metadata comes from [zunia-chain-registry](https://github.com/zunialab/zunia-chain-registry).

## Status

In development (alpha). Not published to the Chrome Web Store yet.

## Related repositories

| Repository | Description |
|------------|-------------|
| [zunia-mobile](https://github.com/zunialab/zunia-mobile) | Mobile wallet (same keys) |
| [zunia-dashboard](https://github.com/zunialab/zunia-dashboard) | Web portfolio |
| [zunia-chain-registry](https://github.com/zunialab/zunia-chain-registry) | Chain metadata |
| [zunia-docs](https://github.com/zunialab/zunia-docs) | Documentation |
| [zunia-website](https://github.com/zunialab/zunia-website) | Marketing site |
| [zunia-brand](https://github.com/zunialab/zunia-brand) | Brand assets |

## Quick start

```bash
npm install
npm run dev
```

Load the unpacked build from `.output/chrome-mv3` in Chrome (`chrome://extensions` → Developer mode → Load unpacked).

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
| `npm run dev` | Watch mode (WXT) |
| `npm run build` | Production build |
| `npm run zip` | Zip for store upload |

Stack: [WXT](https://wxt.dev) + React + TypeScript, Manifest V3.

## Deployment

Chrome Web Store and Firefox Add-ons listings will link from [zuniawallet.com](https://zuniawallet.com) when published. Tag releases on GitHub for reproducible builds.

## Contributing

See [CONTRIBUTING.md](https://github.com/zunialab/.github/blob/main/CONTRIBUTING.md).

## Security

See [SECURITY.md](https://github.com/zunialab/.github/blob/main/SECURITY.md). Never paste seed phrases into issues.

## License

Apache-2.0. See [LICENSE](LICENSE).
