import { CONNECT_CONFIG } from "../config/connect";

/**
 * What window.zunia says about itself, and window.keplr while the alias is on:
 * entrypoints/injected.ts spreads it into the provider.
 *
 * `version` is the provider API version and stays "0.1.0", because sites
 * compare against it. The installed release is `extensionVersion`, the manifest
 * version the content script hands over in the script tag's
 * `data-zunia-version`. `features` names what this build signs that 0.1.4 and
 * older refused or signed wrongly (config/connect.ts). A provider with neither
 * is 0.1.4 or older.
 *
 * Pure, so it is tested without a page; scripts/check-build.mjs checks that
 * every build's injected.js reads the attribute and carries every feature.
 */

/** One entry of `features`. */
export type ProviderFeature = (typeof CONNECT_CONFIG.provider.features)[number];

export interface ProviderIdentity {
  /** Provider API version: "0.1.0" in every release. */
  readonly version: string;
  /** The installed release, e.g. "0.1.5"; "" when the content script could not say. */
  readonly extensionVersion: string;
  readonly isZunia: true;
  /** Frozen: a page cannot add to or rewrite what the wallet says it signs. */
  readonly features: readonly ProviderFeature[];
}

/** A manifest `version` as WXT writes it from package.json: one to four dot-separated integers. */
const MANIFEST_VERSION = /^\d+(?:\.\d+){0,3}$/;

const FEATURES: readonly ProviderFeature[] = Object.freeze([...CONNECT_CONFIG.provider.features]);

/**
 * The provider's identity, given the release the content script wrote into the
 * script tag (`dataset.zuniaVersion`). Anything that is not a manifest version,
 * a missing attribute included, reads as "".
 */
export function providerIdentity(datasetVersion: string | undefined): ProviderIdentity {
  return {
    version: CONNECT_CONFIG.provider.version,
    extensionVersion:
      datasetVersion !== undefined && MANIFEST_VERSION.test(datasetVersion) ? datasetVersion : "",
    isZunia: CONNECT_CONFIG.provider.isZunia,
    features: FEATURES,
  };
}
