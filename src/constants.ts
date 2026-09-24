import { DashboardResponse, Filters } from "./lib/types";

// DASHBOARD-FILTERS
export const DIALOG_TITLE = "Skipped rows";
export const DIALOG_DESCRIPTION = "were skipped because their delivery nr already exists."
export const APPLY_BUTTON_TEXT = "Apply filters";
export const CLEAR_BUTTON_TEXT = "Clear";
export const IMPORT_INPOST_TEXT = "Import Inpost";
export const IMPORT_DHL_TEXT = "Import DHL Słupsk";
export const IMPORT_DHL_PL_TEXT = "Import DHL PL";
export const IMPORT_DPD_TEXT = "Import DPD";
export const IMPORT_FEDEX_TEXT = "Import FedEx";
export const IMPORT_GLS_TEXT = "Import GLS";
export const EXPORT_TEXT = "Export table";
export const EXPORT_COLUMNS_HELP_TITLE = "Exported columns";
export const IMPORT_CSV_TEXT = "Import CSV";
// Generic orders-column CSV import (sidebar footer "Import CSV" button).
// First CSV column must be one of these (used to match existing orders);
// second CSV column must be one of IMPORT_CSV_ALLOWED_VALUE_COLUMNS.
export const IMPORT_CSV_ALLOWED_ID_COLUMNS = ["order_id", "external_order_id"] as const;
// Deliberately excludes columns that get silently overwritten by other
// processes: products_cost/revenue_netto/margin (recalculated by triggers
// on every order_products change or cost recalc) and revenue_brutto
// (overwritten by every "Import orders" BaseLinker sync). fees_brutto is
// also excluded: it's display/export-only — no trigger derives fees_netto
// from it and profit/margin never read it, so importing it wouldn't do
// anything but store an unused number.
// delivery_cost_netto IS allowed despite stage_delivery_cost_after_insert/
// _after_update (db.sql) overwriting it whenever that order's delivery_nr
// later appears in a carrier CSV import (InPost/DHL/DPD/FedEx/GLS) — in
// that case it's expected to get reset to the same cost from that CSV.
export const IMPORT_CSV_ALLOWED_VALUE_COLUMNS = [
  "delivery_cost_netto",
  "fees_netto",
  "marketing_cost",
  "transaction_type",
] as const;
// Every real column on `orders`, used only to tell "not allowed" (exists,
// but not importable) apart from "doesn't exist" (typo in the CSV header)
// in the column-mapping preview.
export const ORDERS_TABLE_COLUMNS = [
  "order_id",
  "external_order_id",
  "order_source",
  "delivery_nr",
  "delivery_country_code",
  "currency",
  "delivery_cost_netto",
  "revenue_brutto",
  "revenue_netto",
  "fees_brutto",
  "fees_netto",
  "marketing_cost",
  "profit",
  "order_date",
  "more_info_link",
  "created_at",
  "products_cost",
  "margin",
  "has_skipped_lines",
  "transaction_type",
];
export const IMPORT_CSV_MAPPING_TITLE = "Confirm column mapping";
export const IMPORT_CSV_MAPPING_DESCRIPTION =
  "Review how the CSV columns will map to the orders table before importing.";
export const IMPORT_CSV_ID_COL_LABEL = "Row ID column";
export const IMPORT_CSV_VALUE_COL_LABEL = "Value column";
export const IMPORT_CSV_COLUMN_NOT_ALLOWED = "Exists in orders, but not allowed for CSV import.";
export const IMPORT_CSV_COLUMN_NOT_FOUND = "No matching column in orders — fix the CSV header.";
export const IMPORT_CSV_UNMATCHED_TITLE = "Unmatched order IDs";
export const IMPORT_CSV_UNMATCHED_DESCRIPTION = "had no matching order and were skipped.";
// Maps exported CSV column names (database) to their equivalent label in the dashboard UI.
// Columns without a frontend equivalent (e.g. delivery_nr, created_at) are intentionally omitted.
export const EXPORT_COLUMN_LABELS: { db: string; frontend: string }[] = [
  { db: "order_id", frontend: "Order" },
  { db: "external_order_id", frontend: "Marketplace Order ID" },
  { db: "order_date", frontend: "Date" },
  { db: "order_source", frontend: "Source" },
  { db: "transaction_type", frontend: "Transaction type" },
  { db: "revenue_netto", frontend: "Revenue" },
  { db: "products_cost", frontend: "Products cost" },
  { db: "delivery_cost_netto", frontend: "Delivery cost" },
  { db: "fees_netto", frontend: "Fees" },
  { db: "marketing_cost", frontend: "Marketing" },
  { db: "profit", frontend: "Profit" },
  { db: "margin", frontend: "Margin" },
];
export const IMPORT_ORDERS_TEXT = "Import orders";
export const IMPORT_ORDERS_FROM_DATE = "2026-08-20";
export const IMPORT_ORDERS_PROGRESS_TITLE = "Importing orders";
export const IMPORT_ORDERS_PROGRESS_DESCRIPTION =
  "Syncing orders from BaseLinker and saving them to the database.";
export const RECALC_ALL_PROGRESS_TITLE = "Recalculating orders";
export const RECALC_ALL_PROGRESS_DESCRIPTION =
  "Refetching orders from BaseLinker and recalculating costs and profit.";

// SIDEBAR
export const SIDEBAR_DELIVERY = "Delivery";
export const SIDEBAR_TITLE = "Aanalytics";

// DASHBOARD-FILTERS: marketplace select
export const ALL_MARKETPLACES_LABEL = "All";

// DASHBOARD-FILTERS: transaction type select
export const ALL_TRANSACTION_TYPES_LABEL = "All";
export const TRANSACTION_TYPES = ["Sprzedaż", "Anulowane", "FBA", "Reklamacja", "Zwrot"];


// STORE
export const INITIAL_DATA: DashboardResponse = {
  summary: {
    totalOrders: 0,
    totalProfit: 0,
    totalRevenueNetto: 0,
    totalRevenueBrutto: 0,
    totalDeliveryCost: 0,
    totalCommission: 0,
    totalProductCost: 0,
    totalMarketingCost: 0,
    avgProfitPerOrder: 0,
    matchedDeliveryCount: 0,
    unmatchedDbOrderCount: 0,
    unmatchedCsvRowCount: 0,
  },
  profitByDate: [],
  orders: {
    rows: [],
    total: 0,
    page: 0,
      pageSize: 10
    },
    unmatchedCsvRows: [],
    unmatchedDbOrders: []
}

export const EMPTY_FILTERS: Filters = { search: "", from: "", to: "", marketplace: "", transactionType: "" };

export const DEFAULT_SORT_BY = "order_date";
export const DEFAULT_SORT_ORDER = "desc";

export const SORTABLE_ORDER_COLUMNS = [
  "order_date",
  "revenue_netto",
  "products_cost",
  "delivery_cost_netto",
  "fees_netto",
  "marketing_cost",
  "profit",
  "margin"
] as const;
