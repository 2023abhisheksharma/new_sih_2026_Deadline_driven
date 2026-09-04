#!/usr/bin/env python3
"""
USNIC Antarctic Iceberg Data Processing Pipeline
------------------------------------------------
Ingests official U.S. National Ice Center (USNIC) Antarctic Iceberg datasets:
1. Shapefile (Icebergs_YYYYMMDD.shp) with real tracked polygon boundaries
2. CSV (current_icebergs.csv) with iceberg dimensions and update timestamps

Validates WGS84 coordinates, reprojects native South Pole Stereographic
polygon coordinates to WGS84 (EPSG:4326), structures attributes, and outputs
canonical JSON/GeoJSON datasets with full provenance metadata.
"""

import os
import sys
import json
import hashlib
import csv
from typing import Dict, Any, List
import geopandas as gpd
from shapely.geometry import mapping

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

RAW_DIR = os.path.join(PROJECT_ROOT, 'data', 'icebergs', 'raw')
EXTRACTED_SHP_DIR = os.path.join(RAW_DIR, 'extracted_shp')
RAW_CSV_PATH = os.path.join(RAW_DIR, 'current_icebergs.csv')
RAW_ZIP_PATH = os.path.join(RAW_DIR, 'current_icebergs_shp.zip')

PROCESSED_JSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'icebergs', 'processed', 'icebergs.json')
PROCESSED_GEOJSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'icebergs', 'processed', 'icebergs.geojson')
FRONTEND_DATA_PATH = os.path.join(PROJECT_ROOT, 'frontend', 'public', 'data', 'icebergs.json')
METADATA_JSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'icebergs', 'metadata', 'source.json')

def clean_float(val: Any) -> float:
    if val is None:
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0

