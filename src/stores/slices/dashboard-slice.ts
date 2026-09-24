import { StateCreator } from 'zustand';
import { StoreState } from '../store';
import { fetchDashboardData } from '@/lib/api/dashboard';
import { SliceInterface, SortColumn } from '@/lib/types';
import {
  DEFAULT_SORT_BY,
  DEFAULT_SORT_ORDER,
  EMPTY_FILTERS,
  INITIAL_DATA,
} from '@/constants';

const PAGE_SIZE = 25;

export const createDashboardSlice: StateCreator<
  StoreState,
  [],
  [],
  SliceInterface
> = (set, get) => {
  let requestId = 0;

  const fetchData = async () => {
    const id = ++requestId;
    set({ loading: true });

    const { page, filters, sortBy, sortOrder } = get();

    try {
      const data = await fetchDashboardData({
        marketplace: filters.marketplace,
        from: filters.from,
        to: filters.to,
        search: filters.search,
        transactionType: filters.transactionType,
        page,
        pageSize: PAGE_SIZE,
        sortBy,
        sortOrder,
      });
      if (id !== requestId) return;
      set({ data, loading: false, error: null });
    } catch (err) {
      if (id !== requestId) return;
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load dashboard data",
      });
    }
  };

  return {
    data: INITIAL_DATA,
    loading: false,
    error: null,
    page: 1,
    filters: EMPTY_FILTERS,
    sortBy: DEFAULT_SORT_BY,
    sortOrder: DEFAULT_SORT_ORDER,
    fetchData,
    setPage: (page) => {
      set({ page });
      void fetchData();
    },
    applyFilters: (filters) => {
      set({ page: 1, filters: { ...EMPTY_FILTERS, ...filters } });
      void fetchData();
    },
    clearFilters: () => {
      set({ page: 1, filters: EMPTY_FILTERS });
      void fetchData();
    },
    setSort: (column: SortColumn) => {
      const { sortBy, sortOrder } = get();
      const nextOrder =
        sortBy === column && sortOrder === "asc" ? "desc" : "asc";
      set({ page: 1, sortBy: column, sortOrder: nextOrder });
      void fetchData();
    },
  };
};
