/**
 * Navigation and geospatial coordinate types for Antarctic DSS
 */

export interface GeographicPoint {
  latitude: number;
  longitude: number;
  altitude?: number;
  name?: string;
}

export type LayerFilterMode = 'ALL' | 'PORTS' | 'MOVING' | 'FIXED';
