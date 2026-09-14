import { memo, type FC } from 'react';
import type { DriftingIcebergTrajectoryRecord } from '../../types/driftingIceberg';

interface DriftingIcebergAnnotationProps {
  /** Drifting iceberg trajectory record */
  iceberg: DriftingIcebergTrajectoryRecord;
  /** 2D screen coordinate [x, y] */
  screenPosition: { x: number; y: number } | null;
  /** Dismiss annotation */
  onClose?: () => void;
}

/**
 * DriftingIcebergAnnotation
 * -------------------------
 * Geographically anchored HUD card for a selected BYU / NIC drifting iceberg.
 * Displays observation dates, satellite sensors, track point count, and drift reach.
 */
export const DriftingIcebergAnnotation: FC<DriftingIcebergAnnotationProps> = memo(({
  iceberg,
  screenPosition,
  onClose,
}) => {
  if (!screenPosition) return null;

  const { id, points, end, latestPos, maxNorthLat, openOcean } = iceberg;
  const lat = latestPos.lat;
  const lon = latestPos.lon;

  const latStr = `${Math.abs(lat).toFixed(2)}° ${lat < 0 ? 'S' : 'N'}`;
  const lonStr = `${Math.abs(lon).toFixed(2)}° ${lon < 0 ? 'W' : 'E'}`;

  const annotationWidth = 220;
  const padding = 12;
  const offset = 12;

  const showOnLeft = screenPosition.x + offset + annotationWidth > window.innerWidth - padding;
  const left = showOnLeft
    ? screenPosition.x - offset - annotationWidth
    : screenPosition.x + offset;

  const top = Math.max(
    padding,
    Math.min(window.innerHeight - 80 - padding, screenPosition.y - 14)
  );

  return (
    <div
      className="absolute z-20 pointer-events-none select-none font-sans"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${annotationWidth}px`,
      }}
      role="region"
      aria-label="Drifting Iceberg Annotation"
    >
      <div className="bg-polar-950/90 px-2.5 py-1.5 rounded border border-polar-800 text-slate-200 shadow-sm pointer-events-auto">
        <div className="flex items-start justify-between gap-1">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span className="text-[11px] font-semibold text-slate-100 leading-tight font-sans">
              Iceberg {id}
            </span>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-slate-500 hover:text-slate-300 transition-colors cursor-pointer text-[10px] leading-none px-1 py-0.5 -mr-1 -mt-0.5"
              aria-label="Close"
            >
              ✕
            </button>
          )}
        </div>

        <div className="text-[9.5px] text-slate-400 mt-1 leading-tight flex items-center justify-between font-sans">
          <span>Latest: {end}</span>
          <span className="text-slate-300">{latStr} {lonStr}</span>
        </div>

        <div className="mt-1.5 pt-1 border-t border-polar-800 grid grid-cols-2 gap-x-2 text-[9.5px] text-slate-400 font-sans">
          <div>
            <span className="text-slate-500">Sensor: </span>
            <span className="text-slate-300">{latestPos.sensor}</span>
          </div>
          <div>
            <span className="text-slate-500">Tracked: </span>
            <span className="text-slate-300">{points.toLocaleString()} pts</span>
          </div>
          <div className="col-span-2 mt-0.5 flex items-center gap-1.5">
            <span className="text-slate-500">Drift Reach: </span>
            <span className="text-slate-300">{Math.abs(maxNorthLat).toFixed(2)}°S</span>
            {openOcean && (
              <span className="text-[9px] text-slate-400">
                (Southern Ocean)
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

DriftingIcebergAnnotation.displayName = 'DriftingIcebergAnnotation';
