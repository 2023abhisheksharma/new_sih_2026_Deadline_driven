#!/usr/bin/env python3
"""
Sentinel-1 Circum-Antarctic Grounded Iceberg Dataset Processing Pipeline
-----------------------------------------------------------------------
Authoritative Dataset:
  'Grounded icebergs around Antarctica: a high-resolution dataset derived from
   deep learning and Sentinel-1 synthetic aperture radar'
Authors: Kaihong Jiao et al.
Published: Earth System Science Data (ESSD), 25 August 2026
Dataset DOI: 10.25959/54sx-pt47
Paper DOI: 10.5194/essd-18-6017-2026
Source: Institute for Marine and Antarctic Studies (IMAS), University of Tasmania (UTAS)

Ingests 39,619 stationary iceberg targets, reprojects from EPSG:3031 to EPSG:4326 (WGS84),
validates all polygon geometries, calculates distribution statistics, and exports
canonical GeoJSON, structured JSON, and source provenance metadata.
"""

import os
import sys
import json
import hashlib
import numpy as np
import geopandas as gpd
from shapely.geometry import mapping

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

RAW_GPKG_PATH = os.path.join(PROJECT_ROOT, 'data', 'icebergs_satellite', 'raw', 'Antarctic_Grounded_Iceberg_Dataset_Sentinel1_v1.2.gpkg')
PROCESSED_JSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'icebergs_satellite', 'processed', 'sentinel1_grounded_icebergs.json')
PROCESSED_GEOJSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'icebergs_satellite', 'processed', 'sentinel1_grounded_icebergs.geojson')
FRONTEND_DATA_PATH = os.path.join(PROJECT_ROOT, 'frontend', 'public', 'data', 'sentinel1_grounded_icebergs.json')
METADATA_JSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'icebergs_satellite', 'metadata', 'source.json')

def clean_float(val, default=0.0):
    if val is None:
        return default
    try:
        f = float(val)
        return f if np.isfinite(f) else default
    except (ValueError, TypeError):
        return default

