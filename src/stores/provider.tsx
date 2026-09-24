// src/stores/provider.tsx
'use client';

import { createContext, useState, ReactNode } from 'react';
import { createAppStore, AppStore } from './store';

export const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState<AppStore>(() => createAppStore());

  return (
    <StoreContext.Provider value={store}>
      {children}
    </StoreContext.Provider>
  );
}