import { listRoute } from "@/lib/compat/shared/extraction";
import { productsResource } from "@/lib/compat/openvpm/extraction-resources";

export const dynamic = "force-dynamic";

// GET /api/v1/products — products with current stock (catalog:read). Read-only; see lib/compat/shared/extraction.ts.
export const GET = listRoute(productsResource);
