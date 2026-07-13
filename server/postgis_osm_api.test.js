import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeNodeId,
  encodeNodeId,
  parseElementTags,
  parseOsmChange
} from './postgis_osm_api.js';


test('node ids round-trip coordinates at seven decimal places', () => {
  const id = encodeNodeId(105.85421234, 21.02851119);
  assert.deepEqual(decodeNodeId(id), [105.8542123, 21.0285112]);
});


test('shared coordinates produce the same stable node id', () => {
  assert.equal(
    encodeNodeId(105.85421234, 21.02851119),
    encodeNodeId(105.85421231, 21.02851121)
  );
});


test('osmChange parser keeps actions, node refs, and escaped tags', () => {
  const xml = `
    <osmChange version="0.6">
      <modify>
        <node id="123" version="1" lon="105.8" lat="21.0"/>
        <way id="456" version="2">
          <nd ref="123"/><nd ref="124"/>
          <tag k="name" v="A &amp; B"/>
        </way>
      </modify>
    </osmChange>`;
  const parsed = parseOsmChange(xml);

  assert.equal(parsed.modify.length, 2);
  assert.deepEqual(parsed.modify[1].nodes, ['123', '124']);
  assert.equal(parsed.modify[1].tags.name, 'A & B');
});


test('changeset tag parser reads upload metadata', () => {
  const tags = parseElementTags(
    '<osm><changeset><tag k="comment" v="Sua duong"/></changeset></osm>',
    'changeset'
  );
  assert.deepEqual(tags, { comment: 'Sua duong' });
});
