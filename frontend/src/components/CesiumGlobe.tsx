import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import * as Cesium from 'cesium';
import { DEMO_VESSEL_CONFIG, VesselConfiguration } from '../config/vessel';
import type { PortRecord } from '../types/port';
import type { IcebergRecord } from '../types/iceberg';
import type { Sentinel1GroundedIcebergRecord } from '../types/sentinel1Iceberg';
import type { DriftingIcebergTrajectoryRecord } from '../types/driftingIceberg';
import type { IceHazardAnalysisReport, IcebergHazardItem } from '../types/iceHazard';
import type { LayerFilterMode } from '../types/navigation';
import { computeMaritimeRoute } from '../services/maritimeRoutingService';

export interface CesiumGlobeRef {
  resetCamera: () => void;
  flyToPort: (port: PortRecord) => void;
  flyToRoute: (coordinates: [number, number][]) => void;
  flyToVessel: () => void;
  flyToHazard: (hazard: IcebergHazardItem) => void;
  getViewer: () => Cesium.Viewer | null;
}

interface CesiumGlobeProps {
  className?: string;
  ports?: PortRecord[];
  icebergs?: IcebergRecord[];
  sentinel1Icebergs?: Sentinel1GroundedIcebergRecord[];
  driftingIcebergs?: DriftingIcebergTrajectoryRecord[];
  hazardReport?: IceHazardAnalysisReport | null;
  selectedPort?: PortRecord | null;
  onSelectPort?: (port: PortRecord | null) => void;
  onPortScreenPosChange?: (pos: { x: number; y: number } | null) => void;
  departurePort?: PortRecord | null;
  onDepartureScreenPosChange?: (pos: { x: number; y: number } | null) => void;
  destinationPort?: PortRecord | null;
  onDestinationScreenPosChange?: (pos: { x: number; y: number } | null) => void;
  onInvalidClick?: (message: string) => void;
  selectedVessel?: VesselConfiguration | null;
  onSelectVessel?: (vessel: VesselConfiguration | null) => void;
  onScreenPositionChange?: (pos: { x: number; y: number } | null) => void;
  selectedDriftingIceberg?: DriftingIcebergTrajectoryRecord | null;
  onSelectDriftingIceberg?: (berg: DriftingIcebergTrajectoryRecord | null) => void;
  onDriftingIcebergScreenPosChange?: (pos: { x: number; y: number } | null) => void;
  vesselLocation?: { latitude: number; longitude: number; altitude?: number; headingDegrees?: number } | null;
  onOpenTacticalView?: () => void;
  layerFilter?: LayerFilterMode;
}

/**
 * Accurately computes the 2D canvas screen coordinate for a 3D Cartesian geographic position.
 * Strictly accounts for:
 * 1. Camera forward-direction plane (point in front of camera)
 * 2. 3D Ellipsoid Horizon Occlusion (point not hidden behind the curved Earth)
 * 3. 2D Viewport Canvas Frustum Bounds (within visible window)
 */
function computeVisibleScreenCoord(
  scene: Cesium.Scene | undefined | null,
  cartesian: Cesium.Cartesian3 | undefined | null
): { x: number; y: number } | null {
  if (!scene || scene.isDestroyed() || !cartesian) return null;
  const camera = scene.camera;
  const cameraPos = camera.positionWC;
  const cameraDir = camera.directionWC;

  // 1. Direction check: Point must be in front of the camera projection plane
  const toTarget = Cesium.Cartesian3.subtract(cartesian, cameraPos, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.dot(toTarget, cameraDir) <= 0) {
    return null;
  }

  // 2. Horizon Occlusion Check: Point must not be occluded by the curved Earth ellipsoid
  const occluder = new (Cesium as any).EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, cameraPos);
  if (!occluder.isPointVisible(cartesian)) {
    return null;
  }

  // 3. Project to canvas 2D pixel coordinates
  const windowCoord = Cesium.SceneTransforms.worldToWindowCoordinates(scene, cartesian);
  if (!windowCoord) {
    return null;
  }

  // 4. Frustum / Viewport boundary test (with small 60px buffer)
  const canvas = scene.canvas;
  const margin = 60;
  if (
    windowCoord.x < -margin ||
    windowCoord.x > canvas.clientWidth + margin ||
    windowCoord.y < -margin ||
    windowCoord.y > canvas.clientHeight + margin
  ) {
    return null;
  }

  return { x: Math.round(windowCoord.x), y: Math.round(windowCoord.y) };
}

const DEFAULT_CAMERA_VIEW = {
  destination: Cesium.Cartesian3.fromDegrees(-60.0, -82.0, 9000000.0),
  orientation: {
    heading: Cesium.Math.toRadians(0.0),
    pitch: Cesium.Math.toRadians(-88.0),
    roll: 0.0,
  },
};

