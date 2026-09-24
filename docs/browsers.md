# Browser support

One codebase, four Manifest V3 builds. `wxt.config.ts` computes the manifest per browser and
`scripts/check-build.mjs` checks each output in CI.

| | Chrome, Brave, Opera | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- |
| Output | `.output/chrome-mv3` | `.output/edge-mv3` | `.output/firefox-mv3` | `.output/safari-mv3` |
| Background | Service worker | Service worker | Event page (`background.scripts`) | Service worker |
| Declared minimum | None, tested on current stable | None, same build | 140 desktop, 142 Android | iOS 17 and macOS 13 (app deployment targets) |
| `externally_connectable` | Yes, for zunialab.com | Yes | Not supported, omitted | Omitted |
| `idle`, `notifications` | Yes | Yes | Yes | Omitted: Safari has neither API |
| Store | Chrome Web Store | Edge Add-ons | addons.mozilla.org | App Store, through the Xcode project |
| Published | No | No | No | No |

## What is verified, and how

| Check | Chrome | Edge | Firefox | Safari |
| --- | --- | --- | --- | --- |
| `check:build` (MV3, CSP, one kernel binary, permissions, per-browser keys) | CI | CI | CI | CI |
| addons-linter (`pnpm lint:firefox`) | | | CI, no errors | |
| Xcode app builds for macOS and the iOS Simulator (`scripts/safari.mjs build`) | | | | CI |
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

Safari runs a web extension only inside a native app. That app lives in `safari/Zunia`: an
Xcode project with an app and an app extension for macOS and for iOS, bundle identifiers
`com.zunialab.Zunia` and `com.zunialab.Zunia.Extension`. It does not copy the web
extension; it references `.output/safari-mv3`, so build the extension first.

```bash
pnpm safari:build   # wxt build -b safari, then the macOS and iOS Simulator apps
pnpm safari:open    # open the project in Xcode
```

`pnpm safari:build` ad hoc signs the macOS app and leaves the Simulator app unsigned; the
products land in `.output/safari-xcode`. Device builds, TestFlight and the App Store need
the Zunia Lab Apple developer team, set under Signing & Capabilities in Xcode.

### Running it locally

- **macOS:** run the Zunia (macOS) scheme from Xcode. In Safari, turn on Settings, Advanced,
  "Show features for web developers", then Develop, Developer Settings, "Allow unsigned
  extensions" (Safari turns this off again when it quits). Enable Zunia in Settings,
  Extensions, and allow it on all websites.
- **iOS Simulator:** run the Zunia (iOS) scheme on a simulator, then enable Zunia in the
  simulator's Settings, Apps, Safari, Extensions, and allow it on all websites.

### What differs in Safari

- There is no `idle` API, so auto-lock runs on its timer only, not on screen lock.
- There is no notifications API, so the browser alerts switch is disabled with a note.
- Safari on iOS has no windows API. When the toolbar popup cannot open, requests open in a
  tab, which closes itself after the last answer. On iPhone the popup fills the sheet's
  width instead of drawing the 360px card.

### Keeping the project in step

Xcode lists the top-level entries of `.output/safari-mv3` one by one. `scripts/safari.mjs`
fails when the build gains or loses one, or when `MARKETING_VERSION` differs from
`package.json`; add or remove the file in both extension targets, or bump the version.

The project came from Apple's converter, then was edited in three places. Keep them if you
ever regenerate it:

```bash
xcrun safari-web-extension-converter .output/safari-mv3 \
  --project-location safari --app-name Zunia \
  --bundle-identifier com.zunialab.Zunia --swift --no-open
```

1. Deployment targets raised to iOS 17 and macOS 13. On iOS the Safari version is the iOS
   version, and older Safari lacks APIs the wallet uses, such as `storage.session`.
2. `MARKETING_VERSION` set to the `package.json` version.
3. `SafariWebExtensionHandler.swift` answers native messages with nothing and logs nothing.
   The template logged every message it received.

## Manual checklist, per browser

Run this on each browser before a store submission:

- [ ] Install the production build, create a wallet, lock, unlock.
- [ ] The WASM kernel is active: the Send screen shows no "signing kernel is not loaded"
      notice and its confirm button is enabled.
- [ ] Connect a dApp, approve, sign an Amino and a Direct transaction.
- [ ] Switch account: the connected page receives `accountsChanged`, others do not.
- [ ] Revoke one chain, then the site, in Connected sites: the page receives `disconnect`
      with the chain and `chainChanged` with what is left, then `disconnect` with `null`.
- [ ] Lock the wallet and reload the connected page: `getConnectedChains()` returns its
      chains and no window opens.
- [ ] Sign in from a dApp: the "Sign in to <site>" screen appears. A sign-in message
      naming another site is refused without opening anything.
- [ ] Send, stake and vote from the wallet itself.
- [ ] Brave: repeat the connect test with Shields up.
