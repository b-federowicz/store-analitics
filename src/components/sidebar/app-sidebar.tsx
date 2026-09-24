'use client'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { DIALOG_DESCRIPTION, DIALOG_TITLE, EXPORT_COLUMN_LABELS, EXPORT_COLUMNS_HELP_TITLE, IMPORT_CSV_TEXT, EXPORT_TEXT, IMPORT_DHL_TEXT, IMPORT_INPOST_TEXT, IMPORT_DPD_TEXT, IMPORT_FEDEX_TEXT, IMPORT_GLS_TEXT, IMPORT_ORDERS_FROM_DATE, IMPORT_ORDERS_PROGRESS_DESCRIPTION, IMPORT_ORDERS_PROGRESS_TITLE, IMPORT_ORDERS_TEXT, SIDEBAR_DELIVERY, IMPORT_DHL_PL_TEXT, IMPORT_CSV_ALLOWED_ID_COLUMNS, IMPORT_CSV_ALLOWED_VALUE_COLUMNS, ORDERS_TABLE_COLUMNS, IMPORT_CSV_MAPPING_TITLE, IMPORT_CSV_MAPPING_DESCRIPTION, IMPORT_CSV_ID_COL_LABEL, IMPORT_CSV_VALUE_COL_LABEL, IMPORT_CSV_COLUMN_NOT_ALLOWED, IMPORT_CSV_COLUMN_NOT_FOUND, IMPORT_CSV_UNMATCHED_TITLE} from "@/constants"
import { useDashboard } from "@/hooks/use-dashboard";
import { fetchDashboardExport } from "@/lib/api/dashboard";
import { readNdjsonStream } from "@/lib/stream";
import { parseCsv } from "@/lib/csv";
import type { SyncEvent } from "@/lib/types";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { DownloadButton } from "../ui/download-button";
import { INITIAL_PROGRESS_DIALOG_STATE, ProgressDialog } from "../ui/progress-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { cn } from "@/lib/utils";
import { FileDown, FileUp, HelpCircle, Loader2, RefreshCw, Upload } from "lucide-react";

const CSV_IMPORT_DELIMITER = ";";

type CsvColumnStatus = "ok" | "not-allowed" | "not-found";

function evaluateCsvColumn(
  label: string,
  allowed: readonly string[]
): CsvColumnStatus {
  if (allowed.includes(label)) return "ok";
  if (ORDERS_TABLE_COLUMNS.includes(label)) return "not-allowed";
  return "not-found";
}

interface CsvMappingPreview {
  file: File;
  rawText: string;
  idLabel: string;
  columnLabel: string;
  idOverride: string | null;
  columnOverride: string | null;
}


const IMPORT_STAGE_PERCENT: Record<string, number> = {
  sheet: 5,
  sources: 8,
  paging: 10,
  products: 65,
  orders: 80,
  lines: 92,
};


