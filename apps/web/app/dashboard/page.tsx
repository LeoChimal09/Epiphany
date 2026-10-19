import { DashboardShell } from "./dashboard-shell";
import { assistantAvailability } from "./assistant-server";
import { loadDashboardData, loadInitialSchedule } from "./server-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [data, schedule] = await Promise.all([loadDashboardData(), loadInitialSchedule()]);
  return (
    <DashboardShell
      initialData={data}
      initialSchedule={schedule}
      assistantSetup={assistantAvailability()}
      devBypass={data.devBypass}
    />
  );
}
