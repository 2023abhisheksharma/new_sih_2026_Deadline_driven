import type { FC } from 'react';

export const Header: FC = () => {
  return (
    <header className="absolute top-5 left-6 z-20 pointer-events-none select-none">
      <h1 className="text-xs font-semibold tracking-wider text-slate-200 uppercase font-sans">
        Antarctic Navigation DSS
      </h1>
      <p className="text-[11px] text-slate-400 font-sans tracking-wide">
        Geospatial Operating Environment
      </p>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-slate-500 font-sans">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
          USNIC: 33 Macro Icebergs
        </span>
        <span>•</span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
          Sentinel-1: 39,619 Grounded (2025)
        </span>
        <span>•</span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          BYU/NIC: 624 Drifting Tracks
        </span>
      </div>
    </header>
  );
};
