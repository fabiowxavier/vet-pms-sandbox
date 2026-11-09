import { listRoute } from "@/lib/compat/shared/extraction";
import { invoiceLinesResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/invoice-lines — invoice lines, including removed lines as tombstones (billing:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(invoiceLinesResource);
