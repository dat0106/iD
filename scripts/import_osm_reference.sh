#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PBF_PATH="${1:-${OSM_PBF_PATH:-${ROOT_DIR}/../../build-routing/build/valhalla/geofabrik-vietnam.osm.pbf}}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5534}"
PGDATABASE="${PGDATABASE:-auto_road}"
PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-Goong@2023!@#}"

export OSM_EDITOR_SCHEMA="${OSM_EDITOR_SCHEMA:-public}"
export OSM_EDITOR_TABLE="${OSM_EDITOR_TABLE:-osm_editor}"
OSM_MIDDLE_SCHEMA="${OSM_MIDDLE_SCHEMA:-osm_editor_import}"
OSM2PGSQL_CACHE="${OSM2PGSQL_CACHE:-800}"
OSM2PGSQL_PROCESSES="${OSM2PGSQL_PROCESSES:-4}"
OSM_KEEP_SLIM="${OSM_KEEP_SLIM:-0}"
STYLE_PATH="${SCRIPT_DIR}/osm_editor.lua"

if [[ ! -f "${PBF_PATH}" ]]; then
  echo "OSM PBF not found: ${PBF_PATH}" >&2
  exit 1
fi

for identifier in OSM_EDITOR_SCHEMA OSM_EDITOR_TABLE OSM_MIDDLE_SCHEMA; do
  value="${!identifier}"
  if [[ ! "${value}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
    echo "Invalid ${identifier}: ${value}" >&2
    exit 1
  fi
done

command -v osm2pgsql >/dev/null || {
  echo "osm2pgsql is required" >&2
  exit 1
}

command -v psql >/dev/null || {
  echo "psql is required" >&2
  exit 1
}

psql \
  -v ON_ERROR_STOP=1 \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  -c "CREATE EXTENSION IF NOT EXISTS postgis; CREATE SCHEMA IF NOT EXISTS \"${OSM_EDITOR_SCHEMA}\"; CREATE SCHEMA IF NOT EXISTS \"${OSM_MIDDLE_SCHEMA}\";"

args=(
  --create
  --output=flex
  --style="${STYLE_PATH}"
  --slim
  --latlong
  --extra-attributes
  --cache="${OSM2PGSQL_CACHE}"
  --number-processes="${OSM2PGSQL_PROCESSES}"
  --middle-schema="${OSM_MIDDLE_SCHEMA}"
  --prefix="${OSM_EDITOR_TABLE}"
  --host="${PGHOST}"
  --port="${PGPORT}"
  --username="${PGUSER}"
  --database="${PGDATABASE}"
)

if [[ "${OSM_KEEP_SLIM}" != "1" ]]; then
  args+=(--drop)
fi

echo "Importing ${PBF_PATH} into ${PGHOST}:${PGPORT}/${PGDATABASE}.${OSM_EDITOR_SCHEMA}.${OSM_EDITOR_TABLE}"
osm2pgsql "${args[@]}" "${PBF_PATH}"

psql \
  -v ON_ERROR_STOP=1 \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  -c "CREATE UNIQUE INDEX IF NOT EXISTS \"${OSM_EDITOR_TABLE}_osm_id_idx\" ON \"${OSM_EDITOR_SCHEMA}\".\"${OSM_EDITOR_TABLE}\" (osm_id); CREATE INDEX IF NOT EXISTS \"${OSM_EDITOR_TABLE}_geom_idx\" ON \"${OSM_EDITOR_SCHEMA}\".\"${OSM_EDITOR_TABLE}\" USING GIST (geom); ANALYZE \"${OSM_EDITOR_SCHEMA}\".\"${OSM_EDITOR_TABLE}\";"

echo "OSM editor import complete: ${PGHOST}:${PGPORT}/${PGDATABASE}.${OSM_EDITOR_SCHEMA}.${OSM_EDITOR_TABLE}"
