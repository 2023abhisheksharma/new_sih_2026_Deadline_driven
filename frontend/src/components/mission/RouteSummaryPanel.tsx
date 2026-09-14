import { useState, useRef, useEffect, useMemo, useCallback, memo, type FC } from 'react';
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
export const RouteSummaryPanel: FC<RouteSummaryPanelProps> = memo(({
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
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [showWaypoints, setShowWaypoints] = useState<boolean>(false);
  const [copiedECDIS, setCopiedECDIS] = useState<boolean>(false);
  const [depQuery, setDepQuery] = useState<string>('');
  const [destQuery, setDestQuery] = useState<string>('');
  const [isSearchingDep, setIsSearchingDep] = useState<boolean>(false);
  const [isSearchingDest, setIsSearchingDest] = useState<boolean>(false);

  const isSuccess = routeResult?.status === 'SUCCESS';
  const isRejected = routeResult?.status === 'REJECTED_LAND_INTERSECTION';
  const distKm = routeResult?.distanceKm || 0;
  const distNm = kmToNauticalMiles(distKm);
  const durationHours = routeResult?.durationHours || (distKm > 0 ? distKm / 27.78 : 0);

  const handleExportECDIS = useCallback(() => {
    if (!routeResult?.navigationalWaypoints) return;
    const lines = [
      '# ECDIS PASSAGE PLAN VOYAGE EXPORT',
      `# Departure: ${departurePort?.portName ?? 'N/A'} (WPI ${departurePort?.wpiNumber ?? 'N/A'})`,
      `# Destination: ${destinationPort?.portName ?? 'N/A'} (WPI ${destinationPort?.wpiNumber ?? 'N/A'})`,
      `# Total Distance: ${Math.round(distNm)} NM (${Math.round(distKm)} km)`,
      `# Generated: ${new Date().toISOString()}`,
      'WP_NAME,LATITUDE,LONGITUDE,TRUE_BEARING_DEG,LEG_DIST_NM,TURN_DEG,TURN_DIR,CUMUL_DIST_NM,ZONE',
      ...routeResult.navigationalWaypoints.map((w) =>
        `${w.name},${w.coords[1].toFixed(5)},${w.coords[0].toFixed(5)},${w.trueBearingDeg.toFixed(1)},${w.legDistanceNm.toFixed(1)},${w.turnAngleDeg.toFixed(1)},${w.turnDirection},${w.cumulativeNm.toFixed(1)},${w.zone}`
      ),
    ];
    navigator.clipboard.writeText(lines.join('\n'));
    setCopiedECDIS(true);
    setTimeout(() => setCopiedECDIS(false), 2000);
  }, [routeResult, departurePort, destinationPort, distNm, distKm]);

  const depResults = useMemo(
    () => (depQuery.trim() ? searchPorts(ports, depQuery, 6) : []),
    [ports, depQuery]
  );
  const destResults = useMemo(
    () => (destQuery.trim() ? searchPorts(ports, destQuery, 6) : []),
    [ports, destQuery]
  );

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

  return (
    <div
      className={`absolute bottom-6 left-6 z-20 pointer-events-auto select-none font-sans ${showWaypoints ? 'w-80 sm:w-96' : 'w-72 sm:w-80'} transition-all duration-150 flex flex-col gap-2`}
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
        <div className="flex flex-col gap-1.5 text-[11px] text-slate-400 pt-1 border-t border-polar-800">
          {isCalculating ? (
            <div className="text-slate-400 flex items-center gap-1.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
              <span>Calculating maritime route...</span>
            </div>
          ) : isSuccess && routeResult ? (
            <>
              {/* Route Operational Header & Mode Badge */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  <span>VALIDATED ROUTE</span>
                </div>
                <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-polar-900 border border-polar-800 text-slate-300 font-sans">
                  {routeResult.topology === 'CASE_1_POLAR_POLAR'
                    ? 'Polar Graph'
                    : routeResult.topology === 'CASE_2_GLOBAL_GLOBAL'
                    ? 'Global MARNET'
                    : 'Hybrid Gateway'}
                </span>
              </div>

              {/* Distance & Duration (Explicitly Assumed 15 kn) */}
              <div className="text-slate-100 font-semibold text-xs tracking-wide">
                {Math.round(distNm).toLocaleString()} NM ({Math.round(distKm).toLocaleString()} km)
              </div>
              <div className="text-[10px] text-slate-400">
                Estimated duration at assumed 15 kn: ~{formatTransitDuration(durationHours)}
              </div>

              {/* Waypoints & Quality Assessment */}
              <div className="text-[10px] text-slate-400 flex items-center justify-between pt-0.5">
                <span>Waypoints: {routeResult.finalNodeCount}</span>
                {routeResult.routeQualityScore && (
                  <span className="font-mono text-sky-300 text-[9.5px]">
                    Q(R) = {routeResult.routeQualityScore.compositeScore.toFixed(4)}
                  </span>
                )}
              </div>

              {routeResult.routeQualityMetrics && (
                <div className="text-[9.5px] text-slate-500 flex items-center justify-between">
                  <span>Tortuosity: {routeResult.routeQualityMetrics.tortuosityRatio.toFixed(2)}x</span>
                  <span>Mean Turn: {routeResult.routeQualityMetrics.meanCourseAlterationDeg.toFixed(1)}°</span>
                </div>
              )}

              {/* Terminal Harbor Approach */}
              {routeResult.terminalApproachStatus && (
                <div className="text-[10px] text-slate-400 flex items-center justify-between">
                  <span className="text-slate-500">Terminal Approach:</span>
                  <span className="text-slate-300">
                    {routeResult.terminalApproachStatus === 'DIRECT_SAFE'
                      ? 'Direct Safe'
                      : routeResult.terminalApproachStatus === 'RADIAL_SCAN_SUCCESS'
                      ? 'Radial Clearance (1.5 km @ 330°)'
                      : 'Unavailable'}
                  </span>
                </div>
              )}

              {/* Transition Gateway */}
              {routeResult.selectedGatewayId && (
                <div className="text-[10px] text-slate-400 flex items-center justify-between">
                  <span className="text-slate-500">Transition Gateway:</span>
                  <span className="font-mono text-sky-300 text-[9.5px]">
                    {routeResult.selectedGatewayId}
                  </span>
                </div>
              )}

              {/* Hard Land Gate Status */}
              <div className="text-[10px] text-emerald-400/90 flex items-center gap-1.5 pt-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                <span>100% Water-Constrained • 0 Land Crossings</span>
              </div>

              {/* PC4 Polar Voyage & Fuel Profile */}
              {routeResult.voyageProfile && (
                <div className="bg-polar-950/90 p-2 rounded border border-polar-800 flex flex-col gap-1 text-[10px]">
                  <div className="flex items-center justify-between text-slate-300 font-medium">
                    <span className="flex items-center gap-1 text-sky-400">
                      <span>❄</span> PC4 Polar Profile
                    </span>
                    <span className="text-[9px] text-slate-400">
                      Ice: {routeResult.voyageProfile.totalDistanceNm > 0
                        ? ((routeResult.voyageProfile.polarZoneDistanceNm / routeResult.voyageProfile.totalDistanceNm) * 100).toFixed(1)
                        : '0.0'}%
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9.5px] text-slate-400 pt-0.5">
                    <div>
                      <span className="text-slate-500">Pack Ice: </span>
                      <span className="text-slate-200">{Math.round(routeResult.voyageProfile.polarZoneDistanceNm)} NM</span>
                    </div>
                    <div>
                      <span className="text-slate-500">Open Water: </span>
                      <span className="text-slate-200">{Math.round(routeResult.voyageProfile.openWaterDistanceNm)} NM</span>
                    </div>
                    <div>
                      <span className="text-slate-500">Ice-Adjusted: </span>
                      <span className="text-slate-200">~{formatTransitDuration(routeResult.voyageProfile.iceAdjustedDurationHours)}</span>
                    </div>
                    <div>
                      <span className="text-slate-500">Fuel (MDO): </span>
                      <span className="text-emerald-400 font-mono">~{routeResult.voyageProfile.estimatedFuelMdoTons.toFixed(1)} MT</span>
                    </div>
                  </div>
                  <div className="text-[9px] text-slate-500 pt-0.5 flex items-center justify-between border-t border-polar-900">
                    <span>Min Clearance: {routeResult.voyageProfile.minCoastalClearanceKm.toFixed(1)} km</span>
                    <span>Speeds: 15 / 8.5 kn</span>
                  </div>
                </div>
              )}

              {/* Bridge Navigation Waypoints Table & ECDIS Export */}
              {routeResult.navigationalWaypoints && routeResult.navigationalWaypoints.length > 0 && (
                <div className="flex flex-col gap-1 pt-0.5">
                  <div className="flex items-center justify-between text-[10px]">
                    <button
                      type="button"
                      onClick={() => setShowWaypoints(!showWaypoints)}
                      className="text-sky-400 hover:text-sky-300 transition-colors cursor-pointer flex items-center gap-1 font-medium"
                    >
                      <span>Waypoints ({routeResult.navigationalWaypoints.length})</span>
                      <span>{showWaypoints ? '▲' : '▼'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportECDIS}
                      className="text-[9.5px] text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded bg-polar-900 border border-polar-800 transition-colors cursor-pointer"
                      title="Copy standard ECDIS CSV voyage plan to clipboard"
                    >
                      {copiedECDIS ? '✓ Copied ECDIS' : 'Export ECDIS'}
                    </button>
                  </div>

                  {showWaypoints && (
                    <div className="max-h-44 overflow-y-auto bg-polar-950 border border-polar-800 rounded p-1 text-[9px] font-mono select-text">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="text-slate-500 border-b border-polar-800 text-[8.5px]">
                            <th className="py-0.5 px-1">WP</th>
                            <th className="py-0.5 px-1">BRG</th>
                            <th className="py-0.5 px-1">LEG</th>
                            <th className="py-0.5 px-1">TURN</th>
                            <th className="py-0.5 px-1 text-right">NM</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-polar-900 text-slate-300">
                          {routeResult.navigationalWaypoints.map((wp) => (
                            <tr key={wp.wpIndex} className="hover:bg-polar-900/50">
                              <td className="py-0.5 px-1 font-medium truncate max-w-[75px]" title={wp.name}>
                                {wp.zone === 'POLAR' ? '❄ ' : ''}{wp.name}
                              </td>
                              <td className="py-0.5 px-1 text-slate-400">
                                {Math.round(wp.trueBearingDeg)}°T
                              </td>
                              <td className="py-0.5 px-1 text-slate-400">
                                {wp.legDistanceNm > 0 ? wp.legDistanceNm.toFixed(1) : '-'}
                              </td>
                              <td className="py-0.5 px-1">
                                {wp.turnDirection === 'STRAIGHT' ? (
                                  <span className="text-slate-600">-</span>
                                ) : (
                                  <span className={wp.turnDirection === 'PORT' ? 'text-rose-400' : 'text-emerald-400'}>
                                    {Math.round(wp.turnAngleDeg)}°{wp.turnDirection === 'PORT' ? 'P' : 'S'}
                                  </span>
                                )}
                              </td>
                              <td className="py-0.5 px-1 text-right text-slate-200">
                                {wp.cumulativeNm.toFixed(1)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex items-center gap-2 text-[10px] text-slate-500 pt-0.5">
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
                <span>•</span>
                <button
                  type="button"
                  onClick={() => setShowDiagnostics(!showDiagnostics)}
                  className="hover:text-slate-300 transition-colors cursor-pointer ml-auto"
                >
                  {showDiagnostics ? 'Diagnostics ▲' : 'Diagnostics ▼'}
                </button>
              </div>

              {/* Collapsible Developer Diagnostics */}
              {showDiagnostics && (
                <div className="text-[9px] bg-polar-950 p-2 rounded border border-polar-800 text-slate-400 font-mono flex flex-col gap-1 max-h-28 overflow-y-auto">
                  <div>Candidates: {routeResult.candidateCountAttempted}</div>
                  <div>Nodes: {routeResult.rawNodeCount} → {routeResult.finalNodeCount}</div>
                  <div>Dataset: {routeResult.provenance.dataset}</div>
                  <div>Method: {routeResult.provenance.method}</div>
                </div>
              )}

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
                      <span>{hazardReport.summary.totalHazards} ice hazards detected (25 NM)</span>
                      <span>{showHazardList ? '▲' : '▼'}</span>
                    </button>
                    {showHazardList && (
                      <div className="max-h-28 overflow-y-auto divide-y divide-polar-800 text-[10px] bg-polar-950 border border-polar-800 rounded p-1">
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
                  <span>No iceberg hazards detected along corridor</span>
                )}
              </div>
            </>
          ) : isRejected && routeResult ? (
            /* State 2: Route Constructed but Rejected by Hard Land Gate */
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-amber-400">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                <span>ROUTE CONSTRUCTED BUT REJECTED</span>
              </div>

              <div className="text-[10.5px] text-slate-200 font-medium">
                {routeResult.failureCategory || 'Land/ice validation failure'}
              </div>

              <div className="text-[10px] text-slate-400 leading-relaxed">
                {routeResult.failureCategory === 'Internal MARNET topology failure'
                  ? 'An internal Eurostat MARNET mesh edge cuts across a land polygon near the coastline. Route cannot be safely navigated.'
                  : routeResult.failureCategory === 'Terminal harbor approach failure'
                  ? 'Berth resides behind headlands/ria where water-safe connection to the offshore mesh exceeds 5 km without crossing land.'
                  : routeResult.failingReason || 'Constructed path intersects land boundaries beyond the 1.5 km dock tolerance.'}
              </div>

              <div className="bg-polar-900/60 p-1.5 rounded border border-polar-800 text-[9.5px] grid grid-cols-2 gap-1 text-slate-400 font-mono">
                <div>
                  <span className="text-slate-500">Constructed: </span>
                  <span className="text-slate-200">
                    {Math.round(routeResult.constructedDistanceKm || 0).toLocaleString()} km
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Validated: </span>
                  <span className="text-slate-200">0 NM (0.0 km)</span>
                </div>
                <div className="col-span-2 text-rose-400">
                  Validation: FAILED (Unsafe for navigation)
                </div>
              </div>

              <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5">
                <button
                  type="button"
                  onClick={onSwapPorts}
                  className="hover:text-slate-300 transition-colors cursor-pointer"
                >
                  Swap Direction
                </button>
                <button
                  type="button"
                  onClick={() => setShowDiagnostics(!showDiagnostics)}
                  className="hover:text-slate-300 transition-colors cursor-pointer"
                >
                  {showDiagnostics ? 'Diagnostics ▲' : 'Diagnostics ▼'}
                </button>
              </div>

              {showDiagnostics && (
                <div className="text-[9px] bg-polar-950 p-2 rounded border border-polar-800 text-slate-400 font-mono flex flex-col gap-1 max-h-28 overflow-y-auto">
                  <div>Reason: {routeResult.failingReason || 'N/A'}</div>
                  {routeResult.validationReport?.failingSegments?.[0] && (
                    <div>
                      First Crossing: Segment #{routeResult.validationReport.failingSegments[0].segmentIndex} (
                      {routeResult.validationReport.failingSegments[0].lengthKm.toFixed(1)} km)
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            /* State 3: Route Completely Unavailable */
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500 shrink-0" />
                <span>ROUTE UNAVAILABLE</span>
              </div>

              <div className="text-[10px] text-slate-400 leading-relaxed">
                {routeResult?.failureCategory === 'Patagonian isolated fjord'
                  ? 'Port belongs to a retained isolated Patagonian waterway; no continuous water route exists to the primary navigation network without synthetic edges.'
                  : routeResult?.failingReason || 'No navigable water route exists between these ports.'}
              </div>

              <div className="bg-polar-900/60 p-1.5 rounded border border-polar-800 text-[9.5px] grid grid-cols-2 gap-1 text-slate-400 font-mono">
                <div>
                  <span className="text-slate-500">Constructed: </span>
                  <span className="text-slate-300">0.0 km</span>
                </div>
                <div>
                  <span className="text-slate-500">Validated: </span>
                  <span className="text-slate-300">0 NM</span>
                </div>
              </div>

              <div className="pt-0.5">
                <button
                  type="button"
                  onClick={onSwapPorts}
                  className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors cursor-pointer"
                >
                  Swap Direction
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

RouteSummaryPanel.displayName = 'RouteSummaryPanel';
