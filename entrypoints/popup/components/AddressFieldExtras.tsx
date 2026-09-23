import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogClose,
  DialogTitle,
  SheetContent,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import { extractBech32Address } from "../../../lib/address-payload";
import type { AddressBookEntry } from "../../../lib/address-book";
import { IconBook, IconClose, IconQr } from "../screens/icons";
import { PickerSheet, type PickerItem } from "./PickerSheet";

type BarcodeDetectorLike = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats: string[] }) => BarcodeDetectorLike;
  }
}

export function AddressFieldActions({
  onScan,
  onBook,
}: {
  onScan: () => void;
  onBook: () => void;
}) {
  return (
    <span className="flex items-center gap-0.5">
      <button
        type="button"
        aria-label="Scan QR code"
        title="Scan QR"
        onClick={onScan}
        className={cn(
          "flex size-7 items-center justify-center rounded-[8px] text-fg-dim",
          "transition-colors duration-[var(--z-duration-fast)] hover:bg-[var(--z-state-hover)] hover:text-fg",
          focusRing,
        )}
      >
        <IconQr width={16} height={16} />
      </button>
      <button
        type="button"
        aria-label="Pick from address book"
        title="Address book"
        onClick={onBook}
        className={cn(
          "flex size-7 items-center justify-center rounded-[8px] text-fg-dim",
          "transition-colors duration-[var(--z-duration-fast)] hover:bg-[var(--z-state-hover)] hover:text-fg",
          focusRing,
        )}
      >
        <IconBook width={16} height={16} />
      </button>
    </span>
  );
}

/**
 * Saved recipients as a searchable sheet over the current screen. Only
 * contacts whose address fits the destination chain are listed, so a pick can
 * never fill in an address the chain would reject.
 */
export function AddressBookPicker({
  contacts,
  expectedPrefix,
  onPick,
  onClose,
}: {
  contacts: AddressBookEntry[];
  expectedPrefix?: string;
  onPick: (address: string) => void;
  onClose: () => void;
}) {
  const items = useMemo<PickerItem[]>(
    () =>
      contacts
        .filter((c) => !expectedPrefix || c.address.startsWith(`${expectedPrefix}1`))
        .map((contact) => ({
          id: contact.id,
          label: contact.label,
          sublabel: truncateAddress(contact.address, 12, 8),
          keywords: [contact.address],
        })),
    [contacts, expectedPrefix],
  );

  return (
    <PickerSheet
      open
      onClose={onClose}
      title="Address book"
      items={items}
      searchPlaceholder="Search by name or address"
      emptyLabel={
        contacts.length === 0
          ? "No saved recipients yet."
          : `No saved address starts with ${expectedPrefix}1.`
      }
      onSelect={(id) => {
        const contact = contacts.find((c) => c.id === id);
        if (contact) onPick(contact.address);
      }}
    />
  );
}

/** Camera / image QR scan that returns a bech32 address. */
export function QrScanOverlay({
  onScan,
  onClose,
}: {
  onScan: (address: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let alive = true;
    const Detector = window.BarcodeDetector;

    async function start() {
      if (!Detector) {
        setSupported(false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        const video = videoRef.current;
        if (!video || !alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        const detector = new Detector({ formats: ["qr_code"] });
        const tick = async () => {
          if (!alive || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const raw = codes[0]?.rawValue;
            if (raw) {
              const address = extractBech32Address(raw);
              if (address) {
                onScan(address);
                return;
              }
              setError("QR did not contain a bech32 address");
            }
          } catch {
            /* frame skipped */
          }
          raf = window.requestAnimationFrame(() => void tick());
        };
        raf = window.requestAnimationFrame(() => void tick());
      } catch {
        setError("Camera permission denied or unavailable");
        setSupported(false);
      }
    }

    void start();
    return () => {
      alive = false;
      window.cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  async function onFile(file: File) {
    setError(null);
    const Detector = window.BarcodeDetector;
    if (!Detector) {
      setError("QR decode is not available in this browser");
      return;
    }
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new Detector({ formats: ["qr_code"] });
      const codes = await detector.detect(bitmap);
      bitmap.close();
      const raw = codes[0]?.rawValue;
      if (!raw) {
        setError("No QR code found in that image");
        return;
      }
      const address = extractBech32Address(raw);
      if (!address) {
        setError("QR did not contain a bech32 address");
        return;
      }
      onScan(address);
    } catch {
      setError("Could not read that image");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        className="flex h-[92vh] max-h-[92vh] flex-col overflow-hidden px-0 pb-0 pt-3"
      >
        <header className="flex items-center gap-2 border-b border-[var(--z-line)] px-3 pb-2.5">
          <DialogClose
            aria-label="Close"
            className={cn(
              "flex size-8 items-center justify-center rounded-full text-fg-dim hover:bg-[var(--z-state-hover)] hover:text-fg",
              focusRing,
            )}
          >
            <IconClose width={16} height={16} />
          </DialogClose>
          <DialogTitle className="flex-1 text-[14px]">Scan address</DialogTitle>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          {supported ? (
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-[16px] bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                className="size-full object-cover"
              />
            </div>
          ) : (
            <p className="px-1 pt-4 text-center text-[12.5px] text-fg-dim">
              Point your camera at a wallet QR, or upload a screenshot.
            </p>
          )}
          {error ? (
            <p className="text-center text-[11.5px] text-[var(--z-danger)]">
              {error}
            </p>
          ) : null}
          <label className="flex w-full cursor-pointer items-center justify-center rounded-[12px] border border-[var(--z-line)] py-2.5 text-[12.5px] font-medium text-fg transition-colors hover:bg-[var(--z-state-hover)]">
            Upload QR image
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </SheetContent>
    </Dialog>
  );
}
