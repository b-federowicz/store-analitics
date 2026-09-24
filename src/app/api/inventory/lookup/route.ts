// src/app/api/inventory/lookup/route.ts
import { NextRequest, NextResponse } from "next/server";
import { lookupInventoryProduct } from "@/lib/baselinker";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!process.env.BASELINKER_API_TOKEN) {
    return NextResponse.json(
      { error: "Missing BASELINKER_API_TOKEN." },
      { status: 500 }
    );
  }

  const code = request.nextUrl.searchParams.get("code")?.trim();
  if (!code) {
    return NextResponse.json({ error: "Missing 'code' query param." }, { status: 400 });
  }

  try {
    const product = await lookupInventoryProduct(code);
    if (!product) {
      return NextResponse.json(
        { error: `No product matches ${code}.` },
        { status: 404 }
      );
    }
    return NextResponse.json({ product });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "BaseLinker lookup failed." },
      { status: 502 }
    );
  }
}
