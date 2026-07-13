/* global Buffer, process */
/* eslint-disable no-process-env */

import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import pg from 'pg';
import { SaxesParser } from 'saxes';

const { Pool } = pg;
const gunzipAsync = promisify(gunzip);

const GENERATOR = 'Goong PostGIS Editor';
const NODE_SCALE = 10_000_000;
const LATITUDE_CARDINALITY = 1_800_000_001n;
const MAX_BODY_BYTES = 50 * 1024 * 1024;


class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}


function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}


function parseTableName(value) {
  const match = /^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(value);
  if (!match) throw new Error(`Invalid EDITOR_TABLE value: ${value}`);
  return {
    schema: match[1],
    table: match[2],
    sql: `${quoteIdentifier(match[1])}.${quoteIdentifier(match[2])}`
  };
}


function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}


function attribute(tag, name) {
  const value = tag.attributes[name];
  if (value && typeof value === 'object') return value.value;
  return value;
}


function closeTagName(tag) {
  return typeof tag === 'string' ? tag : tag.name;
}


function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}


export function encodeNodeId(lon, lat) {
  const longitude = Number(lon);
  const latitude = Number(lat);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
      longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new ApiError(400, `Invalid node coordinate: ${lon},${lat}`);
  }

  const longitudeCode = BigInt(Math.round((longitude + 180) * NODE_SCALE));
  const latitudeCode = BigInt(Math.round((latitude + 90) * NODE_SCALE));
  return (longitudeCode * LATITUDE_CARDINALITY + latitudeCode + 1n).toString();
}


export function decodeNodeId(id) {
  if (!/^\d+$/.test(String(id))) throw new ApiError(400, `Invalid node id: ${id}`);

  const encoded = BigInt(id) - 1n;
  const longitudeCode = encoded / LATITUDE_CARDINALITY;
  const latitudeCode = encoded % LATITUDE_CARDINALITY;
  const lon = Number(longitudeCode - 1_800_000_000n) / NODE_SCALE;
  const lat = Number(latitudeCode - 900_000_000n) / NODE_SCALE;

  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new ApiError(400, `Node id is outside the supported coordinate range: ${id}`);
  }
  return [lon, lat];
}


export function parseOsmChange(xml) {
  const changes = { create: [], modify: [], delete: [] };
  let action;
  let entity;
  const parser = new SaxesParser({ xmlns: false });

  parser.on('opentag', (tag) => {
    if (Object.hasOwn(changes, tag.name)) {
      action = tag.name;
      return;
    }

    if (action && ['node', 'way', 'relation'].includes(tag.name)) {
      entity = {
        type: tag.name,
        id: String(attribute(tag, 'id')),
        version: Number.parseInt(attribute(tag, 'version') || '0', 10),
        lon: attribute(tag, 'lon'),
        lat: attribute(tag, 'lat'),
        nodes: [],
        members: [],
        tags: {}
      };
      return;
    }

    if (!entity) return;
    if (tag.name === 'nd') {
      entity.nodes.push(String(attribute(tag, 'ref')));
    } else if (tag.name === 'member') {
      entity.members.push({
        type: String(attribute(tag, 'type')),
        ref: String(attribute(tag, 'ref')),
        role: String(attribute(tag, 'role') || '')
      });
    } else if (tag.name === 'tag') {
      entity.tags[String(attribute(tag, 'k'))] = String(attribute(tag, 'v') || '');
    }
  });

  parser.on('closetag', (tag) => {
    const name = closeTagName(tag);
    if (entity && name === entity.type) {
      changes[action].push(entity);
      entity = undefined;
    } else if (name === action) {
      action = undefined;
    }
  });

  parser.write(xml).close();
  return changes;
}


export function parseElementTags(xml, elementName) {
  const tags = {};
  let insideElement = false;
  const parser = new SaxesParser({ xmlns: false });

  parser.on('opentag', (tag) => {
    if (tag.name === elementName) {
      insideElement = true;
    } else if (insideElement && tag.name === 'tag') {
      tags[String(attribute(tag, 'k'))] = String(attribute(tag, 'v') || '');
    }
  });
  parser.on('closetag', (tag) => {
    if (closeTagName(tag) === elementName) insideElement = false;
  });

  parser.write(xml).close();
  return tags;
}


