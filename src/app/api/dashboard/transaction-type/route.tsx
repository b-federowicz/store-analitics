import { supabaseAdmin } from "@/lib/supabase-admin";
import { NextRequest, NextResponse } from "next/server";


export async function POST(req: NextRequest) {
     if (!supabaseAdmin) {
        return NextResponse.json(
          { error: "Supabase is not configured on the server." },
          { status: 500 }
        );
      }
      const admin = supabaseAdmin;
    
      let orderId: number | undefined;
      let transactionType: string | undefined;
    try {
        const body = await req.json()

        if(!body.orderId || !body.transactionType) {
            return NextResponse.json({ error: "Missing orderId or transactionType" }, { status: 400 });
        }
        else if (!Number.isFinite(body.orderId)) {
            return NextResponse.json({ error: "Invalid orderId." }, { status: 400 });
        }

        orderId = body.orderId;
        transactionType = body.transactionType;
    } catch {
        return NextResponse.json({ error: "Failed to parse request body" }, { status: 400 });
    }

    const { error } = await admin
        .from("orders")
        .update({ transaction_type: transactionType })
        .eq("order_id", orderId);

    if (error) {
        return NextResponse.json({ error: "Failed to update transaction type" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
}