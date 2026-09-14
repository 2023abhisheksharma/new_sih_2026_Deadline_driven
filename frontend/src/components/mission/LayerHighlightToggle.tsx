import { memo, type FC } from 'react';
import type { LayerFilterMode } from '../../types/navigation';

interface LayerHighlightToggleProps {
  /** Currently active filter mode */
  activeMode: LayerFilterMode;
  /** Callback to change filter mode */
  onSelectMode: (mode: LayerFilterMode) => void;
  /** Total loaded port count */
  portsCount?: number;
  /** Total loaded drifting track count */
  driftingCount?: number;
  /** Total loaded grounded iceberg count */
  groundedCount?: number;
  /** Optional container class names */
  className?: string;
}

/**
 * LayerHighlightToggle
 * --------------------
 * Top-right interactive HUD toolbar enabling instantaneous isolation and visual
 * highlighting of specific operational target layers (All, Ports, Moving Ice, Fixed Ice).
 */
export const LayerHighlightToggle: FC<LayerHighlightToggleProps> = memo(({
  activeMode,
  onSelectMode,
  portsCount = 3807,
  driftingCount = 624,
  groundedCount = 39619,
  className = '',
}) => {
  const handleToggle = (mode: LayerFilterMode) => {
    if (activeMode === mode) {
      onSelectMode('ALL');
    } else {
      onSelectMode(mode);
    }
  };

  return (
    <div
      className={`select-none font-sans text-xs flex flex-col items-end gap-1 ${className}`}
      role="toolbar"
      aria-label="Target Filter"
    >
      {/* Title */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold tracking-wider text-slate-200 uppercase font-sans">
          Targets
        </span>
        {activeMode !== 'ALL' && (
          <button
            type="button"
            onClick={() => onSelectMode('ALL')}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
            title="Reset to show all layers"
          >
            Reset
          </button>
        )}
      </div>

      {/* Floating Controls */}
      <div className="flex items-center gap-3">
        {/* All */}
        <button
          type="button"
          onClick={() => onSelectMode('ALL')}
          className={`cursor-pointer transition-colors text-[11px] ${
            activeMode === 'ALL'
              ? 'text-slate-100 font-medium underline underline-offset-4 decoration-slate-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Display all navigational layers"
        >
          All
        </button>

        {/* Ports */}
        <button
          type="button"
          onClick={() => handleToggle('PORTS')}
          className={`cursor-pointer transition-colors text-[11px] flex items-center gap-1 ${
            activeMode === 'PORTS'
              ? 'text-sky-300 font-medium underline underline-offset-4 decoration-sky-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Isolate & highlight NGA World Port Index berths (3,807 ports)"
        >
          <span>Ports</span>
          <span className="text-[10px] text-slate-500">
            {portsCount > 0
              ? portsCount >= 1000
                ? `${(portsCount / 1000).toFixed(1)}k`
                : portsCount
              : '3.8k'}
          </span>
        </button>

        {/* Drift Tracks */}
        <button
          type="button"
          onClick={() => handleToggle('MOVING')}
          className={`cursor-pointer transition-colors text-[11px] flex items-center gap-1 ${
            activeMode === 'MOVING'
              ? 'text-amber-300 font-medium underline underline-offset-4 decoration-amber-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Isolate & highlight historical drift tracks (BYU/NIC 624 archive trajectories & USNIC observed large icebergs; not real-time telemetry)"
        >
          <span>Drift Tracks</span>
          <span className="text-[10px] text-slate-500">{driftingCount}</span>
        </button>

        {/* Grounded Ice */}
        <button
          type="button"
          onClick={() => handleToggle('FIXED')}
          className={`cursor-pointer transition-colors text-[11px] flex items-center gap-1 ${
            activeMode === 'FIXED'
              ? 'text-rose-300 font-medium underline underline-offset-4 decoration-rose-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Isolate & highlight Sentinel-1 SAR radar-derived stationary/grounded icebergs (39,619 targets)"
        >
          <span>Grounded Ice</span>
          <span className="text-[10px] text-slate-500">
            {(groundedCount / 1000).toFixed(1)}k
          </span>
        </button>
      </div>
    </div>
  );
});

LayerHighlightToggle.displayName = 'LayerHighlightToggle';
