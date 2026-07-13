local schema_name = os.getenv('OSM_EDITOR_SCHEMA') or 'public'
local table_name = os.getenv('OSM_EDITOR_TABLE') or 'osm_editor'

local osm_editor = osm2pgsql.define_table({
    name = table_name,
    schema = schema_name,
    ids = { type = 'way', id_column = 'osm_id' },
    columns = {
        { column = 'tags', type = 'jsonb', not_null = true },
        { column = 'geom', type = 'linestring', projection = 4326, not_null = true }
    }
})

function osm2pgsql.process_way(object)
    if not object.tags.highway then
        return
    end

    osm_editor:add_row({
        tags = object.tags,
        geom = { create = 'line' }
    })
end
