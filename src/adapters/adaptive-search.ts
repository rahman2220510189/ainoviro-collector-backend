import type { Bbox } from '../geonames/build';
import type { GooglePlace, GooglePlacesClient, TextSearchQuery } from './google-places';

/** Splits a box into 4 quadrants: south-west, south-east, north-west, north-east. */
export function splitBbox(box: Bbox): Bbox[] {
  const midLat = (box.south + box.north) / 2;
  const midLng = (box.west + box.east) / 2;
  return [
    { south: box.south, west: box.west, north: midLat, east: midLng },
    { south: box.south, west: midLng, north: midLat, east: box.east },
    { south: midLat, west: box.west, north: box.north, east: midLng },
    { south: midLat, west: midLng, north: box.north, east: box.east },
  ];
}

export interface SplitSearchResult {
  /** Unique places (by Google id) across all tiles. */
  places: GooglePlace[];
  tilesSearched: number;
  pages: number;
  attempts: number;
  /** Tiles still full at the maximum depth: some places may be missing there. */
  saturatedAtMaxDepth: number;
}

/**
 * Searches a box; when a search hits the 60-result ceiling, splits the box into
 * 4 and searches each quadrant, up to maxDepth levels (spec: 2). Rare keywords
 * therefore cost one request per area; only dense ones are split.
 */
export async function searchWithSplitting(
  client: Pick<GooglePlacesClient, 'searchQuery'>,
  query: Omit<TextSearchQuery, 'bbox'>,
  bbox: Bbox,
  maxDepth = 2,
): Promise<SplitSearchResult> {
  const found = new Map<string, GooglePlace>();
  const totals = { tilesSearched: 0, pages: 0, attempts: 0, saturatedAtMaxDepth: 0 };

  const visit = async (tile: Bbox, depth: number): Promise<void> => {
    const result = await client.searchQuery({ ...query, bbox: tile });
    totals.tilesSearched += 1;
    totals.pages += result.pages;
    totals.attempts += result.attempts;
    for (const place of result.places) found.set(place.googlePlaceId, place);

    if (!result.saturated) return;
    if (depth >= maxDepth) {
      totals.saturatedAtMaxDepth += 1;
      return;
    }
    for (const child of splitBbox(tile)) await visit(child, depth + 1);
  };

  await visit(bbox, 0);
  return { places: [...found.values()], ...totals };
}