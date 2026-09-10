import { NextResponse } from "next/server";
import { getDistinctProviders } from "@/lib/requestDetailsDb";
import { getProviderNameMap, buildProviderEntries } from "@/lib/usageProviders";

/**
 * GET /api/usage/providers
 * Returns the provider filter options for the Usage → Details tab.
 */
export async function GET() {
  try {
    // Union of requestDetails + usageHistory (see getDistinctProviders) — reads
    // only the provider column, avoiding a parse of every row's JSON blob.
    const providerIds = await getDistinctProviders();
    const nameMap = await getProviderNameMap();
    return NextResponse.json({ providers: buildProviderEntries(providerIds, nameMap) });
  } catch (error) {
    console.error("[API] Failed to get providers:", error);
    return NextResponse.json(
      { error: "Failed to fetch providers" },
      { status: 500 }
    );
  }
}
