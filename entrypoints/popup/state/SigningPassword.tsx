import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
  PasswordInput,
  SheetContent,
} from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";

/**
 * Resolves with the password to send along with a signing request, or
 * `undefined` when per-signature confirmation is off. Rejects when the user
 * cancels. The worker checks the password; this only collects it.
 */
type RequestPassword = () => Promise<string | undefined>;

const SigningPasswordContext = createContext<RequestPassword | null>(null);

export class SigningCancelledError extends Error {
  constructor() {
    super("Signing cancelled");
    this.name = "SigningCancelledError";
  }
}

export function SigningPasswordProvider({
  required,
  children,
}: {
  required: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const pending = useRef<{
    resolve: (value: string | undefined) => void;
    reject: (reason: Error) => void;
  } | null>(null);

  const request = useCallback<RequestPassword>(() => {
    if (!required) return Promise.resolve(undefined);
    pending.current?.reject(new SigningCancelledError());
    return new Promise<string | undefined>((resolve, reject) => {
      pending.current = { resolve, reject };
      setPassword("");
      setOpen(true);
    });
  }, [required]);

  const settle = useCallback((value: string | null) => {
    const waiter = pending.current;
    pending.current = null;
    setOpen(false);
    setPassword("");
    if (!waiter) return;
    if (value === null) waiter.reject(new SigningCancelledError());
    else waiter.resolve(value);
  }, []);

  return (
    <SigningPasswordContext.Provider value={request}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) settle(null);
        }}
      >
        <SheetContent aria-describedby="zunia-sign-password-desc">
          <DialogTitle>Confirm with your password</DialogTitle>
          <DialogDescription id="zunia-sign-password-desc">
            Per-signature confirmation is on. Zunia checks the password before
            anything is signed.
          </DialogDescription>
          <form
            className="mt-4 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (password) settle(password);
            }}
          >
            <PasswordInput
              aria-label="Password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => settle(null)}
              >
                Cancel
              </Button>
              <Button type="submit" className="flex-[1.4]" disabled={!password}>
                Sign
              </Button>
            </div>
          </form>
        </SheetContent>
      </Dialog>
    </SigningPasswordContext.Provider>
  );
}

const NO_PASSWORD: RequestPassword = () => Promise.resolve(undefined);

/** Ask for the signing password when the setting requires it. */
export function useSigningPassword(): RequestPassword {
  return useContext(SigningPasswordContext) ?? NO_PASSWORD;
}

type SigningMessage = "SIGN_AND_BROADCAST" | "SIGN_AND_BROADCAST_TX";

/**
 * `sendToBackground` for the two wallet signing messages, with the password
 * collected first when per-signature confirmation is on.
 */
export function useSignedSend() {
  const requestPassword = useSigningPassword();
  return useCallback(
    async <T,>(type: SigningMessage, payload: Record<string, unknown>): Promise<T> => {
      const password = await requestPassword();
      return sendToBackground<T>(
        type,
        password === undefined ? payload : { ...payload, password },
      );
    },
    [requestPassword],
  );
}
