import React, { FC, useEffect, useRef, useState, useCallback } from 'react';
import type {
  PortRecord,
  IcebergRecord,
  Sentinel1GroundedIcebergRecord,
  DriftingIcebergTrajectoryRecord,
  MaritimeRouteResult,
  RouteSimulationPoint,
  LayerFilterMode,
} from '../../types';
import { loadSouthernLandRings, LandPolygonRing } from '../../services/landService';
import {
  EARTH_RADIUS_METERS,
  degreesToRadians,
  haversineDistanceMeters,
} from '../../utils/geo';
import { LayerHighlightToggle } from '../mission/LayerHighlightToggle';
import { TacticalControls } from './TacticalControls';
import { TacticalInspector, SelectedEntity } from './TacticalInspector';

export interface Tactical2DViewProps {
  ports?: PortRecord[];
  departurePort: PortRecord | null;
  destinationPort: PortRecord | null;
  routeResult: MaritimeRouteResult | null;
  icebergs: IcebergRecord[];
  sentinel1Icebergs: Sentinel1GroundedIcebergRecord[];
  driftingIcebergs: DriftingIcebergTrajectoryRecord[];
  vesselPoint: RouteSimulationPoint;
  simStatus: 'PLAYING' | 'PAUSED' | 'IDLE' | 'COMPLETED';
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSeekDistance: (distanceMeters: number) => void;
  simSpeedMultiplier: number;
  onSetSimSpeed: (multiplier: number) => void;
  onBackToGlobe: () => void;
  layerFilter?: LayerFilterMode;
  onSelectLayerFilter?: (mode: LayerFilterMode) => void;
}

/**
 * Tactical2DView
 *
 * High-performance 2D HTML5 Canvas tactical navigation display.
 * Renders an interactive tactical radar situational overview centered on the vessel or polar route:
 * 1. Deep ocean backdrop and geographic graticule coordinates.
 * 2. Natural Earth Southern Hemisphere landmass polygons (cached from LandService).
 * 3. Maritime route corridor with traversed vs remaining legs and waypoints.
 * 4. Spatial hazards: USNIC polygon geometries, Sentinel-1 radar groundings, BYU/NIC trajectories.
 * 5. Dynamic radar proximity rings (5 NM / 10 NM) and vessel heading vector.
 * 6. Dynamic nautical distance scale bar.
 */
