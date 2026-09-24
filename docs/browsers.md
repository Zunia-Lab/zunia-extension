# Browser support

One codebase, four Manifest V3 builds. `wxt.config.ts` computes the manifest per browser and
`scripts/check-build.mjs` checks each output in CI.

| | Chrome, Brave, Opera | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- |
| Output | `.output/chrome-mv3` | `.output/edge-mv3` | `.output/firefox-mv3` | `.output/safari-mv3` |
| Background | Service worker | Service worker | Event page (`background.scripts`) | Service worker |
| Declared minimum | None, tested on current stable | None, same build | 140 desktop, 142 Android | None, not yet run in Safari |
| `externally_connectable` | Yes, for zunialab.com | Yes | Not supported, omitted | Omitted |
| Store | Chrome Web Store | Edge Add-ons | addons.mozilla.org | App Store, through the Xcode project |
| Published | No | No | No | No |

## What is verified, and how

| Check | Chrome | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- |
| `check:build` (MV3, CSP, one kernel binary, permissions, per-browser keys) | CI | CI | CI | CI |
| addons-linter (`pnpm lint:firefox`) | | | CI, no errors | |
| WASM kernel loads (`KERNEL_STATUS` reports `flavor: "wasm"`) | Automated | Chromium build | Automated | Manual |
| Provider injects under `script-src 'self'`, nonce plus `strict-dynamic`, and Trusted Types page policies | Automated | Chromium build | Automated | Manual |

The automated checks load the production build into Chromium through Playwright and into
Firefox through geckodriver, then call the worker from an extension page. The remaining two
addons-linter warnings are React DOM's own `innerHTML` code path for
`dangerouslySetInnerHTML`, which this codebase does not use.

## Signing kernel

The WebAssembly kernel ships once per build, at `/zunia_core_bg.wasm`. The
`build:publicAssets` hook copies it out of `@zunialab/core` at build time, `lib/kernel.ts`
loads it from that fixed extension URL, and the manifest CSP carries `'wasm-unsafe-eval'` so
the worker may compile it. If the binary fails to load, the wallet falls back to a JavaScript
kernel that signs dApp requests but refuses to build transactions. The Send, Swap and NFT
transfer screens then disable their confirm button and say why; staking and voting fail
with the kernel's error after approval.

## Firefox

- **Why 140:** Firefox shows its own data consent prompt from 140 on desktop and 142 on
  Android. `data_collection_permissions` declares `financialAndPaymentInfo`: addresses go to
  the chain endpoints balances are read from, and signed transactions to the node that
  broadcasts them. Nothing is sent to a Zunia server.
- **Host access:** Firefox grants the content script's `https://*/*` match at install. If a
  user withdraws it in `about:addons`, Permissions, the provider stops appearing on sites.
- **Local testing:** `about:debugging#/runtime/this-firefox`, Load Temporary Add-on, then
  `manifest.json` in `.output/firefox-mv3`.
- **AMO submission:** AMO asks for the source code and build steps because the build is
  bundled. Point reviewers to [reproducible-builds.md](reproducible-builds.md) and the
  sibling layout in the README.

## Edge

Edge takes the Chromium package unchanged. Submit `pnpm zip:edge` in Partner Center with the
Edge listing assets.

## Safari

`pnpm build:safari` produces the web extension. Safari runs it only inside a native app, and
Apple's converter generates that app:

```bash
xcrun safari-web-extension-converter .output/safari-mv3 \
  --project-location safari --app-name Zunia \
  --bundle-identifier com.zunialab.Zunia --swift --no-open
```

Signing and App Store submission need the Zunia Lab Apple developer account.

## Manual checklist, per browser

Run this on each browser before a store submission:

- [ ] Install the production build, create a wallet, lock, unlock.
- [ ] The WASM kernel is active: the Send screen shows no "signing kernel is not loaded"
      notice and its confirm button is enabled.
- [ ] Connect a dApp, approve, sign an Amino and a Direct transaction.
- [ ] Switch account: the connected page receives `accountsChanged`, others do not.
- [ ] Revoke the site in Connected sites: the page receives `disconnect`.
- [ ] Send, stake and vote from the wallet itself.
- [ ] Brave: repeat the connect test with Shields up.
