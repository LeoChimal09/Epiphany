"use client";

import { useEffect, useRef } from "react";
import styles from "./workspace.module.css";

export interface DashboardConfirmation {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function ConfirmationDialog({
  confirmation,
  onClose,
}: {
  confirmation: DashboardConfirmation;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const cancel = () => {
    onClose();
    confirmation.onCancel?.();
  };
  return (
    <dialog
      ref={ref}
      className={styles.confirmDialog}
      aria-labelledby="dashboard-confirm-title"
      aria-describedby="dashboard-confirm-description"
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <h2 id="dashboard-confirm-title">{confirmation.title}</h2>
      <p id="dashboard-confirm-description">{confirmation.description}</p>
      <div className={styles.rowActions}>
        <button type="button" className={styles.secondaryButton} autoFocus onClick={cancel}>
          Cancel
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => {
            onClose();
            confirmation.onConfirm();
          }}
        >
          {confirmation.confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
