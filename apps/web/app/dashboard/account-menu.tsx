"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronDown, Globe2, LogOut, ShieldAlert, UserRound } from "lucide-react";
import type { OwnerProfile } from "@epiphany/core/services";
import styles from "./workspace.module.css";

// The Discord picture when there is one, otherwise the generic icon (also used if the image fails
// to load, so a blocked CDN never leaves a broken-image box).
function Avatar({
  url,
  size,
  className,
}: {
  url: string | null;
  size: number;
  className: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={className} aria-hidden="true">
      {url && !failed ? (
        // Plain img on purpose: a 128px picture from Discord's CDN needs no optimization pipeline.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          className={styles.avatarImage}
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <UserRound size={Math.round(size * 0.5)} />
      )}
    </span>
  );
}

export function AccountMenu({
  devBypass,
  owner,
  timezone,
}: {
  devBypass: boolean;
  owner: OwnerProfile;
  timezone: string;
}) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const label = devBypass ? "Dev owner" : owner.displayName;
  const avatarUrl = devBypass ? null : owner.avatarUrl;

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
        <Avatar url={avatarUrl} size={28} className={styles.avatar} />
        <span className={styles.accountName}>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open ? (
        <div className={styles.menu} role="menu">
          <div className={styles.menuHeader}>
            <Avatar url={avatarUrl} size={40} className={styles.avatarLarge} />
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
          <a
            href="/dashboard/calendars"
            role="menuitem"
            className={`${styles.menuItem} ${styles.menuLink}`}
          >
            <CalendarDays size={15} aria-hidden="true" />
            Calendars
          </a>
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
