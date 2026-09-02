# Four-browser parity

| Browser | Manifest | Notes |
| --- | --- | --- |
| Chrome | MV3 service worker | Reference implementation |
| Brave | MV3 | Test with Shields up; `window.zunia` must not collide with injected globals |
| Edge | MV3 | Submit via Edge Add-ons using the Chrome package + Edge listing assets |
| Firefox | MV3 event page | No persistent service worker; `browser_specific_settings.gecko` already set. AMO requires a source-code archive and build instructions (see `docs/reproducible-builds.md`) |

## Build matrix

```bash
pnpm build:chrome
pnpm build:firefox
pnpm build:edge
```

CI runs typecheck, unit tests, and the chrome/firefox/edge build matrix.

## Firefox AMO source archive

```bash
git archive --format=zip --output zunia-extension-source.zip HEAD
# Include BUILDING.md that documents: Node 22, pnpm 9, `pnpm build:firefox`
```

## Brave Shields checklist

- [ ] Provider still injects with first-party shields
- [ ] No reliance on remote code
- [ ] Content script does not assume `window.ethereum` shape
