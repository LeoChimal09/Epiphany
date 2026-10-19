import { checkConfigHealth } from "@epiphany/core";

export const dynamic = "force-dynamic";

export function GET() {
  const report = checkConfigHealth("web", process.env);
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
