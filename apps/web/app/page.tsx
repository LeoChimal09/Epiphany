import { redirect } from "next/navigation";
import { verifySession } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  await verifySession();
  redirect("/dashboard");
}
