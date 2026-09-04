import { useRef, useState, useEffect, type FC } from 'react';
import { CesiumGlobe, CesiumGlobeRef } from '../components/CesiumGlobe';
import { VesselInfoCard } from '../components/VesselInfoCard';
import { PortAnnotation } from '../components/PortAnnotation';
import { DepartureAnnotation } from '../components/DepartureAnnotation';
import { DestinationAnnotation } from '../components/DestinationAnnotation';
import { DriftingIcebergAnnotation } from '../components/DriftingIcebergAnnotation';
import { RouteSummaryPanel } from '../components/RouteSummaryPanel';
import type { VesselConfiguration } from '../config/vessel';
import { DEMO_VESSEL_CONFIG } from '../config/vessel';
import type { PortRecord } from '../types/port';
import type { IcebergRecord } from '../types/iceberg';
import type { Sentinel1GroundedIcebergRecord } from '../types/sentinel1Iceberg';
import type { DriftingIcebergTrajectoryRecord } from '../types/driftingIceberg';
import type { IceHazardAnalysisReport, IcebergHazardItem } from '../types/iceHazard';
import { loadPortDataset } from '../services/portService';
import { loadIcebergDataset } from '../services/icebergService';
import { loadSentinel1GroundedIcebergDataset } from '../services/sentinel1IcebergService';
import { loadDriftingIcebergDataset } from '../services/driftingIcebergService';
import { computeMaritimeRoute, type MaritimeRouteResult } from '../services/maritimeRoutingService';
import { analyzeRouteIcebergHazards } from '../services/iceHazardService';
import {
  buildRouteGeometryProfile,
  evaluateSimulationPoint,
  type RouteGeometryProfile,
  type RouteSimulationPoint,
} from '../services/routeSimulationService';
import { Tactical2DView } from '../components/Tactical2DView';
import { LayerHighlightToggle } from '../components/LayerHighlightToggle';
import type { LayerFilterMode } from '../types/navigation';

