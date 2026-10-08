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
| `check:build` (MV3, CSP, one kernel binary, permissions, per-browser keys, the provider's release and features) | CI | CI | CI | CI |
| addons-linter (`pnpm lint:firefox`) | | | CI, no errors | |
| Xcode app builds for macOS and the iOS Simulator (`scripts/safari.mjs build`) | | | | CI |
| WASM kernel loads (`KERNEL_STATUS` reports `flavor: "wasm"`) | Automated | Chromium build | Automated | Partly, iOS Simulator |
| Provider injects under `script-src 'self'`, nonce plus `strict-dynamic`, and Trusted Types page policies | Automated | Chromium build | Automated | By hand, iOS Simulator |
| A dApp connects, signs in (verified by its server), gets an Amino signature, and hears an account switch and a revocation live | Automated | Chromium build | Automated | By hand, iOS Simulator |
| Opening the wallet restarts the auto-lock timer | Automated | Chromium build | | |
| The wallet stays unlocked when the browser unloads an idle background page | | | Automated | |

The automated rows are the `stack/` suite in
[zunia-e2e](https://github.com/Zunia-Lab/zunia-e2e), run locally against the production builds
and the SDK's example dApp. Playwright loads `.output/chrome-mv3` into Chromium; puppeteer-core
loads `.output/firefox-mv3` into a stock Firefox over WebDriver BiDi. The Safari rows are
described under [Tested in Safari](#tested-in-safari). The remaining two addons-linter warnings
are React DOM's own `innerHTML` code path for `dangerouslySetInnerHTML`, which this codebase
does not use.

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
- **Connect requests:** Firefox has no IntersectionObserver v2, so the extension cannot tell
  whether its in-page connect prompt is visible and unobstructed, and does not draw it.
  Connect requests wait in the toolbar popup, like signing requests.
- **Idle unloads:** Firefox unloads the background page about 30 seconds after its last event,
  and fires `runtime.onSuspend` first. The wallet stays unlocked through that: the unlocked
  session lives in `storage.session`, which outlives the page.
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

- There is no IntersectionObserver v2, so, as in Firefox, connect requests go to the toolbar
  popup instead of the in-page prompt.
- There is no `idle` API, so auto-lock runs on its timer only, not on screen lock.
- There is no notifications API, so the browser alerts switch is disabled with a note.
- Safari on iOS has no windows API. When the toolbar popup cannot open, for example because
  another popup is already open, requests open in a tab, which closes itself after the last
  answer. On iPhone the popup fills the sheet's width instead of drawing the 360px card,
  screens without the bottom bar size to their content so their buttons stay in view, and
  inputs use 16px text so Safari does not zoom in when one gets focus.
- In testing, `tabs.sendMessage` never reached a content script. The wallet sends a page's
  events (`accountsChanged`, `chainChanged`, `disconnect`, lock state) over a port the
  content script opens instead. Events are numbered and the last 100 are kept in
  `storage.session`, so a content script that reconnects, after Safari stopped the worker or
  when the tab comes back to the front, receives what it missed.
- Safari on iOS stops an idle worker after about 8 seconds, even with a port open, and about
  2 minutes after the last runtime message. While a request waits for an answer, and while a
  page that uses the wallet is in front, the content script and the approval screen ping the
  worker every 3 seconds.
- Safari keeps website access in its own settings. It answers the wallet's request for the
  chains' public endpoints (`https://*/*`) with a refusal and no prompt, so turning on live
  balances says where to allow it instead. On a Mac: Safari, Settings, Extensions, Zunia,
  Always Allow on Every Website, and Other Websites set to Allow, then Settings, Preferences,
  Live balances. On iPhone and iPad: Settings, Apps, Safari, Extensions, Zunia, Other
  Websites, Allow. The same settings decide which sites the extension may run on, so a dApp
  only sees `window.zunia` on sites Safari allows it on.

### App Store review, live balances (0.1.5)

Paste this in Resolution Center with the two screenshots. The first is Live balances off
before Safari allows Zunia on other websites. The second is it on after Always Allow on
Every Website, with balances loading.

```
Hello,

Live balances stays off until Safari allows Zunia to reach other websites. The switch is not broken. On macOS, Safari does not show a permission prompt when it is turned on. It keeps that choice in Safari's own settings, including a refusal from the previous version.

On the Mac you used:

1. Open Safari.
2. In the Safari menu, choose Settings, then Extensions.
3. Select Zunia.
4. Set website access to Always Allow on Every Website. Other Websites must be Allow.
5. Open Zunia again. Go to Settings, then Preferences, and turn Live balances on.

Balances and prices then load from each chain's public endpoint. Until that Safari setting is Allow, the switch stays off on purpose. The wallet does not read the network without it.

Screenshots are attached. The first shows Live balances off before Safari allows Zunia on other websites. The second shows it on after that access is set to Always Allow on Every Website, with balances loading.

We will upload a new build, 0.1.5.

Thank you.
```

### Tested in Safari

By hand on the iOS Simulator (iOS 26.4), with the Release build from `pnpm safari:build`, the
SDK's example dApp and the zunia-e2e test wallet:

- The dApp connects, from the toolbar popup and from the tab it falls back to, signs in (the
  example's server verifies it), and gets an Amino signature it verifies.
- Switching accounts, locking, unlocking and revoking the site in the wallet reach the open
  page live. After a reload, a locked wallet is still reported as locked.
- A request left open for minutes still gets its answer.
- The provider appears on the four strict-CSP pages of the zunia-e2e suite, served by a copy
  that prints the probe's result, and answers `getConnectedChains()` on each.
- Live balances work once Other Websites is allowed; before that, the switch says where to
  allow it.
- The Swap screen raises no kernel notice, which it shows when the kernel cannot build
  transactions. No transaction was broadcast, so the kernel row stays "partly".

Not yet: macOS Safari (it needs "Allow unsigned extensions", a click in Safari's Developer
Settings), Direct signing, a broadcast transaction, and a physical iPhone.

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
- [ ] Stake, unstake and claim from the wallet itself.
- [ ] Send with the memo "a & b" from the wallet itself: the chain accepts it and the
      explorer shows the memo as typed.
- [ ] Vote on a live proposal from the Governance screen: the chain records the vote
      instead of answering "signature verification failed".
- [ ] Add an account with its own recovery phrase and make it active. A dApp's sign-in and
      its Amino and Direct signatures verify against the key `getKey` returns for it.
- [ ] On app.zunialab.com, approve a Direct contract call (a cross-chain swap or a
      recovery): the prompt reads `Execute "…" on osmo1…` with the contract message, and
      the chain accepts it.
- [ ] Ask for a Direct message the wallet cannot read, such as
      `/cosmos.authz.v1beta1.MsgGrant`: the site's `UNSUPPORTED` error names that type.
- [ ] From a dApp, list an NFT on a marketplace (a `send_nft`): the prompt reads "Hand NFT
      … to contract …", naming the marketplace contract, with a first-time-recipient warning.
- [ ] From a dApp, send tokens with a packet-forward memo: beside the packet-memo notice,
      the prompt names the channel and the receiver the memo forwards them to, and Raw
      transaction shows the memo whole.
- [ ] In the page console, `window.zunia.version` is `"0.1.0"`,
      `window.zunia.extensionVersion` is the version being submitted, and
      `window.zunia.features` lists the strings in `config/connect.ts`.
- [ ] Brave: repeat the connect test with Shields up.
