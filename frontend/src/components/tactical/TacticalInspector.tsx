import type { FC } from 'react';
import type {
  IcebergRecord,
  Sentinel1GroundedIcebergRecord,
  DriftingIcebergTrajectoryRecord,
  PortRecord,
  RouteSimulationPoint,
} from '../../types';

export type SelectedEntity =
  | { type: 'USNIC'; data: IcebergRecord; distanceKm: number }
  | { type: 'SENTINEL_1'; data: Sentinel1GroundedIcebergRecord; distanceKm: number }
  | { type: 'BYU_NIC'; data: DriftingIcebergTrajectoryRecord; distanceKm: number }
  | { type: 'PORT'; data: PortRecord; distanceKm: number }
  | { type: 'VESSEL' }
  | null;

export interface TacticalInspectorProps {
  /** The currently selected target entity, or null if none */
  selectedEntity: SelectedEntity;
  /** Callback invoked when the user dismisses the inspector panel */
  onClose: () => void;
  /** Live simulated vessel telemetry */
  vesselPoint: RouteSimulationPoint;
}

/**
 * TacticalInspector
 *
 * Right-hand floating inspection drawer rendering telemetry, geographic coordinates,
 * range-to-vessel, and scientific data provenance for any selected tactical entity:
 * - Vessel (Heading, simulated cruise speed, route progress, distance traveled/remaining)
 * - USNIC Macro Iceberg (Antarctic database ID, dimensions, distance, observation timestamp)
 * - Sentinel-1 SAR Grounded Iceberg (Fast-ice status, bathymetric bed depth, distance)
 * - BYU/NIC Drifting Iceberg Track (Historical observation count, latest position, trajectory)
 * - NGA World Port Index (WPI number, harbor sizing, icebreaking support capabilities)
 */
