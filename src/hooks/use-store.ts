'use client';

import { useContext } from 'react';
import { useStore as useZustandStore } from 'zustand';
import { StoreContext } from '@/stores/provider';
import { StoreState } from '@/stores/store';

export function useAppStore<T>(selector: (state: StoreState) => T): T {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error('useAppStore must be used within StoreProvider');
  }
  return useZustandStore(store, selector);
}