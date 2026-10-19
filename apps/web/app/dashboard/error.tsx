"use client";

export default function DashboardError({ reset }: { reset: () => void }) {
  return (
    <main style={{ maxWidth: 600, margin: "64px auto", padding: 24 }}>
      <h1>Dashboard unavailable</h1>
      <p>Your saved records could not be loaded.</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
      <form action="/api/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
