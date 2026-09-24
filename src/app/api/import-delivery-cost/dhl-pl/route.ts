import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { parseCsv, parsePolishNumber } from "@/lib/csv";
import { invalidateDashboardCache } from "@/lib/cache";
import { xlsxToCsv, excelSerialToIso } from "@/lib/xlsx";
import soap from "soap";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DELIMITER = ",";
const BATCH_SIZE = 500;
const SHIP_ID_COL = 4;
const NETTO_COL = 17;
const DATE_COL = 5; //2026-08-26


const DHL_WSDL = "https://dhl24.com.pl/webapi2";
const LABELS_CHUNK_SIZE = 50;


interface ParsedShipment {
    shipmentId: string;
    netto: number;
    dateConfirm: string;
}

interface StageDeliveryCostRow {
    nr: string;
    netto: number;
    shipment_id: number;
    date_confirm: string;
}

function parseDhlDeRows(csvText: string): ParsedShipment[] {
    const rows = parseCsv(csvText, DELIMITER);
    if (rows.length === 0) return [];

    return rows
        .slice(1)
        .filter((r) => r[SHIP_ID_COL]?.trim() && !r[SHIP_ID_COL].trim().endsWith("/ZW"))
        .map((r) => {
            const rawDate = r[DATE_COL]?.trim() ?? "";
            return {
                shipmentId: r[SHIP_ID_COL].trim(),
                netto: parsePolishNumber(r[NETTO_COL] ?? "0"),
                dateConfirm: excelSerialToIso(rawDate) ?? rawDate,
            };
        });
}

