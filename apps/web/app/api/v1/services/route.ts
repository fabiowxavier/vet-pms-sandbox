import { listRoute } from "@/lib/compat/shared/extraction";
import { servicesResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/services — billable services (catalog:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(servicesResource);
