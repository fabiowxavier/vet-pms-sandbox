import { listRoute } from "@/lib/compat/shared/extraction";
import { invoiceAdjustmentsResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/invoice-adjustments — invoice credits and write-offs (billing:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(invoiceAdjustmentsResource);
