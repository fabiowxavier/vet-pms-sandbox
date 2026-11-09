import { listRoute } from "@/lib/compat/shared/extraction";
import { invoicesResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/invoices — invoices with current lines (billing:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(invoicesResource);
