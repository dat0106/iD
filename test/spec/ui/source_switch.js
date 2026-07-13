import { select as d3_select } from 'd3-selection';

describe('iD.uiSourceSwitch', function () {
    it('renders named sources and switches to the selected source', function() {
        var activeApiUrl = 'http://goong.test';
        var switchedTo;
        var historyCleared = false;
        var contextFlushed = false;
        var selection = d3_select('body').append('div');
        var sources = [
            { id: 'osm', name: 'OSM', url: 'https://www.openstreetmap.org', apiUrl: 'https://api.openstreetmap.org' },
            { id: 'goong', name: 'Goong', url: 'http://goong.test', apiUrl: 'http://goong.test' }
        ];
        var connection = {
            getApiUrlRoot: () => activeApiUrl,
            switch: source => {
                switchedTo = source;
                activeApiUrl = source.apiUrl || source.url;
            }
        };
        var context = {
            connection: () => connection,
            inIntro: () => false,
            history: () => ({
                hasChanges: () => false,
                clearSaved: () => { historyCleared = true; }
            }),
            enter: () => {},
            flush: () => { contextFlushed = true; }
        };

        selection.call(iD.uiSourceSwitch(context).keys(sources));

        expect(selection.selectAll('a').nodes().map(node => node.textContent)).toEqual(['OSM', 'Goong']);
        expect(selection.select('[data-source="goong"]').classed('active')).toBe(true);

        selection.select('[data-source="osm"]').node().dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(switchedTo).toBe(sources[0]);
        expect(historyCleared).toBe(true);
        expect(contextFlushed).toBe(true);
        expect(selection.select('[data-source="osm"]').classed('active')).toBe(true);
    });
});
