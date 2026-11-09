import { getRoute } from "@/lib/compat/shared/extraction";
import { productsResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/products/:id — a product (catalog:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = getRoute(productsResource);