// soap collapses a single-element array into a bare object; normalize both
// shapes to an array.
function asArray<T>(value: T | T[] | undefined | null): T[] {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

// getLabelsData's result shape:
// result.getLabelsDataResult.item[] (one per shipmentId), each with a
// pieceList.item[] (one per package) carrying the blpPieceId tracking number.
function extractLabelItems(result: unknown): Array<Record<string, unknown>> {
    const r = result as { getLabelsDataResult?: { item?: unknown } } | undefined;
    return asArray(r?.getLabelsDataResult?.item) as Array<Record<string, unknown>>;
}

function soapErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// Calls getLabelsData for every shipmentId and returns the mapping
// shipmentId -> blpPieceIds (one tracking number per physical package; a
// multi-piece shipment has several, each usable as `nr`), plus any
// shipmentIds DHL rejected (e.g. "Brak przesyłki o podanym numerze") together
// with the error message. A single bad shipmentId fails its whole chunk of
// 50, so a failed chunk is retried one shipmentId at a time to find out
// which one(s) are actually bad.
async function getTrackingNumbersByShipmentId(
    shipmentIds: string[]
): Promise<{ byShipmentId: Map<string, string[]>; failed: Map<string, string> }> {
    const username = process.env.DHL_USERNAME;
    const password = process.env.DHL_PASSWORD;
    if (!username || !password) {
        throw new Error("DHL_USERNAME / DHL_PASSWORD are not configured on the server.");
    }

    const client = await soap.createClientAsync(DHL_WSDL);
    const byShipmentId = new Map<string, string[]>();
    const failed = new Map<string, string>();

    const callChunk = async (chunk: string[]) => {
        const args = {
            authData: { username, password },
            itemsToLabelData: { item: chunk.map((shipmentId) => ({ shipmentId })) },
        };
        const [result] = await client.getLabelsDataAsync(args);

        for (const item of extractLabelItems(result)) {
            const shipmentId = item.shipmentId != null ? String(item.shipmentId) : "";
            if (!shipmentId) continue;

            const pieceList = item.pieceList as { item?: unknown } | undefined;
            const pieces = asArray(pieceList?.item) as Array<Record<string, unknown>>;
            const blpPieceIds = pieces
                .map((p) => (p.blpPieceId != null ? String(p.blpPieceId).trim() : ""))
                .filter((id) => id.length > 0);

            if (blpPieceIds.length > 0) byShipmentId.set(shipmentId, blpPieceIds);
        }
    };

    for (let i = 0; i < shipmentIds.length; i += LABELS_CHUNK_SIZE) {
        const chunk = shipmentIds.slice(i, i + LABELS_CHUNK_SIZE);
        try {
            await callChunk(chunk);
        } catch (err) {
            if (chunk.length === 1) {
                failed.set(chunk[0], soapErrorMessage(err));
                continue;
            }
            // Retry the whole chunk in parallel, one shipmentId per call, so a
            // 50-item chunk doesn't turn into 50 sequential round-trips (which
            // can blow past the request's overall timeout).
            const outcomes = await Promise.allSettled(
                chunk.map((shipmentId) => callChunk([shipmentId]))
            );
            outcomes.forEach((outcome, idx) => {
                if (outcome.status === "rejected") {
                    failed.set(chunk[idx], soapErrorMessage(outcome.reason));
                }
            });
        }
    }

    return { byShipmentId, failed };
}

export async function POST(request: NextRequest) {
    if (!supabaseAdmin) {
        return NextResponse.json(
        { error: "Supabase is not configured on the server." },
        { status: 500 }
        );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
        return NextResponse.json(
        { error: "Missing 'file' in form data." },
        { status: 400 }
        );
    }

    let shipments: ParsedShipment[];
    try {
      const csvText = await xlsxToCsv(file);
      shipments = parseDhlDeRows(csvText);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Failed to parse the DHL file." },
        { status: 400 }
      );
    }

    if (shipments.length === 0) {
      return NextResponse.json(
        { error: "No valid rows found in the file." },
        { status: 400 }
      );
    }

    // Last write wins if the same shipmentId appears twice in the file.
    const dataByShipmentId = new Map<string, { netto: number; dateConfirm: string }>();
    const duplicateShipmentIds = new Set<string>();
    for (const s of shipments) {
        if (dataByShipmentId.has(s.shipmentId)) duplicateShipmentIds.add(s.shipmentId);
        dataByShipmentId.set(s.shipmentId, { netto: s.netto, dateConfirm: s.dateConfirm });
    }
    if (duplicateShipmentIds.size > 0) {
        console.warn(
            `DHL PL import: duplicate shipmentId(s) in file, last occurrence wins: ${Array.from(duplicateShipmentIds).join(", ")}`
        );
    }

    let trackingByShipmentId: Map<string, string[]>;
    let failedShipmentIds: Map<string, string>;
    try {
      const result = await getTrackingNumbersByShipmentId(
        Array.from(dataByShipmentId.keys())
      );
      trackingByShipmentId = result.byShipmentId;
      failedShipmentIds = result.failed;
    } catch (err) {
      console.error(err);
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Failed to fetch label data from DHL24 WebAPI.",
        },
        { status: 502 }
      );
    }

    // Some shipmentIds were rejected by DHL24 WebAPI. Report them without
    // importing anything, so the file can be fixed and re-uploaded.
    if (failedShipmentIds.size > 0) {
      return NextResponse.json(
        {
          error: "DHL24 WebAPI rejected some shipmentIds; nothing was imported.",
          failedShipmentIds: Array.from(failedShipmentIds, ([shipmentId, reason]) => ({
            shipmentId,
            reason,
          })),
        },
        { status: 502 }
      );
    }

    const rows: StageDeliveryCostRow[] = [];
    const unmatchedShipmentIds: string[] = [];
    for (const [shipmentId, { netto, dateConfirm }] of dataByShipmentId) {
      const nrs = trackingByShipmentId.get(shipmentId);
      if (nrs && nrs.length > 0) {
        for (const nr of nrs) {
          rows.push({ nr, netto, shipment_id: Number(shipmentId), date_confirm: dateConfirm });
        }
      } else {
        unmatchedShipmentIds.push(shipmentId);
      }
    }

    if (rows.length === 0) {
      return NextResponse.json(
        {
          error: "DHL24 WebAPI returned no blpPieceId for any shipmentId in the file.",
          unmatchedShipmentIds,
        },
        { status: 502 }
      );
    }

    const seenNrs = new Set<string>();
    const duplicateNrs = new Set<string>();
    for (const r of rows) {
        if (seenNrs.has(r.nr)) duplicateNrs.add(r.nr);
        seenNrs.add(r.nr);
    }
    if (duplicateNrs.size > 0) {
        console.warn(
            `DHL PL import: duplicate tracking nr(s), last occurrence wins: ${Array.from(duplicateNrs).join(", ")}`
        );
    }

    const dedupedRows = Array.from(
        new Map(rows.map((r) => [r.nr, r])).values()
    );


    const insertedNrs = new Set<string>();
    for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
        const batch = dedupedRows.slice(i, i + BATCH_SIZE);
        const { data: inserted, error } = await supabaseAdmin
        .from("stage_delivery_cost")
        .upsert(batch, { onConflict: "nr", ignoreDuplicates: true })
        .select("nr");

        if (error) {
        console.error(error);
        return NextResponse.json({ error: error.message }, { status: 500 });
        }

        for (const r of inserted ?? []) insertedNrs.add(r.nr);
    }
    const skippedNrs = dedupedRows
        .map((r) => r.nr)
        .filter((nr) => !insertedNrs.has(nr));

    invalidateDashboardCache();
    return NextResponse.json({
        message: "DHL DE delivery cost import complete.",
        rowsImported: insertedNrs.size,
        skippedNrs,
        unmatchedShipmentIds,
        duplicateShipmentIds: Array.from(duplicateShipmentIds),
        duplicateNrs: Array.from(duplicateNrs),
    });
}