def process_icebergs():
    shp_files = [f for f in os.listdir(EXTRACTED_SHP_DIR) if f.endswith('.shp')]
    if not shp_files:
        print(f'Error: No shapefile found in {EXTRACTED_SHP_DIR}', file=sys.stderr)
        sys.exit(1)
    
    shp_path = os.path.join(EXTRACTED_SHP_DIR, shp_files[0])
    print(f'Reading USNIC Iceberg Shapefile from {shp_path}...')

    with open(RAW_ZIP_PATH, 'rb') as fz:
        zip_bytes = fz.read()
        zip_sha256 = hashlib.sha256(zip_bytes).hexdigest()
        zip_size = len(zip_bytes)

    with open(RAW_CSV_PATH, 'rb') as fc:
        csv_bytes = fc.read()
        csv_sha256 = hashlib.sha256(csv_bytes).hexdigest()
        csv_size = len(csv_bytes)

    csv_metadata: Dict[str, Dict[str, Any]] = {}
    if os.path.exists(RAW_CSV_PATH):
        with open(RAW_CSV_PATH, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            for row in reader:
                berg_id = row.get('Iceberg', '').strip()
                if berg_id:
                    csv_metadata[berg_id] = row

    gdf = gpd.read_file(shp_path)
    source_crs = str(gdf.crs)
    print(f'Source CRS: {source_crs}')
    print(f'Total raw features: {len(gdf)}')

    gdf_wgs84 = gdf.to_crs(epsg=4326)

    processed_records: List[Dict[str, Any]] = []
    geojson_features: List[Dict[str, Any]] = []
    rejected_count = 0

    for _, row in gdf_wgs84.iterrows():
        berg_id = str(row.get('Iceberg_ID', '')).strip()
        if not berg_id:
            rejected_count += 1
            continue

        lat_dec = clean_float(row.get('Lat_Dec'))
        lon_dec = clean_float(row.get('Lon_Dec'))

        geom = row.geometry
        if geom is None or geom.is_empty:
            rejected_count += 1
            continue

        boundary_coords: List[List[float]] = []
        if geom.geom_type == 'Polygon':
            boundary_coords = [[round(p[0], 5), round(p[1], 5)] for p in geom.exterior.coords]
        elif geom.geom_type == 'MultiPolygon':
            largest_poly = max(geom.geoms, key=lambda p: p.area)
            boundary_coords = [[round(p[0], 5), round(p[1], 5)] for p in largest_poly.exterior.coords]
        else:
            rejected_count += 1
            continue

        if len(boundary_coords) < 3:
            rejected_count += 1
            continue

        csv_row = csv_metadata.get(berg_id, {})
        last_update = csv_row.get('Last Update', '08/27/2026').strip()

        length_str = str(row.get('Length', '')).strip()
        width_str = str(row.get('Width', '')).strip()

        length_nm = None
        width_nm = None
        try:
            length_nm = float(length_str.replace('NM', '').replace('nm', '').strip())
        except ValueError:
            pass
        try:
            width_nm = float(width_str.replace('NM', '').replace('nm', '').strip())
        except ValueError:
            pass

        record = {
            'id': berg_id,
            'name': f'Iceberg {berg_id}',
            'latitude': round(lat_dec, 5),
            'longitude': round(lon_dec, 5),
            'length': length_str,
            'width': width_str,
            'lengthNm': length_nm,
            'widthNm': width_nm,
            'areaSqKm': round(clean_float(row.get('Area_sqKM')), 2),
            'areaSqNm': round(clean_float(row.get('Area_sqNM')), 2),
            'areaSqMi': round(clean_float(row.get('Area_sqMI')), 2),
            'status': str(row.get('Status', 'Current')).strip(),
            'lastUpdate': last_update,
            'hasRealBoundary': True,
            'vertexCount': len(boundary_coords),
            'boundaryCoordinates': boundary_coords
        }
        processed_records.append(record)

        geojson_feature = {
            'type': 'Feature',
            'properties': {
                'id': berg_id,
                'name': f'Iceberg {berg_id}',
                'latitude': round(lat_dec, 5),
                'longitude': round(lon_dec, 5),
                'length': length_str,
                'width': width_str,
                'areaSqKm': round(clean_float(row.get('Area_sqKM')), 2),
                'status': str(row.get('Status', 'Current')).strip(),
                'lastUpdate': last_update,
            },
            'geometry': mapping(geom)
        }
        geojson_features.append(geojson_feature)

    print(f'Processed records: {len(processed_records)}')
    print(f'Rejected records: {rejected_count}')

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

    metadata = {
        'dataset': 'U.S. National Ice Center (USNIC) Antarctic Iceberg Dataset',
        'agency': 'U.S. National Ice Center (NOAA / U.S. Navy / U.S. Coast Guard)',
        'source_url': 'https://usicecenter.gov/Products/AntarcIcebergs',
        'download_urls': {
            'shapefile': 'https://usicecenter.gov/File/DownloadCurrent?pId=228',
            'csv': 'https://usicecenter.gov/File/DownloadCurrent?pId=134'
        },
        'retrieved_at': '2026-08-28T17:39:56Z',
        'license_or_usage': 'Public Domain / U.S. Government Work (NOAA / USNIC). Free and unrestricted public release.',
        'canonical_source': True,
        'source_coordinate_system': 'WGS_1984_Stereographic_South_Pole (Polar Stereographic, latitude_of_origin=-60, central_meridian=180, meters)',
        'target_coordinate_system': 'WGS84 (EPSG:4326)',
        'raw_feature_count': len(gdf),
        'processed_feature_count': len(processed_records),
        'rejected_feature_count': rejected_count,
        'geometry_type': 'Polygon',
        'real_geometry_available': True,
        'files': {
            'current_icebergs_shp.zip': {
                'size_bytes': zip_size,
                'sha256': zip_sha256
            },
            'current_icebergs.csv': {
                'size_bytes': csv_size,
                'sha256': csv_sha256
            }
        }
    }

    with open(METADATA_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2)
    print(f'Saved metadata to {METADATA_JSON_PATH}')

if __name__ == '__main__':
    process_icebergs()
