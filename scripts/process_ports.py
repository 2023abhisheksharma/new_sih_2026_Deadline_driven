#!/usr/bin/env python3
"""
NGA World Port Index (WPI Pub 150) Data Processing Pipeline
-----------------------------------------------------------
Reads official NGA WPI CSV (UpdatedPub150.csv), validates every record,
ensures geographic coordinate validity (WGS84 EPSG:4326), selects essential
and navigational attributes, and outputs structured, traceable JSON datasets
for the Antarctic Navigation Decision Support System.
"""

import csv
import json
import os
import sys
import hashlib
from typing import Dict, Any, List, Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

RAW_CSV_PATH = os.path.join(PROJECT_ROOT, 'data', 'ports', 'raw', 'UpdatedPub150.csv')
PROCESSED_JSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'ports', 'processed', 'ports.json')
FRONTEND_DATA_PATH = os.path.join(PROJECT_ROOT, 'frontend', 'public', 'data', 'ports.json')
METADATA_JSON_PATH = os.path.join(PROJECT_ROOT, 'data', 'ports', 'metadata', 'source.json')

def clean_str(val: Optional[str]) -> Optional[str]:
    if val is None:
        return None
    s = val.strip()
    return s if s and s.lower() != 'unknown' else None

def clean_float(val: Optional[str]) -> Optional[float]:
    if val is None:
        return None
    s = val.strip()
    if not s:
        return None
    try:
        f = float(s)
        return f if f != 0.0 else None
    except ValueError:
        return None

