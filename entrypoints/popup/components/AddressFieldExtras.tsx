import { useEffect, useRef, useState } from "react";
import { cn, focusRing } from "@zunialab/ui";
import { extractBech32Address } from "../../../lib/address-payload";
import type { AddressBookEntry } from "../../../lib/address-book";
import { IconBook, IconClose, IconQr } from "../screens/icons";

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

/** Full-screen picker over the current screen (does not navigate away). */
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
  const filtered = expectedPrefix
    ? contacts.filter((c) => c.address.startsWith(`${expectedPrefix}1`))
    : contacts;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-[var(--z-line)] px-3 py-2.5">
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={cn(
            "flex size-8 items-center justify-center rounded-full text-fg-dim hover:bg-[var(--z-state-hover)] hover:text-fg",
            focusRing,
          )}
        >
          <IconClose width={16} height={16} />
        </button>
        <h2 className="flex-1 text-[14px] font-medium text-fg">Address book</h2>
        <span className="font-mono text-[10px] text-fg-dim">
          {filtered.length}
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? (
          <p className="px-1 pt-6 text-center text-[12.5px] text-fg-dim">
            {contacts.length === 0
              ? "No saved recipients yet."
              : `No contacts match ${expectedPrefix}1…`}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {filtered.map((contact) => (
              <li key={contact.id}>
                <button
                  type="button"
                  onClick={() => onPick(contact.address)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-[12px] border border-[var(--z-line)] px-3 py-2.5 text-left",
                    "hover:bg-[var(--z-state-hover)]",
                    focusRing,
                  )}
                >
                  <span className="truncate text-[13px] font-medium text-fg">
                    {contact.label}
                  </span>
                  <span className="truncate font-mono text-[10px] text-fg-dim">
                    {contact.address}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
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
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex items-center gap-2 border-b border-[var(--z-line)] px-3 py-2.5">
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={cn(
            "flex size-8 items-center justify-center rounded-full text-fg-dim hover:bg-[var(--z-state-hover)] hover:text-fg",
            focusRing,
          )}
        >
          <IconClose width={16} height={16} />
        </button>
        <h2 className="flex-1 text-[14px] font-medium text-fg">Scan address</h2>
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
    </div>
  );
}
