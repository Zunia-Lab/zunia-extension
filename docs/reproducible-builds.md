# Reproducible extension builds

**Status:** Instructions stub. Do not claim store builds are reproducible until this checklist passes an external rebuild.

## Goal

Anyone can check out a signed git tag of `zunia-extension`, run a documented command, and obtain a zip / CRX whose hash matches the GitHub Release `SHA256SUMS` entry.

## Prerequisites

- Node/pnpm versions pinned in `package.json` / `.nvmrc` (document exact versions in the tag notes)
- Lockfile committed (`pnpm-lock.yaml`)
- No unsigned dependency overrides at release time
- `zunia-core` WASM pin matches the release notes

## Rebuild steps (draft)

```bash
git fetch --tags
git checkout vX.Y.Z   # signed tag
# Build the sibling packages first, as in the README (zunia-core, zunia-ui, zunia-sdk).
pnpm install --frozen-lockfile
pnpm build
pnpm check:build
pnpm zip:chrome && pnpm zip:edge && pnpm zip:firefox
# Compare the archive hashes to SHA256SUMS on the GitHub Release
shasum -a 256 .output/*.zip
```

## CI

Release workflow should:

1. Build from the tag ref only
2. Upload artifacts + `SHA256SUMS`
3. Optionally attach a detached GPG signature of `SHA256SUMS`
4. Fail if lockfile drift or unpinned `@zunialab/core` changes mid-release

## Non-goals (yet)

- Bit-identical Chrome Web Store package vs local zip (store rewrapping)
- Firefox AMO identical bytes without documented source listing ID mapping
