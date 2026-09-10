import { useState, useRef, useEffect, type FC } from 'react';
import type { PortRecord } from '../../types/port';
import type { MaritimeRouteResult } from '../../services/maritimeRoutingService';
import type { IceHazardAnalysisReport, IcebergHazardItem } from '../../types/iceHazard';
import { searchPorts } from '../../services/portService';
import { kmToNauticalMiles, formatTransitDuration } from '../../utils/geo';

interface RouteSummaryPanelProps {
  /** Complete loaded ports dataset for search autocompletion */
  ports: PortRecord[];
  /** Currently designated departure port */
  departurePort: PortRecord | null;
  /** Currently designated destination port */
  destinationPort: PortRecord | null;
  /** Active calculated route result */
  routeResult: MaritimeRouteResult | null;
  /** Whether route computation is currently running */
  isCalculating: boolean;
  /** Real-time spatial iceberg hazard report */
  hazardReport?: IceHazardAnalysisReport | null;
  /** Whether hazard spatial analysis is running */
  isAnalyzingHazards?: boolean;
  /** Action when user picks departure from search */
  onSelectDeparture: (port: PortRecord) => void;
  /** Action when user picks destination from search */
  onSelectDestination: (port: PortRecord) => void;
  /** Swap departure and destination */
  onSwapPorts: () => void;
  /** Clear departure */
  onClearDeparture: () => void;
  /** Clear destination */
  onClearDestination: () => void;
  /** Clear entire mission route */
  onClearRoute: () => void;
  /** Center camera on departure port */
  onFocusDeparture: () => void;
  /** Center camera on destination port */
  onFocusDestination: () => void;
  /** Fit camera around calculated route line */
  onFocusRoute: () => void;
  /** Center camera on an identified iceberg hazard */
  onFocusHazard?: (hazard: IcebergHazardItem) => void;
  /** Switch to 2D tactical navigation view */
  onOpenTacticalView?: () => void;
}

/**
 * RouteSummaryPanel
 * -----------------
 * Bottom-left mission orchestration HUD providing:
 * - Search and designation for departure & destination ports.
 * - Route status, distance in nautical miles (NM), and estimated transit duration.
 * - Dynamic list of spatially detected iceberg hazards with one-click camera focus.
 */
