import { Dashboard } from "@/components/dashboard/dashboard";


export default function Home() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Store Analytics</h1>
        <p className="text-sm text-muted-foreground">
          Profit overview for orders synced from BaseLinker
        </p>
      </header>
      <Dashboard />
    </div>
  );
}