def process_sentinel1_icebergs():
    if not os.path.exists(RAW_GPKG_PATH):
        print(f'Error: Raw GPKG not found at {RAW_GPKG_PATH}', file=sys.stderr)
        sys.exit(1)

    print(f'Reading Sentinel-1 Grounded Iceberg GeoPackage from {RAW_GPKG_PATH}...')

    # 1. Compute SHA-256 Checksum
    with open(RAW_GPKG_PATH, 'rb') as f:
        file_bytes = f.read()
        sha256_checksum = hashlib.sha256(file_bytes).hexdigest()
        file_size = len(file_bytes)

    # 2. Read Layer and Reproject to WGS84 (EPSG:4326)
    gdf = gpd.read_file(RAW_GPKG_PATH)
    raw_count = len(gdf)
    source_crs = str(gdf.crs)
    print(f'Raw feature count: {raw_count}')
    print(f'Source CRS: {source_crs}')

    gdf_wgs84 = gdf.to_crs(epsg=4326)

    # 3. Geometry & Coordinate Validation
    valid_mask = gdf_wgs84.geometry.is_valid & (~gdf_wgs84.geometry.is_empty)
    valid_count = int(valid_mask.sum())
    invalid_count = raw_count - valid_count
    print(f'Valid geometries: {valid_count} / {raw_count} (Invalid: {invalid_count})')

    # 4. Extract Attributes & Polygons
    processed_records = []
    geojson_features = []
    rejected_count = 0

    for idx, row in gdf_wgs84.iterrows():
        uid = str(row['Global_UID']).strip()
        if not uid:
            rejected_count += 1
            continue

        geom = row.geometry
        if geom is None or geom.is_empty or not geom.is_valid:
            rejected_count += 1
            continue

        # Extract coordinates
        if geom.geom_type == 'Polygon':
            boundary_coords = [[round(float(p[0]), 5), round(float(p[1]), 5)] for p in geom.exterior.coords]
        elif geom.geom_type == 'MultiPolygon':
            largest = max(geom.geoms, key=lambda p: p.area)
            boundary_coords = [[round(float(p[0]), 5), round(float(p[1]), 5)] for p in largest.exterior.coords]
        else:
            rejected_count += 1
            continue

        lat = round(float(row['Latitude']), 5)
        lon = round(float(row['Longitude']), 5)
        area_km2 = round(float(row['Area_Mean_km2']), 4)
        bed_depth = round(float(row['Bed_Depth']), 1)
        fast_ice_status = str(row['Fast_Ice_Overlap_Status']).strip()
        timestamp = str(row['Timestamp']).strip()
        date_range = str(row['Date_Range']).strip()
        orbit = str(row['Orbit']).strip()
        acq_mode = str(row['Acquisition_Mode']).strip()

        rec = {
            'id': uid,
            'orbit': orbit,
            'timestamp': timestamp,
            'dateRange': date_range,
            'areaKm2': area_km2,
            'bedDepthM': bed_depth,
            'acquisitionMode': acq_mode,
            'latitude': lat,
            'longitude': lon,
            'fastIceStatus': fast_ice_status,
            'vertexCount': len(boundary_coords),
            'boundaryCoordinates': boundary_coords
        }
        processed_records.append(rec)

        feat = {
            'type': 'Feature',
            'properties': {
                'id': uid,
                'orbit': orbit,
                'timestamp': timestamp,
                'areaKm2': area_km2,
                'bedDepthM': bed_depth,
                'fastIceStatus': fast_ice_status,
                'latitude': lat,
                'longitude': lon
            },
            'geometry': mapping(geom)
        }
        geojson_features.append(feat)

    print(f'Processed records: {len(processed_records)}')
    print(f'Rejected records: {rejected_count}')

    # 5. Compute Detailed Dataset Statistics
    areas = [r['areaKm2'] for r in processed_records]
    status_counts = {}
    for r in processed_records:
        st = r['fastIceStatus']
        status_counts[st] = status_counts.get(st, 0) + 1

    stats = {
        'total_targets': len(processed_records),
        'high_confidence_grounded_outside_fast_ice': status_counts.get('Outside', 0),
        'fast_ice_entrapped_inside': status_counts.get('Inside', 0),
        'partial_overlap_fast_ice': status_counts.get('Partial', 0),
        'area_km2_stats': {
            'min': float(np.min(areas)),
            'max': float(np.max(areas)),
            'median': float(np.median(areas)),
            'mean': float(np.mean(areas)),
            'percentage_under_1_km2': float((np.array(areas) < 1.0).sum() / len(areas) * 100.0)
        }
    }
    print('\nDataset Statistics Summary:')
    print(json.dumps(stats, indent=2))

    # 6. Save Processed JSON & GeoJSON
    os.makedirs(os.path.dirname(PROCESSED_JSON_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(FRONTEND_DATA_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(METADATA_JSON_PATH), exist_ok=True)

    with open(PROCESSED_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(processed_records, f, separators=(',', ':'), ensure_ascii=False)
    print(f'Saved processed dataset to {PROCESSED_JSON_PATH} ({os.path.getsize(PROCESSED_JSON_PATH)} bytes)')

    with open(FRONTEND_DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(processed_records, f, separators=(',', ':'), ensure_ascii=False)
    print(f'Saved frontend dataset to {FRONTEND_DATA_PATH} ({os.path.getsize(FRONTEND_DATA_PATH)} bytes)')

    geojson_collection = {
        'type': 'FeatureCollection',
        'features': geojson_features
    }
    with open(PROCESSED_GEOJSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(geojson_collection, f, separators=(',', ':'), ensure_ascii=False)
    print(f'Saved GeoJSON dataset to {PROCESSED_GEOJSON_PATH} ({os.path.getsize(PROCESSED_GEOJSON_PATH)} bytes)')

    # 7. Write Source Metadata JSON
    metadata = {
        'dataset': 'Circum-Antarctic Grounded Iceberg Inventory (Sentinel-1 SAR)',
        'title': 'Grounded icebergs around Antarctica: a high-resolution dataset derived from deep learning and Sentinel-1 synthetic aperture radar',
        'authors': [
            'Kaihong Jiao',
            'Alexander D. Fraser',
            'Robert A. Massom',
            'Guy J. Williams',
            'Delphine Lannuzel',
            'Petra Heil'
        ],
        'source_organization': 'Institute for Marine and Antarctic Studies (IMAS), University of Tasmania (UTAS)',
        'dataset_doi': '10.25959/54sx-pt47',
        'paper_doi': '10.5194/essd-18-6017-2026',
        'publication_journal': 'Earth System Science Data (ESSD)',
        'publication_date': '2026-08-25',
        'download_url': 'https://data.imas.utas.edu.au/attachments/fed75718-1513-49cf-8253-a19347e7aeec/Antarctic_Grounded_Iceberg_Dataset_Sentinel1_v1.2.gpkg',
        'retrieved_at': '2026-08-28T18:01:26Z',
        'original_filename': 'Antarctic_Grounded_Iceberg_Dataset_Sentinel1_v1.2.gpkg',
        'file_size_bytes': file_size,
        'sha256': sha256_checksum,
        'source_coordinate_system': 'EPSG:3031 (WGS 84 / Antarctic Polar Stereographic)',
        'target_coordinate_system': 'EPSG:4326 (WGS84)',
        'license': 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
        'observation_period': 'Late February to Early April 2025',
        'temporal_coverage': '2025-02-23 to 2025-04-21',
        'classification_semantics': 'Stationary iceberg targets on the Antarctic continental shelf (grounded icebergs and fast-ice-entrapped candidates). NOT freely drifting icebergs.',
        'raw_record_count': raw_count,
        'processed_record_count': len(processed_records),
        'rejected_record_count': rejected_count,
        'geometry_type': 'Polygon',
        'valid_polygons': valid_count,
        'invalid_polygons': invalid_count,
        'repaired_polygons': 0,
        'statistics': stats
    }

    with open(METADATA_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2)
    print(f'Saved source metadata to {METADATA_JSON_PATH}')

if __name__ == '__main__':
    process_sentinel1_icebergs()
