/**
 * Dedicated Maritime Routing Web Worker
 * --------------------------------------
 * Executes computeMaritimeRoute off the browser main thread to guarantee
 * continuous 60 FPS rendering on Cesium 3D and 2D radar displays, preventing
 * "Page Unresponsive" browser watchdogs during long hybrid or polar graph computations.
 */

import { computeMaritimeRoute, type MaritimeRouteResult } from '../services/maritimeRoutingService';
import type { PortRecord } from '../types/port';

export interface RouteWorkerRequest {
  type: 'COMPUTE_ROUTE';
  id: string;
  origin: PortRecord;
  destination: PortRecord;
}

export interface RouteWorkerSuccessResponse {
  type: 'ROUTE_SUCCESS';
  id: string;
  result: MaritimeRouteResult;
}

export interface RouteWorkerErrorResponse {
  type: 'ROUTE_ERROR';
  id: string;
  error: string;
}

export type RouteWorkerResponse = RouteWorkerSuccessResponse | RouteWorkerErrorResponse;

self.addEventListener('message', async (event: MessageEvent<RouteWorkerRequest>) => {
  const data = event.data;
  if (!data || data.type !== 'COMPUTE_ROUTE') return;

  const { id, origin, destination } = data;

  try {
    const result = await computeMaritimeRoute(origin, destination);
    const response: RouteWorkerSuccessResponse = {
      type: 'ROUTE_SUCCESS',
      id,
      result,
    };
    self.postMessage(response);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const response: RouteWorkerErrorResponse = {
      type: 'ROUTE_ERROR',
      id,
      error: errorMsg,
    };
    self.postMessage(response);
  }
});
