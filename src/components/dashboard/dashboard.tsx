"use client";

import { useEffect, useState } from "react";
import { StatCards } from "@/components/dashboard/stat-cards";
import { ProfitChart } from "@/components/dashboard/profit-chart";
import { OrdersTable } from "@/components/dashboard/orders-table";
import { DeliveryMatchPanel } from "@/components/dashboard/delivery-match-panel";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { DataVerificationButton } from "@/components/dashboard/data-verification";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboard } from "@/hooks/use-dashboard";
import { recalculateOrders } from "@/lib/api/dashboard";
import type { RecalcEvent } from "@/lib/types";
import {
  INITIAL_PROGRESS_DIALOG_STATE,
  ProgressDialog,
} from "@/components/ui/progress-dialog";
import {
  RECALC_ALL_PROGRESS_DESCRIPTION,
  RECALC_ALL_PROGRESS_TITLE,
} from "@/constants";

const RECALC_STAGE_PERCENT: Record<string, number> = {
  sheet: 5,
  orders: 40,
  products: 55,
  lines: 65,
  "product-costs": 75,
  delivery: 85,
  recalc: 90,
};

export function Dashboard() {
  const [recalculatingAll, setRecalculatingAll] = useState(false);
  const [recalcProgress, setRecalcProgress] = useState(INITIAL_PROGRESS_DIALOG_STATE);

  const {
    data,
    loading,
    error,
    filters,
    sortBy,
    sortOrder,
    fetchData,
    setPage,
    applyFilters,
    clearFilters,
    setSort,
  } = useDashboard();

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleApply = (
    search?: string,
    from?: string,
    to?: string,
    marketplace?: string,
    transactionType?: string
  ) => {
    applyFilters({
      search: search ?? "",
      from: from ?? "",
      to: to ?? "",
      marketplace: marketplace ?? "",
      transactionType: transactionType ?? "",
    });
  };

  const handleClear = () => {
    clearFilters();
  };

  const handleRecalculateAll = async (fetchFromBaselinker: boolean) => {
    setRecalculatingAll(true);
    setRecalcProgress({
      open: true,
      minimized: false,
      percent: 0,
      message: "Starting recalculation...",
      error: null,
      done: false,
    });
    try {
      const finalEvent = await recalculateOrders(undefined, fetchFromBaselinker, (event: RecalcEvent) => {
        if (event.type !== "progress") return;
        const basePercent = RECALC_STAGE_PERCENT[event.stage] ?? 0;
        const percent =
          event.stage === "recalc" && event.total
            ? 90 + Math.round(((event.count ?? 0) / event.total) * 10)
            : basePercent;
        setRecalcProgress((prev) => ({
          ...prev,
          percent: Math.max(prev.percent, percent),
          message: event.message,
        }));
      });
      setRecalcProgress((prev) => ({
        ...prev,
        percent: 100,
        message: finalEvent.type === "done" ? finalEvent.message : prev.message,
        done: true,
      }));
      await fetchData();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to recalculate.";
      setRecalcProgress((prev) => ({ ...prev, error: message, done: true }));
      console.error(err);
    } finally {
      setRecalculatingAll(false);
    }
  };

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
        <DashboardFilters
          onClear={handleClear}
          onApply={handleApply}
          loading={loading}
        />
        <DataVerificationButton />
      </div>

      {loading  ? (
        <DashboardSkeleton />
      ) : data ? (
        <>
          <StatCards summary={data.summary} />
          <ProfitChart data={data.profitByDate} />
          <OrdersTable
            orders={data.orders.rows}
            total={data.orders.total}
            page={data.orders.page}
            pageSize={data.orders.pageSize}
            sortBy={sortBy}
            sortOrder={sortOrder}
            onPageChange={setPage}
            onSort={setSort}
            onRecalculated={fetchData}
            recalculatingAll={recalculatingAll}
            onRecalculateAll={(fetchFromBaselinker) => handleRecalculateAll(fetchFromBaselinker)}
          />
          <DeliveryMatchPanel
            unmatchedCsvRows={data.unmatchedCsvRows}
            unmatchedDbOrders={data.unmatchedDbOrders}
            unmatchedCsvRowCount={data.summary.unmatchedCsvRowCount}
            unmatchedDbOrderCount={data.summary.unmatchedDbOrderCount}
            filters={filters}
          />
        </>
      ) : null}
      <ProgressDialog
        title={RECALC_ALL_PROGRESS_TITLE}
        description={RECALC_ALL_PROGRESS_DESCRIPTION}
        state={recalcProgress}
        setState={setRecalcProgress}
      />
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-96" />
    </div>
  );
}
