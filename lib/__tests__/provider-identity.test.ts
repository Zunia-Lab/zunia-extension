import { describe, expect, it } from "vitest";

import { CONNECT_CONFIG } from "../../config/connect";
import { providerIdentity } from "../provider-identity";

/**
 * The strings sites and @zunialab/sdk-core (ZUNIA_SIGNING_FEATURES) match, written
 * out here rather than read from the config: renaming one breaks them, so this
 * test fails instead.
 */
const FEATURES_0_1_5 = [
  "sign-direct:wasm-contract-32",
  "sign-direct:send-32",
  "sign-direct:osmosis-poolmanager",
  "sign-direct:osmosis-exact-out",
  "sign-amino:escaped",
  "sign-amino:osmosis-poolmanager",
];

describe("providerIdentity", () => {
  it("keeps the provider API version at 0.1.0, whatever the release", () => {
    expect(providerIdentity("0.1.5").version).toBe("0.1.0");
    expect(providerIdentity(undefined).version).toBe("0.1.0");
  });

  it("reports the release the content script read from the manifest", () => {
    expect(providerIdentity("0.1.5").extensionVersion).toBe("0.1.5");
    expect(providerIdentity("1.0").extensionVersion).toBe("1.0");
    expect(providerIdentity("2.10.0.7").extensionVersion).toBe("2.10.0.7");
  });

  it("reports an empty release when the content script did not say, or said something else", () => {
    for (const given of [undefined, "", " 0.1.5", "0.1.5-beta", "v0.1.5", "0.1.5.1.2", "<b>0.1.5</b>"]) {
      expect(providerIdentity(given).extensionVersion, String(given)).toBe("");
    }
  });

  it("says it is Zunia", () => {
    expect(providerIdentity("0.1.5").isZunia).toBe(true);
    expect(providerIdentity(undefined).isZunia).toBe(true);
  });

  it("lists exactly the 0.1.5 features, from the connect config", () => {
    const { features } = providerIdentity("0.1.5");
    expect(features).toEqual(FEATURES_0_1_5);
    expect(features).toEqual(CONNECT_CONFIG.provider.features);
    // Even when the release could not be read: the features describe the code.
    expect(providerIdentity(undefined).features).toEqual(FEATURES_0_1_5);
  });

  it("hands the page a frozen list", () => {
    const { features } = providerIdentity("0.1.5");
    expect(Object.isFrozen(features)).toBe(true);
    const list = features as string[];
    expect(() => list.push("sign-direct:everything")).toThrow(TypeError);
    expect(() => {
      list[0] = "sign-direct:everything";
    }).toThrow(TypeError);
    expect(features).toEqual(FEATURES_0_1_5);
    // A frozen copy: the config's own list is not what the page holds.
    expect(features).not.toBe(CONNECT_CONFIG.provider.features);
  });

  it("carries exactly the fields injected.ts spreads into the provider", () => {
    expect(Object.keys(providerIdentity("0.1.5")).sort()).toEqual([
      "extensionVersion",
      "features",
      "isZunia",
      "version",
    ]);
  });
});
