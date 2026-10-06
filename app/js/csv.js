/* CSV export for Jira's CSV importer. */
(function () {
  'use strict';

  const JIRA_PRIORITY = { P0: 'Highest', P1: 'High', P2: 'Medium', P3: 'Low' };

  function cell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+@]/.test(s)) s = "'" + s; // neutralize spreadsheet formula injection
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const toCsv = (header, rows) => [header].concat(rows).map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

  function storiesToCsv(stories) {
    const head = ['Issue Type', 'Summary', 'Description', 'Acceptance Criteria', 'Priority', 'Labels', 'Assignee', 'Status', 'Subtasks'];
    return toCsv(head, stories.map((s) => [
      'Story', s.title, s.description,
      (s.acceptance_criteria || []).map((a, i) => (i + 1) + '. ' + a).join('\n'),
      JIRA_PRIORITY[s.priority] || s.priority,
      (s.labels || []).join(' '), // Jira importer splits labels on whitespace
      s.assignee || '', s.status,
      (s.subtasks || []).map((t) => (typeof t === 'string' ? t : t.text)).join('\n'),
    ]));
  }

  const PLAN_SECTIONS = [
    ['objectives', 'Objectives'], ['scope_in', 'Scope (in)'], ['scope_out', 'Scope (out)'], ['approach', 'Approach'],
    ['entry_criteria', 'Entry criteria'], ['exit_criteria', 'Exit criteria'], ['risks', 'Risks'],
  ];
  const planText = (v) => (Array.isArray(v) ? v.map((x) => '* ' + x).join('\n') : v || '');

  function planToCsv(plan) {
    return toCsv(['Issue Type', 'Summary', 'Description', 'Priority', 'Labels'],
      PLAN_SECTIONS.map(([k, label]) => ['Task', 'Test plan: ' + label, planText(plan[k]), 'Medium', 'test-plan']));
  }

  function casesToCsv(cases) {
    return toCsv(['Issue Type', 'Summary', 'Description', 'Expected Result', 'Priority', 'Labels', 'Issue Key'],
      cases.map((c) => [
        'Test', c.title,
        (c.steps || []).map((s, i) => (i + 1) + '. ' + s).join('\n'),
        c.expected, JIRA_PRIORITY[c.priority] || c.priority, c.requirement_ref, c.id,
      ]));
  }

  function download(name, text) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const file = 'being-agile-' + name + '-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '.csv';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    a.download = file;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return file;
  }

  window.CSV = { cell, storiesToCsv, planToCsv, casesToCsv, PLAN_SECTIONS, download };
})();
