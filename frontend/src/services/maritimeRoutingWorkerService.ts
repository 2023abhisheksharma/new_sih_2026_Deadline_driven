/**
 * Maritime Routing Worker Service
 * -------------------------------
 * Client-side bridge managing the dedicated Web Worker lifecycle.
 * Provides request dispatching, cancellation, and fallback to direct
 * execution in non-browser (Node.js/SSR/test) environments.
 */

import { computeMaritimeRoute, type MaritimeRouteResult } from './maritimeRoutingService';
import type { PortRecord } from '../types/port';
import type { RouteWorkerRequest, RouteWorkerResponse } from '../workers/routing.worker';

let workerInstance: Worker | null = null;
let activeRequestId: string | null = null;
let activeReject: ((reason?: any) => void) | null = null;
let activeResolve: ((result: MaritimeRouteResult) => void) | null = null;

function isWorkerSupported(): boolean {
  return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function getOrCreateWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new Worker(
      new URL('../workers/routing.worker.ts', import.meta.url),
      { type: 'module' }
    );

    workerInstance.onmessage = (event: MessageEvent<RouteWorkerResponse>) => {
      const data = event.data;
      if (!data) return;

      // Drop messages from stale or canceled requests
      if (data.id !== activeRequestId) {
        return;
      }

      if (data.type === 'ROUTE_SUCCESS') {
        if (activeResolve) {
          activeResolve(data.result);
        }
      } else if (data.type === 'ROUTE_ERROR') {
        if (activeReject) {
          activeReject(new Error(data.error));
        }
      }

      activeRequestId = null;
      activeResolve = null;
      activeReject = null;
    };

    workerInstance.onerror = (err) => {
      console.error('[RoutingWorker] Worker thread error:', err);
      if (activeReject) {
        activeReject(err);
      }
      activeRequestId = null;
      activeResolve = null;
      activeReject = null;
    };
  }

  return workerInstance;
}

/**
 * Cancels any currently running route calculation by terminating the active worker
 * and spawning a clean instance, immediately freeing CPU cycles on the host.
 */
export function cancelCurrentRouting(): void {
  if (workerInstance) {
    workerInstance.terminate();
    workerInstance = null;
  }
  if (activeReject) {
    activeReject(new Error('ABORTED_BY_NEWER_REQUEST'));
  }
  activeRequestId = null;
  activeResolve = null;
  activeReject = null;
}

/**
 * Asynchronously requests route computation from the background Web Worker.
 * If a prior calculation is still running, it is terminated immediately.
 */
export async function requestMaritimeRoute(
  origin: PortRecord,
  destination: PortRecord
): Promise<MaritimeRouteResult> {
  // Fallback for Node.js / test environments where Worker is unavailable
  if (!isWorkerSupported()) {
    return computeMaritimeRoute(origin, destination);
  }

  // Cancel prior in-flight calculation
  cancelCurrentRouting();

  const worker = getOrCreateWorker();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  activeRequestId = requestId;

  return new Promise<MaritimeRouteResult>((resolve, reject) => {
    activeResolve = resolve;
    activeReject = reject;

    const request: RouteWorkerRequest = {
      type: 'COMPUTE_ROUTE',
      id: requestId,
      origin,
      destination,
    };

    worker.postMessage(request);
  });
}
