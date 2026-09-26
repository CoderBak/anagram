// lib/surfaces/load.ts — the content script's way to a surface: the chunk, loaded on demand.
import { loadSurfaces } from "../lazy";
import { asPageSurface, type PageSurface, type SurfaceId } from "./index";

/** The surface for `id`, or null where there is none. Rejects if the chunk cannot load. */
export async function loadSurface(id: SurfaceId, doc: Document = document): Promise<PageSurface | null> {
  const { createSurface } = await loadSurfaces();
  const surface = createSurface(id, doc);
  return surface ? asPageSurface(surface) : null;
}
