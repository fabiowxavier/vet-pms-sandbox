import { listRoute } from "@/lib/compat/shared/extraction";
import { paymentsResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/payments — payments (billing:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(paymentsResource);
