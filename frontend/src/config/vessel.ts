/**
 * Research Vessel Configuration
 *
 * Geographic coordinates and visual display parameters for the Antarctic navigation vessel.
 * The vessel position is explicitly classified as a demonstration/configured position
 * located in the open-water navigation corridor of Bransfield Strait, Southern Ocean.
 */

export interface VesselConfiguration {
  id: string;
  name: string;
  classification: 'demo/configured position';
  geographicLocation: {
    latitude: number;
    longitude: number;
    altitude: number;
    waterBody: string;
    region: string;
  };
  orientation: {
    headingDegrees: number;
    pitchDegrees: number;
    rollDegrees: number;
  };
  icon: {
    uri: string;
    width: number;
    height: number;
    scale: number;
    nearFarScalar: {
      nearDistance: number;
      nearScale: number;
      farDistance: number;
      farScale: number;
    };
  };
  model?: {
    uri: string;
    minimumPixelSize: number;
    maximumScale: number;
    scale: number;
    dimensions: {
      lengthMeters: number;
      beamMeters: number;
      heightMeters: number;
    };
  };
}

export const DEMO_VESSEL_CONFIG: VesselConfiguration = {
  id: 'rv-polar-explorer',
  name: 'R/V Polar Explorer',
  classification: 'demo/configured position',
  geographicLocation: {
    latitude: -62.8,
    longitude: -60.0,
    altitude: 0.0,
    waterBody: 'Bransfield Strait',
    region: 'Antarctic Peninsula Maritime Corridor',
  },
  orientation: {
    headingDegrees: 55.0,
    pitchDegrees: 0.0,
    rollDegrees: 0.0,
  },
  icon: {
    uri: '/icons/vessel_marker.svg',
    width: 26,
    height: 26,
    scale: 1.0,
    nearFarScalar: {
      nearDistance: 1.0e3,
      nearScale: 1.0,
      farDistance: 1.0e7,
      farScale: 0.9,
    },
  },
  model: {
    uri: '/models/polar_research_vessel.glb',
    minimumPixelSize: 36,
    maximumScale: 5000,
    scale: 1.0,
    dimensions: {
      lengthMeters: 110.0,
      beamMeters: 21.0,
      heightMeters: 36.5,
    },
  },
};
