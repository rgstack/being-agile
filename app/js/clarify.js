/* Clarify (stage 1): placeholder module for the stage refactor commit. The full screen — ledger, transcript,
   composer, dry-run script — lands in the next commit. Exposes window.Clarify with the surface screens.js expects. */
(function () {
  'use strict';
  let X = null; // the slice of screens.js this module is given at init
  const S = () => X.getS();
  function render() {
    const C = S().clarify, esc = X.esc;
    return '<h1 class="title">Clarify</h1><p class="lede">The AI reads your documents through a delivery lens, then asks about what it could not place. Nothing it asks blocks you.</p>' +
      '<div class="ledger"><p class="cl-kicker">The delivery ledger</p>' + window.State.LENSES.map((k) => '<div class="lens"><i class="mark"></i><span>' + esc(window.State.LENS_LABEL[k]) + '</span><span class="hint">—</span></div>').join('') + '</div>' +
      '<div class="next"><button class="btn" data-a="cl-begin" disabled title="Arrives in the next commit">Begin review</button><button class="btn btn-q" data-a="cl-gen"' + (X.ui.busy ? ' disabled' : '') + '>Generate stories</button></div>' + X.errBox() + (C.status ? '' : '');
  }
  const meta = () => { const C = S().clarify; if (C.status === 'idle') return 'No review yet'; if (C.status === 'reading') return 'Reading…'; const t = window.State.ledgerTally(C.ledger); return t.confirmed + ' of 4 confirmed · ' + t.open + ' open'; };
  window.Clarify = {
    init: (ctx) => { X = ctx; }, render, meta, onEnter: () => {}, reset: () => {},
    actions: { 'cl-gen': () => X.genStories() }, inputs: {}, changes: {},
    dryTurn: () => ({ reply: '', ledger_updates: {}, question_updates: [], ask: null, done: true }),
  };
})();
