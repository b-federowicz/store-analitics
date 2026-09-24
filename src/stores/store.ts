import { SliceInterface } from "@/lib/types";
import { createStore } from 'zustand/vanilla';
import { createDashboardSlice } from "./slices/dashboard-slice";

export type StoreState = SliceInterface;

export const createAppStore = (initState?: Partial<StoreState>) => {
    return createStore<StoreState>()((...a) => ({
        ...createDashboardSlice(...a),
        ...initState,
    }));
};

export type AppStore = ReturnType<typeof createAppStore>;