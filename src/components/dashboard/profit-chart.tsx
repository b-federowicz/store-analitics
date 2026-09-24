"use client";

import { memo, useCallback } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { ProfitByDate } from "@/lib/types";
import { formatCurrency, formatDate } from "@/lib/format";

const chartConfig = {
  profit: {
    label: "Profit",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

export const ProfitChart = memo(function ProfitChart({ data }: { data: ProfitByDate[] }) {
  const formatTickDate = useCallback((value: string) => formatDate(value), []);
  const formatTickCurrency = useCallback((value: number) => formatCurrency(value), []);
  const formatTooltipLabel = useCallback((value: unknown) => formatDate(String(value)), []);
  const formatTooltipValue = useCallback((value: unknown) => formatCurrency(Number(value)), []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profit over time</CardTitle>
        <CardDescription>Daily profit for the selected period</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">
            No orders in this period.
          </p>
        ) : (
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <BarChart data={data}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tickFormatter={formatTickDate}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={72}
                tickFormatter={formatTickCurrency}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={formatTooltipLabel}
                    formatter={formatTooltipValue}
                  />
                }
              />
              <Bar dataKey="profit" fill="var(--color-profit)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
});
