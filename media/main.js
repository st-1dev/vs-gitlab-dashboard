// GitLab Dashboard webview: renders controller state and sends typed user actions (UC6).
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const { parseAnsi, completions } = window.DashboardShared;
  const post = (type, payload = {}) => vscode.postMessage({ type, ...payload });

  /** Element builder: properties and listeners are assigned directly, content is always text. */
  function h(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null) continue;
      if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key === 'class') element.className = value;
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key in element && typeof value !== 'string') element[key] = value;
      else element.setAttribute(key, value);
    }
    for (const child of children.flat()) if (child != null) element.append(child instanceof Node ? child : String(child));
    return element;
  }
  const button = (text, onclick, props = {}) => h('button', { type: 'button', onclick, ...props }, text);
  const action = (text, type, props = {}) => button(text, () => post(type), props);

  let state = null;
  let queryVersion = 0;
  let sort = null;
  let logKey = null;
  let suggestion = null;
  let shownRow = null, shownJob = null;
  let detailVisible = false;
  let returnFocus = null;

  // ---- Layout ----
  const presets = h('select', { 'aria-label': 'Сохранённые фильтры', onchange: () => { if (presets.value) post('applyPreset', { name: presets.value }); deletePreset.disabled = !presets.value; } });
  const deletePreset = button('Удалить', () => { if (presets.value) post('deletePreset', { name: presets.value }); }, { disabled: true });
  const watchButton = button('Следить до завершения', () => post('toggleWatch'));
  const openButton = action('Открыть в GitLab', 'openPipeline');
  const watchedOnly = h('input', { type: 'checkbox', onchange: () => post('watchedOnly', { value: watchedOnly.checked }) });
  const runButton = action('Запустить pipeline', 'openRunForm', { class: 'primary' });
  const toolbar = h('div', { class: 'toolbar' },
    h('h1', {}, 'Pipelines'), runButton);

  const query = h('input', { type: 'text', class: 'query', spellcheck: false, placeholder: 'project:team/* branch:feature/* status:failed,running user:me after:24h',
    id: 'pipeline-query', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'query-suggestions', 'aria-describedby': 'query-hint',
    title: 'project:team/* branch:feature/* status:failed,running user:me after:24h' });
  const suggest = h('div', { id: 'query-suggestions', class: 'suggest hidden', role: 'listbox', 'aria-label': 'Подсказки запроса' });
  const more = action('Загрузить ещё', 'loadMore');
  const stop = action('Остановить загрузку', 'stop');
  const findButton = button('Найти', () => search());
  const filterButton = button('Фильтры…', () => post('openFilterForm', { query: query.value }));
  const querybar = h('div', { class: 'querybar' },
    h('div', { class: 'query-wrap' }, query, suggest),
    findButton, filterButton);
  const searchPanel = h('section', { class: 'search-panel', 'aria-label': 'Поиск pipeline' },
    h('label', { for: 'pipeline-query', class: 'label' }, 'Поиск pipeline'), querybar,
    h('div', { id: 'query-hint', class: 'hint' }, 'Enter — найти · Ctrl+Space — подсказки'),
    h('div', { class: 'filter-tools' },
      h('label', { class: 'check' }, watchedOnly, 'Отслеживаемые'),
      h('details', { class: 'saved-filters' }, h('summary', {}, 'Сохранённые фильтры'),
        h('div', { class: 'saved-filter-controls' }, presets,
          button('Сохранить текущий', () => post('savePreset', { query: query.value })), deletePreset))));

  const columns = [['status', 'Статус'], ['project', 'Проект'], ['id', 'Pipeline'], ['ref', 'Ветка'], ['sha', 'SHA'], ['source', 'Источник'], ['createdAt', 'Создан']];
  const headRow = h('tr', {}, columns.map(([key, title]) => h('th', { scope: 'col', dataset: { key } }, button(title, () => {
    sort = sort?.key === key ? { key, dir: -sort.dir } : { key, dir: 1 }; renderRows();
  }, { class: 'sort-button' }))));
  const rows = h('tbody');
  const empty = h('div', { class: 'empty' });
  const pipelineGrid = h('table', { role: 'grid', tabindex: '0', 'aria-label': 'Pipeline: стрелки вверх и вниз — выбор', onkeydown: moveSelection }, h('thead', {}, headRow), rows);
  const table = h('div', { class: 'pipelines' }, pipelineGrid, empty);
  const pipelineCount = h('span', { class: 'section-count' });
  const pipelineSection = h('section', { class: 'pipeline-section', 'aria-label': 'Список pipeline' },
    h('div', { class: 'section-heading' }, h('h2', {}, 'Результаты'), pipelineCount), table,
    h('div', { class: 'list-actions' }, more, stop));

  const details = h('pre', { class: 'details' });
  const eta = h('pre', { class: 'eta' });
  const jobs = h('div', { class: 'jobs', tabindex: '0', role: 'listbox', 'aria-label': 'Jobs по стадиям', onkeydown: moveJob });
  const logTitle = h('span', { class: 'log-title' }, 'Лог job');
  const logSearch = h('input', { type: 'search', class: 'log-search', placeholder: 'Поиск в логе', oninput: () => findInLog(0), onkeydown: event => {
    if (event.key === 'Enter') { event.preventDefault(); findInLog(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') { logSearch.value = ''; findInLog(0); }
  }, 'aria-label': 'Поиск в логе' });
  const logCount = h('span', { class: 'log-count', role: 'status' });
  const log = h('div', { class: 'console', tabindex: '0', role: 'region', 'aria-label': 'Лог выбранной job' });
  const logActions = h('details', { class: 'log-actions' }, h('summary', {}, 'Действия с логом'),
    h('div', { class: 'row' },
      action('Обновить', 'refreshLog'), action('Копировать', 'copyLog', { title: 'Копировать лог без ANSI-кодов' }),
      action('В редактор', 'openLog'), action('Job в GitLab', 'openJob')));
  const logPanel = h('div', { class: 'log' },
    h('div', { class: 'log-heading' }, logTitle, logActions),
    h('div', { class: 'log-toolbar' }, logSearch, logCount,
      button('↑', () => findInLog(-1), { 'aria-label': 'Предыдущее совпадение', title: 'Предыдущее совпадение (Shift+Enter)' }),
      button('↓', () => findInLog(1), { 'aria-label': 'Следующее совпадение', title: 'Следующее совпадение (Enter)' })),
    log);
  const backButton = button('← К списку', () => { detailVisible = false; renderLayout(); pipelineGrid.focus(); }, { class: 'back-button' });
  const detailHeading = h('h2', { tabindex: '-1' }, 'Детали pipeline');
  const detailActions = h('div', { class: 'detail-actions' }, watchButton, openButton);
  const jobsLog = h('div', { class: 'jobs-log' }, jobs, logPanel);
  const detailPanel = h('section', { class: 'detail-panel', 'aria-label': 'Детали pipeline' },
    h('div', { class: 'section-heading' }, backButton, detailHeading), detailActions, details, eta, jobsLog);
  const splitter = h('div', { class: 'splitter', tabindex: '0', role: 'separator', 'aria-label': 'Ширина списка pipeline', 'aria-orientation': 'vertical',
    'aria-valuemin': '25', 'aria-valuemax': '70', 'aria-valuenow': '45', title: 'Перетащите или используйте стрелки влево и вправо' });
  const banner = h('section', { class: 'banner hidden', 'aria-label': 'Подключение к GitLab' },
    h('h2', {}, 'Ваши pipeline в VS Code'), h('p', {}, 'Статусы, jobs и логи проектов — в одной панели.'),
    h('ol', {}, h('li', {}, 'Откройте доверенную папку проекта.'), h('li', {}, 'Укажите URL GitLab и Personal Access Token со scope api.')),
    action('Настроить подключение', 'configure', { class: 'primary' }),
    h('p', { class: 'hint' }, 'Подключение хранится в .vscode/gitlab-dashboard.json.'));
  const main = h('div', { class: 'main' }, pipelineSection, splitter, detailPanel);
  const status = h('div', { class: 'status', role: 'status' });
  const monitor = h('div', { class: 'monitor' });
  const overlay = h('div', { class: 'overlay hidden' });
  const app = h('div', { class: 'app' }, toolbar, searchPanel, banner, main, h('div', { class: 'statusbar' }, status, monitor));
  document.body.append(app, overlay);

  function renderLayout() {
    app.classList.toggle('has-selection', Boolean(state?.selectedKey) && detailVisible);
  }

  function selectPipeline(key) {
    detailVisible = true;
    renderLayout();
    if (state?.selectedKey && window.matchMedia('(max-width: 600px)').matches) backButton.focus();
    post('selectPipeline', { key });
  }

  function resizePipelines(percent) {
    const value = Math.min(70, Math.max(25, percent));
    pipelineSection.style.flexBasis = `${value}%`;
    splitter.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  splitter.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = Number(splitter.getAttribute('aria-valuenow'));
    resizePipelines(event.key === 'Home' ? 25 : event.key === 'End' ? 70 : current + (event.key === 'ArrowLeft' ? -5 : 5));
  });

  splitter.addEventListener('pointerdown', event => {
    splitter.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      const box = main.getBoundingClientRect();
      resizePipelines((moveEvent.clientX - box.left) / box.width * 100);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('lostpointercapture', () => splitter.removeEventListener('pointermove', move), { once: true });
  });

  // ---- Query and suggestions ----
  function search() { hideSuggestions(); post('search', { query: query.value }); }

  query.addEventListener('keydown', event => {
    if (event.key === ' ' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); showSuggestions(); return; }
    if (suggestion) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        suggestion.index = (suggestion.index + (event.key === 'ArrowDown' ? 1 : -1) + suggestion.items.length) % suggestion.items.length;
        renderSuggestions();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); applySuggestion(suggestion.items[suggestion.index]); return; }
      if (event.key === 'Escape') { event.preventDefault(); hideSuggestions(); return; }
    }
    if (event.key === 'Enter') { event.preventDefault(); search(); }
  });
  query.addEventListener('input', () => { if (suggestion) showSuggestions(); });
  query.addEventListener('blur', () => setTimeout(hideSuggestions, 150));

  function showSuggestions() {
    if (!state) return;
    const result = completions(query.value, query.selectionStart ?? query.value.length, state.completion);
    suggestion = result.items.length ? { ...result, index: 0 } : null;
    renderSuggestions();
  }
  function renderSuggestions() {
    suggest.replaceChildren(...(suggestion?.items ?? []).map((item, index) => h('div', {
      id: `suggestion-${index}`, class: index === suggestion.index ? 'item active' : 'item', role: 'option', 'aria-selected': String(index === suggestion.index),
      onmousedown: event => { event.preventDefault(); applySuggestion(item); }
    }, item)));
    suggest.classList.toggle('hidden', !suggestion);
    query.setAttribute('aria-expanded', String(Boolean(suggestion)));
    if (suggestion) query.setAttribute('aria-activedescendant', `suggestion-${suggestion.index}`);
    else query.removeAttribute('aria-activedescendant');
    suggest.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  function hideSuggestions() { suggestion = null; renderSuggestions(); }
  function applySuggestion(item) {
    const { start, end } = suggestion;
    const tail = query.value.slice(end);
    const insert = item + (item.endsWith(':') || tail.startsWith(' ') ? '' : ' ');
    query.value = query.value.slice(0, start) + insert + tail;
    query.selectionStart = query.selectionEnd = start + insert.length;
    query.focus();
    if (item.endsWith(':')) showSuggestions(); else hideSuggestions();
  }

  // ---- Rendering ----
  const statusClass = value => `status-${String(value).replace(/[^a-z_]/g, '')}`;

  function render() {
    if (!state) return;
    if (state.queryVersion !== queryVersion) { queryVersion = state.queryVersion; query.value = state.query; }
    const previous = presets.value;
    presets.replaceChildren(h('option', { value: '' }, 'Сохранённые фильтры…'), ...state.presets.map(name => h('option', { value: name }, name)));
    presets.value = state.presets.includes(previous) ? previous : '';
    deletePreset.disabled = !presets.value;
    banner.classList.toggle('hidden', state.configured);
    app.classList.toggle('unconfigured', !state.configured);
    watchedOnly.checked = state.watchedOnly;
    runButton.disabled = !state.configured || !state.completion.projects.length;
    findButton.disabled = state.loading;
    watchButton.disabled = !state.selectedKey;
    openButton.disabled = !state.selectedKey;
    watchButton.setAttribute('aria-pressed', String(state.selectedWatched));
    watchButton.textContent = state.selectedWatched ? 'Перестать следить' : 'Следить до завершения';
    more.disabled = !state.canLoadMore || state.loading;
    more.classList.toggle('hidden', !state.canLoadMore);
    stop.disabled = !state.loading;
    stop.classList.toggle('hidden', !state.loading);
    table.setAttribute('aria-busy', String(state.loading));
    status.textContent = state.status;
    status.title = state.status;
    status.classList.toggle('loading', state.loading);
    monitor.textContent = state.monitorStatus;
    monitor.title = state.monitorStatus;
    pipelineCount.textContent = `${state.rows.length}${state.loading ? ' · загрузка…' : ''}`;
    detailHeading.textContent = state.selectedKey ? `Pipeline #${state.rows.find(row => row.key === state.selectedKey)?.id ?? state.selectedKey.split(':').pop()}` : 'Детали pipeline';
    detailActions.classList.toggle('hidden', !state.selectedKey);
    jobsLog.classList.toggle('hidden', !state.selectedKey);
    renderLayout();
    renderRows();
    details.textContent = state.details || (state.selectedKey ? 'Загружаю детали…' : 'Выберите pipeline в списке. Здесь появятся детали, прогноз завершения, jobs и лог.');
    eta.textContent = state.eta;
    eta.classList.toggle('hidden', !state.eta);
    renderJobs();
    renderOverlay();
  }

  function renderRows() {
    const list = [...state.rows];
    if (sort) list.sort((a, b) => (a[sort.key] < b[sort.key] ? -1 : a[sort.key] > b[sort.key] ? 1 : 0) * sort.dir);
    for (const th of headRow.children) {
      th.dataset.sort = sort?.key === th.dataset.key ? (sort.dir > 0 ? 'asc' : 'desc') : '';
      th.setAttribute('aria-sort', !th.dataset.sort ? 'none' : sort.dir > 0 ? 'ascending' : 'descending');
    }
    rows.replaceChildren(...list.map(row => h('tr', {
      id: `pipeline-${row.key}`, 'aria-selected': String(row.key === state.selectedKey),
      class: row.key === state.selectedKey ? 'selected' : '', dataset: { key: row.key },
      onclick: () => { pipelineGrid.focus(); selectPipeline(row.key); }
    },
    h('td', { class: `cell-status ${statusClass(row.status)}`, title: row.status }, h('span', { class: 'dot', 'aria-hidden': 'true' }), row.status, row.watched ? h('span', { class: 'watched', title: 'Отслеживается', 'aria-label': 'Отслеживается' }, ' ◉') : null),
    h('td', { class: 'cell-project', title: row.project }, row.project), h('td', { class: 'cell-id num' }, `#${row.id}`), h('td', { class: 'cell-ref', title: row.ref }, row.ref), h('td', { class: 'cell-sha mono' }, row.sha),
    h('td', { class: 'cell-source' }, row.source), h('td', { class: 'cell-created num' }, row.created))));
    if (state.selectedKey && list.some(row => row.key === state.selectedKey)) pipelineGrid.setAttribute('aria-activedescendant', `pipeline-${state.selectedKey}`);
    else pipelineGrid.removeAttribute('aria-activedescendant');
    const noProjects = !state.completion.projects.length;
    empty.replaceChildren(...(list.length ? [] : [
      h('h3', {}, state.loading ? 'Загружаю pipeline…' : noProjects ? 'Добавьте первый проект' : state.watchedOnly ? 'Нет отслеживаемых pipeline' : 'Pipeline не найдены'),
      h('p', {}, state.loading ? 'Результаты появятся здесь.' : noProjects ? 'Откройте GitLab-репозиторий или добавьте проект по URL либо названию.' : state.watchedOnly ? 'Выберите pipeline и нажмите «Следить до завершения».' : 'Измените фильтры или проверьте историю за другой период.'),
      state.loading ? null : noProjects ? action('Добавить проект', 'addProject') : state.watchedOnly
        ? button('Показать все pipeline', () => post('watchedOnly', { value: false }))
        : button('Сбросить фильтры', () => { query.value = 'after:7d'; search(); })
    ]));
    empty.classList.toggle('hidden', list.length > 0);
    if (state.selectedKey !== shownRow) { shownRow = state.selectedKey; rows.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' }); }
  }

  function moveSelection(event) {
    if (event.target !== pipelineGrid || !['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const keys = [...rows.children].map(tr => tr.dataset.key);
    if (!keys.length) return;
    const index = keys.indexOf(state.selectedKey);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : index < 0 ? 0 : Math.min(keys.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0)));
    selectPipeline(keys[next]);
  }

  function renderJobs() {
    let stage = null;
    const items = [];
    for (const job of state.jobs) {
      if (job.stage !== stage) { stage = job.stage; items.push(h('div', { class: 'stage' }, stage)); }
      items.push(h('div', {
        id: `job-${job.id}`, 'aria-selected': String(job.id === state.selectedJobId),
        class: `job ${statusClass(job.status)}${job.id === state.selectedJobId ? ' selected' : ''}`, role: 'option', dataset: { id: String(job.id) },
        title: `${job.stage} / ${job.name} — ${job.status}${job.allowFailure ? ' (allow_failure)' : ''}${job.isTrigger ? ' · trigger job' : ''}`,
        onclick: () => { jobs.focus(); post('selectJob', { jobId: job.id }); }
      }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'job-name' }, job.isTrigger ? '⇢ ' : '', job.name), h('span', { class: 'job-status' }, job.status)));
    }
    jobs.replaceChildren(...(items.length ? items : [h('div', { class: 'empty' }, 'Jobs пока нет.')]));
    if (state.jobs.some(job => job.id === state.selectedJobId)) jobs.setAttribute('aria-activedescendant', `job-${state.selectedJobId}`);
    else jobs.removeAttribute('aria-activedescendant');
    if (state.selectedJobId !== shownJob) { shownJob = state.selectedJobId; jobs.querySelector('.job.selected')?.scrollIntoView({ block: 'nearest' }); }
  }

  function moveJob(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const ids = state.jobs.map(job => job.id);
    const index = ids.indexOf(state.selectedJobId);
    const next = ids[event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : Math.min(ids.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
    if (next != null) post('selectJob', { jobId: next });
  }

  // ---- Log console ----
  let logNodes = null, matches = [], matchIndex = -1;
  const highlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  function renderLog(data) {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    const sameJob = data?.key === logKey;
    logKey = data?.key ?? null;
    logTitle.textContent = data ? data.jobName : 'Лог job';
    logTitle.title = data?.jobName || 'Лог job';
    for (const control of logActions.querySelectorAll('button')) {
      control.disabled = !data || (['Копировать', 'В редактор'].includes(control.textContent) && !data.text);
    }
    const fragment = document.createDocumentFragment();
    if (data?.notice) fragment.append(h('div', { class: 'system' }, data.notice));
    if (data?.loading && !data.text) fragment.append(h('div', { class: 'system' }, 'Загружаю лог…'));
    if (data?.truncated) fragment.append(h('div', { class: 'system' }, 'Показан конец лога (буфер 2 MiB). Полный лог доступен в GitLab.'));
    for (const segment of data?.text ? parseAnsi(data.text) : []) {
      const style = segment.style;
      if (!Object.keys(style).length) { fragment.append(segment.text); continue; }
      const span = document.createElement('span');
      span.textContent = segment.text;
      const fg = style.inverse ? style.bg || 'var(--vscode-terminal-background, var(--vscode-panel-background))' : style.fg;
      const bg = style.inverse ? style.fg || 'var(--vscode-terminal-foreground, var(--vscode-foreground))' : style.bg;
      if (fg) span.style.color = fg;
      if (bg) span.style.backgroundColor = bg;
      if (style.bold) span.style.fontWeight = 'bold';
      if (style.dim) span.style.opacity = '0.7';
      if (style.italic) span.style.fontStyle = 'italic';
      if (style.underline) span.style.textDecoration = 'underline';
      fragment.append(span);
    }
    if (data?.error) fragment.append(h('div', { class: 'error' }, data.error));
    if (!data) fragment.append(h('div', { class: 'system' }, 'Выберите job, чтобы увидеть лог.'));
    log.replaceChildren(fragment);
    logNodes = null;
    if (!sameJob || atBottom) log.scrollTop = log.scrollHeight;
    findInLog(0, true);
  }

  function textNodes() {
    if (logNodes) return logNodes;
    const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let text = '';
    while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: text.length }); text += walker.currentNode.data; }
    logNodes = { nodes, text: text.toLowerCase() };
    return logNodes;
  }

  function rangeAt(start, end) {
    const { nodes } = textNodes();
    const locate = offset => {
      let low = 0, high = nodes.length - 1;
      while (low < high) { const mid = (low + high + 1) >> 1; if (nodes[mid].start <= offset) low = mid; else high = mid - 1; }
      return nodes[low];
    };
    const first = locate(start), last = locate(end - 1);
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }

  /** UC5: find text in the rendered log, highlight all matches and scroll to the current one. */
  function findInLog(step, keepPosition = false) {
    const needle = logSearch.value.toLowerCase();
    if (highlights) { CSS.highlights.delete('log-match'); CSS.highlights.delete('log-current'); }
    if (!needle) { matches = []; matchIndex = -1; logCount.textContent = ''; return; }
    const { text } = textNodes();
    const previous = matches[matchIndex];
    matches = [];
    for (let index = text.indexOf(needle); index >= 0 && matches.length < 10000; index = text.indexOf(needle, index + needle.length)) matches.push(index);
    if (!matches.length) { matchIndex = -1; logCount.textContent = 'нет совпадений'; return; }
    if (step === 0) {
      const kept = keepPosition && previous != null ? matches.indexOf(previous) : -1;
      matchIndex = kept >= 0 ? kept : 0;
    } else matchIndex = (matchIndex + step + matches.length) % matches.length;
    logCount.textContent = `${matchIndex + 1} / ${matches.length}${matches.length >= 10000 ? '+' : ''}`;
    const current = rangeAt(matches[matchIndex], matches[matchIndex] + needle.length);
    if (highlights) {
      CSS.highlights.set('log-match', new Highlight(...matches.slice(0, 2000).map(start => rangeAt(start, start + needle.length))));
      CSS.highlights.set('log-current', new Highlight(current));
    } else {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(current);
    }
    if (keepPosition) return;
    const rect = current.getBoundingClientRect(), box = log.getBoundingClientRect();
    if (rect.top < box.top || rect.bottom > box.bottom) log.scrollTop += rect.top - box.top - box.height / 2;
  }

  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && !overlay.contains(document.activeElement)) {
      event.preventDefault();
      const target = logSearch.getClientRects().length ? logSearch : query;
      target.focus();
      target.select();
    }
  });

  // ---- Forms ----
  let openForm = null, branchVersion = -1;

  function field(label, control, hint) {
    const wrapper = ['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tagName) ? 'label' : 'div';
    if (wrapper === 'div') {
      const input = control.querySelector('input:not([type="checkbox"])');
      if (input) input.setAttribute('aria-label', label);
    }
    return h(wrapper, { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  function renderOverlay() {
    const form = state.filterForm ? 'filter' : state.runForm ? 'run' : null;
    if (form !== openForm) {
      if (!openForm && form) returnFocus = document.activeElement;
      openForm = form;
      overlay.replaceChildren();
      branchVersion = -1;
      if (form === 'filter') buildFilterForm(state.filterForm.fields);
      if (form === 'run') buildRunForm();
      overlay.classList.toggle('hidden', !form);
      app.inert = Boolean(form);
      overlay.querySelector('input, select')?.focus();
      if (!form) { returnFocus?.focus(); returnFocus = null; }
    }
    if (form === 'filter') overlay.querySelector('.form-error').textContent = state.filterForm.error || '';
    if (form === 'run') updateRunForm();
  }

  function dialog(title, body, buttons) {
    const box = h('form', { class: 'dialog', tabindex: '-1', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title', onsubmit: event => event.preventDefault(), onkeydown: event => {
      if (event.key === 'Escape') { event.preventDefault(); post('closeForm'); }
      if (event.key !== 'Tab') return;
      const controls = [...box.querySelectorAll('input, select, textarea, button')].filter(control => !control.disabled);
      const first = controls[0], last = controls[controls.length - 1];
      if (!controls.length) { event.preventDefault(); box.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    } }, h('h2', { id: 'dialog-title' }, title), body, h('div', { class: 'form-error', role: 'alert' }), h('div', { class: 'buttons' }, buttons));
    overlay.append(box);
    return box;
  }

  function buildFilterForm(fields) {
    const input = (name, value) => h('input', { type: 'text', name, value: value ?? '', spellcheck: false });
    const projects = input('projects', fields.projects.join(','));
    const picker = h('select', { multiple: true, size: 4, onchange: () => { projects.value = [...picker.selectedOptions].map(option => option.value).join(','); } },
      state.completion.projects.map(path => h('option', { value: path, selected: fields.projects.includes(path) }, path)));
    const statuses = h('div', { class: 'checks' }, state.completion.statuses.map(value => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'status', value, checked: fields.statuses.includes(value) }), value)));
    const latest = h('input', { type: 'checkbox', name: 'latest', checked: fields.latest });
    const values = {
      branches: input('branches', fields.branches.join(',')), user: input('user', fields.user), sha: input('sha', fields.sha), id: input('id', fields.id),
      name: input('name', fields.name), source: input('source', fields.source), after: input('after', fields.after), before: input('before', fields.before), text: input('text', fields.text)
    };
    const apply = () => post('applyFilter', { fields: {
      projects: projects.value, statuses: [...statuses.querySelectorAll('input:checked')].map(box => box.value), latest: latest.checked,
      ...Object.fromEntries(Object.entries(values).map(([key, element]) => [key, element.value]))
    } });
    dialog('Фильтры pipeline', h('div', { class: 'grid' },
      field('Проекты (через запятую, * и ?)', projects), field('Выбрать проекты', picker, 'Ctrl/Cmd — несколько'),
      field('Ветки / маски / @current', values.branches), field('Статусы', statuses),
      field('Инициатор (username или me)', values.user), field('SHA (можно префикс)', values.sha),
      field('ID pipeline', values.id), field('Название / маска', values.name),
      field('Источник (api, push, web, schedule…)', values.source), field('Создан после (24h, 7d, YYYY-MM-DD)', values.after),
      field('Создан до (YYYY-MM-DD / ISO 8601)', values.before), field('Текстовый поиск', values.text),
      h('label', { class: 'check wide' }, latest, 'Последний подходящий pipeline каждой ветки')),
    [button('Применить', apply, { class: 'primary', type: 'submit' }), button('Отмена', () => post('closeForm'))]);
  }

  let run = null;
  function buildRunForm() {
    const project = h('select', { name: 'project', onchange: () => post('runProject', { projectId: Number(project.value) }) });
    const branch = h('input', { type: 'text', name: 'branch', spellcheck: false, onkeydown: event => {
      if (event.key === 'Enter') { event.preventDefault(); post('forecast', { projectId: Number(project.value), branch: branch.value }); }
    } });
    const branches = h('div', { class: 'branches' });
    const forecast = h('div', { class: 'forecast' });
    const variables = h('div', { class: 'variables' });
    const addVariable = () => {
      const row = h('div', { class: 'variable' },
        h('input', { type: 'text', class: 'key', placeholder: 'KEY', 'aria-label': 'Имя CI/CD variable', spellcheck: false, autocomplete: 'off' }),
        h('textarea', { class: 'value', rows: 1, placeholder: 'значение', 'aria-label': 'Значение CI/CD variable', spellcheck: false, autocomplete: 'off' }),
        button('×', () => { row.remove(); addVariableButton.focus(); }, { 'aria-label': 'Удалить variable' }));
      variables.append(row);
      row.querySelector('input').focus();
    };
    const submit = button('Запустить', () => post('submitRun', { projectId: Number(project.value), branch: branch.value,
      variables: [...variables.children].map(row => ({ key: row.querySelector('.key').value, value: row.querySelector('.value').value })) }), { class: 'primary', type: 'submit' });
    const cancel = button('Отмена', () => post('closeForm'));
    const addVariableButton = button('Добавить variable', addVariable);
    dialog('Запустить GitLab pipeline', h('div', { class: 'stack' },
      field('Проект', project),
      field('Серверная ветка (запускается её текущий commit в GitLab)', h('div', { class: 'row' }, branch,
        button('Найти ветки', () => post('findBranches', { projectId: Number(project.value), search: branch.value })),
        button('Обновить прогноз', () => post('forecast', { projectId: Number(project.value), branch: branch.value })))),
      branches, forecast,
      h('div', { class: 'label' }, 'CI/CD variables'), variables,
      h('div', { class: 'row' }, addVariableButton, h('span', { class: 'hint' }, 'Значения variables не сохраняются в настройках.'))),
    [submit, cancel]);
    run = { project, branch, branches, forecast, submit, cancel };
  }

  function updateRunForm() {
    const form = state.runForm;
    const selected = String(form.projectId);
    if (run.project.options.length !== form.projects.length) run.project.replaceChildren(...form.projects.map(p => h('option', { value: String(p.id) }, p.path)));
    run.project.value = selected;
    if (form.branchVersion !== branchVersion) { branchVersion = form.branchVersion; run.branch.value = form.branch; }
    run.branches.replaceChildren(...form.branches.map(name => button(name, () => {
      run.branch.value = name;
      post('forecast', { projectId: Number(run.project.value), branch: name });
    }, { class: 'chip' })), form.branchesMore ? h('span', { class: 'hint' }, 'Показаны первые 100: уточните поиск') : '');
    run.forecast.textContent = form.forecast;
    run.forecast.title = form.forecastTitle || '';
    const feedback = overlay.querySelector('.form-error');
    feedback.textContent = form.submitting ? 'Запускаю…' : form.error || '';
    feedback.classList.toggle('pending', form.submitting);
    const box = overlay.querySelector('.dialog');
    box.setAttribute('aria-busy', String(form.submitting));
    for (const element of overlay.querySelectorAll('input, select, textarea, button')) element.disabled = form.submitting;
    if (form.submitting) box.focus();
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'state') {
      const previousKey = state?.selectedKey;
      state = message.state;
      if (state.selectedKey !== previousKey) detailVisible = Boolean(state.selectedKey);
      render();
      if (state.selectedKey && state.selectedKey !== previousKey && window.matchMedia('(max-width: 600px)').matches && !openForm) backButton.focus();
    }
    if (message?.type === 'log') renderLog(message.log);
  });
  renderLog(null);
  post('ready');
}());
