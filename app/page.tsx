import { Suspense } from "react";
import Dashboard from "@/components/ProgressDashboard";

// Avoid static export complaints if needed:
export const dynamic = "force-dynamic"; // or: export const revalidate = 0;

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-400">Loading…</div>}>
      <Dashboard />
    </Suspense>
  );
}
