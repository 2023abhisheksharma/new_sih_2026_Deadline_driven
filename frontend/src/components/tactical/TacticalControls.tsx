import type { FC } from 'react';
import type { RouteSimulationPoint } from '../../services/routeSimulationService';
import { METERS_PER_NAUTICAL_MILE } from '../../utils/geo';

export interface TacticalControlsProps {
  /** Current simulation status */
  simStatus: 'PLAYING' | 'PAUSED' | 'IDLE' | 'COMPLETED';
  /** Start / resume simulation */
  onPlay: () => void;
  /** Pause simulation */
  onPause: () => void;
  /** Reset vessel position to departure */
  onReset: () => void;
  /** Seek distance in meters */
  onSeekDistance: (distanceMeters: number) => void;
  /** Active speed multiplier */
  simSpeedMultiplier: number;
  /** Set speed multiplier */
  onSetSimSpeed: (multiplier: number) => void;
  /** Whether the camera follows the vessel */
  followVessel: boolean;
  /** Toggle camera follow vessel mode */
  onToggleFollowVessel: () => void;
  /** Current interpolated simulation metrics */
  vesselPoint: RouteSimulationPoint;
}

/**
 * TacticalControls
 * ----------------
 * Bottom mission simulation console providing playback controls,
 * speed selection (1x, 5x, 15x, 30x), interactive distance scrubber,
 * and camera vessel tracking.
 */
export const TacticalControls: FC<TacticalControlsProps> = ({
  simStatus,
  onPlay,
  onPause,
  onReset,
  onSeekDistance,
  simSpeedMultiplier,
  onSetSimSpeed,
  followVessel,
  onToggleFollowVessel,
  vesselPoint,
}) => {
  const traveledNm = (vesselPoint.distanceTraveledMeters / METERS_PER_NAUTICAL_MILE).toFixed(0);
  const totalNm = (vesselPoint.totalDistanceMeters / METERS_PER_NAUTICAL_MILE).toFixed(0);

  return (
    <div className="absolute bottom-4 left-4 right-4 z-20 pointer-events-auto">
      <div className="bg-polar-950/90 rounded border border-polar-800 shadow-sm px-3 py-2 flex flex-col md:flex-row items-center justify-between gap-3 text-xs font-sans">
        {/* Playback Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {simStatus === 'PLAYING' ? (
            <button
              type="button"
              onClick={onPause}
              className="px-2.5 py-1 rounded bg-polar-800 hover:bg-polar-750 text-slate-100 border border-slate-600 font-medium text-xs transition-colors cursor-pointer flex items-center gap-1 shadow-sm"
            >
              <span>Ⅱ</span> Pause
            </button>
          ) : (
            <button
              type="button"
              onClick={onPlay}
              className="px-2.5 py-1 rounded bg-polar-800 hover:bg-polar-750 text-slate-100 border border-slate-600 font-medium text-xs transition-colors cursor-pointer flex items-center gap-1 shadow-sm"
            >
              <span>▶</span> Run Simulation
            </button>
          )}

          <button
            type="button"
            onClick={onReset}
            className="px-2 py-1 rounded bg-polar-900/80 hover:bg-polar-850 text-slate-400 hover:text-slate-200 text-xs transition-colors cursor-pointer border border-polar-800"
          >
            ↺ Reset
          </button>

          {/* Speed Selector */}
          <div className="flex items-center gap-0.5 bg-polar-900/80 p-0.5 rounded border border-polar-800 text-[10px] font-sans">
            {[1, 5, 15, 30].map((spd) => (
              <button
                key={spd}
                type="button"
                onClick={() => onSetSimSpeed(spd)}
                className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                  simSpeedMultiplier === spd
                    ? 'bg-polar-800 text-slate-100 font-medium border border-slate-600'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {spd}x
              </button>
            ))}
          </div>

          {/* Follow Vessel Toggle */}
          <button
            type="button"
            onClick={onToggleFollowVessel}
            className={`px-2 py-1 rounded text-xs font-sans transition-colors cursor-pointer border ${
              followVessel
                ? 'bg-polar-800 text-slate-100 border-slate-600'
                : 'bg-polar-900/80 text-slate-400 border-polar-800 hover:text-slate-200'
            }`}
          >
            Follow Vessel: {followVessel ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* Route Scrubber Slider & Distance Progress */}
        <div className="flex-1 w-full flex items-center gap-2.5 font-sans text-xs text-slate-300">
          <span className="text-[11px] text-slate-400 shrink-0">
            {traveledNm} NM
          </span>
          <input
            type="range"
            min={0}
            max={vesselPoint.totalDistanceMeters || 1}
            value={vesselPoint.distanceTraveledMeters}
            onChange={(e) => onSeekDistance(parseFloat(e.target.value))}
            className="w-full h-1 bg-polar-800 rounded appearance-none cursor-pointer accent-slate-400"
            aria-label="Route Distance Scrubber"
          />
          <span className="text-[11px] text-slate-400 shrink-0">
            {totalNm} NM
          </span>
          <span className="text-slate-200 font-medium shrink-0 text-xs font-sans">
            {vesselPoint.progressPercent.toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
};