export const TacticalInspector: FC<TacticalInspectorProps> = ({
  selectedEntity,
  onClose,
  vesselPoint,
}) => {
  if (!selectedEntity) return null;

  return (
    <div className="absolute top-20 right-4 z-20 w-72 bg-polar-950/90 p-2.5 rounded border border-polar-800 shadow-sm pointer-events-auto flex flex-col gap-2 font-sans text-xs">
      <div className="flex items-center justify-between border-b border-polar-800 pb-1">
        <span className="font-semibold text-slate-200 uppercase tracking-wider text-[10px] font-sans">
          {selectedEntity.type === 'VESSEL'
            ? 'Vessel Status'
            : selectedEntity.type === 'PORT'
            ? `Port: ${selectedEntity.data.portName}`
            : `Iceberg ${selectedEntity.data.id}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-500 hover:text-slate-300 cursor-pointer text-xs leading-none"
          title="Close details"
        >
          ✕
        </button>
      </div>

      {selectedEntity.type === 'VESSEL' ? (
        <div className="flex flex-col gap-1.5 text-[11px] font-sans text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-400">Position:</span>
            <span>
              {Math.abs(vesselPoint.coordinate[1]).toFixed(4)}°S,{' '}
              {Math.abs(vesselPoint.coordinate[0]).toFixed(4)}°W
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Heading:</span>
            <span className="text-slate-200 font-medium">{vesselPoint.headingDegrees.toFixed(1)}° True</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Cruise Speed:</span>
            <span className="text-slate-200 font-medium">15.0 kts (Simulated)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Progress:</span>
            <span>{vesselPoint.progressPercent.toFixed(1)}%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Traveled:</span>
            <span>{(vesselPoint.distanceTraveledMeters / 1852.0).toFixed(1)} NM</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Remaining:</span>
            <span>{(vesselPoint.distanceRemainingMeters / 1852.0).toFixed(1)} NM</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Segment:</span>
            <span>{vesselPoint.segmentIndex} → {vesselPoint.segmentIndex + 1}</span>
          </div>
        </div>
      ) : selectedEntity.type === 'USNIC' ? (
        <div className="flex flex-col gap-1.5 text-[11px] font-sans text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-400">Source:</span>
            <span className="text-slate-200 font-medium">USNIC Macro Iceberg</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Distance to Ship:</span>
            <span className="text-slate-200 font-medium">
              {(selectedEntity.distanceKm / 1.852).toFixed(1)} NM ({selectedEntity.distanceKm.toFixed(1)} km)
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Centroid:</span>
            <span>
              {Math.abs(selectedEntity.data.latitude).toFixed(3)}°S,{' '}
              {Math.abs(selectedEntity.data.longitude).toFixed(3)}°W
            </span>
          </div>
          {(selectedEntity.data.lengthNm || selectedEntity.data.widthNm) && (
            <div className="flex justify-between">
              <span className="text-slate-400">Dimensions:</span>
              <span>{selectedEntity.data.lengthNm ?? '—'} × {selectedEntity.data.widthNm ?? '—'} NM</span>
            </div>
          )}
          {selectedEntity.data.lastUpdate && (
            <div className="flex justify-between">
              <span className="text-slate-400">Last Update:</span>
              <span>{selectedEntity.data.lastUpdate}</span>
            </div>
          )}
        </div>
      ) : selectedEntity.type === 'SENTINEL_1' ? (
        <div className="flex flex-col gap-1.5 text-[11px] font-sans text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-400">Source:</span>
            <span className="text-slate-200 font-medium">Sentinel-1 SAR Grounded</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Distance to Ship:</span>
            <span className="text-slate-200 font-medium">
              {(selectedEntity.distanceKm / 1.852).toFixed(1)} NM ({selectedEntity.distanceKm.toFixed(1)} km)
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Coordinates:</span>
            <span>
              {Math.abs(selectedEntity.data.latitude).toFixed(4)}°S,{' '}
              {Math.abs(selectedEntity.data.longitude).toFixed(4)}°W
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Fast-Ice Overlap:</span>
            <span className="text-slate-200 font-medium">{selectedEntity.data.fastIceStatus}</span>
          </div>
          {selectedEntity.data.bedDepthM && (
            <div className="flex justify-between">
              <span className="text-slate-400">Bed Depth:</span>
              <span>{selectedEntity.data.bedDepthM} m</span>
            </div>
          )}
        </div>
      ) : selectedEntity.type === 'PORT' ? (
        <div className="flex flex-col gap-1.5 text-[11px] font-sans text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-400">Source:</span>
            <span className="text-slate-200 font-medium">NGA World Port Index (Pub 150)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">WPI Number:</span>
            <span>{selectedEntity.data.wpiNumber}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Coordinates:</span>
            <span>
              {Math.abs(selectedEntity.data.latitude).toFixed(3)}°S, {Math.abs(selectedEntity.data.longitude).toFixed(3)}°W
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Distance to Ship:</span>
            <span className="text-slate-200 font-medium">
              {(selectedEntity.distanceKm / 1.852).toFixed(1)} NM ({selectedEntity.distanceKm.toFixed(1)} km)
            </span>
          </div>
          {selectedEntity.data.harborSize && (
            <div className="flex justify-between">
              <span className="text-slate-400">Harbor Size:</span>
              <span>{selectedEntity.data.harborSize}</span>
            </div>
          )}
          {selectedEntity.data.servicesIceBreaking && (
            <div className="flex justify-between">
              <span className="text-slate-400">Ice Breaking:</span>
              <span className="text-slate-200">{selectedEntity.data.servicesIceBreaking}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 text-[11px] font-sans text-slate-300">
          <div className="flex justify-between">
            <span className="text-slate-400">Source:</span>
            <span className="text-slate-200 font-medium">BYU/NIC Drifting Track</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Distance to Ship:</span>
            <span className="text-slate-200 font-medium">
              {(selectedEntity.distanceKm / 1.852).toFixed(1)} NM ({selectedEntity.distanceKm.toFixed(1)} km)
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Latest Obs:</span>
            <span>
              {Math.abs(selectedEntity.data.latestPos!.lat).toFixed(3)}°S,{' '}
              {Math.abs(selectedEntity.data.latestPos!.lon).toFixed(3)}°W
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Obs Date:</span>
            <span>{selectedEntity.data.end}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Trajectory:</span>
            <span>{selectedEntity.data.coords.length} historical records</span>
          </div>
          <div className="text-[10px] text-slate-400 mt-1 italic font-sans border-t border-polar-800 pt-1">
            Displaying genuine historical trajectory track for {selectedEntity.data.id}.
          </div>
        </div>
      )}
    </div>
  );
};
