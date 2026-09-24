'use client';

import { useAppStore } from '@/hooks/use-store';

export function useDashboard() {
  const data = useAppStore((s) => s.data);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const page = useAppStore((s) => s.page);
  const filters = useAppStore((s) => s.filters);
  const sortBy = useAppStore((s) => s.sortBy);
  const sortOrder = useAppStore((s) => s.sortOrder);
  const fetchData = useAppStore((s) => s.fetchData);
  const setPage = useAppStore((s) => s.setPage);
  const applyFilters = useAppStore((s) => s.applyFilters);
  const clearFilters = useAppStore((s) => s.clearFilters);
  const setSort = useAppStore((s) => s.setSort);

  return {
    data,
    loading,
    error,
    page,
    filters,
    sortBy,
    sortOrder,
    fetchData,
    setPage,
    applyFilters,
    clearFilters,
    setSort,
  };
}
