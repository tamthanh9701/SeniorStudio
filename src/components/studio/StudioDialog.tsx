"use client";

import { useEffect, useRef, type ReactNode } from "react";

export function StudioDialog({
  open,
  onClose,
  label,
  children,
  initialFocusRef,
  returnFocusRef,
  dismissible = true,
  className,
  style,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  dismissible?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      if (!dialog.open) {
        dialog.showModal();
      }
      const timer = window.setTimeout(() => {
        const target = initialFocusRef?.current ?? dialog.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])");
        target?.focus();
      }, 0);
      return () => window.clearTimeout(timer);
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, initialFocusRef]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleClose = () => {
      if (returnFocusRef?.current && returnFocusRef.current.isConnected && returnFocusRef.current.offsetParent !== null) {
        returnFocusRef.current.focus();
      } else if (previousFocusRef.current && previousFocusRef.current.isConnected && previousFocusRef.current.offsetParent !== null) {
        previousFocusRef.current.focus();
      }
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [returnFocusRef]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (event: Event) => {
      if (!dismissible) { event.preventDefault(); return; }
      onClose();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [dismissible, onClose]);

  useEffect(() => {
    if (!open) return;
    const handleBackdrop = (event: MouseEvent) => {
      if (!dismissible) return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
      onClose();
    };
    const dialog = dialogRef.current;
    if (dialog) dialog.addEventListener("mousedown", handleBackdrop);
    return () => { if (dialog) dialog.removeEventListener("mousedown", handleBackdrop); };
  }, [open, dismissible, onClose]);

  return (
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className={`backdrop:bg-black/60 ${className ?? ""}`}
      style={style}
    >
      {children}
    </dialog>
  );
}