export const Tactical2DView: FC<Tactical2DViewProps> = ({
  ports = [],
  departurePort,
  destinationPort,
  routeResult,
  icebergs,
  sentinel1Icebergs,
  driftingIcebergs,
  vesselPoint,
  simStatus,
  onPlay,
  onPause,
  onReset,
  onSeekDistance,
  simSpeedMultiplier,
  onSetSimSpeed,
  onBackToGlobe,
  layerFilter = 'ALL',
  onSelectLayerFilter,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [landRings, setLandRings] = useState<LandPolygonRing[]>([]);
  const [followVessel, setFollowVessel] = useState<boolean>(true);
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity>(null);

  // Viewport camera state [centerLon, centerLat, metersPerPixel]
  const [viewCenter, setViewCenter] = useState<{ lon: number; lat: number }>({
    lon: vesselPoint.coordinate[0],
    lat: vesselPoint.coordinate[1],
  });
  const [zoomLevel, setZoomLevel] = useState<number>(380); // meters per canvas pixel (smaller = closer)

  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number; startLon: number; startLat: number }>({
    x: 0,
    y: 0,
    startLon: 0,
    startLat: 0,
  });

  // Load real landmass polygons once from unified land service
  useEffect(() => {
    let active = true;
    loadSouthernLandRings().then((rings) => {
      if (active) setLandRings(rings);
    });
    return () => {
      active = false;
    };
  }, []);

  // Update center when followVessel is enabled and vessel moves
  useEffect(() => {
    if (followVessel) {
      setViewCenter({
        lon: vesselPoint.coordinate[0],
        lat: vesselPoint.coordinate[1],
      });
    }
  }, [followVessel, vesselPoint.coordinate]);

  // Initial Framing when opening tactical view
  useEffect(() => {
    if (departurePort) {
      setViewCenter({
        lon: departurePort.longitude,
        lat: departurePort.latitude,
      });
      setZoomLevel(320);
    }
  }, [departurePort]);

  // Coordinate Conversion Math (Local Equirectangular projection centered on view)
  const projectToScreen = useCallback(
    (lon: number, lat: number, width: number, height: number): [number, number] => {
      const centerLatRad = degreesToRadians(viewCenter.lat);
      const cosLat = Math.cos(centerLatRad);

      const dxMeters = degreesToRadians(lon - viewCenter.lon) * EARTH_RADIUS_METERS * cosLat;
      const dyMeters = degreesToRadians(lat - viewCenter.lat) * EARTH_RADIUS_METERS;

      const screenX = width / 2.0 + dxMeters / zoomLevel;
      const screenY = height / 2.0 - dyMeters / zoomLevel; // Y is inverted on screen

      return [screenX, screenY];
    },
    [viewCenter.lon, viewCenter.lat, zoomLevel]
  );

  const unprojectFromScreen = useCallback(
    (screenX: number, screenY: number, width: number, height: number): [number, number] => {
      const centerLatRad = degreesToRadians(viewCenter.lat);
      const cosLat = Math.cos(centerLatRad);

      const dxMeters = (screenX - width / 2.0) * zoomLevel;
      const dyMeters = (height / 2.0 - screenY) * zoomLevel;

      const dLon = (dxMeters / (EARTH_RADIUS_METERS * cosLat)) * (180.0 / Math.PI);
      const dLat = (dyMeters / EARTH_RADIUS_METERS) * (180.0 / Math.PI);

      return [viewCenter.lon + dLon, viewCenter.lat + dLat];
    },
    [viewCenter.lon, viewCenter.lat, zoomLevel]
  );

  // Compute nearby icebergs dynamically from vessel's real position (within 150 km)
  const nearbyRadiusMeters = 150000.0; // 150 km (~81 NM)
  const [vesselLon, vesselLat] = vesselPoint.coordinate;

  const nearbyUsnic = icebergs
    .map((berg) => {
      const dist = haversineDistanceMeters(
        vesselLon,
        vesselLat,
        berg.longitude,
        berg.latitude
      );
      return { berg, dist };
    })
    .filter((item) => item.dist <= nearbyRadiusMeters);

  const nearbySentinel1 = sentinel1Icebergs
    .map((berg) => {
      const dist = haversineDistanceMeters(
        vesselLon,
        vesselLat,
        berg.longitude,
        berg.latitude
      );
      return { berg, dist };
    })
    .filter((item) => item.dist <= nearbyRadiusMeters);

  const nearbyDrifting = driftingIcebergs
    .filter((berg) => berg.latestPos)
    .map((berg) => {
      const dist = haversineDistanceMeters(
        vesselLon,
        vesselLat,
        berg.latestPos!.lon,
        berg.latestPos!.lat
      );
      return { berg, dist };
    })
    .filter((item) => item.dist <= nearbyRadiusMeters);

  const nearbyPorts = (ports || [])
    .filter((p) => p.latitude <= 0.0)
    .map((port) => {
      const dist = haversineDistanceMeters(
        vesselLon,
        vesselLat,
        port.longitude,
        port.latitude
      );
      return { port, dist };
    })
    .filter((item) => item.dist <= nearbyRadiusMeters * 2);

  // Main Canvas Rendering Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. Deep Ocean Background
    ctx.fillStyle = '#020813';
    ctx.fillRect(0, 0, width, height);

    // 2. Coordinate Graticule Grid Lines & Labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#0f1f38';
    ctx.fillStyle = '#334155';
    ctx.font = '9px monospace';

    const latStep = zoomLevel > 600 ? 2 : zoomLevel > 200 ? 1 : 0.5;
    const lonStep = zoomLevel > 600 ? 4 : zoomLevel > 200 ? 2 : 1;

    const [minLon, maxLat] = unprojectFromScreen(0, 0, width, height);
    const [maxLon, minLat] = unprojectFromScreen(width, height, width, height);

    const startLat = Math.floor(minLat / latStep) * latStep;
    const endLat = Math.ceil(maxLat / latStep) * latStep;
    for (let lat = startLat; lat <= endLat; lat += latStep) {
      const [, y] = projectToScreen(viewCenter.lon, lat, width, height);
      if (y >= 0 && y <= height) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        ctx.fillText(`${Math.abs(lat).toFixed(latStep < 1 ? 1 : 0)}°${lat < 0 ? 'S' : 'N'}`, 8, y - 3);
      }
    }

    const startLon = Math.floor(minLon / lonStep) * lonStep;
    const endLon = Math.ceil(maxLon / lonStep) * lonStep;
    for (let lon = startLon; lon <= endLon; lon += lonStep) {
      const [x] = projectToScreen(lon, viewCenter.lat, width, height);
      if (x >= 0 && x <= width) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillText(
          `${Math.abs(lon).toFixed(lonStep < 1 ? 1 : 0)}°${lon < 0 ? 'W' : 'E'}`,
          x + 4,
          height - 8
        );
      }
    }

    // 3. Render Real Coastline Polygons
    if (landRings.length > 0) {
      ctx.fillStyle = '#0a1628';
      ctx.strokeStyle = '#1e385c';
      ctx.lineWidth = 1.0;

      for (let i = 0; i < landRings.length; i++) {
        const { bbox, ring } = landRings[i];
        // Bounding box viewport pre-test
        if (
          bbox[2] < minLon ||
          bbox[0] > maxLon ||
          bbox[3] < minLat ||
          bbox[1] > maxLat
        ) {
          continue;
        }

        if (ring.length < 3) continue;

        ctx.beginPath();
        const [startX, startY] = projectToScreen(ring[0][0], ring[0][1], width, height);
        ctx.moveTo(startX, startY);

        for (let j = 1; j < ring.length; j++) {
          const [px, py] = projectToScreen(ring[j][0], ring[j][1], width, height);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // 4. Render Calculated Maritime Route LineString
    if (routeResult && routeResult.coordinates.length >= 2) {
      const coords = routeResult.coordinates;

      // Subtle Route Navigation Corridor Buffer (5 km)
      ctx.lineWidth = Math.max(8, 10000 / zoomLevel);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.04)';
      ctx.beginPath();
      const [initX, initY] = projectToScreen(coords[0][0], coords[0][1], width, height);
      ctx.moveTo(initX, initY);
      for (let i = 1; i < coords.length; i++) {
        const [rx, ry] = projectToScreen(coords[i][0], coords[i][1], width, height);
        ctx.lineTo(rx, ry);
      }
      ctx.stroke();

      // Traveled Segment (Muted Slate Dashed)
      const curSeg = vesselPoint.segmentIndex;
      if (curSeg > 0) {
        ctx.lineWidth = 2.0;
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#475569';
        ctx.beginPath();
        ctx.moveTo(initX, initY);
        for (let i = 1; i <= curSeg; i++) {
          const [rx, ry] = projectToScreen(coords[i][0], coords[i][1], width, height);
          ctx.lineTo(rx, ry);
        }
        const [vX, vY] = projectToScreen(vesselLon, vesselLat, width, height);
        ctx.lineTo(vX, vY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Remaining Active Route (Luminous Cyan Solid)
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = '#38bdf8';
      ctx.beginPath();
      const [vX, vY] = projectToScreen(vesselLon, vesselLat, width, height);
      ctx.moveTo(vX, vY);
      for (let i = curSeg + 1; i < coords.length; i++) {
        const [rx, ry] = projectToScreen(coords[i][0], coords[i][1], width, height);
        ctx.lineTo(rx, ry);
      }
      ctx.stroke();

      // Waypoint Nodes
      for (let i = 0; i < coords.length; i++) {
        const [wx, wy] = projectToScreen(coords[i][0], coords[i][1], width, height);
        ctx.fillStyle = i <= curSeg ? '#64748b' : '#38bdf8';
        ctx.beginPath();
        ctx.arc(wx, wy, 3, 0, Math.PI * 2);
        ctx.fill();

        if (zoomLevel < 500 && i > 0 && i < coords.length - 1) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = '8px monospace';
          ctx.fillText(`WP${i}`, wx + 5, wy - 5);
        }
      }
    }

    // 5. Selected BYU/NIC Historical Trajectory Track (if BYU/NIC iceberg selected)
    if (selectedEntity && selectedEntity.type === 'BYU_NIC') {
      const traj = selectedEntity.data.coords;
      if (traj && traj.length >= 2) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        const [firstX, firstY] = projectToScreen(traj[0][0], traj[0][1], width, height);
        ctx.moveTo(firstX, firstY);

        for (let k = 1; k < traj.length; k++) {
          const [tx, ty] = projectToScreen(traj[k][0], traj[k][1], width, height);
          ctx.lineTo(tx, ty);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Historical Track Observation Dots
        for (let k = 0; k < traj.length; k++) {
          const [tx, ty] = projectToScreen(traj[k][0], traj[k][1], width, height);
          ctx.fillStyle = k === traj.length - 1 ? '#f59e0b' : '#b45309';
          ctx.beginPath();
          ctx.arc(tx, ty, k === traj.length - 1 ? 4 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 6. Render USNIC Macro Icebergs (Real Polygons & Centroids)
    {
      const isSubdued = layerFilter !== 'ALL';
      for (const { berg } of nearbyUsnic) {
        const isSelected = selectedEntity?.type === 'USNIC' && selectedEntity.data.id === berg.id;
        const poly = berg.boundaryCoordinates;

        if (poly && poly.length >= 3) {
          ctx.beginPath();
          const [firstX, firstY] = projectToScreen(poly[0][0], poly[0][1], width, height);
          ctx.moveTo(firstX, firstY);
          for (let p = 1; p < poly.length; p++) {
            const [px, py] = projectToScreen(poly[p][0], poly[p][1], width, height);
            ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = isSubdued
            ? (isSelected ? 'rgba(239, 68, 68, 0.25)' : 'rgba(239, 68, 68, 0.06)')
            : (isSelected ? 'rgba(239, 68, 68, 0.4)' : 'rgba(239, 68, 68, 0.15)');
          ctx.fill();
          ctx.strokeStyle = isSubdued
            ? (isSelected ? '#ef4444' : 'rgba(239, 68, 68, 0.25)')
            : (isSelected ? '#ffffff' : '#ef4444');
          ctx.lineWidth = isSubdued ? (isSelected ? 1.5 : 0.8) : (isSelected ? 2.0 : 1.2);
          ctx.stroke();
        }

        // Centroid Marker & ID Label
        const [cx, cy] = projectToScreen(berg.longitude, berg.latitude, width, height);
        ctx.fillStyle = isSubdued
          ? (isSelected ? '#ef4444' : 'rgba(239, 68, 68, 0.35)')
          : (isSelected ? '#ffffff' : '#ef4444');
        ctx.beginPath();
        ctx.arc(cx, cy, isSubdued ? 2.5 : (isSelected ? 5 : 3.5), 0, Math.PI * 2);
        ctx.fill();

        if (!isSubdued || isSelected) {
          ctx.fillStyle = isSelected ? '#ffffff' : '#fca5a5';
          ctx.font = '10px sans-serif';
          ctx.fillText(berg.id, cx + 7, cy - 4);
        }
      }
    }

    // 7. Render Sentinel-1 Grounded Iceberg Targets
    {
      const isHighlight = layerFilter === 'FIXED';
      const isSubdued = layerFilter === 'PORTS' || layerFilter === 'MOVING';
      for (const { berg } of nearbySentinel1) {
        const isSelected = selectedEntity?.type === 'SENTINEL_1' && selectedEntity.data.id === berg.id;
        const [sx, sy] = projectToScreen(berg.longitude, berg.latitude, width, height);

        ctx.fillStyle = isHighlight
          ? (isSelected ? '#ffffff' : berg.fastIceStatus === 'Outside' ? '#ff1744' : '#f43f5e')
          : isSubdued
          ? (isSelected ? '#ffffff' : 'rgba(244, 63, 94, 0.18)')
          : (isSelected ? '#ffffff' : berg.fastIceStatus === 'Outside' ? '#ef4444' : '#fb7185');

        const sz = isHighlight ? (isSelected ? 9 : 7) : isSubdued ? 3 : 5;
        ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
        if (isHighlight || isSelected) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = isHighlight ? 1.5 : 1;
          ctx.strokeRect(sx - sz / 2, sy - sz / 2, sz, sz);
        }

        if (isHighlight || isSelected || (!isSubdued && zoomLevel < 450)) {
          ctx.fillStyle = isHighlight ? '#fecdd3' : '#cbd5e1';
          ctx.font = isHighlight ? 'bold 9px sans-serif' : '8px sans-serif';
          ctx.fillText(berg.id, sx + 6, sy + 3);
        }
      }
    }

    // 8. Render BYU/NIC Drifting Icebergs (Latest Observed Positions)
    {
      const isHighlight = layerFilter === 'MOVING';
      const isSubdued = layerFilter === 'PORTS' || layerFilter === 'FIXED';
      for (const { berg } of nearbyDrifting) {
        const isSelected = selectedEntity?.type === 'BYU_NIC' && selectedEntity.data.id === berg.id;
        const [dx, dy] = projectToScreen(berg.latestPos!.lon, berg.latestPos!.lat, width, height);

        const dSz = isHighlight ? (isSelected ? 10 : 8) : isSubdued ? 3.5 : 5;
        ctx.fillStyle = isHighlight
          ? (isSelected ? '#ffffff' : '#fbbf24')
          : isSubdued
          ? (isSelected ? '#ffffff' : 'rgba(245, 158, 11, 0.22)')
          : (isSelected ? '#ffffff' : '#f59e0b');
        ctx.beginPath();
        ctx.moveTo(dx, dy - dSz);
        ctx.lineTo(dx + dSz, dy);
        ctx.lineTo(dx, dy + dSz);
        ctx.lineTo(dx - dSz, dy);
        ctx.closePath();
        ctx.fill();
        if (isHighlight || isSelected) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        if (isHighlight || isSelected || (!isSubdued && zoomLevel < 500)) {
          ctx.fillStyle = isHighlight ? '#fef08a' : '#fde68a';
          ctx.font = isHighlight ? 'bold 10px sans-serif' : '9px sans-serif';
          ctx.fillText(berg.id, dx + 8, dy + 3);
        }
      }
    }

    // 9. Render Ports
    {
      const isHighlight = layerFilter === 'PORTS';
      const isSubdued = layerFilter === 'MOVING' || layerFilter === 'FIXED';
      for (const { port } of nearbyPorts) {
        if (port.wpiNumber === departurePort?.wpiNumber || port.wpiNumber === destinationPort?.wpiNumber) continue;
        const isSelected = selectedEntity?.type === 'PORT' && selectedEntity.data.wpiNumber === port.wpiNumber;
        const [px, py] = projectToScreen(port.longitude, port.latitude, width, height);

        ctx.fillStyle = isHighlight
          ? '#38bdf8'
          : isSubdued
          ? 'rgba(148, 163, 184, 0.22)'
          : (isSelected ? '#ffffff' : '#38bdf8');
        ctx.strokeStyle = isHighlight ? '#ffffff' : 'transparent';
        ctx.lineWidth = isHighlight ? 2 : 0;
        ctx.beginPath();
        ctx.arc(px, py, isHighlight ? (isSelected ? 9 : 7) : isSubdued ? 2.5 : (isSelected ? 7 : 5), 0, Math.PI * 2);
        if (isHighlight || isSelected) ctx.stroke();
        ctx.fill();

        if (isHighlight || isSelected || (!isSubdued && zoomLevel < 500)) {
          ctx.fillStyle = isHighlight ? '#38bdf8' : '#cbd5e1';
          ctx.font = isHighlight ? 'bold 10px sans-serif' : '9px sans-serif';
          ctx.fillText(port.portName, px + 8, py - 4);
        }
      }
    }

    // Always render Departure & Destination Ports
    if (departurePort) {
      const [depX, depY] = projectToScreen(departurePort.longitude, departurePort.latitude, width, height);
      ctx.fillStyle = '#10b981';
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(depX, depY, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();

      ctx.fillStyle = '#a7f3d0';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(`DEP: ${departurePort.portName}`, depX + 9, depY - 4);
    }

    if (destinationPort) {
      const [destX, destY] = projectToScreen(destinationPort.longitude, destinationPort.latitude, width, height);
      ctx.fillStyle = '#f43f5e';
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.4)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(destX, destY, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();

      ctx.fillStyle = '#fecdd3';
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText(`DEST: ${destinationPort.portName}`, destX + 9, destY - 4);
    }

    // 10. Render Vessel Symbol & Radar Proximity Rings
    const [shipX, shipY] = projectToScreen(vesselLon, vesselLat, width, height);

    // Radar Proximity Rings (5 NM = 9260m, 10 NM = 18520m)
    const ring5NmPixels = 9260 / zoomLevel;
    const ring10NmPixels = 18520 / zoomLevel;

    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.beginPath();
    ctx.arc(shipX, shipY, ring5NmPixels, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.15)';
    ctx.beginPath();
    ctx.arc(shipX, shipY, ring10NmPixels, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Vessel Heading Arrow Glyphs
    ctx.save();
    ctx.translate(shipX, shipY);
    ctx.rotate(degreesToRadians(vesselPoint.headingDegrees));

    // Direction-aware vessel silhouette
    ctx.fillStyle = '#38bdf8';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -12); // Bow
    ctx.lineTo(6, 8); // Starboard Stern
    ctx.lineTo(0, 4); // Center Stern Notch
    ctx.lineTo(-6, 8); // Port Stern
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Center Core Dot
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Vessel Label
    ctx.fillStyle = '#f8fafc';
    ctx.font = '10px sans-serif';
    ctx.fillText('R/V Polar Explorer', shipX + 12, shipY + 4);

    // 11. Nautical Distance Scale Bar (Bottom Right)
    const scaleBarTargetPixels = 120;
    const metersInTarget = scaleBarTargetPixels * zoomLevel;
    const nmInTarget = metersInTarget / 1852.0;

    let roundedNm = 10;
    if (nmInTarget >= 100) roundedNm = Math.round(nmInTarget / 50) * 50;
    else if (nmInTarget >= 50) roundedNm = 50;
    else if (nmInTarget >= 25) roundedNm = 25;
    else if (nmInTarget >= 10) roundedNm = 10;
    else if (nmInTarget >= 5) roundedNm = 5;
    else roundedNm = Math.max(1, Math.round(nmInTarget));

    const scaleBarActualPixels = (roundedNm * 1852.0) / zoomLevel;
    const scaleX = width - scaleBarActualPixels - 24;
    const scaleY = height - 24;

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(scaleX, scaleY);
    ctx.lineTo(scaleX + scaleBarActualPixels, scaleY);
    ctx.moveTo(scaleX, scaleY - 4);
    ctx.lineTo(scaleX, scaleY + 4);
    ctx.moveTo(scaleX + scaleBarActualPixels, scaleY - 4);
    ctx.lineTo(scaleX + scaleBarActualPixels, scaleY + 4);
    ctx.stroke();

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${roundedNm} NM`, scaleX + scaleBarActualPixels / 2.0, scaleY - 6);
    ctx.textAlign = 'left';

    ctx.restore();
  }, [
    viewCenter.lon,
    viewCenter.lat,
    zoomLevel,
    landRings,
    routeResult,
    nearbyUsnic,
    nearbySentinel1,
    nearbyDrifting,
    vesselPoint,
    departurePort,
    destinationPort,
    selectedEntity,
    projectToScreen,
    unprojectFromScreen,
    layerFilter,
    vesselLon,
    vesselLat,
  ]);

  // Mouse Interaction: Pan & Zoom
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      startLon: viewCenter.lon,
      startLat: viewCenter.lat,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDraggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      if (followVessel) {
        setFollowVessel(false);
      }
    }

    const centerLatRad = degreesToRadians(dragStartRef.current.startLat);
    const cosLat = Math.cos(centerLatRad);

    const dLonMeters = -dx * zoomLevel;
    const dLatMeters = dy * zoomLevel;

    const newLon = dragStartRef.current.startLon + (dLonMeters / (EARTH_RADIUS_METERS * cosLat)) * (180.0 / Math.PI);
    const newLat = dragStartRef.current.startLat + (dLatMeters / EARTH_RADIUS_METERS) * (180.0 / Math.PI);

    setViewCenter({
      lon: Math.max(-180, Math.min(180, newLon)),
      lat: Math.max(-85, Math.min(-40, newLat)),
    });
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 1.18 : 0.85;
    setZoomLevel((prev) => Math.max(40, Math.min(3500, prev * zoomFactor)));
  };

  // Entity Selection on Click
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    const hitRadius = 14;

    // Check Vessel Click
    const [shipX, shipY] = projectToScreen(vesselLon, vesselLat, width, height);
    if (Math.hypot(clickX - shipX, clickY - shipY) <= hitRadius) {
      setSelectedEntity({ type: 'VESSEL' });
      return;
    }

    // Check active layer first with priority
    if (layerFilter === 'PORTS') {
      for (const { port, dist } of nearbyPorts) {
        const [px, py] = projectToScreen(port.longitude, port.latitude, width, height);
        if (Math.hypot(clickX - px, clickY - py) <= hitRadius) {
          setSelectedEntity({ type: 'PORT', data: port, distanceKm: dist / 1000.0 });
          return;
        }
      }
    } else if (layerFilter === 'MOVING') {
      for (const { berg, dist } of nearbyDrifting) {
        const [dx, dy] = projectToScreen(berg.latestPos!.lon, berg.latestPos!.lat, width, height);
        if (Math.hypot(clickX - dx, clickY - dy) <= hitRadius) {
          setSelectedEntity({ type: 'BYU_NIC', data: berg, distanceKm: dist / 1000.0 });
          return;
        }
      }
    } else if (layerFilter === 'FIXED') {
      for (const { berg, dist } of nearbySentinel1) {
        const [bx, by] = projectToScreen(berg.longitude, berg.latitude, width, height);
        if (Math.hypot(clickX - bx, clickY - by) <= hitRadius) {
          setSelectedEntity({ type: 'SENTINEL_1', data: berg, distanceKm: dist / 1000.0 });
          return;
        }
      }
    }

    // Fallback check all remaining entities
    for (const { port, dist } of nearbyPorts) {
      const [px, py] = projectToScreen(port.longitude, port.latitude, width, height);
      if (Math.hypot(clickX - px, clickY - py) <= hitRadius) {
        setSelectedEntity({ type: 'PORT', data: port, distanceKm: dist / 1000.0 });
        return;
      }
    }
    for (const { berg, dist } of nearbyDrifting) {
      const [dx, dy] = projectToScreen(berg.latestPos!.lon, berg.latestPos!.lat, width, height);
      if (Math.hypot(clickX - dx, clickY - dy) <= hitRadius) {
        setSelectedEntity({ type: 'BYU_NIC', data: berg, distanceKm: dist / 1000.0 });
        return;
      }
    }
    for (const { berg, dist } of nearbySentinel1) {
      const [bx, by] = projectToScreen(berg.longitude, berg.latitude, width, height);
      if (Math.hypot(clickX - bx, clickY - by) <= hitRadius) {
        setSelectedEntity({ type: 'SENTINEL_1', data: berg, distanceKm: dist / 1000.0 });
        return;
      }
    }
    for (const { berg, dist } of nearbyUsnic) {
      const [bx, by] = projectToScreen(berg.longitude, berg.latitude, width, height);
      if (Math.hypot(clickX - bx, clickY - by) <= hitRadius) {
        setSelectedEntity({ type: 'USNIC', data: berg, distanceKm: dist / 1000.0 });
        return;
      }
    }

    // Clicked empty ocean space
    setSelectedEntity(null);
  };

  const handleCenterVessel = () => {
    setFollowVessel(true);
    setViewCenter({
      lon: vesselPoint.coordinate[0],
      lat: vesselPoint.coordinate[1],
    });
  };

  const handleFitRoute = () => {
    if (!routeResult || routeResult.coordinates.length < 2) return;
    setFollowVessel(false);
    let minLon = 180;
    let maxLon = -180;
    let minLat = 90;
    let maxLat = -90;
    for (const [lon, lat] of routeResult.coordinates) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const cLon = (minLon + maxLon) / 2.0;
    const cLat = (minLat + maxLat) / 2.0;
    setViewCenter({ lon: cLon, lat: cLat });

    const totalDistM = routeResult.distanceKm * 1000.0;
    setZoomLevel(Math.max(100, Math.min(3000, totalDistM / 1400.0)));
  };

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden bg-polar-950 select-none font-sans">
      {/* 2D Tactical Navigation View Canvas */}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onClick={handleClick}
        className="w-full h-full cursor-crosshair block"
      />

      {/* Top Header Operational HUD Bar */}
      <div className="absolute top-4 left-6 right-6 z-20 pointer-events-none flex items-start justify-between">
        <div className="flex flex-col gap-0.5 font-sans">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-200 font-sans">
            Tactical 2D Navigation View
          </div>

          <div className="text-[11px] text-slate-400 font-sans">
            {departurePort && destinationPort ? (
              <span>
                {departurePort.portName}
                <span className="text-slate-500 mx-1.5">→</span>
                {destinationPort.portName}
                {routeResult && (
                  <span className="text-slate-500 ml-1.5 font-sans">
                    ({Math.round(routeResult.distanceKm / 1.852).toLocaleString()} NM)
                  </span>
                )}
              </span>
            ) : (
              <span>No active calculated mission route</span>
            )}
          </div>
        </div>

        {/* Layer Filter and Back to 3D Globe Button */}
        <div className="pointer-events-auto flex items-center gap-4">
          {onSelectLayerFilter && (
            <LayerHighlightToggle
              activeMode={layerFilter}
              onSelectMode={onSelectLayerFilter}
              portsCount={ports.length || 3807}
              driftingCount={driftingIcebergs.length || 624}
              groundedCount={sentinel1Icebergs.length || 39619}
            />
          )}
          <button
            type="button"
            onClick={onBackToGlobe}
            className="text-slate-400 hover:text-slate-200 text-xs font-sans transition-colors cursor-pointer flex items-center gap-1"
            title="Return to primary 3D Cesium globe overview"
          >
            <span>←</span> Back to 3D Globe
          </button>
        </div>
      </div>

      {/* Selected Entity Inspector Panel (Right Drawer) */}
      <TacticalInspector
        selectedEntity={selectedEntity}
        onClose={() => setSelectedEntity(null)}
        vesselPoint={vesselPoint}
      />

      {/* Map Pan / Zoom Navigation Controls (Bottom Right) */}
      <div className="absolute bottom-20 right-4 z-20 pointer-events-auto flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setZoomLevel((z) => Math.max(40, z * 0.75))}
          className="w-7 h-7 rounded bg-polar-950/90 hover:bg-polar-900 text-slate-300 border border-polar-800 text-xs font-sans flex items-center justify-center cursor-pointer shadow-sm transition-colors"
          title="Zoom In"
        >
          +
        </button>
        <button
          type="button"
          onClick={() => setZoomLevel((z) => Math.min(3500, z * 1.35))}
          className="w-7 h-7 rounded bg-polar-950/90 hover:bg-polar-900 text-slate-300 border border-polar-800 text-xs font-sans flex items-center justify-center cursor-pointer shadow-sm transition-colors"
          title="Zoom Out"
        >
          −
        </button>
        <button
          type="button"
          onClick={handleCenterVessel}
          className={`w-7 h-7 rounded border text-xs font-sans flex items-center justify-center cursor-pointer shadow-sm transition-colors ${
            followVessel
              ? 'bg-polar-800 text-slate-100 border-slate-600'
              : 'bg-polar-950/90 hover:bg-polar-900 text-slate-400 border-polar-800'
          }`}
          title="Center view on vessel"
        >
          ⌖
        </button>
        <button
          type="button"
          onClick={handleFitRoute}
          className="w-7 h-7 rounded bg-polar-950/90 hover:bg-polar-900 text-slate-300 border border-polar-800 text-xs font-sans flex items-center justify-center cursor-pointer shadow-sm transition-colors"
          title="Fit full route in tactical view"
        >
          ⤢
        </button>
      </div>

      {/* Bottom Mission Simulation Control Console */}
      <TacticalControls
        simStatus={simStatus}
        onPlay={onPlay}
        onPause={onPause}
        onReset={onReset}
        simSpeedMultiplier={simSpeedMultiplier}
        onSetSimSpeed={onSetSimSpeed}
        followVessel={followVessel}
        onToggleFollowVessel={() => setFollowVessel(!followVessel)}
        vesselPoint={vesselPoint}
        onSeekDistance={onSeekDistance}
      />
    </div>
  );
};
