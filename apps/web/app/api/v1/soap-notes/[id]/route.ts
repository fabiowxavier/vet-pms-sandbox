import { getRoute } from "@/lib/compat/shared/extraction";
import { soapNotesResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/soap-notes/:id — a finalized SOAP note with addenda and correction history (records:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = getRoute(soapNotesResource);
