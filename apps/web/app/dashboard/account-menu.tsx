"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Globe2, LogOut, ShieldAlert, UserRound } from "lucide-react";
import styles from "./workspace.module.css";

export function AccountMenu({ devBypass, timezone }: { devBypass: boolean; timezone: string }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = devBypass ? "Dev owner" : "Owner";

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.account} ref={ref}>
      <button
        type="button"
        className={styles.accountButton}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar} aria-hidden="true">
          <UserRound size={15} />
        </span>
        <span className={styles.accountName}>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open ? (
        <div className={styles.menu} role="menu">
          <div className={styles.menuHeader}>
            <span className={styles.avatarLarge} aria-hidden="true">
              <UserRound size={20} />
            </span>
            <div>
              <p className={styles.menuName}>{label}</p>
              <p className={styles.menuMeta}>
                <Globe2 size={11} aria-hidden="true" /> {timezone}
              </p>
            </div>
          </div>
          {devBypass ? (
            <p className={styles.menuWarning}>
              <ShieldAlert size={13} aria-hidden="true" /> Local dev access. Use test data only.
            </p>
          ) : null}
          <form action="/api/auth/logout" method="post" onSubmit={() => setSigningOut(true)}>
            <button type="submit" role="menuitem" className={styles.menuItem} disabled={signingOut}>
              <LogOut size={15} aria-hidden="true" />
              {signingOut ? "Signing out..." : "Sign out"}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
