import { supabaseAdmin } from "@/lib/supabase-admin";
import { invalidateDashboardCache } from "@/lib/cache";
import { TRANSACTION_TYPES } from "@/constants";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
    if (!supabaseAdmin) {
    return NextResponse.json(
        { error: "Supabase is not configured on the server." },
        { status: 500 }
    );
    }

    const { searchParams } = new URL(request.url);
    const token = searchParams.get("token");

    if (!process.env.BASE_TRANSACTION_TYPE_TOKEN || token !== process.env.BASE_TRANSACTION_TYPE_TOKEN) {
        return NextResponse.json(
            { error: "Unauthorized" },
            { status: 401 }
        );
    }

    const orderId = searchParams.get("orderId");
    const transactionType = searchParams.get("transactionType") || TRANSACTION_TYPES[0];

    if (!orderId) {
        return NextResponse.json(
            { error: "Missing orderId" },
            { status: 400 }
        );
    }

    try {
        const admin = supabaseAdmin;

        const { data, error } = await admin
            .from("orders")
            .update({ transaction_type: transactionType })
            .eq("order_id", orderId)
            .select("order_id, transaction_type")
            .single();

        if (error) {
            // PGRST116: .single() found no matching row — base sent an
            // order_id that doesn't exist in our DB yet. Not a server error.
            if (error.code === "PGRST116") {
                return NextResponse.json(
                    { error: `Order ${orderId} not found.` },
                    { status: 404 }
                );
            }

            console.error(error);
            return NextResponse.json(
                { error: error.message },
                { status: 500 }
            );
        }

        invalidateDashboardCache();

        return NextResponse.json({ message: "Updated transaction type to: " + data.transaction_type + " in row: " + data.order_id });
    } catch (error) {
        console.error(error);
        return NextResponse.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
        );
    }
}