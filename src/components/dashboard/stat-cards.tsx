import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { DashboardSummary } from "@/lib/types";
import { formatCurrency, formatNumber } from "@/lib/format";
import { TrendingUp, ShoppingCart, Truck, Percent } from "lucide-react";

export function StatCards({ summary }: { summary: DashboardSummary }) {
  const matchRateTotal = summary.matchedDeliveryCount + summary.unmatchedDbOrderCount;
  const matchRate =
    matchRateTotal > 0
      ? Math.round((summary.matchedDeliveryCount / matchRateTotal) * 100)
      : 0;

  const cards = [
    {
      label: "Total profit",
      value: formatCurrency(summary.totalProfit),
      icon: TrendingUp,
      sub: `${formatCurrency(summary.avgProfitPerOrder)} avg / order`,
    },
    {
      label: "Orders",
      value: formatNumber(summary.totalOrders),
      icon: ShoppingCart,
      sub: `${formatCurrency(summary.totalRevenueNetto)} revenue (netto)`,
    },
    {
      label: "Costs",
      value: formatCurrency(
        summary.totalDeliveryCost + summary.totalCommission + summary.totalProductCost + summary.totalMarketingCost
      ),
      icon: Truck,
      sub: `${formatCurrency(summary.totalDeliveryCost)} delivery · ${formatCurrency(
        summary.totalCommission
      )} fees · ${formatCurrency(summary.totalProductCost)} products · ${formatCurrency(
        summary.totalMarketingCost
      )} marketing`,
    },
    {
      label: "Delivery match rate",
      value: `${matchRate}%`,
      icon: Percent,
      sub: `${summary.unmatchedDbOrderCount} unmatched orders · ${summary.unmatchedCsvRowCount} unmatched CSV rows`,
    },
  ];

  return (
    <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardDescription>{c.label}</CardDescription>
              <c.icon className="size-4 text-muted-foreground" />
            </div>
            <CardTitle className="text-2xl font-semibold tabular-nums">
              {c.value}
            </CardTitle>
            <CardDescription className="text-xs">{c.sub}</CardDescription>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

export function MatchRateBadge({ matched }: { matched: boolean }) {
  return matched ? (
    <Badge variant="secondary">Matched</Badge>
  ) : (
    <Badge variant="destructive">Unmatched</Badge>
  );
}
