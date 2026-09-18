/**
 * The kernel load path, which is the thing that decides whether this wallet can sign.
 *
 * The defect these tests exist to prevent: `loadKernel()` quietly resolving to a kernel that
 * cannot build a Cosmos transaction, and callers finding out only when a chain answers
 * "unauthorized" to a signature made over the wrong bytes.
 */

import { describe, expect, it } from "vitest";

import {
  KernelUnavailableError,
  createLocalKernel,
  getKernelStatus,
  kernelStatus,
  loadKernel,
  resetKernelForTests,
} from "./kernel";

/** Every method the JS kernel must refuse, with arguments it would otherwise accept. */
const TRANSACTION_CALLS: Array<[string, (k: ReturnType<typeof createLocalKernel>) => unknown]> = [
  ["buildSignBytes", (k) => k.buildSignBytes("c", "[]", "{}", "", 0, 0, "00", false, "direct")],
  ["assembleTxRaw", (k) => k.assembleTxRaw("c", "[]", "{}", "", 0, 0, "00", false, "direct", "00")],
  ["buildSimulateTx", (k) => k.buildSimulateTx("c", "[]", "{}", "", 0, 0, "00", false)],
  ["signTx", (k) => k.signTx("p", "", "{}", 0, "c", "[]", "{}", "", 0, 0, "direct")],
  ["previewTx", (k) => k.previewTx("c", "[]", "{}", "", 0, 0, "00", false, "direct")],
];

describe("JS kernel fallback", () => {
  const kernel = createLocalKernel("not installed in this test");

  it.each(TRANSACTION_CALLS)("refuses %s instead of returning bytes", (method, call) => {
    let thrown: unknown;
    try {
      call(kernel);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KernelUnavailableError);
    const error = thrown as KernelUnavailableError;
    expect(error.code).toBe("KERNEL_TRANSACTION_UNSUPPORTED");
    expect(error.method).toBe(method);
    expect(error.kernel).toBe("js");
    // The message has to be usable in a UI: it must name the method, say what is missing,
    // and carry the reason the load path recorded.
    expect(error.message).toContain(method);
    expect(error.message).toContain("@zunialab/core");
    expect(error.message).toContain("not installed in this test");
  });

  it("still serves the methods it implements correctly", () => {
    const phrase = `${"abandon ".repeat(11)}about`;
    expect(kernel.validateMnemonic(phrase)).toBe(true);
    const derived = kernel.deriveAddress(
      phrase,
      "",
      JSON.stringify({ bech32Prefix: "cosmos", coinType: 118 }),
      0,
    );
    expect(derived.bech32Address).toBe(
      "cosmos19rl4cm2hmr8afy4kldpxz3fka4jguq0auqdal4",
    );
    const envelope = kernel.sealKeyring(phrase, "password123", "{}");
    expect(kernel.openKeyring(envelope, "password123")).toBe(phrase);
  });

  it("reports that it cannot sign transactions", () => {
    expect(kernel.status.flavor).toBe("js");
    expect(kernel.status.canSignTransactions).toBe(false);
    expect(kernel.status.degradedReason).toBe("not installed in this test");
    expect(kernel.status.version).toBe(kernel.kernelVersion());
  });
});

describe("loadKernel", () => {
  it("reports which kernel is active", async () => {
    resetKernelForTests();
    const status = await kernelStatus();
    expect(status.flavor).toBe("js");
    expect(status.canSignTransactions).toBe(false);
    // The synchronous snapshot must agree with the awaited one, because the UI reads it from
    // a render path that cannot await.
    expect(getKernelStatus()).toEqual(status);
  });

  it("resolves the same kernel object the status describes", async () => {
    resetKernelForTests();
    const kernel = await loadKernel();
    expect(kernel.status).toEqual(await kernelStatus());
    expect(kernel).toBe(await loadKernel());
  });

  it("keeps the wallet usable while withholding signing", async () => {
    resetKernelForTests();
    // A missing WASM package must not take the wallet down: unlocking and address
    // derivation still have to work, only signing is withheld.
    const kernel = await loadKernel();
    expect(kernel.generateMnemonic(12).split(" ")).toHaveLength(12);
    expect(() =>
      kernel.buildSignBytes("c", "[]", "{}", "", 0, 0, "00", false, "direct"),
    ).toThrow(KernelUnavailableError);
  });
});