def process_dataset():
    if not os.path.exists(RAW_CSV_PATH):
        print(f"Error: Raw CSV not found at {RAW_CSV_PATH}", file=sys.stderr)
        sys.exit(1)

    print(f"Reading raw NGA WPI dataset from {RAW_CSV_PATH}...")

    with open(RAW_CSV_PATH, 'rb') as fb:
        raw_bytes = fb.read()
        sha256_checksum = hashlib.sha256(raw_bytes).hexdigest()
        file_size = len(raw_bytes)

    valid_records: List[Dict[str, Any]] = []
    rejected_records: List[Dict[str, Any]] = []

    with open(RAW_CSV_PATH, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        
        for row_idx, row in enumerate(reader, start=2):
            wpi_raw = row.get('World Port Index Number', '').strip()
            port_name = row.get('Main Port Name', '').strip()
            lat_raw = row.get('Latitude', '').strip()
            lon_raw = row.get('Longitude', '').strip()

            # 1. Validate WPI ID
            if not wpi_raw:
                rejected_records.append({
                    'row': row_idx,
                    'reason': 'Missing World Port Index Number',
                    'port_name': port_name
                })
                continue
            try:
                wpi_number = int(float(wpi_raw))
            except ValueError:
                rejected_records.append({
                    'row': row_idx,
                    'reason': f'Invalid non-numeric WPI Number: {wpi_raw}',
                    'port_name': port_name
                })
                continue

            # 2. Validate Port Name
            if not port_name:
                rejected_records.append({
                    'row': row_idx,
                    'reason': 'Missing Main Port Name',
                    'wpi_number': wpi_number
                })
                continue

            # 3. Validate Coordinates
            if not lat_raw or not lon_raw:
                rejected_records.append({
                    'row': row_idx,
                    'reason': 'Missing latitude or longitude',
                    'wpi_number': wpi_number,
                    'port_name': port_name
                })
                continue

            try:
                lat = float(lat_raw)
                lon = float(lon_raw)
            except ValueError:
                rejected_records.append({
                    'row': row_idx,
                    'reason': f'Non-numeric coordinates: lat="{lat_raw}", lon="{lon_raw}"',
                    'wpi_number': wpi_number,
                    'port_name': port_name
                })
                continue

            if not (-90.0 <= lat <= 90.0):
                rejected_records.append({
                    'row': row_idx,
                    'reason': f'Latitude out of range [-90.0, 90.0]: {lat}',
                    'wpi_number': wpi_number,
                    'port_name': port_name
                })
                continue

            if not (-180.0 <= lon <= 180.0):
                rejected_records.append({
                    'row': row_idx,
                    'reason': f'Longitude out of range [-180.0, 180.0]: {lon}',
                    'wpi_number': wpi_number,
                    'port_name': port_name
                })
                continue

            # Construct structured port record
            record = {
                'wpiNumber': wpi_number,
                'portName': port_name,
                'alternatePortName': clean_str(row.get('Alternate Port Name')),
                'unLocode': clean_str(row.get('UN/LOCODE')),
                'countryCode': clean_str(row.get('Country Code')),
                'regionName': clean_str(row.get('Region Name')),
                'waterBody': clean_str(row.get('World Water Body')),
                'seaArea': clean_str(row.get('IHO S-130 Sea Area')),
                'latitude': round(lat, 5),
                'longitude': round(lon, 5),
                'harborSize': clean_str(row.get('Harbor Size')),
                'harborType': clean_str(row.get('Harbor Type')),
                'harborUse': clean_str(row.get('Harbor Use')),
                'shelter': clean_str(row.get('Shelter Afforded')),
                'entranceIce': clean_str(row.get('Entrance Restriction - Ice')),
                'entranceSwell': clean_str(row.get('Entrance Restriction - Heavy Swell')),
                'facilitiesAnchorage': clean_str(row.get('Facilities - Anchorage')),
                'facilitiesIceMooring': clean_str(row.get('Facilities - Ice Mooring')),
                'servicesIceBreaking': clean_str(row.get('Services - Ice Breaking')),
                'maxVesselLength': clean_float(row.get('Maximum Vessel Length (m)')),
                'maxVesselBeam': clean_float(row.get('Maximum Vessel Beam (m)')),
                'maxVesselDraft': clean_float(row.get('Maximum Vessel Draft (m)')),
                'channelDepth': clean_str(row.get('Channel Depth (m)')),
                'anchorageDepth': clean_str(row.get('Anchorage Depth (m)')),
                'cargoPierDepth': clean_str(row.get('Cargo Pier Depth (m)')),
                'sailingDirection': clean_str(row.get('Sailing Direction or Publication')),
                'publicationLink': clean_str(row.get('Publication Link')),
            }

            valid_records.append(record)

    print(f"Total raw rows: {len(valid_records) + len(rejected_records)}")
    print(f"Accepted records: {len(valid_records)}")
    print(f"Rejected records: {len(rejected_records)}")

    # Ensure output directories exist
    os.makedirs(os.path.dirname(PROCESSED_JSON_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(FRONTEND_DATA_PATH), exist_ok=True)

    # Write processed JSON files
    with open(PROCESSED_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(valid_records, f, separators=(',', ':'), ensure_ascii=False)
    print(f"Saved processed dataset to {PROCESSED_JSON_PATH} ({os.path.getsize(PROCESSED_JSON_PATH)} bytes)")

    with open(FRONTEND_DATA_PATH, 'w', encoding='utf-8') as f:
        json.dump(valid_records, f, separators=(',', ':'), ensure_ascii=False)
    print(f"Saved frontend dataset to {FRONTEND_DATA_PATH} ({os.path.getsize(FRONTEND_DATA_PATH)} bytes)")

    # Update metadata
    metadata = {
        'dataset': 'NGA World Port Index',
        'publication': 'Pub 150',
        'source_url': 'https://msi.nga.mil/api/publications/download?key=16920959/SFH00000/UpdatedPub150.csv&type=download',
        'file': 'UpdatedPub150.csv',
        'retrieved_at': '2026-08-28T14:33:15Z',
        'license_or_usage': 'Public Domain / U.S. Government Work (U.S. National Geospatial-Intelligence Agency Maritime Safety Information). Approved for public release; distribution is unlimited.',
        'canonical_source': True,
        'coordinate_system': 'WGS84 (EPSG:4326)',
        'raw_record_count': len(valid_records) + len(rejected_records),
        'processed_record_count': len(valid_records),
        'rejected_record_count': len(rejected_records),
        'file_size_bytes': file_size,
        'sha256': sha256_checksum
    }

    with open(METADATA_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(metadata, f, indent=2)
    print(f"Saved source metadata to {METADATA_JSON_PATH}")

if __name__ == '__main__':
    process_dataset()