export const RouteSummaryPanel: FC<RouteSummaryPanelProps> = ({
  ports,
  departurePort,
  destinationPort,
  routeResult,
  isCalculating,
  hazardReport,
  isAnalyzingHazards = false,
  onSelectDeparture,
  onSelectDestination,
  onSwapPorts,
  onClearDeparture,
  onClearDestination,
  onClearRoute,
  onFocusDeparture,
  onFocusDestination,
  onFocusRoute,
  onFocusHazard,
  onOpenTacticalView,
}) => {
  const [showHazardList, setShowHazardList] = useState<boolean>(false);
  const [depQuery, setDepQuery] = useState<string>('');
  const [destQuery, setDestQuery] = useState<string>('');
  const [isSearchingDep, setIsSearchingDep] = useState<boolean>(false);
  const [isSearchingDest, setIsSearchingDest] = useState<boolean>(false);

  const depResults = depQuery.trim() ? searchPorts(ports, depQuery, 6) : [];
  const destResults = destQuery.trim() ? searchPorts(ports, destQuery, 6) : [];

  const depContainerRef = useRef<HTMLDivElement>(null);
  const destContainerRef = useRef<HTMLDivElement>(null);

  // Dismiss autocompletion dropdowns on outside clicks
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (depContainerRef.current && !depContainerRef.current.contains(e.target as Node)) {
        setIsSearchingDep(false);
      }
      if (destContainerRef.current && !destContainerRef.current.contains(e.target as Node)) {
        setIsSearchingDest(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const isSuccess = routeResult?.status === 'SUCCESS';
  const distKm = routeResult?.distanceKm || 0;
  const distNm = kmToNauticalMiles(distKm);
  const durationHours = routeResult?.durationHours || (distKm > 0 ? distKm / 27.78 : 0);

  return (
    <div
      className="absolute bottom-6 left-6 z-20 pointer-events-auto select-none font-sans w-64 flex flex-col gap-2"
      role="region"
      aria-label="Maritime Mission"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold tracking-wider text-slate-200 uppercase font-sans">
          Maritime Mission
        </span>
        {(departurePort || destinationPort) && (
          <button
            type="button"
            onClick={onClearRoute}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
            title="Clear active route"
          >
            Clear
          </button>
        )}
      </div>

      {/* Departure Field */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between text-[11px] text-slate-400 font-sans">
          <span>Departure</span>
          {departurePort && !isSearchingDep && (
            <button
              type="button"
              onClick={() => {
                setIsSearchingDep(true);
                setDepQuery('');
              }}
              className="text-[10px] text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              Change
            </button>
          )}
        </div>

        <div ref={depContainerRef} className="relative">
          {departurePort && !isSearchingDep ? (
            <div className="flex items-center justify-between text-xs text-slate-200 py-0.5">
              <button
                type="button"
                onClick={onFocusDeparture}
                className="text-slate-200 hover:text-white font-medium truncate text-left cursor-pointer"
                title={`Center camera on ${departurePort.portName}`}
              >
                {departurePort.portName}
              </button>
              <button
                type="button"
                onClick={onClearDeparture}
                className="text-slate-500 hover:text-slate-300 text-[10px] px-1 cursor-pointer"
                title="Clear departure"
              >
                ✕
              </button>
            </div>
          ) : (
            <div>
              <input
                type="text"
                value={depQuery}
                onChange={(e) => {
                  setDepQuery(e.target.value);
                  setIsSearchingDep(true);
                }}
                onFocus={() => setIsSearchingDep(true)}
                placeholder="Search departure port..."
                className="w-full bg-transparent border-b border-polar-750 focus:border-slate-400 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none font-sans"
                autoFocus={isSearchingDep}
              />
              {isSearchingDep && depQuery.trim() && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-polar-950 border border-polar-800 rounded shadow-lg z-30 max-h-44 overflow-y-auto font-sans divide-y divide-polar-800">
                  {depResults.length === 0 ? (
                    <div className="p-2 text-[10px] text-slate-500 italic">
                      No matching ports for &quot;{depQuery}&quot;
                    </div>
                  ) : (
                    depResults.map((p) => (
                      <button
                        key={p.wpiNumber}
                        type="button"
                        onClick={() => {
                          onSelectDeparture(p);
                          setIsSearchingDep(false);
                          setDepQuery('');
                        }}
                        className="w-full text-left px-2 py-1.5 hover:bg-polar-900 transition-colors cursor-pointer flex flex-col"
                      >
                        <div className="text-xs text-slate-200 flex items-center justify-between">
                          <span className="truncate">{p.portName}</span>
                          <span className="text-[10px] text-slate-500">WPI {p.wpiNumber}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 truncate">
                          {p.countryCode || p.regionName || ''}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Destination Field */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between text-[11px] text-slate-400 font-sans">
          <span>Destination</span>
          {destinationPort && !isSearchingDest && (
            <button
              type="button"
              onClick={() => {
                setIsSearchingDest(true);
                setDestQuery('');
              }}
              className="text-[10px] text-slate-500 hover:text-slate-300 cursor-pointer"
            >
              Change
            </button>
          )}
        </div>

        <div ref={destContainerRef} className="relative">
          {destinationPort && !isSearchingDest ? (
            <div className="flex items-center justify-between text-xs text-slate-200 py-0.5">
              <button
                type="button"
                onClick={onFocusDestination}
                className="text-slate-200 hover:text-white font-medium truncate text-left cursor-pointer"
                title={`Center camera on ${destinationPort.portName}`}
              >
                {destinationPort.portName}
              </button>
              <button
                type="button"
                onClick={onClearDestination}
                className="text-slate-500 hover:text-slate-300 text-[10px] px-1 cursor-pointer"
                title="Clear destination"
              >
                ✕
              </button>
            </div>
          ) : (
            <div>
              <input
                type="text"
                value={destQuery}
                onChange={(e) => {
                  setDestQuery(e.target.value);
                  setIsSearchingDest(true);
                }}
                onFocus={() => setIsSearchingDest(true)}
                placeholder="Search destination port..."
                className="w-full bg-transparent border-b border-polar-750 focus:border-slate-400 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none font-sans"
                autoFocus={isSearchingDest}
              />
              {isSearchingDest && destQuery.trim() && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-polar-950 border border-polar-800 rounded shadow-lg z-30 max-h-44 overflow-y-auto font-sans divide-y divide-polar-800">
                  {destResults.length === 0 ? (
                    <div className="p-2 text-[10px] text-slate-500 italic">
                      No matching ports for &quot;{destQuery}&quot;
                    </div>
                  ) : (
                    destResults.map((p) => (
                      <button
                        key={p.wpiNumber}
                        type="button"
                        onClick={() => {
                          onSelectDestination(p);
                          setIsSearchingDest(false);
                          setDestQuery('');
                        }}
                        className="w-full text-left px-2 py-1.5 hover:bg-polar-900 transition-colors cursor-pointer flex flex-col"
                      >
                        <div className="text-xs text-slate-200 flex items-center justify-between">
                          <span className="truncate">{p.portName}</span>
                          <span className="text-[10px] text-slate-500">WPI {p.wpiNumber}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 truncate">
                          {p.countryCode || p.regionName || ''}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Calculated Route Status & Metrics */}
      {departurePort && destinationPort && (
        <div className="flex flex-col gap-1 text-[11px] text-slate-400 pt-0.5">
          {isCalculating ? (
            <div className="text-slate-400">Calculating route...</div>
          ) : isSuccess ? (
            <>
              <div className="text-slate-200 font-medium">
                {Math.round(distNm).toLocaleString()} NM • {formatTransitDuration(durationHours)}
              </div>

              <div className="flex items-center gap-2 text-[10px] text-slate-500">
                <button
                  type="button"
                  onClick={onFocusRoute}
                  className="hover:text-slate-300 transition-colors cursor-pointer"
                >
                  Fit Route
                </button>
                <span>•</span>
                {onOpenTacticalView && (
                  <>
                    <button
                      type="button"
                      onClick={onOpenTacticalView}
                      className="hover:text-slate-300 transition-colors cursor-pointer"
                    >
                      2D View →
                    </button>
                    <span>•</span>
                  </>
                )}
                <button
                  type="button"
                  onClick={onSwapPorts}
                  className="hover:text-slate-300 transition-colors cursor-pointer"
                >
                  Swap
                </button>
              </div>

              {/* Ice Hazard Information */}
              <div className="text-[10px] text-slate-500 mt-0.5">
                {isAnalyzingHazards ? (
                  <span>Checking ice hazards...</span>
                ) : hazardReport && hazardReport.summary.totalHazards > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => setShowHazardList(!showHazardList)}
                      className="text-left text-slate-400 hover:text-slate-200 cursor-pointer flex items-center justify-between"
                    >
                      <span>{hazardReport.summary.totalHazards} ice hazards detected</span>
                      <span>{showHazardList ? '▲' : '▼'}</span>
                    </button>
                    {showHazardList && (
                      <div className="max-h-32 overflow-y-auto divide-y divide-polar-800 text-[10px] bg-polar-950 border border-polar-800 rounded p-1">
                        {hazardReport.hazards.map((h, idx) => (
                          <div
                            key={`${h.sourceDataset}-${h.icebergId}-${idx}`}
                            className="py-0.5 flex items-center justify-between"
                          >
                            <button
                              type="button"
                              onClick={() => onFocusHazard?.(h)}
                              className="text-slate-300 hover:text-white truncate cursor-pointer text-left"
                            >
                              {h.icebergId}
                            </button>
                            <span className="text-slate-500 shrink-0 ml-1">
                              {h.relationship === 'INTERSECTING'
                                ? 'Intersecting'
                                : `${h.minDistanceNm.toFixed(1)} NM`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <span>No iceberg hazards detected</span>
                )}
              </div>
            </>
          ) : (
            <div className="text-slate-500">
              {routeResult?.failingReason || 'No feasible water route'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
