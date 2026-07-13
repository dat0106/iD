import { t } from '../core/localizer';
import { modeBrowse } from '../modes/browse';


export function uiSourceSwitch(context) {
    var keys = [];
    var rootSelection;


    function sourceKey(source, index) {
        return source.id || source.apiUrl || source.url || index;
    }


    function sourceLabel(source, index) {
        if (source.name) return source.name;
        return index === 0 ? t('source_switch.live') : t('source_switch.dev');
    }


    function isActive(source) {
        var osm = context.connection();
        if (!osm) return false;
        return osm.getApiUrlRoot() === (source.apiUrl || source.url);
    }


    function render(selection) {
        rootSelection = selection;

        selection
            .selectAll('a.source-option')
            .data(keys, sourceKey)
            .join('a')
            .attr('href', '#')
            .attr('class', 'chip source-option')
            .attr('data-source', source => source.id || null)
            .attr('aria-pressed', source => isActive(source) ? 'true' : 'false')
            .attr('title', (source, index) => source.description || sourceLabel(source, index))
            .classed('active', isActive)
            .text(sourceLabel)
            .on('click', click);
    }


    function click(d3_event, source) {
        d3_event.preventDefault();

        var osm = context.connection();
        if (!osm) return;
        if (isActive(source)) return;

        if (context.inIntro()) return;

        if (context.history().hasChanges() &&
            !window.confirm(t('source_switch.lose_changes'))) return;

        context.enter(modeBrowse(context));
        context.history().clearSaved();          // remove saved history
        context.flush();                         // remove stored data

        osm.switch(source);  // warning: dispatches 'change' event
        render(rootSelection);
    }

    var sourceSwitch = function(selection) {
        render(selection);
    };


    sourceSwitch.keys = function(_) {
        if (!arguments.length) return keys;
        keys = _;
        return sourceSwitch;
    };


    return sourceSwitch;
}