export const AntarcticOverview: FC = () => {
  const globeRef = useRef<CesiumGlobeRef>(null);
  const [activeView, setActiveView] = useState<'3D_GLOBE' | '2D_TACTICAL'>('3D_GLOBE');
  const [layerFilter, setLayerFilter] = useState<LayerFilterMode>('ALL');

  const [ports, setPorts] = useState<PortRecord[]>([]);
  const [icebergs, setIcebergs] = useState<IcebergRecord[]>([]);
  const [sentinel1Icebergs, setSentinel1Icebergs] = useState<Sentinel1GroundedIcebergRecord[]>([]);
  const [driftingIcebergs, setDriftingIcebergs] = useState<DriftingIcebergTrajectoryRecord[]>([]);
  const [selectedDriftingIceberg, setSelectedDriftingIceberg] = useState<DriftingIcebergTrajectoryRecord | null>(null);
  const [driftingIcebergScreenPos, setDriftingIcebergScreenPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedPort, setSelectedPort] = useState<PortRecord | null>(null);
  const [portScreenPos, setPortScreenPos] = useState<{ x: number; y: number } | null>(null);

  const [departurePort, setDeparturePort] = useState<PortRecord | null>(null);
  const [departureScreenPos, setDepartureScreenPos] = useState<{ x: number; y: number } | null>(null);

  const [destinationPort, setDestinationPort] = useState<PortRecord | null>(null);
  const [destinationScreenPos, setDestinationScreenPos] = useState<{ x: number; y: number } | null>(null);

  const [routeResult, setRouteResult] = useState<MaritimeRouteResult | null>(null);
  const [isCalculatingRoute, setIsCalculatingRoute] = useState<boolean>(false);

  const [hazardReport, setHazardReport] = useState<IceHazardAnalysisReport | null>(null);
  const [isAnalyzingHazards, setIsAnalyzingHazards] = useState<boolean>(false);

  // Simulation State for Movement along Calculated Route
  const [routeProfile, setRouteProfile] = useState<RouteGeometryProfile | null>(null);
  const [simDistanceMeters, setSimDistanceMeters] = useState<number>(0);
  const [simStatus, setSimStatus] = useState<'IDLE' | 'PLAYING' | 'PAUSED' | 'COMPLETED'>('IDLE');
  const [simSpeedMultiplier, setSimSpeedMultiplier] = useState<number>(5);

  const [selectedVessel, setSelectedVessel] = useState<VesselConfiguration | null>(null);
  const [vesselScreenPos, setVesselScreenPos] = useState<{ x: number; y: number } | null>(null);

  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    if (feedbackTimerRef.current) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    setFeedbackMessage(msg);
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedbackMessage(null);
      feedbackTimerRef.current = null;
    }, 2800);
  };

  const handleSelectLayerFilter = (mode: LayerFilterMode) => {
    setLayerFilter(mode);
    if (mode === 'PORTS') {
      showToast(`Isolated & Highlighted: All Maritime Ports (${ports.length > 0 ? ports.length.toLocaleString() : '3,807'} points)`);
    } else if (mode === 'MOVING') {
      const movingCount = (icebergs.length + driftingIcebergs.length) || 624;
      showToast(`Isolated & Highlighted: Moving Icebergs (${movingCount.toLocaleString()} drifting & tracked targets)`);
    } else if (mode === 'FIXED') {
      showToast(`Isolated & Highlighted: Fixed Grounded Icebergs (${sentinel1Icebergs.length > 0 ? sentinel1Icebergs.length.toLocaleString() : '39,619'} stationary targets)`);
    } else {
      showToast('Displaying All Navigation Layers (Default View)');
    }
  };

  const handleSelectPort = (port: PortRecord | null) => {
    if (port) {
      setFeedbackMessage(null);
    }
    setSelectedPort(port);
  };

  const handleSetDeparture = (port?: PortRecord) => {
    const target = port || selectedPort;
    if (!target) return;

    if (destinationPort?.wpiNumber === target.wpiNumber) {
      showToast("Departure and destination cannot be the same port");
      return;
    }
    setDeparturePort(target);
    showToast(`Departure set to ${target.portName}`);
  };

  const handleSelectDepartureFromSearch = (port: PortRecord) => {
    if (destinationPort?.wpiNumber === port.wpiNumber) {
      showToast("Departure and destination cannot be the same port");
      return;
    }
    setDeparturePort(port);
    setSelectedPort(port);
    globeRef.current?.flyToPort(port);
    showToast(`Departure set to ${port.portName} (WPI ${port.wpiNumber})`);
  };

  const handleClearDeparture = () => {
    setDeparturePort(null);
    setRouteResult(null);
    showToast("Departure port cleared");
  };

  const handleSetDestination = (port?: PortRecord) => {
    const target = port || selectedPort;
    if (!target) return;

    if (departurePort?.wpiNumber === target.wpiNumber) {
      showToast("Departure and destination cannot be the same port");
      return;
    }
    setDestinationPort(target);
    showToast(`Destination set to ${target.portName}`);
  };

  const handleSelectDestinationFromSearch = (port: PortRecord) => {
    if (departurePort?.wpiNumber === port.wpiNumber) {
      showToast("Departure and destination cannot be the same port");
      return;
    }
    setDestinationPort(port);
    setSelectedPort(port);
    globeRef.current?.flyToPort(port);
    showToast(`Destination set to ${port.portName} (WPI ${port.wpiNumber})`);
  };

  const handleClearDestination = () => {
    setDestinationPort(null);
    setRouteResult(null);
    showToast("Destination port cleared");
  };

  const handleSwapPorts = () => {
    if (!departurePort || !destinationPort) return;
    const prevDep = departurePort;
    const prevDest = destinationPort;
    setDeparturePort(prevDest);
    setDestinationPort(prevDep);
    showToast(`Swapped route direction: ${prevDest.portName} → ${prevDep.portName}`);
  };

  const handleClearRoute = () => {
    setDeparturePort(null);
    setDestinationPort(null);
    setRouteResult(null);
    showToast("Active maritime route cleared");
  };

  // Compute route whenever departure or destination changes
  useEffect(() => {
    let cancelled = false;

    if (departurePort && destinationPort) {
      if (departurePort.wpiNumber === destinationPort.wpiNumber) {
        setRouteResult({
          status: "NO_FEASIBLE_ROUTE",
          routeName: "Computed Maritime Route",
          coordinates: [],
          distanceKm: 0,
          candidateCountAttempted: 0,
          rawNodeCount: 0,
          finalNodeCount: 0,
          failingReason: "Departure and destination ports cannot be the same",
          provenance: {
            dataset: "N/A",
            version: "",
            source: "",
            license: "",
            method: "",
          },
        });
        return;
      }

      setIsCalculatingRoute(true);
      computeMaritimeRoute(departurePort, destinationPort)
        .then((res) => {
          if (!cancelled) {
            setRouteResult(res);
            setIsCalculatingRoute(false);
            if (res.status === "SUCCESS" && res.coordinates.length >= 2) {
              const profile = buildRouteGeometryProfile(res.coordinates);
              setRouteProfile(profile);
              setSimDistanceMeters(0);
              setSimStatus('IDLE');
            } else {
              setRouteProfile(null);
              setSimDistanceMeters(0);
              setSimStatus('IDLE');
            }
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.error("Routing error:", err);
            setIsCalculatingRoute(false);
            setRouteResult(null);
            setRouteProfile(null);
            setSimDistanceMeters(0);
            setSimStatus('IDLE');
          }
        });
    } else {
      setRouteResult(null);
      setIsCalculatingRoute(false);
      setHazardReport(null);
      setIsAnalyzingHazards(false);
      setRouteProfile(null);
      setSimDistanceMeters(0);
      setSimStatus('IDLE');
    }

    return () => {
      cancelled = true;
    };
  }, [departurePort, destinationPort]);

  // Deterministic Route Simulation Animation Loop (nominal 15 knots = 7.71667 m/s * multiplier)
  useEffect(() => {
    if (simStatus !== 'PLAYING' || !routeProfile) return;

    let animId: number;
    let lastTimestamp = performance.now();

    const frame = (now: number) => {
      const dtSeconds = Math.max(0, (now - lastTimestamp) / 1000.0);
      lastTimestamp = now;

      // 15 knots = 7.71667 m/s
      const nominalSpeedMps = 15.0 * 0.514444;
      const advance = dtSeconds * nominalSpeedMps * simSpeedMultiplier;

      setSimDistanceMeters((prev) => {
        const next = prev + advance;
        if (next >= routeProfile.totalDistanceMeters) {
          setSimStatus('COMPLETED');
          return routeProfile.totalDistanceMeters;
        }
        return next;
      });

      animId = requestAnimationFrame(frame);
    };

    animId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [simStatus, routeProfile, simSpeedMultiplier]);

  // Evaluate current vessel simulation point along the route
  const vesselPoint: RouteSimulationPoint = routeProfile
    ? evaluateSimulationPoint(routeProfile, simDistanceMeters)
    : departurePort
    ? {
        coordinate: [departurePort.longitude, departurePort.latitude],
        headingDegrees: 0,
        segmentIndex: 0,
        distanceTraveledMeters: 0,
        distanceRemainingMeters: 0,
        totalDistanceMeters: 0,
        progressPercent: 0,
        isCompleted: false,
      }
    : {
        coordinate: [
          DEMO_VESSEL_CONFIG.geographicLocation.longitude,
          DEMO_VESSEL_CONFIG.geographicLocation.latitude,
        ],
        headingDegrees: 55.0,
        segmentIndex: 0,
        distanceTraveledMeters: 0,
        distanceRemainingMeters: 0,
        totalDistanceMeters: 0,
        progressPercent: 0,
        isCompleted: false,
      };

  const currentVesselLocation = {
    latitude: vesselPoint.coordinate[1],
    longitude: vesselPoint.coordinate[0],
    altitude: 0,
    headingDegrees: vesselPoint.headingDegrees,
  };

  // Perform rigorous spatial hazard analysis against real iceberg datasets when valid route exists
  useEffect(() => {
    let cancelled = false;

    if (
      routeResult &&
      routeResult.status === "SUCCESS" &&
      routeResult.coordinates.length >= 2 &&
      (icebergs.length > 0 || sentinel1Icebergs.length > 0 || driftingIcebergs.length > 0)
    ) {
      setIsAnalyzingHazards(true);

      analyzeRouteIcebergHazards(
        routeResult.coordinates,
        icebergs,
        sentinel1Icebergs,
        driftingIcebergs
      )
        .then((report) => {
          if (!cancelled) {
            setHazardReport(report);
            setIsAnalyzingHazards(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.error("Hazard analysis error:", err);
            setIsAnalyzingHazards(false);
          }
        });
    } else {
      setHazardReport(null);
      setIsAnalyzingHazards(false);
    }

    return () => {
      cancelled = true;
    };
  }, [routeResult, icebergs, sentinel1Icebergs, driftingIcebergs]);

  // Load real-world NGA World Port Index & USNIC Antarctic Icebergs datasets
  useEffect(() => {
    let mounted = true;
    loadPortDataset()
      .then((data) => {
        if (mounted) {
          setPorts(data);
        }
      })
      .catch((err) => {
        console.error('Failed to load WPI ports dataset:', err);
      });

    loadIcebergDataset()
      .then((data) => {
        if (mounted) {
          setIcebergs(data);
        }
      })
      .catch((err) => {
        console.error('Failed to load USNIC icebergs dataset:', err);
      });

    loadSentinel1GroundedIcebergDataset()
      .then((data) => {
        if (mounted) {
          setSentinel1Icebergs(data);
        }
      })
      .catch((err) => {
        console.error('Failed to load Sentinel-1 grounded icebergs dataset:', err);
      });

    loadDriftingIcebergDataset()
      .then((data) => {
        if (mounted) {
          setDriftingIcebergs(data);
        }
      })
      .catch((err) => {
        console.error('Failed to load BYU/NIC drifting icebergs dataset:', err);
      });

    return () => {
      mounted = false;
      if (feedbackTimerRef.current) {
        window.clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  const handleResetCamera = () => {
    globeRef.current?.resetCamera();
  };

  const handleFocusDeparture = () => {
    if (departurePort) {
      setSelectedPort(departurePort);
      globeRef.current?.flyToPort(departurePort);
    }
  };

  const handleFocusDestination = () => {
    if (destinationPort) {
      setSelectedPort(destinationPort);
      globeRef.current?.flyToPort(destinationPort);
    }
  };

  const handleFocusRoute = () => {
    if (routeResult && routeResult.coordinates.length >= 2) {
      globeRef.current?.flyToRoute(routeResult.coordinates);
    }
  };

  const handleFocusHazard = (hazard: IcebergHazardItem) => {
    globeRef.current?.flyToHazard(hazard);
    showToast(`Focused hazard: Iceberg ${hazard.icebergId} (${hazard.relationship})`);
  };

  const handleFocusVessel = () => {
    globeRef.current?.flyToVessel();
  };

  const handleOpenTacticalView = () => {
    if (!routeResult || routeResult.status !== 'SUCCESS') {
      showToast("Calculate a valid maritime route first to open 2D Tactical View");
      return;
    }
    setActiveView('2D_TACTICAL');
    showToast("Switched to 2D Tactical Navigation View");
  };

  const handleBackToGlobe = () => {
    setActiveView('3D_GLOBE');
    showToast("Returned to 3D Global Overview");
  };

  const handlePlaySim = () => {
    if (!routeProfile) return;
    if (simStatus === 'COMPLETED' || simDistanceMeters >= routeProfile.totalDistanceMeters) {
      setSimDistanceMeters(0);
    }
    setSimStatus('PLAYING');
  };

  const handlePauseSim = () => {
    setSimStatus('PAUSED');
  };

  const handleResetSim = () => {
    setSimDistanceMeters(0);
    setSimStatus('IDLE');
  };

  const handleSeekDistance = (dist: number) => {
    if (!routeProfile) return;
    const clamped = Math.max(0, Math.min(routeProfile.totalDistanceMeters, dist));
    setSimDistanceMeters(clamped);
    if (clamped >= routeProfile.totalDistanceMeters) {
      setSimStatus('COMPLETED');
    }
  };

  return (
    <div className="w-full h-full relative overflow-hidden bg-polar-950">

      {/* ──────────── 2D TACTICAL NAVIGATION VIEW ──────────── */}
      {activeView === '2D_TACTICAL' && routeResult && (
        <Tactical2DView
          ports={ports}
          departurePort={departurePort}
          destinationPort={destinationPort}
          routeResult={routeResult}
          icebergs={icebergs}
          sentinel1Icebergs={sentinel1Icebergs}
          driftingIcebergs={driftingIcebergs}
          vesselPoint={vesselPoint}
          simStatus={simStatus}
          onPlay={handlePlaySim}
          onPause={handlePauseSim}
          onReset={handleResetSim}
          onSeekDistance={handleSeekDistance}
          simSpeedMultiplier={simSpeedMultiplier}
          onSetSimSpeed={setSimSpeedMultiplier}
          onBackToGlobe={handleBackToGlobe}
          layerFilter={layerFilter}
          onSelectLayerFilter={handleSelectLayerFilter}
        />
      )}

      {/* ──────────── 3D GLOBE VIEW ──────────── */}
      {activeView === '3D_GLOBE' && (
        <>
          <CesiumGlobe
            ref={globeRef}
            className="w-full h-full"
            ports={ports}
            icebergs={icebergs}
            sentinel1Icebergs={sentinel1Icebergs}
            driftingIcebergs={driftingIcebergs}
            hazardReport={hazardReport}
            selectedPort={selectedPort}
            onSelectPort={handleSelectPort}
            onPortScreenPosChange={setPortScreenPos}
            departurePort={departurePort}
            onDepartureScreenPosChange={setDepartureScreenPos}
            destinationPort={destinationPort}
            onDestinationScreenPosChange={setDestinationScreenPos}
            onInvalidClick={showToast}
            selectedVessel={selectedVessel}
            onSelectVessel={setSelectedVessel}
            onScreenPositionChange={setVesselScreenPos}
            selectedDriftingIceberg={selectedDriftingIceberg}
            onSelectDriftingIceberg={setSelectedDriftingIceberg}
            onDriftingIcebergScreenPosChange={setDriftingIcebergScreenPos}
            vesselLocation={currentVesselLocation}
            onOpenTacticalView={handleOpenTacticalView}
            layerFilter={layerFilter}
          />

          {/* Layer Filter / Isolation & Highlight Toggle (Top Right) */}
          <div className="absolute top-5 right-6 z-20 pointer-events-auto">
            <LayerHighlightToggle
              activeMode={layerFilter}
              onSelectMode={handleSelectLayerFilter}
              portsCount={ports.length || 3807}
              driftingCount={driftingIcebergs.length || 624}
              groundedCount={sentinel1Icebergs.length || 39619}
            />
          </div>

          {/* Mission Departure Annotation (Hidden if port is actively selected to avoid overlap) */}
          {departurePort && departureScreenPos && selectedPort?.wpiNumber !== departurePort.wpiNumber && (
            <DepartureAnnotation
              port={departurePort}
              screenPosition={departureScreenPos}
            />
          )}

          {/* Mission Destination Annotation (Hidden if port is actively selected to avoid overlap) */}
          {destinationPort && destinationScreenPos && selectedPort?.wpiNumber !== destinationPort.wpiNumber && (
            <DestinationAnnotation
              port={destinationPort}
              screenPosition={destinationScreenPos}
            />
          )}

          {/* Geographically Anchored Vessel Map Annotation */}
          {selectedVessel && vesselScreenPos && (
            <VesselInfoCard
              vessel={selectedVessel}
              screenPosition={vesselScreenPos}
              onClose={() => setSelectedVessel(null)}
              onOpenTacticalView={handleOpenTacticalView}
            />
          )}

          {/* Single Geographically Anchored Selected Port Annotation */}
          {selectedPort && portScreenPos && (
            <PortAnnotation
              port={selectedPort}
              screenPosition={portScreenPos}
              isDeparture={departurePort?.wpiNumber === selectedPort.wpiNumber}
              onSetDeparture={() => handleSetDeparture(selectedPort)}
              onClearDeparture={handleClearDeparture}
              isDestination={destinationPort?.wpiNumber === selectedPort.wpiNumber}
              onSetDestination={() => handleSetDestination(selectedPort)}
              onClearDestination={handleClearDestination}
              onClose={() => setSelectedPort(null)}
            />
          )}

          {/* Single Geographically Anchored Selected Drifting Iceberg Annotation */}
          {selectedDriftingIceberg && driftingIcebergScreenPos && (
            <DriftingIcebergAnnotation
              iceberg={selectedDriftingIceberg}
              screenPosition={driftingIcebergScreenPos}
              onClose={() => setSelectedDriftingIceberg(null)}
            />
          )}

          {/* Mission Maritime Navigation Route Summary Panel */}
          <RouteSummaryPanel
            ports={ports}
            departurePort={departurePort}
            destinationPort={destinationPort}
            routeResult={routeResult}
            isCalculating={isCalculatingRoute}
            hazardReport={hazardReport}
            isAnalyzingHazards={isAnalyzingHazards}
            onSelectDeparture={handleSelectDepartureFromSearch}
            onSelectDestination={handleSelectDestinationFromSearch}
            onSwapPorts={handleSwapPorts}
            onClearDeparture={handleClearDeparture}
            onClearDestination={handleClearDestination}
            onClearRoute={handleClearRoute}
            onFocusDeparture={handleFocusDeparture}
            onFocusDestination={handleFocusDestination}
            onFocusRoute={handleFocusRoute}
            onFocusHazard={handleFocusHazard}
            onOpenTacticalView={handleOpenTacticalView}
          />

          {/* Viewport & Navigation Map Controls */}
          <div className="absolute bottom-6 right-6 z-20 pointer-events-auto select-none flex items-center gap-4 text-xs font-sans">
            {routeResult && routeResult.status === 'SUCCESS' && (
              <button
                type="button"
                onClick={handleOpenTacticalView}
                className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
                title="Open 2D Tactical Navigation View"
              >
                2D Tactical
              </button>
            )}
            <button
              type="button"
              onClick={handleFocusVessel}
              className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              title="Locate R/V Polar Explorer"
            >
              Locate Vessel
            </button>
            <button
              type="button"
              onClick={handleResetCamera}
              className="text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              title="Reset globe to polar view"
            >
              Reset Camera
            </button>
          </div>
        </>
      )}

      {/* Operational Feedback Toast */}
      {feedbackMessage && (
        <div
          role="status"
          aria-live="polite"
          className="absolute top-5 left-1/2 -translate-x-1/2 z-50 pointer-events-none select-none"
        >
          <div className="text-slate-300 text-xs font-sans flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
            <span>{feedbackMessage}</span>
          </div>
        </div>
      )}
    </div>
  );
};