export function AppSidebar({variant}: {variant?: "sidebar" | "floating" | "inset" | undefined}) {
  const [importing, setImporting] = useState(false);
  const [importingDhl, setImportingDhl] = useState(false);
  const [importingDhlDe, setImportingDhlDe] = useState(false);
  const [importingDpd, setImportingDpd] = useState(false);
  const [importingFedex, setImprtingFedex] = useState(false);
  const [importingGls, setImportingGls] = useState(false);
  const [importingOrders, setImportingOrders] = useState(false);
  const [importProgress, setImportProgress] = useState(
    INITIAL_PROGRESS_DIALOG_STATE
  );
  const [exporting, setExporting] = useState(false);
  const [importingCsv, setImportingCsv] = useState(false);
  const [skippedNrs, setSkippedNrs] = useState<string[]>([]);
  const [idIssues, setIdIssues] = useState<{ title: string; items: string[] } | null>(null);
  const [csvMappingPreview, setCsvMappingPreview] = useState<CsvMappingPreview | null>(null);
  const {fetchData, filters, sortBy, sortOrder} = useDashboard();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dhlFileInputRef = useRef<HTMLInputElement>(null);
  const dhlDeFileInputRef = useRef<HTMLInputElement>(null);
  const dpdFileInputRef = useRef<HTMLInputElement>(null);
  const fedexFileInputRef = useRef<HTMLInputElement>(null);
  const glsFileInputRef = useRef<HTMLInputElement>(null);
  const importCsvFileInputRef = useRef<HTMLInputElement>(null);

  async function importDeliveryCostCsv(
    file: File,
    endpoint: string,
    carrierLabel: string,
    setBusy: (busy: boolean) => void
  ) {
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(endpoint, {
        method: "POST",
        body: formData,
      });
      const json = await res.json();

      if (!res.ok) {
        const unmatchedShipmentIds: string[] = Array.isArray(json.unmatchedShipmentIds)
          ? json.unmatchedShipmentIds
          : [];
        const failedShipmentIds: string[] = Array.isArray(json.failedShipmentIds)
          ? json.failedShipmentIds.map((f: { shipmentId: string; reason?: string }) =>
              f.reason ? `${f.shipmentId} — ${f.reason}` : f.shipmentId
            )
          : [];

        if (failedShipmentIds.length > 0) {
          setIdIssues({ title: "Shipment IDs rejected by DHL24", items: failedShipmentIds });
        } else if (unmatchedShipmentIds.length > 0) {
          setIdIssues({
            title: "Shipment IDs with no tracking number",
            items: unmatchedShipmentIds,
          });
        }

        throw new Error(json.error ?? `Failed to import ${carrierLabel} CSV.`);
      }

      const skipped: string[] = Array.isArray(json.skippedNrs)
        ? json.skippedNrs
        : [];

      const ratesUsed: Record<string, number> | undefined =
        json.ratesUsed && typeof json.ratesUsed === "object" ? json.ratesUsed : undefined;

      if (ratesUsed && Object.keys(ratesUsed).length > 0) {
        console.log(`${carrierLabel} import: EUR/PLN rates used`, ratesUsed);
      }

      const ratesSummary = ratesUsed
        ? Object.entries(ratesUsed)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, rate]) => `${date}: ${rate}`)
            .join(", ")
        : "";

      toast.success(json.message ?? `${carrierLabel} delivery cost import complete.`, {
        description:
          typeof json.rowsImported === "number"
            ? `${json.rowsImported} rows imported${
                skipped.length ? `, ${skipped.length} skipped (already imported).` : "."
              }${ratesSummary ? ` EUR/PLN rate(s): ${ratesSummary}.` : ""}`
            : undefined,
      });

      if (skipped.length > 0) {
        setSkippedNrs(skipped);
      }

      fetchData();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to import ${carrierLabel} CSV.`
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    await importDeliveryCostCsv(
      file,
      "/api/import-delivery-cost/inpost",
      "InPost",
      setImporting
    );
  }

  async function handleDhlFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    await importDeliveryCostCsv(
      file,
      "/api/import-delivery-cost/dhl",
      "DHL",
      setImportingDhl
    );
  }

  async function handleDhlDeFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    await importDeliveryCostCsv(
      file,
      "/api/import-delivery-cost/dhl-pl",
      "DHL PL",
      setImportingDhlDe
    );
  }

  async function handleDpdFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    await importDeliveryCostCsv(
      file,
      "/api/import-delivery-cost/dpd",
      "DPD",
      setImportingDpd
    );
  }

  async function handleFedexFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    await importDeliveryCostCsv(
      file,
      "/api/import-delivery-cost/fedex",
      "FedEx",
      setImprtingFedex
    );
  }

  async function handleGlsFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    await importDeliveryCostCsv(
      file,
      "/api/import-delivery-cost/gls",
      "GLS",
      setImportingGls
    );
  }

  async function handleImportOrders() {
    setImportingOrders(true);
    setImportProgress({
      open: true,
      minimized: false,
      percent: 0,
      message: "Starting import...",
      error: null,
      done: false,
    });

    try {
      const res = await fetch(
        `/api/sync-baselinker-orders?from=${IMPORT_ORDERS_FROM_DATE}`,
        { method: "POST" }
      );

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? "Failed to import orders.");
      }

      const holder: { finalEvent: SyncEvent | null } = { finalEvent: null };
      await readNdjsonStream<SyncEvent>(res, (event) => {
        if (event.type === "progress") {
          const basePercent = IMPORT_STAGE_PERCENT[event.stage] ?? 0;
          const percent =
            event.stage === "paging" && event.page
              ? Math.min(60, basePercent + event.page * 5)
              : basePercent;
          setImportProgress((prev) => ({
            ...prev,
            percent: Math.max(prev.percent, percent),
            message: event.message,
          }));
        } else {
          holder.finalEvent = event;
        }
      });

      const result = holder.finalEvent;
      if (!result) {
        throw new Error("Import ended unexpectedly.");
      }

      if (result.type === "error") {
        throw new Error(result.error);
      }
      if (result.type !== "done") {
        throw new Error("Import ended unexpectedly.");
      }

      setImportProgress((prev) => ({
        ...prev,
        percent: 100,
        message: result.message,
        done: true,
      }));

      toast.success(result.message ?? "Orders import complete.", {
        description: `${result.ordersInserted} orders inserted.${
          result.lineItemsSkipped
            ? ` ${result.lineItemsSkipped} line item(s) skipped — check server logs.`
            : ""
        }`,
      });

      fetchData();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to import orders.";
      setImportProgress((prev) => ({ ...prev, error: message, done: true }));
      toast.error(message);
    } finally {
      setImportingOrders(false);
    }
  }


  async function handleExport() {
    setExporting(true);
    try {
      const blob = await fetchDashboardExport({
        marketplace: filters.marketplace,
        from: filters.from,
        to: filters.to,
        search: filters.search,
        sortBy,
        sortOrder,
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "dashboard-export.csv";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to export dashboard data."
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleImportCsvFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const rawText = await file.text();
    const [headerRow] = parseCsv(rawText, CSV_IMPORT_DELIMITER);
    const idLabel = headerRow?.[0]?.trim() ?? "";
    const columnLabel = headerRow?.[1]?.trim() ?? "";

    setCsvMappingPreview({
      file,
      rawText,
      idLabel,
      columnLabel,
      idOverride: null,
      columnOverride: null,
    });
  }

  async function handleConfirmImportCsv() {
    if (!csvMappingPreview) return;
    const { file, rawText, idLabel, columnLabel, idOverride, columnOverride } = csvMappingPreview;
    setCsvMappingPreview(null);
    setImportingCsv(true);

    try {
      const effectiveIdLabel = idOverride ?? idLabel;
      const effectiveColumnLabel = columnOverride ?? columnLabel;

      // Only the header line is rewritten (to the corrected column names);
      // data rows are matched positionally by the API, so they're untouched.
      const lines = rawText.split(/\r\n|\r|\n/);
      lines[0] = `${effectiveIdLabel}${CSV_IMPORT_DELIMITER}${effectiveColumnLabel}`;
      const finalBlob = new Blob([lines.join("\n")], { type: "text/csv" });

      const formData = new FormData();
      formData.append("file", finalBlob, file.name);

      const res = await fetch("/api/dashboard/import-csv", {
        method: "POST",
        body: formData,
      });
      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error ?? "Failed to import CSV.");
      }

      const unmatchedIds: string[] = Array.isArray(json.unmatchedIds)
        ? json.unmatchedIds
        : [];

      toast.success(json.message ?? "CSV import complete.", {
        description:
          typeof json.rowsImported === "number"
            ? `${json.rowsImported} order(s) updated${
                unmatchedIds.length ? `, ${unmatchedIds.length} skipped (no matching order).` : "."
              }`
            : undefined,
      });

      if (unmatchedIds.length > 0) {
        setIdIssues({ title: IMPORT_CSV_UNMATCHED_TITLE, items: unmatchedIds });
      }

      fetchData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import CSV.");
    } finally {
      setImportingCsv(false);
    }
  }

  return (<>
    <Sidebar
        variant={variant}
        collapsible="icon"
    >
      <SidebarHeader/>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip={IMPORT_ORDERS_TEXT}
                    onClick={handleImportOrders}
                    disabled={importingOrders}
                    render={
                      <span>
                        {importingOrders ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RefreshCw className="size-4" />
                        )}
                        <span className=" cursor-default">{IMPORT_ORDERS_TEXT}</span>
                      </span>
                    }
                  />
                </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
            <SidebarGroupLabel>{SIDEBAR_DELIVERY}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                  <SidebarMenuItem>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={handleFileSelected}
                    />
                    <SidebarMenuButton
                      tooltip={IMPORT_INPOST_TEXT}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={importing}
                      render={
                        <span>
                           {importing ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Upload className="size-4" />
                          )}
                          <span className=" cursor-default">{IMPORT_INPOST_TEXT}</span>
                        </span>
                      }
                    />
                </SidebarMenuItem>
                <SidebarMenuItem>
                    <input
                      ref={dhlFileInputRef}
                      type="file"
                      accept=".xlsx"
                      className="hidden"
                      onChange={handleDhlFileSelected}
                    />
                    <SidebarMenuButton
                      tooltip={IMPORT_DHL_TEXT}
                      onClick={() => dhlFileInputRef.current?.click()}
                      disabled={importingDhl}
                      render={
                        <span>
                           {importingDhl ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Upload className="size-4" />
                          )}
                          <span className=" cursor-default">{IMPORT_DHL_TEXT}</span>
                        </span>
                      }
                    />
                </SidebarMenuItem>
                <SidebarMenuItem>
                    <input
                      ref={dpdFileInputRef}
                      type="file"
                      accept=".xlsx"
                      className="hidden"
                      onChange={handleDpdFileSelected}
                    />
                    <SidebarMenuButton
                      tooltip={IMPORT_DPD_TEXT}
                      onClick={() => dpdFileInputRef.current?.click()}
                      disabled={importingDpd}
                      render={
                        <span>
                           {importingDpd ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Upload className="size-4" />
                          )}
                          <span className=" cursor-default">{IMPORT_DPD_TEXT}</span>
                        </span>
                      }
                    />
                </SidebarMenuItem>
                <SidebarMenuItem>
                    <input
                      ref={fedexFileInputRef}
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={handleFedexFileSelected}
                    />
                    <SidebarMenuButton
                      tooltip={IMPORT_FEDEX_TEXT}
                      onClick={() => fedexFileInputRef.current?.click()}
                      disabled={importingFedex}
                      render={
                        <span>
                           {importingFedex ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Upload className="size-4" />
                          )}
                          <span className=" cursor-default">{IMPORT_FEDEX_TEXT}</span>
                        </span>
                      }
                    />
                </SidebarMenuItem>
                <SidebarMenuItem>
                    <input
                      ref={glsFileInputRef}
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={handleGlsFileSelected}
                    />
                    <SidebarMenuButton
                      tooltip={IMPORT_GLS_TEXT}
                      onClick={() => glsFileInputRef.current?.click()}
                      disabled={importingGls}
                      render={
                        <span>
                           {importingGls ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Upload className="size-4" />
                          )}
                          <span className=" cursor-default">{IMPORT_GLS_TEXT}</span>
                        </span>
                      }
                    />
                </SidebarMenuItem>
                <SidebarMenuItem>
                    <input
                      ref={dhlDeFileInputRef}
                      type="file"
                      accept=".xls,.xlsx"
                      className="hidden"
                      onChange={handleDhlDeFileSelected}
                    />
                    <SidebarMenuButton
                      tooltip={IMPORT_DHL_PL_TEXT}
                      onClick={() => dhlDeFileInputRef.current?.click()}
                      disabled={importingDhlDe}
                      render={
                        <span>
                           {importingDhlDe ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Upload className="size-4" />
                          )}
                          <span className=" cursor-default">{IMPORT_DHL_PL_TEXT}</span>
                        </span>
                      }
                    />
                </SidebarMenuItem>
            </SidebarMenu>
            </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup />

      </SidebarContent>
      <SidebarFooter >
        <SidebarMenu>
          <SidebarMenuItem>
            <input
                ref={importCsvFileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleImportCsvFileSelected}
              />
            <SidebarMenuButton
              onClick={() => importCsvFileInputRef.current?.click()}
              disabled={importingCsv}
              tooltip={IMPORT_CSV_TEXT}
              className="transition-none flex-1"
            >
              {importingCsv ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (<FileUp className="size-4"/>)}
              {IMPORT_CSV_TEXT}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <div className="flex items-start gap-1 group-data-[collapsible=icon]:flex-col">
              <SidebarMenuButton
                onClick={handleExport}
                disabled={exporting}
                tooltip={EXPORT_TEXT}
                className="transition-none"
              >
                {exporting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (<FileDown className="size-4"/>)}
                {EXPORT_TEXT}
              </SidebarMenuButton>
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      title={EXPORT_COLUMNS_HELP_TITLE}
                      className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-none group-data-[collapsible=icon]:order-last group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:rounded-md group-data-[collapsible=icon]:hover:bg-sidebar-accent group-data-[collapsible=icon]:hover:text-sidebar-accent-foreground"
                    >
                      <HelpCircle className="size-4" />
                    </button>
                  }
                />
                <PopoverContent side="right" align="end" className="w-80">
                  <p className="mb-2 text-sm font-medium">{EXPORT_COLUMNS_HELP_TITLE}</p>
                  <ul className="space-y-1 text-xs">
                    {EXPORT_COLUMN_LABELS.map(({ db, frontend }) => (
                      <li key={db} className="flex items-center justify-between gap-2">
                        <span className="font-mono text-muted-foreground">{db}</span>
                        <span>{frontend}</span>
                      </li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
    <Dialog
        open={csvMappingPreview !== null}
        onOpenChange={(open) => {
          if (!open) setCsvMappingPreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{IMPORT_CSV_MAPPING_TITLE}</DialogTitle>
            <DialogDescription>{IMPORT_CSV_MAPPING_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {csvMappingPreview && [
              {
                label: IMPORT_CSV_ID_COL_LABEL,
                detected: csvMappingPreview.idLabel,
                override: csvMappingPreview.idOverride,
                allowed: IMPORT_CSV_ALLOWED_ID_COLUMNS as readonly string[],
                setOverride: (value: string) =>
                  setCsvMappingPreview((prev) => (prev ? { ...prev, idOverride: value } : prev)),
              },
              {
                label: IMPORT_CSV_VALUE_COL_LABEL,
                detected: csvMappingPreview.columnLabel,
                override: csvMappingPreview.columnOverride,
                allowed: IMPORT_CSV_ALLOWED_VALUE_COLUMNS as readonly string[],
                setOverride: (value: string) =>
                  setCsvMappingPreview((prev) => (prev ? { ...prev, columnOverride: value } : prev)),
              },
            ].map(({ label, detected, override, allowed, setOverride }) => {
              const column = override ?? detected;
              const status = evaluateCsvColumn(column, allowed);
              return (
                <div
                  key={label}
                  className={cn(
                    "rounded-md border p-3",
                    status === "ok" &&
                      "border-green-600/30 bg-green-600/15 dark:border-green-500/30 dark:bg-green-500/10",
                    status !== "ok" &&
                      "border-destructive/30 bg-destructive/15 dark:bg-destructive/10"
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base text-muted-foreground">{label}</span>
                    <span
                      className={cn(
                        "font-mono text-base font-medium",
                        status === "ok" && "text-green-700 dark:text-green-400",
                        status !== "ok" && "text-destructive"
                      )}
                    >
                      {column || "(missing)"}
                    </span>
                  </div>
                  {status === "ok" && (
                    <p className="mt-1 text-sm text-green-700 dark:text-green-400">
                      Mapped to orders.{column}
                    </p>
                  )}
                  {status !== "ok" && (
                    <>
                      <p className="mt-1 text-sm text-destructive">
                        {status === "not-allowed" ? IMPORT_CSV_COLUMN_NOT_ALLOWED : IMPORT_CSV_COLUMN_NOT_FOUND}
                      </p>
                      <Select value={override ?? ""} onValueChange={(value) => setOverride(value as string)}>
                        <SelectTrigger className="mt-2 w-full bg-background">
                          <SelectValue placeholder="Pick the correct column..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {allowed.map((col) => (
                              <SelectItem key={col} value={col}>
                                {col}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter showCloseButton>
            <Button
              disabled={
                !csvMappingPreview ||
                evaluateCsvColumn(
                  csvMappingPreview.idOverride ?? csvMappingPreview.idLabel,
                  IMPORT_CSV_ALLOWED_ID_COLUMNS
                ) !== "ok" ||
                evaluateCsvColumn(
                  csvMappingPreview.columnOverride ?? csvMappingPreview.columnLabel,
                  IMPORT_CSV_ALLOWED_VALUE_COLUMNS
                ) !== "ok"
              }
              onClick={handleConfirmImportCsv}
            >
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    <Dialog
        open={skippedNrs.length > 0}
        onOpenChange={(open) => {
          if (!open) setSkippedNrs([]);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{DIALOG_TITLE}</DialogTitle>
            <DialogDescription>
              {skippedNrs.length} row{skippedNrs.length === 1 ? "" : "s"}{" "}
              {DIALOG_DESCRIPTION}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto rounded-md border">
            <ul className="divide-y text-sm">
              {skippedNrs.map((nr) => (
                <li key={nr} className="px-3 py-1.5 font-mono">
                  {nr}
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter showCloseButton>
            <DownloadButton data={skippedNrs} downloadName="skipped-rows.txt" />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    <Dialog
        open={idIssues !== null}
        onOpenChange={(open) => {
          if (!open) setIdIssues(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{idIssues?.title}</DialogTitle>
            <DialogDescription>
              {idIssues?.items.length} ID{idIssues?.items.length === 1 ? "" : "s"}{" "}
              could not be imported.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 overflow-y-auto rounded-md border">
            <ul className="divide-y text-sm">
              {idIssues?.items.map((id) => (
                <li key={id} className="px-3 py-1.5 font-mono">
                  {id}
                </li>
              ))}
            </ul>
          </div>
          <DialogFooter showCloseButton>
            <DownloadButton
              data={idIssues?.items ?? []}
              downloadName="failed-shipment-ids.txt"
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>
    <ProgressDialog
      title={IMPORT_ORDERS_PROGRESS_TITLE}
      description={IMPORT_ORDERS_PROGRESS_DESCRIPTION}
      state={importProgress}
      setState={setImportProgress}
    />
  </>)
}