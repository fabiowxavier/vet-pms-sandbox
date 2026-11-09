import { listRoute } from "@/lib/compat/shared/extraction";
import { stockMovementsResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/stock-movements — stock receipts, adjustments, dispensing and sales (inventory:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(stockMovementsResource);
