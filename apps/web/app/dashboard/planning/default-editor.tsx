"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, Pencil, type LucideIcon } from "lucide-react";
import styles from "./settings.module.css";

export function DefaultEditor<T>({
  title,
  icon: Icon,
  value,
  onReset,
  summary,
  onSave,
  children,
}: {
  title: string;
  icon: LucideIcon;
  value: T;
  onReset: (saved: T) => void;
  summary: (saved: T) => string;
  onSave: (draft: T) => Promise<{ ok: true } | { ok: false; error: string }>;
  children: ReactNode;
}) {
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const [saved, setSaved] = useState(value);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [justSaved, setJustSaved] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);

  useEffect(() => {
    if (justSaved && !editing && !pending) editButton.current?.focus();
  }, [justSaved, editing, pending]);

  function close() {
    setEditing(false);
    setError("");
    editButton.current?.focus();
  }

  return (
    <section className={styles.section} aria-label={title}>
      <header className={styles.cardHeader}>
        <Icon size={19} aria-hidden="true" />
        <div className={styles.summaryText}>
          <h3>{title}</h3>
          <p>{summary(saved)}</p>
        </div>
        <button
          ref={editButton}
          type="button"
          className={styles.editButton}
          aria-label={`Edit ${title.toLowerCase()}`}
          aria-expanded={editing}
          aria-controls={id}
          disabled={pending}
          onClick={() => {
            if (editing) {
              onReset(saved);
              close();
            } else {
              setEditing(true);
              setJustSaved(false);
            }
          }}
        >
          <Pencil size={14} aria-hidden="true" /> {editing ? "Close" : "Edit"}
        </button>
      </header>
      {editing ? (
        <form
          id={id}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!dirty || pending) return;
            setPending(true);
            setError("");
            try {
              const result = await onSave(value);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setSaved(value);
              setJustSaved(true);
              close();
            } catch {
              setError("Could not confirm the save. Reload to check before trying again.");
            } finally {
              setPending(false);
            }
          }}
        >
          <fieldset disabled={pending} className={styles.fields}>
            {children}
            <div className={styles.editorFooter}>
              <span>{dirty ? "Unsaved changes" : "No changes"}</span>
              <button
                type="button"
                onClick={() => {
                  onReset(saved);
                  close();
                }}
              >
                Cancel
              </button>
              <button type="submit" disabled={!dirty || pending}>
                {pending ? "Saving..." : "Save changes"}
              </button>
            </div>
          </fieldset>
          {error ? <p role="alert">{error}</p> : null}
        </form>
      ) : null}
      <span className={styles.saveStatus} role="status">
        {justSaved ? (
          <>
            <Check size={13} aria-hidden="true" /> Saved
          </>
        ) : null}
      </span>
    </section>
  );
}

export function clockSummary(time: string) {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}
