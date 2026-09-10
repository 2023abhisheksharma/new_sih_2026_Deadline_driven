import type { FC } from 'react';
import type { PortRecord } from '../../types/port';

interface PortAnnotationProps {
  /** Selected port data */
  port: PortRecord;
  /** 2D screen coordinate [x, y] */
  screenPosition: { x: number; y: number } | null;
  /** Whether port is currently set as departure */
  isDeparture?: boolean;
  /** Handler to designate port as mission departure */
  onSetDeparture?: () => void;
  /** Handler to clear port from mission departure */
  onClearDeparture?: () => void;
  /** Whether port is currently set as destination */
  isDestination?: boolean;
  /** Handler to designate port as mission destination */
  onSetDestination?: () => void;
  /** Handler to clear port from mission destination */
  onClearDestination?: () => void;
  /** Dismiss annotation */
  onClose?: () => void;
}

/**
 * PortAnnotation
 * --------------
 * Interactive HUD card anchored to a selected port on the 3D Cesium globe.
 * Displays port identity, country/region, coordinates, and inline actions
 * to set or clear the port as departure or destination.
 */
export const PortAnnotation: FC<PortAnnotationProps> = ({
  port,
  screenPosition,
  isDeparture = false,
  onSetDeparture,
  onClearDeparture,
  isDestination = false,
  onSetDestination,
  onClearDestination,
  onClose,
}) => {
  if (!screenPosition) return null;

  const { portName, countryCode, regionName, latitude, longitude } = port;

  const latStr = `${Math.abs(latitude).toFixed(4)}° ${latitude < 0 ? 'S' : 'N'}`;
  const lonStr = `${Math.abs(longitude).toFixed(4)}° ${longitude < 0 ? 'W' : 'E'}`;

  const countryOrRegion = countryCode || (regionName ? regionName.split('--')[0].trim() : '');

  // Compact annotation dimensions
  const annotationWidth = 205;
  const padding = 12;
  const offset = 12;

  // Intelligently place annotation to the right or left of the port marker
  const showOnLeft = screenPosition.x + offset + annotationWidth > window.innerWidth - padding;
  const left = showOnLeft
    ? screenPosition.x - offset - annotationWidth
    : screenPosition.x + offset;

  // Vertical placement clamped to viewport
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
      aria-label="Port Annotation"
    >
      {/* Quiet map annotation plate */}
      <div className="bg-polar-950/90 px-2.5 py-1.5 rounded border border-polar-800 text-slate-200 shadow-sm pointer-events-auto">
        <div className="flex items-start justify-between gap-1">
          <div className="text-[11.5px] font-medium text-slate-100 leading-tight truncate font-sans">
            {portName}
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
        <div className="text-[9.5px] text-slate-400 mt-0.5 leading-tight flex items-center justify-between font-sans">
          <span className="truncate max-w-[75px] uppercase tracking-wider">{countryOrRegion}</span>
          <span className="text-slate-400 text-[9.5px] font-sans">{latStr} {lonStr}</span>
        </div>

        {/* Inline assignment actions */}
        <div className="mt-1.5 pt-1 border-t border-polar-800/80 flex items-center justify-between text-[9.5px]">
          {isDeparture ? (
            <button
              type="button"
              onClick={onClearDeparture}
              className="text-emerald-400 hover:text-emerald-300 font-medium tracking-wide flex items-center gap-1 cursor-pointer py-0.5"
              title="Click to remove as departure"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Departure ✕
            </button>
          ) : (
            <button
              type="button"
              onClick={onSetDeparture}
              className="text-slate-400 hover:text-emerald-300 transition-colors cursor-pointer py-0.5 font-medium tracking-wide"
            >
              Set Departure
            </button>
          )}

          <span className="text-polar-700 select-none">|</span>

          {isDestination ? (
            <button
              type="button"
              onClick={onClearDestination}
              className="text-rose-400 hover:text-rose-300 font-medium tracking-wide flex items-center gap-1 cursor-pointer py-0.5"
              title="Click to remove as destination"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              Destination ✕
            </button>
          ) : (
            <button
              type="button"
              onClick={onSetDestination}
              className="text-slate-400 hover:text-rose-300 transition-colors cursor-pointer py-0.5 font-medium tracking-wide"
            >
              Set Destination
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
