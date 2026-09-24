// src/app/api/dashboard/sources/route.ts
import { NextResponse } from "next/server";
import { buildSourceGroups, fetchOrderSourceRows } from "@/lib/order-sources";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await fetchOrderSourceRows();
    const groups = buildSourceGroups(rows);
    return NextResponse.json({ groups: groups.map(({ key, label }) => ({ key, label })) });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
