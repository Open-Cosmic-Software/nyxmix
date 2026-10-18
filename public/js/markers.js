// Marker list: navigate, rename, turn into selections, delete. Agents leave review notes here.
import { el, fmtTime } from './ui.js';

export class MarkersView {
  constructor(app) { this.app = app; this.label = 'Markers'; }

  render(box) {
    const app = this.app, ms = app.project.markers;
    if (!ms.length) { box.replaceChildren(el('p', { class: 'muted dock-empty' }, 'Press M to drop a marker at the playhead (or over a selected range). Agents use markers to flag spots for you to check.')); return; }
    box.replaceChildren(el('table', { class: 'markers' }, [
      el('thead', {}, el('tr', {}, ['Time', 'Length', 'Note', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, ms.map((m) => el('tr', {}, [
        el('td', {}, el('button', { class: 'link', onclick: () => { app.player.seek(m.time); app.timeline.reveal(m.time); if (m.duration) { app.selection.range = { start: m.time, end: m.time + m.duration }; app.emitSelection(); } } }, fmtTime(m.time, 2))),
        el('td', { class: 'muted' }, m.duration ? `${m.duration.toFixed(2)} s` : ''),
        el('td', { class: 'grow' }, el('input', { class: 'input mk-label', value: m.label, placeholder: 'Add a note', onchange: (e) => app.op('marker.update', { markerId: m.id, label: e.target.value }) })),
        el('td', {}, el('button', { class: 'icon-btn', 'aria-label': 'Delete marker', title: 'Delete marker', onclick: () => app.op('marker.remove', { markerId: m.id }) }, '×')),
      ]))),
    ]));
  }
}
