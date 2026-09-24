// src/lib/supabase-admin.ts
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.warn("Supabase admin client is not fully configured.");
}

export const supabaseAdmin =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      })
    : null;

// Separate Supabase project used only by the Stock check page. Its env keys
// carry a STOCK_ marker (see .env.local); schema in scripts/stock-check-schema.sql.
const stockSupabaseUrl = process.env.NEXT_PUBLIC_STOCK_SUPABASE_URL;
const stockServiceRoleKey = process.env.SUPABASE_STOCK_SERVICE_ROLE_KEY;

if (!stockSupabaseUrl || !stockServiceRoleKey) {
  console.warn("Stock-check Supabase admin client is not fully configured.");
}

export const supabaseStockAdmin =
  stockSupabaseUrl && stockServiceRoleKey
    ? createClient(stockSupabaseUrl, stockServiceRoleKey, {
        auth: { persistSession: false },
      })
    : null;
