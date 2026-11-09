import { listRoute } from "@/lib/compat/shared/extraction";
import { prescriptionsResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/prescriptions — prescriptions (orders) with lifecycle events (records:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(prescriptionsResource);