async function readRequestBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'Request body is too large');
    chunks.push(chunk);
  }

  let body = Buffer.concat(chunks);
  if (request.headers['content-encoding'] === 'gzip') body = await gunzipAsync(body);
  return body.toString('utf8');
}


function sendJSON(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  response.end(JSON.stringify(payload));
}


function sendText(response, status, payload, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType
  });
  response.end(String(payload));
}


function validateIds(values, type) {
  const ids = values.filter(Boolean);
  if (!ids.length || ids.some(id => !/^\d+$/.test(id))) {
    throw new ApiError(400, `Invalid ${type} id list`);
  }
  return ids;
}


export function createPostgisOsmApi(options = {}) {
  const table = parseTableName(options.table || process.env.EDITOR_TABLE || 'public.goong_road');
  const maxWays = parseInteger(options.maxWays || process.env.EDITOR_MAX_WAYS, 5000);
  const pool = options.pool || new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: parseInteger(process.env.PGPORT, 5534),
    database: process.env.PGDATABASE || 'auto_road',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    max: parseInteger(process.env.PGPOOL_SIZE, 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000
  });

  let tagColumns = [];
  let tagColumnSet = new Set();
  let roadSelectColumns = '';


  async function init() {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS goong_editor;

      CREATE TABLE IF NOT EXISTS goong_editor.way_versions (
        way_id bigint PRIMARY KEY,
        version integer NOT NULL DEFAULT 1 CHECK (version > 0),
        changeset_id bigint,
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by text NOT NULL DEFAULT 'goong-editor'
      );

      CREATE TABLE IF NOT EXISTS goong_editor.changesets (
        id bigserial PRIMARY KEY,
        tags jsonb NOT NULL DEFAULT '{}'::jsonb,
        opened_at timestamptz NOT NULL DEFAULT now(),
        closed_at timestamptz
      );

      CREATE TABLE IF NOT EXISTS goong_editor.uploads (
        id bigserial PRIMARY KEY,
        changeset_id bigint NOT NULL,
        affected_way_ids bigint[] NOT NULL DEFAULT '{}',
        osm_change text NOT NULL,
        uploaded_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE SEQUENCE IF NOT EXISTS goong_editor.way_id_seq AS bigint;
    `);

    const columnsResult = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND data_type IN ('text', 'character varying', 'character')
        AND column_name <> 'tags'
      ORDER BY ordinal_position
    `, [table.schema, table.table]);

    tagColumns = columnsResult.rows.map(row => row.column_name);
    tagColumnSet = new Set(tagColumns);
    roadSelectColumns = tagColumns
      .map(column => `g.${quoteIdentifier(column)}`)
      .join(', ');

    const nextIdResult = await pool.query(
      `SELECT COALESCE(MAX(osm_id), 0) + 1 AS next_id FROM ${table.sql}`
    );
    await pool.query(`
      SELECT setval(
        'goong_editor.way_id_seq',
        GREATEST(
          $1::bigint,
          (
            SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END
            FROM goong_editor.way_id_seq
          )
        ),
        false
      )
    `, [nextIdResult.rows[0].next_id]);
  }


  function tagsFromRow(row) {
    let tags = {};
    if (row._extra_tags) {
      if (typeof row._extra_tags === 'object' && !Array.isArray(row._extra_tags)) {
        tags = row._extra_tags;
      } else {
        try {
          const extra = JSON.parse(row._extra_tags);
          if (extra && typeof extra === 'object' && !Array.isArray(extra)) tags = extra;
        } catch {
          // Legacy imports may contain non-JSON text. Known columns remain editable.
        }
      }
    }

    for (const column of tagColumns) {
      const value = row[column];
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        tags[column] = String(value);
      }
    }
    return tags;
  }


  function rowsToElements(rows, includeNodes = true) {
    const nodes = new Map();
    const ways = [];

    for (const row of rows) {
      if (!row.geometry || row.geometry.type !== 'LineString') continue;
      const nodeIds = [];

      for (const coordinate of row.geometry.coordinates) {
        const nodeId = encodeNodeId(coordinate[0], coordinate[1]);
        const loc = decodeNodeId(nodeId);
        nodeIds.push(nodeId);
        if (includeNodes && !nodes.has(nodeId)) {
          nodes.set(nodeId, {
            type: 'node',
            id: nodeId,
            lat: loc[1],
            lon: loc[0],
            version: 1,
            user: GENERATOR,
            uid: 1,
            tags: {}
          });
        }
      }

      ways.push({
        type: 'way',
        id: row.osm_id,
        version: Number(row.version),
        timestamp: row.updated_at || undefined,
        user: GENERATOR,
        uid: 1,
        nodes: nodeIds,
        tags: tagsFromRow(row)
      });
    }

    return [...nodes.values(), ...ways];
  }


  async function selectRoads(whereSql, values, limit) {
    const selectedTags = roadSelectColumns ? `, ${roadSelectColumns}` : '';
    const limitSql = limit ? `LIMIT ${Number(limit)}` : '';
    const result = await pool.query(`
      SELECT
        g.osm_id::text AS osm_id,
        ST_AsGeoJSON(ST_Force2D(g.geom), 7)::jsonb AS geometry,
        g.tags AS _extra_tags,
        COALESCE(v.version, 1) AS version,
        v.updated_at
        ${selectedTags}
      FROM ${table.sql} g
      LEFT JOIN goong_editor.way_versions v ON v.way_id = g.osm_id
      WHERE ${whereSql}
      ORDER BY g.osm_id
      ${limitSql}
    `, values);
    return result.rows;
  }


  async function loadMap(url, response) {
    const bbox = (url.searchParams.get('bbox') || '').split(',').map(Number);
    if (bbox.length !== 4 || bbox.some(value => !Number.isFinite(value)) ||
        bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
      throw new ApiError(400, 'bbox must be minLon,minLat,maxLon,maxLat');
    }

    const rows = await selectRoads(`
      g.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      AND ST_Intersects(g.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
    `, bbox, maxWays + 1);
    const truncated = rows.length > maxWays;
    if (truncated) rows.length = maxWays;

    sendJSON(response, 200, {
      version: '0.6',
      generator: GENERATOR,
      elements: rowsToElements(rows)
    }, truncated ? { 'X-Editor-Truncated': 'true' } : {});
  }


  async function loadWays(ids, response, includeNodes) {
    const rows = await selectRoads('g.osm_id = ANY($1::bigint[])', [ids]);
    if (ids.length === 1 && rows.length === 0) {
      throw new ApiError(404, `Way ${ids[0]} was not found`);
    }
    sendJSON(response, 200, {
      version: '0.6',
      generator: GENERATOR,
      elements: rowsToElements(rows, includeNodes)
    });
  }


  function loadNodes(ids, response) {
    const elements = ids.map(id => {
      const [lon, lat] = decodeNodeId(id);
      return {
        type: 'node', id, lat, lon, version: 1,
        user: GENERATOR, uid: 1, tags: {}
      };
    });
    sendJSON(response, 200, { version: '0.6', generator: GENERATOR, elements });
  }


  function splitTags(tags) {
    const known = tagColumns.map(column => tags[column] ?? null);
    const extra = {};
    for (const [key, value] of Object.entries(tags)) {
      if (!tagColumnSet.has(key)) extra[key] = value;
    }
    return {
      known,
      extra: Object.keys(extra).length ? JSON.stringify(extra) : null
    };
  }


  function geometryFromWay(way, nodeCoordinates) {
    if (way.nodes.length < 2) {
      throw new ApiError(400, `Way ${way.id} must contain at least two nodes`);
    }

    const coordinates = way.nodes.map(nodeId => {
      if (nodeCoordinates.has(nodeId)) return nodeCoordinates.get(nodeId);
      return decodeNodeId(nodeId);
    });
    return JSON.stringify({ type: 'LineString', coordinates });
  }


  async function assertWayVersion(client, way) {
    const result = await client.query(`
      SELECT COALESCE(v.version, 1) AS version
      FROM ${table.sql} g
      LEFT JOIN goong_editor.way_versions v ON v.way_id = g.osm_id
      WHERE g.osm_id = $1
      FOR UPDATE OF g
    `, [way.id]);

    if (!result.rowCount) throw new ApiError(404, `Way ${way.id} was not found`);
    const currentVersion = Number(result.rows[0].version);
    if (way.version !== currentVersion) {
      throw new ApiError(409, `Way ${way.id} has version ${currentVersion}, not ${way.version}`);
    }
  }


  async function insertWay(client, way, nodeCoordinates) {
    const idResult = await client.query(
      'SELECT nextval(\'goong_editor.way_id_seq\')::text AS id'
    );
    const id = idResult.rows[0].id;
    const geometry = geometryFromWay(way, nodeCoordinates);
    const { known, extra } = splitTags(way.tags);
    const columns = ['osm_id', 'geom', ...tagColumns, 'tags'];
    const values = [id, geometry, ...known, extra];
    const placeholders = [
      '$1',
      'ST_SetSRID(ST_GeomFromGeoJSON($2), 4326)',
      ...known.map((...args) => `$${args[1] + 3}`),
      `$${known.length + 3}`
    ];

    await client.query(`
      INSERT INTO ${table.sql} (${columns.map(quoteIdentifier).join(', ')})
      VALUES (${placeholders.join(', ')})
    `, values);
    return id;
  }


  async function updateWay(client, way, nodeCoordinates) {
    const geometry = geometryFromWay(way, nodeCoordinates);
    const { known, extra } = splitTags(way.tags);
    const assignments = [
      'geom = ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)',
      ...tagColumns.map((column, index) => `${quoteIdentifier(column)} = $${index + 2}`),
      `tags = $${known.length + 2}`
    ];
    await client.query(`
      UPDATE ${table.sql}
      SET ${assignments.join(', ')}
      WHERE osm_id = $${known.length + 3}
    `, [geometry, ...known, extra, way.id]);
  }


  async function moveNode(client, node) {
    const oldCoordinate = decodeNodeId(node.id);
    const newCoordinate = [Number(node.lon), Number(node.lat)];
    encodeNodeId(newCoordinate[0], newCoordinate[1]);
    if (oldCoordinate[0] === newCoordinate[0] && oldCoordinate[1] === newCoordinate[1]) return [];

    const result = await client.query(`
      WITH candidates AS (
        SELECT
          g.osm_id,
          ST_MakeLine(
            CASE
              WHEN round(ST_X(points.geom)::numeric, 7) = round($1::numeric, 7)
               AND round(ST_Y(points.geom)::numeric, 7) = round($2::numeric, 7)
              THEN ST_SetSRID(ST_MakePoint($3, $4), 4326)
              ELSE points.geom
            END
            ORDER BY points.path
          ) AS new_geom
        FROM ${table.sql} g
        CROSS JOIN LATERAL ST_DumpPoints(g.geom) points
        WHERE g.geom && ST_Expand(ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.00000006)
        GROUP BY g.osm_id
        HAVING bool_or(
          round(ST_X(points.geom)::numeric, 7) = round($1::numeric, 7)
          AND round(ST_Y(points.geom)::numeric, 7) = round($2::numeric, 7)
        )
      )
      UPDATE ${table.sql} g
      SET geom = candidates.new_geom
      FROM candidates
      WHERE g.osm_id = candidates.osm_id
      RETURNING g.osm_id::text
    `, [oldCoordinate[0], oldCoordinate[1], newCoordinate[0], newCoordinate[1]]);
    return result.rows.map(row => row.osm_id);
  }


  async function bumpWayVersion(client, wayId, changesetId) {
    const result = await client.query(`
      INSERT INTO goong_editor.way_versions
        (way_id, version, changeset_id, updated_at, updated_by)
      VALUES ($1, 2, $2, now(), $3)
      ON CONFLICT (way_id) DO UPDATE SET
        version = goong_editor.way_versions.version + 1,
        changeset_id = EXCLUDED.changeset_id,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
      RETURNING version
    `, [wayId, changesetId, GENERATOR]);
    return Number(result.rows[0].version);
  }


  function validateChanges(changes) {
    const relations = [...changes.create, ...changes.modify, ...changes.delete]
      .filter(entity => entity.type === 'relation');
    if (relations.length) {
      throw new ApiError(400, 'Relations are not supported by the goong_road adapter');
    }

    const taggedNodes = [...changes.create, ...changes.modify]
      .filter(entity => entity.type === 'node' && Object.keys(entity.tags).length);
    if (taggedNodes.length) {
      throw new ApiError(400, 'Tagged point features are not supported by the goong_road adapter');
    }
  }


  async function uploadChangeset(changesetId, xml) {
    const changes = parseOsmChange(xml);
    validateChanges(changes);
    const client = await pool.connect();
    const affectedWayIds = new Set();
    const deletedWayIds = new Set();
    const nodeCoordinates = new Map();
    const diffEntries = [];

    for (const action of ['create', 'modify']) {
      for (const node of changes[action].filter(entity => entity.type === 'node')) {
        const coordinate = [Number(node.lon), Number(node.lat)];
        const stableId = encodeNodeId(coordinate[0], coordinate[1]);
        nodeCoordinates.set(node.id, coordinate);
        diffEntries.push({ type: 'node', oldId: node.id, newId: stableId, version: 1 });
      }
    }

    try {
      await client.query('BEGIN');
      const changesetResult = await client.query(
        'SELECT id FROM goong_editor.changesets WHERE id = $1 AND closed_at IS NULL FOR UPDATE',
        [changesetId]
      );
      if (!changesetResult.rowCount) {
        throw new ApiError(409, `Changeset ${changesetId} is missing or closed`);
      }

      for (const node of changes.modify.filter(entity => entity.type === 'node')) {
        const movedWays = await moveNode(client, node);
        movedWays.forEach(id => affectedWayIds.add(id));
      }

      for (const way of changes.create.filter(entity => entity.type === 'way')) {
        const newId = await insertWay(client, way, nodeCoordinates);
        await client.query(`
          INSERT INTO goong_editor.way_versions
            (way_id, version, changeset_id, updated_at, updated_by)
          VALUES ($1, 1, $2, now(), $3)
        `, [newId, changesetId, GENERATOR]);
        diffEntries.push({ type: 'way', oldId: way.id, newId, version: 1 });
      }

      for (const way of changes.modify.filter(entity => entity.type === 'way')) {
        await assertWayVersion(client, way);
        await updateWay(client, way, nodeCoordinates);
        affectedWayIds.add(way.id);
      }

      for (const way of changes.delete.filter(entity => entity.type === 'way')) {
        await assertWayVersion(client, way);
        await client.query(`DELETE FROM ${table.sql} WHERE osm_id = $1`, [way.id]);
        await client.query('DELETE FROM goong_editor.way_versions WHERE way_id = $1', [way.id]);
        affectedWayIds.delete(way.id);
        deletedWayIds.add(way.id);
      }

      for (const wayId of affectedWayIds) {
        if (deletedWayIds.has(wayId)) continue;
        const version = await bumpWayVersion(client, wayId, changesetId);
        diffEntries.push({ type: 'way', oldId: wayId, newId: wayId, version });
      }

      await client.query(`
        INSERT INTO goong_editor.uploads (changeset_id, affected_way_ids, osm_change)
        VALUES ($1, $2::bigint[], $3)
      `, [changesetId, [...affectedWayIds], xml]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const entries = diffEntries.map(entry =>
      `<${entry.type} old_id="${xmlEscape(entry.oldId)}" new_id="${xmlEscape(entry.newId)}" new_version="${entry.version}"/>`
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><diffResult version="0.6" generator="${GENERATOR}">${entries}</diffResult>`;
  }


  async function handle(request, response) {
    const url = new URL(request.url, 'http://editor.local');
    const { pathname } = url;
    const method = request.method || 'GET';

    if (pathname === '/editor-config.json') {
      const defaultSource = process.env.EDITOR_DEFAULT_SOURCE === 'osm' ? 'osm' : 'goong';
      sendJSON(response, 200, {
        defaultSource,
        osmClientId: process.env.OSM_CLIENT_ID || '0tmNTmd0Jo1dQp4AUmMBLtGiD9YpMuXzHefitcuVStc',
        goongAccessToken: process.env.GOONG_API_TOKEN || 'local-docker-editor'
      });
      return true;
    }

    if (pathname === '/health') {
      try {
        await pool.query('SELECT 1');
        sendJSON(response, 200, { status: 'ok', database: 'online', table: `${table.schema}.${table.table}` });
      } catch (error) {
        sendJSON(response, 503, { status: 'error', database: 'offline', message: error.message });
      }
      return true;
    }

    if (!pathname.startsWith('/api/')) return false;

    try {
      if (method === 'GET' && pathname === '/api/capabilities.json') {
        sendJSON(response, 200, {
          version: '0.6',
          generator: GENERATOR,
          api: {
            version: { minimum: '0.6', maximum: '0.6' },
            area: { maximum: 0.25 },
            note_area: { maximum: 25 },
            tracepoints: { per_page: 5000 },
            waynodes: { maximum: 2000 },
            changesets: { maximum_elements: 10000, default_query_limit: 100 },
            timeout: { seconds: 300 },
            status: { database: 'online', api: 'online', gpx: 'offline' }
          },
          policy: { imagery: { blacklist: [] } }
        });
        return true;
      }

      if (method === 'GET' && pathname === '/api/0.6/user/details.json') {
        sendJSON(response, 200, {
          version: '0.6', generator: GENERATOR,
          user: {
            id: 1,
            display_name: GENERATOR,
            account_created: '2026-01-01T00:00:00Z',
            description: 'Local PostGIS editor',
            contributor_terms: { agreed: true },
            roles: [],
            changesets: { count: 0 },
            traces: { count: 0 },
            blocks: { received: { count: 0, active: 0 } }
          }
        });
        return true;
      }

      if (method === 'GET' && pathname === '/api/0.6/changesets.json') {
        sendJSON(response, 200, { changesets: [] });
        return true;
      }

      if (method === 'GET' && pathname === '/api/0.6/map.json') {
        await loadMap(url, response);
        return true;
      }

      if (method === 'GET' && pathname === '/api/0.6/notes.json') {
        sendJSON(response, 200, { type: 'FeatureCollection', features: [] });
        return true;
      }

      let match = /^\/api\/0\.6\/way\/(\d+)\/full\.json$/.exec(pathname);
      if (method === 'GET' && match) {
        await loadWays([match[1]], response, true);
        return true;
      }

      match = /^\/api\/0\.6\/way\/(\d+)\.json$/.exec(pathname);
      if (method === 'GET' && match) {
        await loadWays([match[1]], response, false);
        return true;
      }

      match = /^\/api\/0\.6\/node\/(\d+)\.json$/.exec(pathname);
      if (method === 'GET' && match) {
        loadNodes([match[1]], response);
        return true;
      }

      match = /^\/api\/0\.6\/(node|way)\/\d+\/relations\.json$/.exec(pathname);
      if (method === 'GET' && match) {
        sendJSON(response, 200, { version: '0.6', generator: GENERATOR, elements: [] });
        return true;
      }

      if (method === 'GET' && pathname === '/api/0.6/ways.json') {
        const ids = validateIds((url.searchParams.get('ways') || '').split(','), 'way');
        await loadWays(ids, response, false);
        return true;
      }

      if (method === 'GET' && pathname === '/api/0.6/nodes.json') {
        const ids = validateIds((url.searchParams.get('nodes') || '').split(','), 'node');
        loadNodes(ids, response);
        return true;
      }

      if (method === 'PUT' && pathname === '/api/0.6/changeset/create') {
        const xml = await readRequestBody(request);
        const tags = parseElementTags(xml, 'changeset');
        const result = await pool.query(
          'INSERT INTO goong_editor.changesets (tags) VALUES ($1::jsonb) RETURNING id::text',
          [JSON.stringify(tags)]
        );
        sendText(response, 200, result.rows[0].id);
        return true;
      }

      match = /^\/api\/0\.6\/changeset\/(\d+)\/upload$/.exec(pathname);
      if (method === 'POST' && match) {
        const xml = await readRequestBody(request);
        const diffResult = await uploadChangeset(match[1], xml);
        sendText(response, 200, diffResult, 'text/xml; charset=utf-8');
        return true;
      }

      match = /^\/api\/0\.6\/changeset\/(\d+)\/close$/.exec(pathname);
      if (method === 'PUT' && match) {
        await pool.query(
          'UPDATE goong_editor.changesets SET closed_at = now() WHERE id = $1',
          [match[1]]
        );
        sendText(response, 200, '');
        return true;
      }

      match = /^\/api\/0\.6\/changeset\/(\d+)$/.exec(pathname);
      if (method === 'PUT' && match) {
        const xml = await readRequestBody(request);
        const tags = parseElementTags(xml, 'changeset');
        await pool.query(
          'UPDATE goong_editor.changesets SET tags = $2::jsonb WHERE id = $1',
          [match[1], JSON.stringify(tags)]
        );
        sendText(response, 200, '');
        return true;
      }

      throw new ApiError(404, `Unsupported API endpoint: ${method} ${pathname}`);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error); // eslint-disable-line no-console
      sendText(response, status, error.message || 'Internal server error');
      return true;
    }
  }


  async function close() {
    await pool.end();
  }


  return { init, handle, close };
}
