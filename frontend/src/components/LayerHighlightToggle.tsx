import type { FC } from 'react';
import type { LayerFilterMode } from '../types/navigation';

interface LayerHighlightToggleProps {
  activeMode: LayerFilterMode;
  onSelectMode: (mode: LayerFilterMode) => void;
  portsCount?: number;
  driftingCount?: number;
  groundedCount?: number;
  className?: string;
}

export const LayerHighlightToggle: FC<LayerHighlightToggleProps> = ({
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
          title="Isolate & highlight all ports (hides icebergs)"
        >
          <span>Ports</span>
          <span className="text-[10px] text-slate-500">
            {portsCount > 0 ? (portsCount >= 1000 ? `${(portsCount / 1000).toFixed(1)}k` : portsCount) : '3.8k'}
          </span>
        </button>

        {/* Moving Ice */}
        <button
          type="button"
          onClick={() => handleToggle('MOVING')}
          className={`cursor-pointer transition-colors text-[11px] flex items-center gap-1 ${
            activeMode === 'MOVING'
              ? 'text-amber-300 font-medium underline underline-offset-4 decoration-amber-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Isolate & highlight moving icebergs (hides ports and fixed ice)"
        >
          <span>Moving Ice</span>
          <span className="text-[10px] text-slate-500">{driftingCount}</span>
        </button>

        {/* Fixed Ice */}
        <button
          type="button"
          onClick={() => handleToggle('FIXED')}
          className={`cursor-pointer transition-colors text-[11px] flex items-center gap-1 ${
            activeMode === 'FIXED'
              ? 'text-rose-300 font-medium underline underline-offset-4 decoration-rose-400'
              : 'text-slate-400 hover:text-slate-200'
          }`}
          title="Isolate & highlight fixed icebergs (hides ports and moving ice)"
        >
          <span>Fixed Ice</span>
          <span className="text-[10px] text-slate-500">
            {(groundedCount / 1000).toFixed(1)}k
          </span>
        </button>
      </div>
    </div>
  );
};