export const CesiumGlobe = forwardRef<CesiumGlobeRef, CesiumGlobeProps>(
  (
    {
      className = '',
      ports,
      icebergs,
      sentinel1Icebergs,
      driftingIcebergs,
      hazardReport,
      selectedPort,
      onSelectPort,
      onPortScreenPosChange,
      departurePort,
      onDepartureScreenPosChange,
      destinationPort,
      onDestinationScreenPosChange,
      onInvalidClick,
      selectedVessel,
      onSelectVessel,
      onScreenPositionChange,
      selectedDriftingIceberg,
      onSelectDriftingIceberg,
      onDriftingIcebergScreenPosChange,
      vesselLocation,
      onOpenTacticalView,
      layerFilter = 'ALL',
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewerRef = useRef<Cesium.Viewer | null>(null);

    const portMapRef = useRef<Map<number, PortRecord>>(new Map());
    const driftingMapRef = useRef<Map<string, DriftingIcebergTrajectoryRecord>>(new Map());

    const onSelectPortRef = useRef(onSelectPort);
    onSelectPortRef.current = onSelectPort;
    const selectedPortRef = useRef(selectedPort);
    selectedPortRef.current = selectedPort;
    const onPortScreenPosChangeRef = useRef(onPortScreenPosChange);
    onPortScreenPosChangeRef.current = onPortScreenPosChange;
    const departurePortRef = useRef(departurePort);
    departurePortRef.current = departurePort;
    const onDepartureScreenPosChangeRef = useRef(onDepartureScreenPosChange);
    onDepartureScreenPosChangeRef.current = onDepartureScreenPosChange;
    const destinationPortRef = useRef(destinationPort);
    destinationPortRef.current = destinationPort;
    const onDestinationScreenPosChangeRef = useRef(onDestinationScreenPosChange);
    onDestinationScreenPosChangeRef.current = onDestinationScreenPosChange;
    const onInvalidClickRef = useRef(onInvalidClick);
    onInvalidClickRef.current = onInvalidClick;

    const onSelectVesselRef = useRef(onSelectVessel);
    onSelectVesselRef.current = onSelectVessel;
    const onScreenPositionChangeRef = useRef(onScreenPositionChange);
    onScreenPositionChangeRef.current = onScreenPositionChange;
    const selectedVesselRef = useRef(selectedVessel);
    selectedVesselRef.current = selectedVessel;

    const onOpenTacticalViewRef = useRef(onOpenTacticalView);
    onOpenTacticalViewRef.current = onOpenTacticalView;
    const vesselLocationRef = useRef(vesselLocation);
    vesselLocationRef.current = vesselLocation;

    const onSelectDriftingIcebergRef = useRef(onSelectDriftingIceberg);
    onSelectDriftingIcebergRef.current = onSelectDriftingIceberg;
    const selectedDriftingIcebergRef = useRef(selectedDriftingIceberg);
    selectedDriftingIcebergRef.current = selectedDriftingIceberg;
    const onDriftingIcebergScreenPosChangeRef = useRef(onDriftingIcebergScreenPosChange);
    onDriftingIcebergScreenPosChangeRef.current = onDriftingIcebergScreenPosChange;

    useImperativeHandle(ref, () => ({
      resetCamera: () => {
        const viewer = viewerRef.current;
        if (!viewer || viewer.isDestroyed()) return;
        viewer.camera.flyTo({
          destination: DEFAULT_CAMERA_VIEW.destination,
          orientation: DEFAULT_CAMERA_VIEW.orientation,
          duration: 1.2,
        });
      },
      flyToPort: (port: PortRecord) => {
        const viewer = viewerRef.current;
        if (!viewer || viewer.isDestroyed()) return;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(port.longitude, port.latitude, 600000.0),
          duration: 1.4,
        });
      },
      flyToRoute: (coordinates: [number, number][]) => {
        const viewer = viewerRef.current;
        if (!viewer || viewer.isDestroyed() || coordinates.length < 2) return;
        const cartesians = coordinates.map(([lon, lat]) =>
          Cesium.Cartesian3.fromDegrees(lon, lat, 0)
        );
        const boundingSphere = Cesium.BoundingSphere.fromPoints(cartesians);
        viewer.camera.flyToBoundingSphere(boundingSphere, {
          duration: 1.5,
          offset: new Cesium.HeadingPitchRange(
            viewer.camera.heading,
            Cesium.Math.toRadians(-65.0),
            boundingSphere.radius * 2.6
          ),
        });
      },
      flyToVessel: () => {
        const viewer = viewerRef.current;
        if (!viewer || viewer.isDestroyed()) return;
        const loc = DEMO_VESSEL_CONFIG.geographicLocation;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(loc.longitude, loc.latitude, 350000.0),
          duration: 1.4,
        });
      },
      flyToHazard: (hazard: IcebergHazardItem) => {
        const viewer = viewerRef.current;
        if (!viewer || viewer.isDestroyed()) return;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            hazard.icebergPosition[0],
            hazard.icebergPosition[1],
            220000.0
          ),
          duration: 1.4,
        });
      },
      getViewer: () => viewerRef.current,
    }));

    useEffect(() => {
      if (!containerRef.current) return;

      const baseLayer = Cesium.ImageryLayer.fromProviderAsync(
        Cesium.ArcGisMapServerImageryProvider.fromUrl(
          'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
          {
            enablePickFeatures: false,
          }
        )
      );

      const viewer = new Cesium.Viewer(containerRef.current, {
        baseLayer: baseLayer,
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        scene3DOnly: true,
        shadows: false,
        contextOptions: {
          webgl: {
            alpha: false,
            antialias: true,
            preserveDrawingBuffer: false,
            failIfMajorPerformanceCaveat: false,
            powerPreference: 'high-performance',
          },
        },
      });

      viewer.scene.requestRenderMode = true;
      viewer.scene.maximumRenderTimeChange = Infinity;
      viewer.useBrowserRecommendedResolution = true;

      viewer.scene.globe.maximumScreenSpaceError = 2.0;
      viewer.scene.globe.tileCacheSize = 100;
      viewer.scene.globe.preloadAncestors = true;
      viewer.scene.globe.preloadSiblings = false;
      viewer.scene.globe.backFaceCulling = true;
      viewer.scene.globe.depthTestAgainstTerrain = false;

      const controller = viewer.scene.screenSpaceCameraController;
      controller.inertiaSpin = 0.85;
      controller.inertiaTranslate = 0.85;
      controller.inertiaZoom = 0.8;
      controller.bounceAnimationTime = 0.0;

      viewer.scene.globe.enableLighting = false;
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#030a16');
      if (viewer.scene.skyAtmosphere) {
        viewer.scene.skyAtmosphere.show = true;
        viewer.scene.skyAtmosphere.brightnessShift = 0.1;
      }

      viewer.camera.setView(DEFAULT_CAMERA_VIEW);

      // Research Vessel Entity (Configured Demonstration Position - Billboard Icon)
      const { geographicLocation, orientation, icon, name, classification } = DEMO_VESSEL_CONFIG;
      const vesselPosition = Cesium.Cartesian3.fromDegrees(
        geographicLocation.longitude,
        geographicLocation.latitude,
        geographicLocation.altitude
      );

      // Subtle, restrained selection frame (quiet hairline outline)
      viewer.entities.add({
        id: 'vessel-selection-ring',
        name: 'Vessel Selection Ring',
        position: vesselPosition,
        show: false,
        point: {
          pixelSize: 28,
          color: Cesium.Color.TRANSPARENT,
          outlineColor: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.7),
          outlineWidth: 1.0,
          scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.0, 1.0e7, 0.9),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });

      // Vessel Billboard Entity
      viewer.entities.add({
        id: 'vessel-entity',
        name: `${name} (${classification})`,
        position: vesselPosition,
        billboard: {
          image: icon.uri,
          width: icon.width,
          height: icon.height,
          scale: icon.scale,
          scaleByDistance: new Cesium.NearFarScalar(
            icon.nearFarScalar.nearDistance,
            icon.nearFarScalar.nearScale,
            icon.nearFarScalar.farDistance,
            icon.nearFarScalar.farScale
          ),
          rotation: Cesium.Math.toRadians(-orientation.headingDegrees),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          heightReference: Cesium.HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });

      // ScreenSpaceEventHandler for native Cesium entity & globe picking
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((movement: { position: Cesium.Cartesian2 }) => {
        const pickedObject = viewer.scene.pick(movement.position);
        if (Cesium.defined(pickedObject)) {
          // Check if picked object is a Drifting Iceberg Point Primitive
          let driftId: string | null = null;
          if (typeof pickedObject.id === 'string' && pickedObject.id.startsWith('drift-point-')) {
            driftId = pickedObject.id.replace('drift-point-', '');
          } else if (pickedObject.primitive && typeof (pickedObject.primitive as any).id === 'string' && (pickedObject.primitive as any).id.startsWith('drift-point-')) {
            driftId = (pickedObject.primitive as any).id.replace('drift-point-', '');
          }

          if (driftId && driftingMapRef.current) {
            const berg = driftingMapRef.current.get(driftId);
            if (berg) {
              onSelectPortRef.current?.(null);
              onSelectVesselRef.current?.(null);
              if (selectedDriftingIcebergRef.current?.id === berg.id) {
                onSelectDriftingIcebergRef.current?.(null);
              } else {
                onSelectDriftingIcebergRef.current?.(berg);
              }
              return;
            }
          }

          // Check if picked object is a Port Primitive (Point or Label)
          let portId: number | null = null;
          if (typeof pickedObject.id === 'string' && pickedObject.id.startsWith('port-') && pickedObject.id !== 'port-selection-ring') {
            portId = parseInt(pickedObject.id.replace('port-', ''), 10);
          } else if (typeof pickedObject.id === 'object' && pickedObject.id && 'wpiNumber' in pickedObject.id) {
            portId = (pickedObject.id as PortRecord).wpiNumber;
          } else if (pickedObject.primitive && typeof (pickedObject.primitive as any).id === 'string' && (pickedObject.primitive as any).id.startsWith('port-')) {
            portId = parseInt((pickedObject.primitive as any).id.replace('port-', ''), 10);
          }

          if (portId !== null && portMapRef.current) {
            const port = portMapRef.current.get(portId);
            if (port) {
              onSelectVesselRef.current?.(null);
              onSelectDriftingIcebergRef.current?.(null);
              if (selectedPortRef.current?.wpiNumber === port.wpiNumber) {
                onSelectPortRef.current?.(null);
              } else {
                onSelectPortRef.current?.(port);
              }
              return;
            }
          }

          // Check if picked object is an Entity
          const entity = pickedObject.id as Cesium.Entity;
          if (entity && typeof entity === 'object' && 'id' in entity) {
            // Active Port Selection Ring clicked -> toggle off
            if (entity.id === 'port-selection-ring') {
              onSelectPortRef.current?.(null);
              return;
            }

            // Vessel Icon Picked
            if (entity.id === 'vessel-entity' || entity.id === 'vessel-selection-ring' || entity.name?.includes(name)) {
              onSelectPortRef.current?.(null);
              onSelectDriftingIcebergRef.current?.(null);

              const currentVesselLoc = vesselLocationRef.current || DEMO_VESSEL_CONFIG.geographicLocation;
              const configuredVessel: VesselConfiguration = {
                ...DEMO_VESSEL_CONFIG,
                geographicLocation: {
                  ...DEMO_VESSEL_CONFIG.geographicLocation,
                  latitude: currentVesselLoc.latitude,
                  longitude: currentVesselLoc.longitude,
                },
              };

              onSelectVesselRef.current?.(configuredVessel);
              onOpenTacticalViewRef.current?.();
              return;
            }

            // Departure Marker Picked -> toggle departure port selection
            if (entity.id === 'departure-marker' || entity.name?.includes('Departure')) {
              if (departurePortRef.current) {
                onSelectVesselRef.current?.(null);
                onSelectDriftingIcebergRef.current?.(null);
                if (selectedPortRef.current?.wpiNumber === departurePortRef.current.wpiNumber) {
                  onSelectPortRef.current?.(null);
                } else {
                  onSelectPortRef.current?.(departurePortRef.current);
                }
                return;
              }
            }

            // Destination Marker Picked -> toggle destination port selection
            if (entity.id === 'destination-marker' || entity.name?.includes('Destination')) {
              if (destinationPortRef.current) {
                onSelectVesselRef.current?.(null);
                onSelectDriftingIcebergRef.current?.(null);
                if (selectedPortRef.current?.wpiNumber === destinationPortRef.current.wpiNumber) {
                  onSelectPortRef.current?.(null);
                } else {
                  onSelectPortRef.current?.(destinationPortRef.current);
                }
                return;
              }
            }
          }
        }

        // Clicking empty space/ocean dismisses open port, vessel, or drifting iceberg selection without errors
        onSelectPortRef.current?.(null);
        onSelectVesselRef.current?.(null);
        onSelectDriftingIcebergRef.current?.(null);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      const lastPosRef = {
        vessel: null as { x: number; y: number } | null,
        port: null as { x: number; y: number } | null,
        departure: null as { x: number; y: number } | null,
        destination: null as { x: number; y: number } | null,
        drifting: null as { x: number; y: number } | null,
      };

      const isCoordDifferent = (
        prev: { x: number; y: number } | null,
        next: { x: number; y: number } | null
      ) => {
        if (!prev && !next) return false;
        if (!prev || !next) return true;
        return Math.abs(prev.x - next.x) > 0.5 || Math.abs(prev.y - next.y) > 0.5;
      };

      // Continuously synchronize vessel, port, departure, destination & drifting screen coordinates with 3D horizon occlusion
      const updateScreenPos = () => {
        if (!viewer || viewer.isDestroyed()) return;

        // 1. Vessel annotation position
        const currentVessel = selectedVesselRef.current;
        let nextVesselPos: { x: number; y: number } | null = null;
        if (currentVessel && onScreenPositionChangeRef.current) {
          const posCartesian = Cesium.Cartesian3.fromDegrees(
            currentVessel.geographicLocation.longitude,
            currentVessel.geographicLocation.latitude,
            currentVessel.geographicLocation.altitude
          );
          nextVesselPos = computeVisibleScreenCoord(viewer.scene, posCartesian);
        }
        if (isCoordDifferent(lastPosRef.vessel, nextVesselPos)) {
          lastPosRef.vessel = nextVesselPos;
          onScreenPositionChangeRef.current?.(nextVesselPos);
        }

        // 2. Port annotation position
        const curPort = selectedPortRef.current;
        let nextPortPos: { x: number; y: number } | null = null;
        if (curPort && onPortScreenPosChangeRef.current) {
          const portCartesian = Cesium.Cartesian3.fromDegrees(
            curPort.longitude,
            curPort.latitude,
            0
          );
          nextPortPos = computeVisibleScreenCoord(viewer.scene, portCartesian);
        }
        if (isCoordDifferent(lastPosRef.port, nextPortPos)) {
          lastPosRef.port = nextPortPos;
          onPortScreenPosChangeRef.current?.(nextPortPos);
        }

        // 3. Departure port annotation position
        const curDep = departurePortRef.current;
        let nextDepPos: { x: number; y: number } | null = null;
        if (curDep && onDepartureScreenPosChangeRef.current) {
          const depCartesian = Cesium.Cartesian3.fromDegrees(
            curDep.longitude,
            curDep.latitude,
            0
          );
          nextDepPos = computeVisibleScreenCoord(viewer.scene, depCartesian);
        }
        if (isCoordDifferent(lastPosRef.departure, nextDepPos)) {
          lastPosRef.departure = nextDepPos;
          onDepartureScreenPosChangeRef.current?.(nextDepPos);
        }

        // 4. Destination port annotation position
        const curDest = destinationPortRef.current;
        let nextDestPos: { x: number; y: number } | null = null;
        if (curDest && onDestinationScreenPosChangeRef.current) {
          const destCartesian = Cesium.Cartesian3.fromDegrees(
            curDest.longitude,
            curDest.latitude,
            0
          );
          nextDestPos = computeVisibleScreenCoord(viewer.scene, destCartesian);
        }
        if (isCoordDifferent(lastPosRef.destination, nextDestPos)) {
          lastPosRef.destination = nextDestPos;
          onDestinationScreenPosChangeRef.current?.(nextDestPos);
        }

        // 5. Selected Drifting Iceberg annotation position
        const curDrift = selectedDriftingIcebergRef.current;
        let nextDriftPos: { x: number; y: number } | null = null;
        if (curDrift && onDriftingIcebergScreenPosChangeRef.current && curDrift.latestPos) {
          const driftCartesian = Cesium.Cartesian3.fromDegrees(
            curDrift.latestPos.lon,
            curDrift.latestPos.lat,
            30
          );
          nextDriftPos = computeVisibleScreenCoord(viewer.scene, driftCartesian);
        }
        if (isCoordDifferent(lastPosRef.drifting, nextDriftPos)) {
          lastPosRef.drifting = nextDriftPos;
          onDriftingIcebergScreenPosChangeRef.current?.(nextDriftPos);
        }
      };

      const removePostRender = viewer.scene.postRender.addEventListener(updateScreenPos);
      const removeCameraChanged = viewer.camera.changed.addEventListener(updateScreenPos);
      const removeCameraMoveEnd = viewer.camera.moveEnd.addEventListener(updateScreenPos);

      viewer.scene.requestRender();

      if (containerRef.current) {
        (containerRef.current as any).__cesiumViewer = viewer;
      }
      (window as any).Cesium = Cesium;
      (window as any).cesiumViewer = viewer;

      viewerRef.current = viewer;

      return () => {
        removePostRender();
        if (removeCameraChanged) removeCameraChanged();
        if (removeCameraMoveEnd) removeCameraMoveEnd();
        handler.destroy();
        if (!viewer.isDestroyed()) {
          viewer.destroy();
        }
        viewerRef.current = null;
      };
    }, []);

    // Sync vessel geographic position when vesselLocation changes (e.g. at departure port or during simulation)
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      const loc = vesselLocation || DEMO_VESSEL_CONFIG.geographicLocation;
      const vPos = Cesium.Cartesian3.fromDegrees(
        loc.longitude,
        loc.latitude,
        (loc as any).altitude || 0.0
      );

      const vesselEntity = viewer.entities.getById('vessel-entity');
      if (vesselEntity) {
        vesselEntity.position = new Cesium.ConstantPositionProperty(vPos);
      }

      const selectionRing = viewer.entities.getById('vessel-selection-ring');
      if (selectionRing) {
        selectionRing.position = new Cesium.ConstantPositionProperty(vPos);
      }

      viewer.scene.requestRender();
    }, [vesselLocation]);

    // Sync visual selection state with React prop changes
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      const vesselEntity = viewer.entities.getById('vessel-entity');
      const selectionRing = viewer.entities.getById('vessel-selection-ring');

      if (vesselEntity && vesselEntity.billboard) {
        vesselEntity.billboard.scale = new Cesium.ConstantProperty(selectedVessel ? 1.1 : 1.0);
      }
      if (selectionRing) {
        selectionRing.show = !!selectedVessel;
      }

      if (selectedVessel) {
        const posCartesian = Cesium.Cartesian3.fromDegrees(
          selectedVessel.geographicLocation.longitude,
          selectedVessel.geographicLocation.latitude,
          selectedVessel.geographicLocation.altitude
        );
        const windowCoord = computeVisibleScreenCoord(viewer.scene, posCartesian);
        onScreenPositionChangeRef.current?.(windowCoord);
      } else {
        onScreenPositionChangeRef.current?.(null);
      }

      viewer.scene.requestRender();
    }, [selectedVessel]);

    // Sync Departure Marker entity with React prop changes
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      let depEntity = viewer.entities.getById('departure-marker');

      if (departurePort) {
        const posCartesian = Cesium.Cartesian3.fromDegrees(
          departurePort.longitude,
          departurePort.latitude,
          0
        );

        const depLabelText = `${departurePort.portName}\nMISSION DEPARTURE`;

        if (!depEntity) {
          viewer.entities.add({
            id: 'departure-marker',
            name: `Departure: ${departurePort.portName}`,
            position: posCartesian,
            billboard: {
              image: '/icons/departure_marker.svg',
              width: 20,
              height: 20,
              scale: 1.0,
              scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.0, 7.0e6, 0.8),
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: depLabelText,
              font: 'bold 11px Inter, sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#34d399'),
              outlineColor: Cesium.Color.fromCssColorString('#020617'),
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, 16),
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              verticalOrigin: Cesium.VerticalOrigin.TOP,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 25000000.0),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        } else {
          depEntity.position = new Cesium.ConstantPositionProperty(posCartesian);
          depEntity.name = `Departure: ${departurePort.portName}`;
          if (depEntity.label) {
            depEntity.label.text = new Cesium.ConstantProperty(depLabelText);
          }
          depEntity.show = true;
        }

        const windowCoord = computeVisibleScreenCoord(viewer.scene, posCartesian);
        onDepartureScreenPosChangeRef.current?.(windowCoord);
      } else if (depEntity) {
        depEntity.show = false;
        onDepartureScreenPosChangeRef.current?.(null);
      }

      viewer.scene.requestRender();
    }, [departurePort]);

    // Sync Destination Marker entity with React prop changes
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      let destEntity = viewer.entities.getById('destination-marker');

      if (destinationPort) {
        const posCartesian = Cesium.Cartesian3.fromDegrees(
          destinationPort.longitude,
          destinationPort.latitude,
          0
        );

        const destLabelText = `${destinationPort.portName}\nMISSION DESTINATION`;

        if (!destEntity) {
          viewer.entities.add({
            id: 'destination-marker',
            name: `Destination: ${destinationPort.portName}`,
            position: posCartesian,
            billboard: {
              image: '/icons/destination_marker.svg',
              width: 20,
              height: 20,
              scale: 1.0,
              scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.0, 7.0e6, 0.8),
              verticalOrigin: Cesium.VerticalOrigin.CENTER,
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              heightReference: Cesium.HeightReference.NONE,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: destLabelText,
              font: 'bold 11px Inter, sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#fb7185'),
              outlineColor: Cesium.Color.fromCssColorString('#020617'),
              outlineWidth: 3,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, 16),
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              verticalOrigin: Cesium.VerticalOrigin.TOP,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 25000000.0),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        } else {
          destEntity.position = new Cesium.ConstantPositionProperty(posCartesian);
          destEntity.name = `Destination: ${destinationPort.portName}`;
          if (destEntity.label) {
            destEntity.label.text = new Cesium.ConstantProperty(destLabelText);
          }
          destEntity.show = true;
        }

        const windowCoord = computeVisibleScreenCoord(viewer.scene, posCartesian);
        onDestinationScreenPosChangeRef.current?.(windowCoord);
      } else if (destEntity) {
        destEntity.show = false;
        onDestinationScreenPosChangeRef.current?.(null);
      }

      viewer.scene.requestRender();
    }, [destinationPort]);

    // Sync Computed Maritime Route Polyline
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      let cancelled = false;
      let routeEntity = viewer.entities.getById('mission-maritime-route');

      if (departurePort && destinationPort) {
        computeMaritimeRoute(departurePort, destinationPort).then((routeResult) => {
          if (cancelled || !viewer || viewer.isDestroyed()) return;

          routeEntity = viewer.entities.getById('mission-maritime-route');

          // STRICT VALIDATION GATE: Only render if status === 'SUCCESS' and coordinates pass all tests
          if (routeResult.status === 'SUCCESS' && routeResult.coordinates.length >= 2) {
            const positions = routeResult.coordinates.map(([lon, lat]) =>
              Cesium.Cartesian3.fromDegrees(lon, lat, 800)
            );

            if (!routeEntity) {
              viewer.entities.add({
                id: 'mission-maritime-route',
                name: 'Computed Maritime Route',
                polyline: {
                  positions,
                  width: 3.5,
                  material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.25,
                    taperPower: 1.0,
                    color: Cesium.Color.fromCssColorString('#38bdf8'),
                  }),
                  arcType: Cesium.ArcType.NONE,
                },
              });
            } else {
              if (routeEntity.polyline) {
                routeEntity.polyline.positions = new Cesium.ConstantProperty(positions);
              }
              routeEntity.show = true;
            }
          } else {
            // REJECTED / INVALID: Never display an invalid route on the globe
            if (routeEntity) {
              routeEntity.show = false;
            }
            if (routeResult.failingReason) {
              onInvalidClickRef.current?.(`No valid maritime route found (${routeResult.failingReason})`);
            }
          }

          viewer.scene.requestRender();
        });
      } else if (routeEntity) {
        routeEntity.show = false;
        viewer.scene.requestRender();
      }

      return () => {
        cancelled = true;
      };
    }, [departurePort, destinationPort]);

    const portPointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const portLabelsRef = useRef<Cesium.LabelCollection | null>(null);

    // Sync real-world ports dataset with Cesium primitives
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      // Clean up previous primitives if any
      if (portPointsRef.current && !portPointsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(portPointsRef.current);
        portPointsRef.current = null;
      }
      if (portLabelsRef.current && !portLabelsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(portLabelsRef.current);
        portLabelsRef.current = null;
      }

      if (!ports || ports.length === 0) return;

      const isHighlight = layerFilter === 'PORTS';
      const isSubdued = layerFilter === 'MOVING' || layerFilter === 'FIXED';

      const pointCollection = new Cesium.PointPrimitiveCollection();
      const labelCollection = new Cesium.LabelCollection();

      // Geographically filter to Southern Hemisphere / Antarctic maritime theater
      const relevantPorts = ports.filter((p) => p.latitude <= 0.0);

      const map = new Map<number, PortRecord>();
      for (const p of relevantPorts) {
        map.set(p.wpiNumber, p);
      }
      portMapRef.current = map;

      for (let i = 0; i < relevantPorts.length; i++) {
        const port = relevantPorts[i];
        const isAntarctic = port.latitude < -50.0;
        const isRegionalGateway = port.latitude >= -50.0 && port.latitude <= -30.0;
        const position = Cesium.Cartesian3.fromDegrees(port.longitude, port.latitude, 0);

        // Visibility distances:
        // - Primary / Highlight: visible from broad global overview (18,000 km)
        // - Subdued: visible only up to 3,500 km, no labels
        // - Normal: 7,000 km for Antarctic, 3,500 km for regional
        const maxVisibleDistance = isHighlight
          ? 18000000.0
          : isSubdued
          ? (isAntarctic ? 3500000.0 : 1500000.0)
          : isAntarctic
          ? 7000000.0
          : isRegionalGateway
          ? 3500000.0
          : 1200000.0;

        // Strict Geographic LOD for Port Labels:
        // - Global View (> 2,000 km): NO general port labels (clean globe)
        // - Regional View (<= 1,800 km): Antarctic polar stations & key gateways
        // - Close Regional (<= 800 km): Sub-polar regional gateway ports
        // - Tactical Harbor View (<= 300 km): Local general ports
        // - Subdued Mode: Zero labels (keeps inactive background subordinate)
        const maxLabelDistance = isSubdued
          ? 0.0
          : isHighlight
          ? (isAntarctic ? 2000000.0 : isRegionalGateway ? 900000.0 : 350000.0)
          : isAntarctic
          ? 1800000.0
          : isRegionalGateway
          ? 800000.0
          : 300000.0;

        const pixelSize = isHighlight
          ? (isAntarctic ? 11.0 : 8.0)
          : isSubdued
          ? (isAntarctic ? 3.0 : 2.0)
          : (isAntarctic ? 6.5 : 4.0);

        const pointColor = isHighlight
          ? Cesium.Color.fromCssColorString('#38bdf8')
          : isSubdued
          ? Cesium.Color.fromCssColorString('#64748b').withAlpha(0.22)
          : isAntarctic
          ? Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.95)
          : Cesium.Color.fromCssColorString('#94a3b8').withAlpha(0.6);

        const outlineColor = isHighlight
          ? Cesium.Color.fromCssColorString('#ffffff')
          : isSubdued
          ? Cesium.Color.TRANSPARENT
          : Cesium.Color.fromCssColorString('#030a16');

        const outlineWidth = isHighlight ? 2.5 : isSubdued ? 0.0 : (isAntarctic ? 1.5 : 1.0);

        // Minimalist navigation-style point marker
        pointCollection.add({
          position,
          pixelSize,
          color: pointColor,
          outlineColor,
          outlineWidth,
          scaleByDistance: isHighlight
            ? new Cesium.NearFarScalar(1.0e3, 1.4, 1.0e7, 0.9)
            : isSubdued
            ? new Cesium.NearFarScalar(1.0e3, 1.0, 4.0e6, 0.5)
            : new Cesium.NearFarScalar(1.0e3, 1.2, 7.0e6, 0.7),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, maxVisibleDistance),
          id: `port-${port.wpiNumber}`,
        });

        // Real-source port name labels (only when maxLabelDistance > 0)
        if (maxLabelDistance > 0) {
          labelCollection.add({
            id: `port-${port.wpiNumber}`,
            position,
            text: port.portName,
            font: '10px Inter, sans-serif',
            fillColor: isHighlight
              ? Cesium.Color.fromCssColorString('#38bdf8')
              : isAntarctic
              ? Cesium.Color.fromCssColorString('#e2e8f0')
              : Cesium.Color.fromCssColorString('#cbd5e1'),
            outlineColor: Cesium.Color.fromCssColorString('#030a16'),
            outlineWidth: 2.0,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -9),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, maxLabelDistance),
            scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.0, 2.0e6, 0.75),
            showBackground: false,
          });
        }
      }

      viewer.scene.primitives.add(pointCollection);
      viewer.scene.primitives.add(labelCollection);

      portPointsRef.current = pointCollection;
      portLabelsRef.current = labelCollection;

      viewer.scene.requestRender();

      return () => {
        if (viewer && !viewer.isDestroyed()) {
          if (pointCollection && !pointCollection.isDestroyed()) {
            viewer.scene.primitives.remove(pointCollection);
          }
          if (labelCollection && !labelCollection.isDestroyed()) {
            viewer.scene.primitives.remove(labelCollection);
          }
        }
      };
    }, [ports, layerFilter]);

    // Sync visual selection ring for selected port
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      let portRing = viewer.entities.getById('port-selection-ring');

      if (selectedPort) {
        const posCartesian = Cesium.Cartesian3.fromDegrees(
          selectedPort.longitude,
          selectedPort.latitude,
          0
        );

        const countryText = selectedPort.countryCode
          ? ` (${selectedPort.countryCode})`
          : selectedPort.regionName
          ? ` (${selectedPort.regionName.split('--')[0].trim()})`
          : '';
        const labelText = `${selectedPort.portName}${countryText}\nWPI ${selectedPort.wpiNumber}`;

        if (!portRing) {
          viewer.entities.add({
            id: 'port-selection-ring',
            name: `Selected: ${selectedPort.portName}`,
            position: posCartesian,
            point: {
              pixelSize: 14,
              color: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.25),
              outlineColor: Cesium.Color.fromCssColorString('#38bdf8'),
              outlineWidth: 2.0,
              scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.3, 9.0e6, 1.1),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
              text: labelText,
              font: 'bold 11px Inter, sans-serif',
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              fillColor: Cesium.Color.fromCssColorString('#38bdf8'),
              outlineColor: Cesium.Color.fromCssColorString('#020617'),
              outlineWidth: 3,
              pixelOffset: new Cesium.Cartesian2(0, -15),
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              showBackground: false,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 25000000.0),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        } else {
          portRing.position = new Cesium.ConstantPositionProperty(posCartesian);
          portRing.name = `Selected: ${selectedPort.portName}`;
          if (portRing.label) {
            portRing.label.text = new Cesium.ConstantProperty(labelText);
            portRing.label.showBackground = new Cesium.ConstantProperty(false);
          }
          portRing.show = true;
        }

        const windowCoord = computeVisibleScreenCoord(viewer.scene, posCartesian);
        onPortScreenPosChangeRef.current?.(windowCoord);
      } else if (portRing) {
        portRing.show = false;
        onPortScreenPosChangeRef.current?.(null);
      }

      viewer.scene.requestRender();
    }, [selectedPort]);

    const icebergEntityIdsRef = useRef<string[]>([]);
    const icebergPointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const icebergLabelsRef = useRef<Cesium.LabelCollection | null>(null);

    // Sync real-world USNIC Antarctic Icebergs dataset with Cesium polygon boundaries & primitives
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      // Clean up previous iceberg entities
      for (const entityId of icebergEntityIdsRef.current) {
        viewer.entities.removeById(entityId);
      }
      icebergEntityIdsRef.current = [];

      // Clean up previous primitive collections if any
      if (icebergPointsRef.current && !icebergPointsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(icebergPointsRef.current);
        icebergPointsRef.current = null;
      }
      if (icebergLabelsRef.current && !icebergLabelsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(icebergLabelsRef.current);
        icebergLabelsRef.current = null;
      }

      if (!icebergs || icebergs.length === 0) return;

      const isSubdued = layerFilter !== 'ALL';

      const pointCollection = new Cesium.PointPrimitiveCollection();
      const labelCollection = new Cesium.LabelCollection();
      const addedEntityIds: string[] = [];

      for (let i = 0; i < icebergs.length; i++) {
        const berg = icebergs[i];
        const centerPos = Cesium.Cartesian3.fromDegrees(berg.longitude, berg.latitude, 0);

        // CASE A: Real Iceberg Polygon / Boundary Exists -> Render actual source geometry
        if (berg.hasRealBoundary && berg.boundaryCoordinates && berg.boundaryCoordinates.length >= 3) {
          const polyEntityId = `iceberg-boundary-${berg.id}`;
          addedEntityIds.push(polyEntityId);

          const flatCoords = berg.boundaryCoordinates.flat();
          const polylineHeights = berg.boundaryCoordinates
            .map(([lon, lat]) => [lon, lat, isSubdued ? 30 : 100])
            .flat();

          viewer.entities.add({
            id: polyEntityId,
            name: `${berg.name} (USNIC Real Tracked Boundary: ${berg.length} x ${berg.width})`,
            polygon: {
              hierarchy: Cesium.Cartesian3.fromDegreesArray(flatCoords),
              material: isSubdued
                ? Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.04)
                : Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.12),
              height: 50,
            },
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(polylineHeights),
              width: isSubdued ? 0.8 : 1.5,
              material: new Cesium.ColorMaterialProperty(
                isSubdued
                  ? Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.20)
                  : Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.95)
              ),
              arcType: Cesium.ArcType.NONE,
            },
          });
        }

        // Center Point marker for geographic presence across zoom scales
        pointCollection.add({
          position: centerPos,
          pixelSize: isSubdued ? 3.0 : 4.5,
          color: isSubdued
            ? Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.25)
            : Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.9),
          outlineColor: isSubdued
            ? Cesium.Color.TRANSPARENT
            : Cesium.Color.fromCssColorString('#030a16'),
          outlineWidth: isSubdued ? 0 : 1.0,
          scaleByDistance: isSubdued
            ? new Cesium.NearFarScalar(1.0e3, 1.0, 5.0e6, 0.4)
            : new Cesium.NearFarScalar(1.0e3, 1.1, 7.0e6, 0.7),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, isSubdued ? 4000000.0 : 9000000.0),
          id: `iceberg-point-${berg.id}`,
        });

        // Iceberg ID label (only when not subdued)
        if (!isSubdued) {
          labelCollection.add({
            id: `iceberg-label-${berg.id}`,
            position: centerPos,
            text: berg.id,
            font: '10px Inter, sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#fca5a5'),
            outlineColor: Cesium.Color.fromCssColorString('#030a16'),
            outlineWidth: 2.0,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -9),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4500000.0),
            scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.0, 5.0e6, 0.8),
          });
        }
      }

      viewer.scene.primitives.add(pointCollection);
      viewer.scene.primitives.add(labelCollection);

      icebergEntityIdsRef.current = addedEntityIds;
      icebergPointsRef.current = pointCollection;
      icebergLabelsRef.current = labelCollection;

      viewer.scene.requestRender();

      return () => {
        if (viewer && !viewer.isDestroyed()) {
          for (const entityId of addedEntityIds) {
            viewer.entities.removeById(entityId);
          }
          if (pointCollection && !pointCollection.isDestroyed()) {
            viewer.scene.primitives.remove(pointCollection);
          }
          if (labelCollection && !labelCollection.isDestroyed()) {
            viewer.scene.primitives.remove(labelCollection);
          }
        }
      };
    }, [icebergs, layerFilter]);

    const sentinel1PointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const sentinel1TacticalPolylinesRef = useRef<Cesium.PolylineCollection | null>(null);
    const sentinel1DataRef = useRef<Sentinel1GroundedIcebergRecord[]>([]);
    sentinel1DataRef.current = sentinel1Icebergs || [];

    // Sync real-world Sentinel-1 Circum-Antarctic Grounded Iceberg Dataset (39,619 stationary targets)
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      // Clean up previous primitive collections if any
      if (sentinel1PointsRef.current && !sentinel1PointsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(sentinel1PointsRef.current);
        sentinel1PointsRef.current = null;
      }
      if (sentinel1TacticalPolylinesRef.current && !sentinel1TacticalPolylinesRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(sentinel1TacticalPolylinesRef.current);
        sentinel1TacticalPolylinesRef.current = null;
      }

      if (!sentinel1Icebergs || sentinel1Icebergs.length === 0) return;

      const isHighlight = layerFilter === 'FIXED';
      const isSubdued = layerFilter === 'PORTS' || layerFilter === 'MOVING';

      // 1. Instanced GPU Point Mesh for all 39,619 stationary targets across circum-Antarctic overview
      const pointCollection = new Cesium.PointPrimitiveCollection();
      const tacticalPolylines = new Cesium.PolylineCollection();

      const outsideColor = isHighlight
        ? Cesium.Color.fromCssColorString('#ff1744')
        : isSubdued
        ? Cesium.Color.fromCssColorString('#e11d48').withAlpha(0.18)
        : Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.9);

      const partialColor = isHighlight
        ? Cesium.Color.fromCssColorString('#f43f5e')
        : isSubdued
        ? Cesium.Color.fromCssColorString('#f43f5e').withAlpha(0.14)
        : Cesium.Color.fromCssColorString('#f87171').withAlpha(0.75);

      const insideColor = isHighlight
        ? Cesium.Color.fromCssColorString('#fb7185')
        : isSubdued
        ? Cesium.Color.fromCssColorString('#fb7185').withAlpha(0.10)
        : Cesium.Color.fromCssColorString('#fb7185').withAlpha(0.55);

      for (let i = 0; i < sentinel1Icebergs.length; i++) {
        const berg = sentinel1Icebergs[i];
        if (!Number.isFinite(berg.latitude) || !Number.isFinite(berg.longitude)) continue;

        const isOutside = berg.fastIceStatus === 'Outside';
        const isPartial = berg.fastIceStatus === 'Partial';
        const color = isOutside ? outsideColor : isPartial ? partialColor : insideColor;
        const pixelSize = isHighlight
          ? (isOutside ? 6.0 : isPartial ? 4.8 : 3.8)
          : isSubdued
          ? (isOutside ? 2.0 : 1.5)
          : (isOutside ? 3.0 : isPartial ? 2.4 : 2.0);

        // Stationary target hazard point marker
        pointCollection.add({
          position: Cesium.Cartesian3.fromDegrees(berg.longitude, berg.latitude, 0),
          pixelSize,
          color,
          outlineColor: isHighlight
            ? Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.9)
            : isSubdued
            ? Cesium.Color.TRANSPARENT
            : Cesium.Color.fromCssColorString('#030a16'),
          outlineWidth: isHighlight ? 1.2 : isSubdued ? 0 : 0.8,
          scaleByDistance: isHighlight
            ? new Cesium.NearFarScalar(1.0e3, 1.4, 8.0e6, 0.85)
            : isSubdued
            ? new Cesium.NearFarScalar(1.0e3, 1.0, 5.0e6, 0.4)
            : new Cesium.NearFarScalar(1.0e3, 1.2, 8.0e6, 0.6),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            isHighlight ? 18000000.0 : isSubdued ? 6000000.0 : 12000000.0
          ),
          id: `s1-point-${berg.id}`,
        });
      }

      viewer.scene.primitives.add(pointCollection);
      viewer.scene.primitives.add(tacticalPolylines);

      sentinel1PointsRef.current = pointCollection;
      sentinel1TacticalPolylinesRef.current = tacticalPolylines;

      // 2. Dynamic Viewport-Driven Tactical LOD for Polygon Boundaries
      const updateTacticalPolygons = () => {
        if (!viewer || viewer.isDestroyed()) return;
        const polyCol = sentinel1TacticalPolylinesRef.current;
        if (!polyCol || polyCol.isDestroyed()) return;

        polyCol.removeAll();

        // If subdued, do not render tactical polygon outlines (keeps background clean)
        if (isSubdued) {
          viewer.scene.requestRender();
          return;
        }

        const cameraHeight = viewer.camera.positionCartographic.height;
        const maxPolyHeight = isHighlight ? 2500000.0 : 1200000.0;
        if (cameraHeight > maxPolyHeight) {
          viewer.scene.requestRender();
          return;
        }

        const viewRect = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
        if (!viewRect) {
          viewer.scene.requestRender();
          return;
        }

        const minLon = Cesium.Math.toDegrees(viewRect.west);
        const maxLon = Cesium.Math.toDegrees(viewRect.east);
        const minLat = Cesium.Math.toDegrees(viewRect.south);
        const maxLat = Cesium.Math.toDegrees(viewRect.north);

        const outsidePolyColor = isHighlight
          ? Cesium.Color.fromCssColorString('#ff2255')
          : Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.85);
        const otherPolyColor = isHighlight
          ? Cesium.Color.fromCssColorString('#fb7185')
          : Cesium.Color.fromCssColorString('#f87171').withAlpha(0.65);

        const currentData = sentinel1DataRef.current;
        let renderedCount = 0;
        const MAX_TACTICAL_POLYGONS = isHighlight ? 2000 : 1200;

        for (let i = 0; i < currentData.length; i++) {
          const berg = currentData[i];
          if (!berg.boundaryCoordinates || berg.boundaryCoordinates.length < 3) continue;

          let inView = false;
          if (minLon <= maxLon) {
            inView = berg.longitude >= minLon && berg.longitude <= maxLon &&
                     berg.latitude >= minLat && berg.latitude <= maxLat;
          } else {
            // Antimeridian crossing
            inView = (berg.longitude >= minLon || berg.longitude <= maxLon) &&
                     berg.latitude >= minLat && berg.latitude <= maxLat;
          }

          if (inView) {
            const positions = berg.boundaryCoordinates.map(([lon, lat]) =>
              Cesium.Cartesian3.fromDegrees(lon, lat, 15)
            );
            polyCol.add({
              positions,
              width: isHighlight ? 2.0 : 1.0,
              material: Cesium.Material.fromType('Color', {
                color: berg.fastIceStatus === 'Outside' ? outsidePolyColor : otherPolyColor,
              }),
              id: `s1-poly-${berg.id}`,
            });
            renderedCount++;
            if (renderedCount >= MAX_TACTICAL_POLYGONS) break;
          }
        }

        viewer.scene.requestRender();
      };

      // Initial tactical polygon check
      updateTacticalPolygons();

      // Listen to camera moves for seamless tactical LOD update
      const removeCameraListener = viewer.camera.moveEnd.addEventListener(updateTacticalPolygons);

      viewer.scene.requestRender();

      return () => {
        if (removeCameraListener) removeCameraListener();
        if (viewer && !viewer.isDestroyed()) {
          if (pointCollection && !pointCollection.isDestroyed()) {
            viewer.scene.primitives.remove(pointCollection);
          }
          if (tacticalPolylines && !tacticalPolylines.isDestroyed()) {
            viewer.scene.primitives.remove(tacticalPolylines);
          }
        }
      };
    }, [sentinel1Icebergs, layerFilter]);

    const driftingPointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const driftingLabelsRef = useRef<Cesium.LabelCollection | null>(null);
    const selectedTrajectoryLinesRef = useRef<Cesium.PolylineCollection | null>(null);
    const selectedTrajectoryPointsRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
    const selectedDriftEntityRef = useRef<string | null>(null);

    // 1. Sync real-world BYU / NIC Antarctic Drifting Iceberg Latest Positions (624 icebergs)
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      if (driftingPointsRef.current && !driftingPointsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(driftingPointsRef.current);
        driftingPointsRef.current = null;
      }
      if (driftingLabelsRef.current && !driftingLabelsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(driftingLabelsRef.current);
        driftingLabelsRef.current = null;
      }

      driftingMapRef.current.clear();

      if (!driftingIcebergs || driftingIcebergs.length === 0) return;

      const isHighlight = layerFilter === 'MOVING';
      const isSubdued = layerFilter === 'PORTS' || layerFilter === 'FIXED';

      const pointCollection = new Cesium.PointPrimitiveCollection();
      const labelCollection = new Cesium.LabelCollection();

      const amberColor = isHighlight
        ? Cesium.Color.fromCssColorString('#fbbf24')
        : isSubdued
        ? Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.20)
        : Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.88);

      const openOceanColor = isHighlight
        ? Cesium.Color.fromCssColorString('#fbbf24')
        : isSubdued
        ? Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.22)
        : Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.95);

      for (let i = 0; i < driftingIcebergs.length; i++) {
        const berg = driftingIcebergs[i];
        if (!berg.latestPos || !Number.isFinite(berg.latestPos.lat) || !Number.isFinite(berg.latestPos.lon)) continue;

        driftingMapRef.current.set(berg.id, berg);

        // Render latest observation position as hazard point
        pointCollection.add({
          position: Cesium.Cartesian3.fromDegrees(berg.latestPos.lon, berg.latestPos.lat, 30),
          pixelSize: isHighlight
            ? (berg.openOcean ? 9.5 : 7.5)
            : isSubdued
            ? 2.2
            : (berg.openOcean ? 3.0 : 2.2),
          color: berg.openOcean ? openOceanColor : amberColor,
          outlineColor: isHighlight
            ? Cesium.Color.fromCssColorString('#ffffff')
            : isSubdued
            ? Cesium.Color.TRANSPARENT
            : Cesium.Color.fromCssColorString('#030a16'),
          outlineWidth: isHighlight ? 2.0 : isSubdued ? 0 : 0.8,
          scaleByDistance: isHighlight
            ? new Cesium.NearFarScalar(1.0e3, 1.4, 8.0e6, 0.95)
            : isSubdued
            ? new Cesium.NearFarScalar(1.0e3, 1.0, 5.0e6, 0.4)
            : new Cesium.NearFarScalar(1.0e3, 1.2, 8.0e6, 0.65),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            isHighlight ? 18000000.0 : isSubdued ? 5000000.0 : 12000000.0
          ),
          id: `drift-point-${berg.id}`,
        });

        // Tactical label (shown broadly when isHighlight, or close up when isNormal for openOcean, none when isSubdued)
        if (isHighlight || (!isSubdued && berg.openOcean)) {
          labelCollection.add({
            position: Cesium.Cartesian3.fromDegrees(berg.latestPos.lon, berg.latestPos.lat, 30),
            text: berg.id,
            font: isHighlight ? 'bold 11px Inter, sans-serif' : '9px Inter, sans-serif',
            fillColor: Cesium.Color.fromCssColorString('#fbbf24'),
            outlineColor: Cesium.Color.fromCssColorString('#030a16'),
            outlineWidth: 2.5,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, isHighlight ? -12 : -8),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, isHighlight ? 8000000.0 : 2500000.0),
            scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.0, 4.0e6, 0.75),
            showBackground: isHighlight,
            backgroundColor: Cesium.Color.fromCssColorString('#020617').withAlpha(0.85),
            backgroundPadding: new Cesium.Cartesian2(4, 2),
          });
        }
      }

      viewer.scene.primitives.add(pointCollection);
      viewer.scene.primitives.add(labelCollection);

      driftingPointsRef.current = pointCollection;
      driftingLabelsRef.current = labelCollection;

      viewer.scene.requestRender();

      return () => {
        if (viewer && !viewer.isDestroyed()) {
          if (pointCollection && !pointCollection.isDestroyed()) {
            viewer.scene.primitives.remove(pointCollection);
          }
          if (labelCollection && !labelCollection.isDestroyed()) {
            viewer.scene.primitives.remove(labelCollection);
          }
        }
      };
    }, [driftingIcebergs, layerFilter]);

    // 2. Render Historical Trajectory ONLY for the currently selected drifting iceberg
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      // Clean up previous selected trajectory primitives & ring
      if (selectedTrajectoryLinesRef.current && !selectedTrajectoryLinesRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(selectedTrajectoryLinesRef.current);
        selectedTrajectoryLinesRef.current = null;
      }
      if (selectedTrajectoryPointsRef.current && !selectedTrajectoryPointsRef.current.isDestroyed()) {
        viewer.scene.primitives.remove(selectedTrajectoryPointsRef.current);
        selectedTrajectoryPointsRef.current = null;
      }
      if (selectedDriftEntityRef.current) {
        viewer.entities.removeById(selectedDriftEntityRef.current);
        selectedDriftEntityRef.current = null;
      }

      // If filter is PORTS or FIXED, hide drifting trajectory
      if (layerFilter === 'PORTS' || layerFilter === 'FIXED') {
        viewer.scene.requestRender();
        return;
      }

      if (!selectedDriftingIceberg || !selectedDriftingIceberg.coords || selectedDriftingIceberg.coords.length < 2) {
        viewer.scene.requestRender();
        return;
      }

      const berg = selectedDriftingIceberg;
      const trajLineCollection = new Cesium.PolylineCollection();
      const trajPointCollection = new Cesium.PointPrimitiveCollection();

      // Downsample trajectory coordinates for smooth WebGL rendering (max ~150 points)
      const step = Math.max(1, Math.floor(berg.coords.length / 150));
      const positions: Cesium.Cartesian3[] = [];

      for (let j = 0; j < berg.coords.length; j += step) {
        const p = berg.coords[j];
        const pos = Cesium.Cartesian3.fromDegrees(p[0], p[1], 25);
        positions.push(pos);
        trajPointCollection.add({
          position: pos,
          pixelSize: 2.0,
          color: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.45),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6000000.0),
        });
      }

      // Add exact last point
      const lastPt = berg.coords[berg.coords.length - 1];
      positions.push(Cesium.Cartesian3.fromDegrees(lastPt[0], lastPt[1], 25));

      // Single subtle, restrained historical trajectory polyline
      trajLineCollection.add({
        positions,
        width: 1.5,
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.8),
        }),
        id: `selected-traj-${berg.id}`,
      });

      viewer.scene.primitives.add(trajLineCollection);
      viewer.scene.primitives.add(trajPointCollection);

      selectedTrajectoryLinesRef.current = trajLineCollection;
      selectedTrajectoryPointsRef.current = trajPointCollection;

      // Add selection ring around latest observation position
      const latestPos = Cesium.Cartesian3.fromDegrees(berg.latestPos.lon, berg.latestPos.lat, 30);
      const ringId = `drift-selection-ring-${berg.id}`;
      viewer.entities.add({
        id: ringId,
        position: latestPos,
        ellipse: {
          semiMinorAxis: 18000.0,
          semiMajorAxis: 18000.0,
          height: 35,
          material: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.2),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.9),
          outlineWidth: 2,
        },
      });
      selectedDriftEntityRef.current = ringId;

      viewer.scene.requestRender();

      return () => {
        if (viewer && !viewer.isDestroyed()) {
          if (trajLineCollection && !trajLineCollection.isDestroyed()) {
            viewer.scene.primitives.remove(trajLineCollection);
          }
          if (trajPointCollection && !trajPointCollection.isDestroyed()) {
            viewer.scene.primitives.remove(trajPointCollection);
          }
          if (selectedDriftEntityRef.current) {
            viewer.entities.removeById(selectedDriftEntityRef.current);
            selectedDriftEntityRef.current = null;
          }
        }
      };
    }, [selectedDriftingIceberg, layerFilter]);

    const hazardEntityIdsRef = useRef<string[]>([]);

    // 3. Render Subtle Visual Emphasis for Spatially Detected Iceberg Hazards
    useEffect(() => {
      const viewer = viewerRef.current;
      if (!viewer || viewer.isDestroyed()) return;

      // Clean up previous hazard highlight entities
      for (const id of hazardEntityIdsRef.current) {
        viewer.entities.removeById(id);
      }
      hazardEntityIdsRef.current = [];

      if (!hazardReport || !hazardReport.hazards || hazardReport.hazards.length === 0) {
        viewer.scene.requestRender();
        return;
      }

      const addedIds: string[] = [];

      for (let i = 0; i < hazardReport.hazards.length; i++) {
        const h = hazardReport.hazards[i];
        const isIsect = h.relationship === 'INTERSECTING';
        const entityId = `hazard-highlight-${h.sourceDataset}-${h.icebergId}-${i}`;
        addedIds.push(entityId);

        const posCartesian = Cesium.Cartesian3.fromDegrees(
          h.icebergPosition[0],
          h.icebergPosition[1],
          40
        );

        // Subtle, quiet hazard emphasis ring
        viewer.entities.add({
          id: entityId,
          name: `Hazard: ${h.icebergId} (${h.sourceDataset} - ${h.relationship})`,
          position: posCartesian,
          point: {
            pixelSize: isIsect ? 16 : 12,
            color: Cesium.Color.TRANSPARENT,
            outlineColor: isIsect
              ? Cesium.Color.fromCssColorString('#f43f5e').withAlpha(0.95)
              : Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.85),
            outlineWidth: isIsect ? 2.0 : 1.5,
            scaleByDistance: new Cesium.NearFarScalar(1.0e3, 1.2, 8.0e6, 0.8),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }

      hazardEntityIdsRef.current = addedIds;
      viewer.scene.requestRender();

      return () => {
        if (viewer && !viewer.isDestroyed()) {
          for (const id of addedIds) {
            viewer.entities.removeById(id);
          }
        }
      };
    }, [hazardReport]);

    return (
      <div className={`w-full h-full relative ${className}`}>
        <div ref={containerRef} className="w-full h-full" />
      </div>
    );
  }
);

CesiumGlobe.displayName = 'CesiumGlobe';
