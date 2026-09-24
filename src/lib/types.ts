export type Order = {
  order_id: number;
  external_order_id: string | null;
  order_source: number | null;
  order_source_label: string;
  delivery_nr: string | null;
  transaction_type: string;
  delivery_country_code: string | null;
  delivery_cost_netto: number;
  revenue_brutto: number;
  revenue_netto: number;
  fees_brutto: number;
  fees_netto: number;
  marketing_cost: number;
  profit: number;
  order_date: string;
  more_info_link: string | null;
  created_at: string;
  delivery_matched: boolean;
  products_cost: number;
  margin: number;
};

export type DashboardSummary = {
  totalOrders: number;
  totalProfit: number;
  totalRevenueNetto: number;
  totalRevenueBrutto: number;
  totalDeliveryCost: number;
  totalCommission: number;
  totalProductCost: number;
  totalMarketingCost: number;
  avgProfitPerOrder: number;
  matchedDeliveryCount: number;
  unmatchedDbOrderCount: number;
  unmatchedCsvRowCount: number;
};

export type ProfitByDate = {
  date: string;
  profit: number;
  orders: number;
};

export type StageDeliveryCostRow = {
  nr: string;
  netto: number;
  [key: string]: unknown;
};

export type DashboardResponse = {
  summary: DashboardSummary;
  profitByDate: ProfitByDate[];
  orders: {
    rows: Order[];
    total: number;
    page: number;
    pageSize: number;
  };
  unmatchedCsvRows: StageDeliveryCostRow[];
  unmatchedDbOrders: Order[];
};


export type Filters = {
  search: string;
  from: string;
  to: string;
  marketplace: string;
  transactionType: string;
};

export type SourceGroup = {
  key: string;
  label: string;
};

export type CheckStatus = "ok" | "warning" | "error";

export type VerificationCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  summary: string;
  details?: unknown[];
  detailsTruncated?: boolean;
};

export type VerificationReport = {
  generatedAt: string;
  scope: { from: string | null; to: string | null; ordersChecked: number };
  status: CheckStatus;
  checks: VerificationCheck[];
};

export type SortColumn =
  | "order_date"
  | "revenue_netto"
  | "products_cost"
  | "delivery_cost_netto"
  | "fees_netto"
  | "marketing_cost"
  | "profit"
  | "margin";

export type SortOrder = "asc" | "desc";

// Streamed as newline-delimited JSON so the client can render live progress
export type SyncEvent =
  | { type: "progress"; stage: string; message: string; page?: number; ordersFetched?: number }
  | {
      type: "done";
      message: string;
      ordersFetched: number;
      ordersInserted: number;
      lineItemsInserted: number;
      newProductsCreated: number;
      lineItemsSkipped: number;
    }
  | { type: "error"; error: string };

export type RecalcEvent =
  | { type: "progress"; stage: string; message: string; page?: number; count?: number; total?: number }
  | {
      type: "done";
      message: string;
      orderId: number | null;
      refetchedLines: number | null;
      skippedLineItems: number;
      productsChecked: number;
      updatedProducts: number;
      updatedDeliveryCosts: number;
      recalculatedOrders: number;
    }
  | { type: "error"; error: string };

export interface SliceInterface {
  data: DashboardResponse;
  loading: boolean;
  error: string | null;
  page: number;
  filters: Filters;
  sortBy: SortColumn;
  sortOrder: SortOrder;
  fetchData: () => Promise<void>;
  setPage: (page: number) => void;
  applyFilters: (filters: Partial<Filters>) => void;
  clearFilters: () => void;
  setSort: (column: SortColumn) => void;
}