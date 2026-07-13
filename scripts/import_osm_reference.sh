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

OSM_SCHEMA="${OSM_SCHEMA:-osm_reference}"
OSM_PREFIX="${OSM_PREFIX:-planet_osm}"
OSM2PGSQL_CACHE="${OSM2PGSQL_CACHE:-800}"
OSM2PGSQL_PROCESSES="${OSM2PGSQL_PROCESSES:-4}"
OSM_KEEP_SLIM="${OSM_KEEP_SLIM:-0}"

if [[ ! -f "${PBF_PATH}" ]]; then
  echo "OSM PBF not found: ${PBF_PATH}" >&2
  exit 1
fi

if [[ ! "${OSM_SCHEMA}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "Invalid OSM_SCHEMA: ${OSM_SCHEMA}" >&2
  exit 1
fi

if [[ ! "${OSM_PREFIX}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "Invalid OSM_PREFIX: ${OSM_PREFIX}" >&2
  exit 1
fi

command -v osm2pgsql >/dev/null || {
  echo "osm2pgsql is required" >&2
  exit 1
}

psql \
  -v ON_ERROR_STOP=1 \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  -c "CREATE SCHEMA IF NOT EXISTS \"${OSM_SCHEMA}\";"

args=(
  --create
  --output=pgsql
  --slim
  --latlong
  --hstore
  --extra-attributes
  --cache="${OSM2PGSQL_CACHE}"
  --number-processes="${OSM2PGSQL_PROCESSES}"
  --output-pgsql-schema="${OSM_SCHEMA}"
  --middle-schema="${OSM_SCHEMA}"
  --prefix="${OSM_PREFIX}"
  --host="${PGHOST}"
  --port="${PGPORT}"
  --username="${PGUSER}"
  --database="${PGDATABASE}"
)

if [[ "${OSM_KEEP_SLIM}" != "1" ]]; then
  args+=(--drop)
fi

echo "Importing ${PBF_PATH} into ${PGDATABASE}.${OSM_SCHEMA}"
osm2pgsql "${args[@]}" "${PBF_PATH}"

psql \
  -v ON_ERROR_STOP=1 \
  -h "${PGHOST}" \
  -p "${PGPORT}" \
  -U "${PGUSER}" \
  -d "${PGDATABASE}" \
  -c "ANALYZE \"${OSM_SCHEMA}\".\"${OSM_PREFIX}_point\"; ANALYZE \"${OSM_SCHEMA}\".\"${OSM_PREFIX}_line\"; ANALYZE \"${OSM_SCHEMA}\".\"${OSM_PREFIX}_polygon\"; ANALYZE \"${OSM_SCHEMA}\".\"${OSM_PREFIX}_roads\";"

echo "OSM reference import complete: ${PGDATABASE}.${OSM_SCHEMA}"
