"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchVerificationReport } from "@/lib/api/dashboard";
import type { CheckStatus, VerificationReport } from "@/lib/types";
import {
  ChevronDown,
  CircleCheck,
  CircleAlert,
  CircleX,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

const STATUS_META: Record<
  CheckStatus,
  { icon: typeof CircleCheck; badgeVariant: "secondary" | "outline" | "destructive"; label: string }
> = {
  ok: { icon: CircleCheck, badgeVariant: "secondary", label: "OK" },
  warning: { icon: CircleAlert, badgeVariant: "outline", label: "Warning" },
  error: { icon: CircleX, badgeVariant: "destructive", label: "Error" },
};

function StatusBadge({ status }: { status: CheckStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.badgeVariant} className="gap-1">
      <Icon className="size-3" />
      {meta.label}
    </Badge>
  );
}

function CheckRow({ check }: { check: VerificationReport["checks"][number] }) {
  const hasDetails = !!check.details && check.details.length > 0;

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium text-sm">{check.label}</p>
          <p className="text-sm text-muted-foreground mt-0.5">{check.summary}</p>
        </div>
        <StatusBadge status={check.status} />
      </div>
      {hasDetails ? (
        <Collapsible>
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
                <ChevronDown className="size-3.5" />
                {check.details!.length} item{check.details!.length === 1 ? "" : "s"}
                {check.detailsTruncated ? " (truncated)" : ""}
              </Button>
            }
          />
          <CollapsibleContent>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">
              {JSON.stringify(check.details, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

export function DataVerificationButton() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<VerificationReport | null>(null);

  const runVerification = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchVerificationReport();
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run verification");
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && !report && !loading) {
      runVerification();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <ShieldCheck className="size-4" />
        Verify data
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>Data verification</DialogTitle>
            {report ? <StatusBadge status={report.status} /> : null}
          </div>
          <DialogDescription>
            Recomputes profit, margin and products_cost straight from orders,
            order_products and products, and checks delivery-cost matching
            and product costing for issues that could silently skew the
            numbers.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        ) : report ? (
          <>
            <p className="text-xs text-muted-foreground">
              Checked {report.scope.ordersChecked} order
              {report.scope.ordersChecked === 1 ? "" : "s"} ·{" "}
              {new Date(report.generatedAt).toLocaleString()}
            </p>
            <ScrollArea className="max-h-[55vh]">
              <div className="space-y-2 pr-3">
                {report.checks.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </div>
            </ScrollArea>
          </>
        ) : null}

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={runVerification}
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            Re-run
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
