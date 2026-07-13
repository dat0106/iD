/* eslint-disable no-console, no-process-env, require-atomic-updates */

const baseUrl = process.env.EDITOR_URL || 'http://127.0.0.1:8081';
let createdWayId;
let createdWayVersion = 1;
let deleted = false;


async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${body}`);
  }
  return { response, body };
}


async function createChangeset(comment) {
  const xml = `<osm><changeset><tag k="comment" v="${comment}"/><tag k="created_by" v="Goong editor smoke test"/></changeset></osm>`;
  const { body } = await request('/api/0.6/changeset/create', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/xml' },
    body: xml
  });
  return body.trim();
}


function upload(changesetId, xml) {
  return request(`/api/0.6/changeset/${changesetId}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: xml
  });
}


async function closeChangeset(changesetId) {
  await request(`/api/0.6/changeset/${changesetId}/close`, { method: 'PUT' });
}


async function deleteCreatedWay(comment) {
  if (!createdWayId || deleted) return;
  const changesetId = await createChangeset(comment);
  const xml = `<osmChange version="0.6" generator="smoke-test"><delete if-unused="true"><way id="${createdWayId}" version="${createdWayVersion}" changeset="${changesetId}"/></delete></osmChange>`;
  await upload(changesetId, xml);
  await closeChangeset(changesetId);
  deleted = true;
}


try {
  const health = await request('/health');
  const healthPayload = JSON.parse(health.body);
  if (healthPayload.database !== 'online') throw new Error('Database is not online');

  const createChangesetId = await createChangeset('Create temporary smoke-test road');
  const createXml = `<osmChange version="0.6" generator="smoke-test"><create><node id="-1" version="0" lon="10.0000000" lat="10.0000000" changeset="${createChangesetId}"/><node id="-2" version="0" lon="10.0001000" lat="10.0001000" changeset="${createChangesetId}"/><way id="-1" version="0" changeset="${createChangesetId}"><nd ref="-1"/><nd ref="-2"/><tag k="highway" v="service"/><tag k="name" v="__goong_editor_smoke_test__"/></way></create></osmChange>`;
  const created = await upload(createChangesetId, createXml);
  await closeChangeset(createChangesetId);

  const idMatch = /<way old_id="-1" new_id="(\d+)" new_version="(\d+)"\/>/.exec(created.body);
  if (!idMatch) throw new Error(`Create diffResult did not contain a way id: ${created.body}`);
  createdWayId = idMatch[1];
  createdWayVersion = Number(idMatch[2]);

  const loaded = await request(`/api/0.6/way/${createdWayId}/full.json`);
  const loadedPayload = JSON.parse(loaded.body);
  const loadedWay = loadedPayload.elements.find(element => element.type === 'way');
  if (!loadedWay || loadedWay.tags.name !== '__goong_editor_smoke_test__') {
    throw new Error('Created road could not be read back through the OSM API');
  }

  const originalNodeId = loadedWay.nodes[0];
  const moveChangesetId = await createChangeset('Move temporary smoke-test road node');
  const moveXml = `<osmChange version="0.6" generator="smoke-test"><modify><node id="${originalNodeId}" version="1" lon="10.0000200" lat="10.0000200" changeset="${moveChangesetId}"/></modify></osmChange>`;
  await upload(moveChangesetId, moveXml);
  await closeChangeset(moveChangesetId);

  const moved = await request(`/api/0.6/way/${createdWayId}/full.json`);
  const movedPayload = JSON.parse(moved.body);
  const movedWay = movedPayload.elements.find(element => element.type === 'way');
  if (!movedWay || movedWay.nodes[0] === originalNodeId || movedWay.version !== 2) {
    throw new Error('Moved road node or version was not persisted');
  }
  createdWayVersion = movedWay.version;

  const modifyChangesetId = await createChangeset('Modify temporary smoke-test road tags');
  const nodeReferences = movedWay.nodes.map(id => `<nd ref="${id}"/>`).join('');
  const modifyXml = `<osmChange version="0.6" generator="smoke-test"><modify><way id="${createdWayId}" version="${createdWayVersion}" changeset="${modifyChangesetId}">${nodeReferences}<tag k="highway" v="service"/><tag k="name" v="__goong_editor_smoke_test_modified__"/><tag k="maxspeed" v="30"/></way></modify></osmChange>`;
  await upload(modifyChangesetId, modifyXml);
  await closeChangeset(modifyChangesetId);

  const modified = await request(`/api/0.6/way/${createdWayId}/full.json`);
  const modifiedPayload = JSON.parse(modified.body);
  const modifiedWay = modifiedPayload.elements.find(element => element.type === 'way');
  if (!modifiedWay || modifiedWay.tags.name !== '__goong_editor_smoke_test_modified__' ||
      modifiedWay.tags.maxspeed !== '30' || modifiedWay.version !== 3) {
    throw new Error('Modified road tags or version were not persisted');
  }
  createdWayVersion = modifiedWay.version;

  await deleteCreatedWay('Delete temporary smoke-test road');
  const deletedResponse = await fetch(`${baseUrl}/api/0.6/way/${createdWayId}/full.json`);
  if (deletedResponse.status !== 404) {
    throw new Error(`Deleted road still returned status ${deletedResponse.status}`);
  }

  console.log(JSON.stringify({
    status: 'ok',
    database: healthPayload.table,
    temporaryWayId: createdWayId,
    cleanup: 'deleted'
  }));
} finally {
  await deleteCreatedWay('Cleanup temporary smoke-test road').catch(error => {
    console.error(`Cleanup failed: ${error.message}`);
  });
}
