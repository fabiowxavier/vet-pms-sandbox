import { listRoute } from "@/lib/compat/shared/extraction";
import { dispensingEventsResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/dispensing-events — actual supply from clinic stock with billing state (inventory:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(dispensingEventsResource);
