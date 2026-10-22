import { DashboardShell } from "./dashboard-shell";
import { assistantAvailability } from "./assistant-server";
import { loadDashboardData, loadInitialSchedule } from "./server-data";
import { voiceStatus } from "./voice-server";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [data, schedule, voice] = await Promise.all([
    loadDashboardData(),
    loadInitialSchedule(),
    voiceStatus(),
  ]);
  return (
    <DashboardShell
      initialData={data}
      initialSchedule={schedule}
      assistantSetup={assistantAvailability()}
      devBypass={data.devBypass}
      owner={data.owner}
      voice={voice}
    />
  );
}
