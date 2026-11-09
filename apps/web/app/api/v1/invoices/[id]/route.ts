import { getRoute } from "@/lib/compat/shared/extraction";
import { invoicesResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/invoices/:id — an invoice with current lines (billing:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = getRoute(invoicesResource);
