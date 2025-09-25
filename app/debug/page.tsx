export default function Debug() {
  return (
    <div className="p-6 space-y-4">
      <div className="h-10 w-full rounded bg-red-500" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-12 rounded bg-emerald-500" />
        <div className="h-12 rounded bg-sky-500" />
      </div>
      <p className="text-sm text-slate-400">If you see colored boxes and spacing, Tailwind is working.</p>
    </div>
  );
}
