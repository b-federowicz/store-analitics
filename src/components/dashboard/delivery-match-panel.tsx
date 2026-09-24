"use client";

import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import type { Order, StageDeliveryCostRow } from "@/lib/types";
import { formatCurrency, formatDate } from "@/lib/format";
import { fetchUnmatchedCsvRows, fetchUnmatchedOrders } from "@/lib/api/dashboard";

const ROW_HEIGHT = 41;

function CsvRowsList({ rows }: { rows: StageDeliveryCostRow[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Every CSV row matched an order.
      </p>
    );
  }

  return (
    <div ref={parentRef} className="h-64 overflow-y-auto">
      <div
        className="relative w-full divide-y"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              className="absolute top-0 left-0 flex w-full items-center justify-between py-2 text-sm"
              style={{
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <span className="font-mono">{row.nr}</span>
              <span className="tabular-nums text-muted-foreground">
                {formatCurrency(Number(row.netto ?? 0))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OrdersList({ orders }: { orders: Order[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: orders.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  if (orders.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Every order with a delivery number has a CSV match.
      </p>
    );
  }

  return (
    <div ref={parentRef} className="h-64 overflow-y-auto">
      <div
        className="relative w-full divide-y"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const o = orders[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              className="absolute top-0 left-0 flex w-full items-center justify-between py-2 text-sm"
              style={{
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <span>
                #{o.order_id}
                <span className="text-muted-foreground ml-2">
                  {formatDate(o.order_date)}
                </span>
              </span>
              <span className="font-mono text-muted-foreground">
                {o.delivery_nr ?? "no delivery nr"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DeliveryMatchPanel({
  unmatchedCsvRows,
  unmatchedDbOrders,
  unmatchedCsvRowCount,
  unmatchedDbOrderCount,
  filters,
}: {
  unmatchedCsvRows: StageDeliveryCostRow[];
  unmatchedDbOrders: Order[];
  unmatchedCsvRowCount: number;
  unmatchedDbOrderCount: number;
  filters: { from: string; to: string; marketplace: string };
}) {
  const [csvRows, setCsvRows] = useState(unmatchedCsvRows);
  const [prevUnmatchedCsvRows, setPrevUnmatchedCsvRows] = useState(unmatchedCsvRows);
  const [csvLoadedAll, setCsvLoadedAll] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);

  const [orderRows, setOrderRows] = useState(unmatchedDbOrders);
  const [prevUnmatchedDbOrders, setPrevUnmatchedDbOrders] = useState(unmatchedDbOrders);
  const [ordersLoadedAll, setOrdersLoadedAll] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);

  if (unmatchedCsvRows !== prevUnmatchedCsvRows) {
    setPrevUnmatchedCsvRows(unmatchedCsvRows);
    setCsvRows(unmatchedCsvRows);
    setCsvLoadedAll(false);
  }

  if (unmatchedDbOrders !== prevUnmatchedDbOrders) {
    setPrevUnmatchedDbOrders(unmatchedDbOrders);
    setOrderRows(unmatchedDbOrders);
    setOrdersLoadedAll(false);
  }

  const loadAllCsv = async () => {
    setCsvLoading(true);
    try {
      const rows = await fetchUnmatchedCsvRows(filters);
      setCsvRows(rows);
      setCsvLoadedAll(true);
    } finally {
      setCsvLoading(false);
    }
  };

  const loadAllOrders = async () => {
    setOrdersLoading(true);
    try {
      const rows = await fetchUnmatchedOrders(filters);
      setOrderRows(rows);
      setOrdersLoadedAll(true);
    } finally {
      setOrdersLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delivery number matching</CardTitle>
        <CardDescription>
          Discrepancies between orders and the imported delivery-cost CSV
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="csv">
          <TabsList>
            <TabsTrigger value="csv">
              CSV rows without an order ({unmatchedCsvRowCount})
            </TabsTrigger>
            <TabsTrigger value="orders">
              Orders without a CSV match ({unmatchedDbOrderCount})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="csv">
            <CsvRowsList rows={csvRows} />
            {!csvLoadedAll && unmatchedCsvRowCount > csvRows.length && (
              <div className="pt-2 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={csvLoading}
                  onClick={loadAllCsv}
                >
                  {csvLoading
                    ? "Loading…"
                    : `Load all ${unmatchedCsvRowCount}`}
                </Button>
              </div>
            )}
          </TabsContent>
          <TabsContent value="orders">
            <OrdersList orders={orderRows} />
            {!ordersLoadedAll && unmatchedDbOrderCount > orderRows.length && (
              <div className="pt-2 text-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={ordersLoading}
                  onClick={loadAllOrders}
                >
                  {ordersLoading
                    ? "Loading…"
                    : `Load all ${unmatchedDbOrderCount}`}
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
