"use client";

import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Order, SortColumn, SortOrder } from "@/lib/types";
import { formatCurrency, formatDate } from "@/lib/format";
import { deleteOrders, invalidateDashboardCache, recalculateOrders, updateTransactionType } from "@/lib/api/dashboard";
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select";
import { TRANSACTION_TYPES } from "@/constants";


function SortableHead({
  column,
  sortBy,
  sortOrder,
  onSort,
  className,
  children,
}: {
  column: SortColumn;
  sortBy: SortColumn;
  sortOrder: SortOrder;
  onSort: (column: SortColumn) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const active = sortBy === column;
  const Icon = active ? (sortOrder === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          className?.includes("text-right") ? "flex-row-reverse" : ""
        } ${active ? "text-foreground" : ""}`}
      >
        {children}
        <Icon className="size-3.5" />
      </button>
    </TableHead>
  );
}

export function OrdersTable({
  orders,
  total,
  page,
  pageSize,
  sortBy,
  sortOrder,
  onPageChange,
  onSort,
  onRecalculated,
  recalculatingAll,
  onRecalculateAll,
}: {
  orders: Order[];
  total: number;
  page: number;
  pageSize: number;
  sortBy: SortColumn;
  sortOrder: SortOrder;
  onPageChange: (page: number) => void;
  onSort: (column: SortColumn) => void;
  onRecalculated?: () => void | Promise<void>;
  recalculatingAll: boolean;
  onRecalculateAll: (fetchFromBaselinker: boolean) => void | Promise<void>;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const [invalidateCache, setInvalidateCache] = useState(false);
  const [recalculatingOrderId, setRecalculatingOrderId] = useState<number | null>(null);
  const [recalcMode, setRecalcMode] = useState<"withBaselinker" | "recalcOnly">("recalcOnly");
  const [recalcDrawerOpen, setRecalcDrawerOpen] = useState(false);
  const [deletingPage, setDeletingPage] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [transactionType, setTransactionType] = useState<Map<number, string>>(new Map(orders.map((o) => [o.order_id, o.transaction_type])));

  const handleDeletePage = async () => {
    setDeletingPage(true);
    try {
      await deleteOrders(orders.map((o) => o.order_id));
      setConfirmDeleteOpen(false);
      await onRecalculated?.();
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingPage(false);
    }
  };

  const handleRecalculateOrder = async (orderId: number) => {
    setRecalculatingOrderId(orderId);
    try {
      await recalculateOrders(orderId, recalcMode === "withBaselinker");
      await onRecalculated?.();
    } catch (err) {
      console.error(err);
    } finally {
      setRecalculatingOrderId(null);
    }
  };

  const handleStartRecalculateAll = () => {
    setRecalcDrawerOpen(false);
    onRecalculateAll(recalcMode === "withBaselinker");
  };

  const handleInvalidateCache = async () => {
    setInvalidateCache(true);
    try {
      await invalidateDashboardCache();
      await onRecalculated?.();
    } catch (err) {
      console.error(err);
    } finally {
      setInvalidateCache(false);
    }
  };

  const handleTransactionTypeChange = async (orderId: number, newType: string) => {
    const oldType = transactionType.get(orderId);
    if (oldType === newType) return;

    const newTransactionType = new Map(transactionType);
    newTransactionType.set(orderId, newType);
    setTransactionType(newTransactionType);

    try {
      await updateTransactionType(orderId, newType);
      await invalidateDashboardCache();
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Failed to update transaction type");

      const revertedTransactionType = new Map(transactionType);
      revertedTransactionType.set(orderId, oldType ?? '');
      setTransactionType(revertedTransactionType);
    }

  }

  return (
    <div className="space-y-3 min-w-0">
      <Collapsible open={recalcDrawerOpen} onOpenChange={setRecalcDrawerOpen}>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleInvalidateCache}
          >
            <RefreshCw className={`size-4 ${invalidateCache ? "animate-spin" : ""}`} />
            Refresh cache
          </Button>
          <CollapsibleTrigger
            render={<Button variant="outline" size="sm" disabled={recalculatingAll} />}
          >
            <RefreshCw className={`size-4 ${recalculatingAll ? "animate-spin" : ""}`} />
            Recalculate all
          </CollapsibleTrigger>
          <Button
            variant="outline"
            size="sm"
            disabled={orders.length === 0}
            onClick={() => setConfirmDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
            Delete page
          </Button>
        </div>
        <CollapsibleContent className="overflow-hidden transition-[height] duration-200 ease-out h-(--collapsible-panel-height) data-starting-style:h-0 data-ending-style:h-0">
          <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-3 justify-end rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="recalc-mode"
                  checked={recalcMode === "withBaselinker"}
                  onChange={() => setRecalcMode("withBaselinker")}
                />
                Fetch from BaseLinker + recalculate
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="recalc-mode"
                  checked={recalcMode === "recalcOnly"}
                  onChange={() => setRecalcMode("recalcOnly")}
                />
                Recalculate only
              </label>
            </div>
            <Button size="sm" disabled={recalculatingAll} onClick={handleStartRecalculateAll}>
              <RefreshCw className={`size-4 ${recalculatingAll ? "animate-spin" : ""}`} />
              Start
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this page of orders?</DialogTitle>
            <DialogDescription>
              This will permanently delete {orders.length} order
              {orders.length === 1 ? "" : "s"} shown on the current page from the
              database. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Cancel</Button>} />
            <Button
              variant="destructive"
              disabled={deletingPage}
              onClick={handleDeletePage}
            >
              {deletingPage ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <SortableHead column="order_date" sortBy={sortBy} sortOrder={sortOrder} onSort={onSort}>
                Date
              </SortableHead>
              <TableHead>Source</TableHead>
              <TableHead>Transaction type</TableHead>
              <SortableHead
                column="revenue_netto"
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSort={onSort}
                className="text-right"
              >
                Revenue
              </SortableHead>
              <SortableHead
                column="products_cost"
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSort={onSort}
                className="text-right"
              >
                Products cost
              </SortableHead>
              <SortableHead
                column="delivery_cost_netto"
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSort={onSort}
                className="text-right"
              >
                Delivery cost
              </SortableHead>
              <SortableHead
                column="fees_netto"
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSort={onSort}
                className="text-right"
              >
                Fees
              </SortableHead>
              <SortableHead
                column="marketing_cost"
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSort={onSort}
                className="text-right"
              >
                Marketing
              </SortableHead>
              <SortableHead
                column="profit"
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSort={onSort}
                className="text-right"
              >
                Profit
              </SortableHead>
              <SortableHead
                column="margin"
                sortBy={sortBy}
                sortOrder={sortOrder}
                onSort={onSort}
                className="text-right"
              >
                Margin
              </SortableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                  No orders found.
                </TableCell>
              </TableRow>
            ) : (
              orders.map((o) => (
                <TableRow key={o.order_id}>
                  <TableCell className="font-medium">
                    {o.order_id}
                    {o.external_order_id ? (
                      <span className="block text-xs text-muted-foreground">
                        {o.external_order_id}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>{formatDate(o.order_date)}</TableCell>
                  <TableCell>{o.order_source_label}</TableCell>
                  <TableCell>
                    <Select
                      value={transactionType.get(o.order_id)}
                      onValueChange={(value) => {
                        if (value) handleTransactionTypeChange(o.order_id, value);
                      }}
                    >
                      <SelectTrigger className="w-full max-w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectLabel>Type</SelectLabel>
                          {TRANSACTION_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {type}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(o.revenue_netto)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(o.products_cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(o.delivery_cost_netto)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(o.fees_netto)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(o.marketing_cost)}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums font-medium ${
                      o.profit < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {formatCurrency(o.profit)}
                  </TableCell>
                  <TableCell
                    className={`text-right font-medium`}
                  >
                    {o.margin}%
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {o.more_info_link ? (
                        <a
                          href={o.more_info_link}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="Recalculate"
                        disabled={recalculatingOrderId === o.order_id}
                        onClick={() => handleRecalculateOrder(o.order_id)}
                      >
                        <RefreshCw
                          className={`size-4 ${
                            recalculatingOrderId === o.order_id ? "animate-spin" : ""
                          }`}
                        />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Page {page} of {totalPages} · {total} orders
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
