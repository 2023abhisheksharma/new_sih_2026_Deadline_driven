import type { FC } from 'react';
import type { VesselConfiguration } from '../../config/vessel';

interface VesselInfoCardProps {
  /** Configured vessel metadata */
  vessel: VesselConfiguration;
  /** 2D screen coordinate [x, y] */
  screenPosition: { x: number; y: number } | null;
  /** Action to launch 2D tactical view */
  onOpenTacticalView?: () => void;
  /** Dismiss annotation */
  onClose?: () => void;
}

/**
 * VesselInfoCard
 * --------------
 * Geographically anchored HUD telemetry plate for the research vessel.
 * Displays vessel identity, operational classification, and geographic coordinates.
 */
export const VesselInfoCard: FC<VesselInfoCardProps> = ({
  vessel,
  screenPosition,
  onOpenTacticalView,
}) => {
  if (!screenPosition) return null;

  const { name, classification, geographicLocation } = vessel;

  const latStr = `${Math.abs(geographicLocation.latitude).toFixed(4)}° ${geographicLocation.latitude < 0 ? 'S' : 'N'}`;
  const lonStr = `${Math.abs(geographicLocation.longitude).toFixed(4)}° ${geographicLocation.longitude < 0 ? 'W' : 'E'}`;

  // Annotation dimensions & viewport boundaries
  const annotationWidth = 220;
  const padding = 16;
  const offset = 14;

  // Intelligently place annotation to the right or left of the vessel icon
  const showOnLeft = screenPosition.x + offset + annotationWidth > window.innerWidth - padding;
  const left = showOnLeft
    ? screenPosition.x - offset - annotationWidth
    : screenPosition.x + offset;

  // Vertical placement centered beside the vessel icon, clamped to viewport
  const top = Math.max(
    padding,
    Math.min(window.innerHeight - 60 - padding, screenPosition.y - 18)
  );

  return (
    <div
      className="absolute z-20 pointer-events-auto select-none font-sans"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        width: `${annotationWidth}px`,
      }}
      role="region"
      aria-label="Vessel Map Annotation"
    >
      <div className="bg-polar-950/90 px-2.5 py-1.5 rounded border border-polar-800 text-slate-200 shadow-sm flex flex-col gap-1 font-sans">
        <div className="text-xs font-semibold text-slate-100 tracking-tight leading-tight">
          {name}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-slate-400 font-sans leading-none">
          {classification}
        </div>
        <div className="text-[9.5px] text-slate-400 mt-0.5 leading-tight font-sans">
          {latStr}&nbsp;&nbsp;{lonStr}
        </div>

        {onOpenTacticalView && (
          <button
            type="button"
            onClick={onOpenTacticalView}
            className="mt-1 w-full py-1 px-2 rounded bg-polar-900 hover:bg-polar-850 text-slate-300 hover:text-white border border-polar-800 text-[10px] transition-colors cursor-pointer flex items-center justify-center gap-1 font-sans"
          >
            Open 2D Tactical View →
          </button>
        )}
      </div>
    </div>
  );
};
