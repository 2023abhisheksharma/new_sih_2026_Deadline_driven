/**
 * Domain Types Barrel Export
 * ---------------------------
 * Re-exports all core domain types for navigation, ports, icebergs,
 * hazards, route simulation, and maritime routing across the Antarctic DSS.
 */

export * from './navigation';
export * from './port';
export * from './iceberg';
export * from './driftingIceberg';
export * from './sentinel1Iceberg';
export * from './iceHazard';
export type { MaritimeRouteResult } from '../services/maritimeRoutingService';
export type {
  RouteSimulationPoint,
  RouteGeometryProfile,
} from '../services/routeSimulationService';
