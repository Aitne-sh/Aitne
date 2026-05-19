"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  /**
   * When set, the confirm button stays disabled until the user types this
   * exact string into an input box. The comparison is case-sensitive and
   * trim-aware — leading/trailing whitespace is ignored.
   */
  requireText?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm must be used inside ConfirmProvider");
  return fn;
}

interface DialogState extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [typed, setTyped] = useState("");
  // Ref mirrors state so the stable `confirm` callback can resolve the
  // previous dialog without needing `dialog` in its dependency array.
  const dialogRef = useRef<DialogState | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    // If a previous dialog is still pending, resolve it as cancelled
    // to prevent a Promise leak.
    if (dialogRef.current) {
      dialogRef.current.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const state: DialogState = { ...options, resolve };
      dialogRef.current = state;
      setDialog(state);
      setTyped("");
    });
  }, []);

  const handleResult = useCallback((result: boolean) => {
    dialogRef.current?.resolve(result);
    dialogRef.current = null;
    setDialog(null);
    setTyped("");
  }, []);

  const requiredText = dialog?.requireText;
  const typedMatches =
    !requiredText || typed.trim() === requiredText;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialogPrimitive.Root
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) handleResult(false);
        }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
          <AlertDialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95">
            <AlertDialogPrimitive.Title className="text-base font-semibold text-foreground">
              {dialog?.title}
            </AlertDialogPrimitive.Title>
            {dialog?.description && (
              <AlertDialogPrimitive.Description className="mt-2 text-sm text-muted-foreground">
                {dialog.description}
              </AlertDialogPrimitive.Description>
            )}
            {requiredText && (
              <div className="mt-4 space-y-2">
                <p className="text-xs text-muted-foreground">
                  Type <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">{requiredText}</code> to confirm:
                </p>
                <Input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && typedMatches) {
                      e.preventDefault();
                      handleResult(true);
                    }
                  }}
                  placeholder={requiredText}
                  className="font-mono"
                />
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialogPrimitive.Cancel asChild>
                <Button variant="outline" size="sm">
                  {dialog?.cancelLabel ?? "Cancel"}
                </Button>
              </AlertDialogPrimitive.Cancel>
              <AlertDialogPrimitive.Action asChild>
                <Button
                  variant={dialog?.variant === "destructive" ? "destructive" : "default"}
                  size="sm"
                  onClick={() => handleResult(true)}
                  disabled={!typedMatches}
                >
                  {dialog?.confirmLabel ?? "Confirm"}
                </Button>
              </AlertDialogPrimitive.Action>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </ConfirmContext.Provider>
  );
}
