/* CEMS v9.4.4 Learning-first — goal-led navigation, accessible controls and evidence summaries */
(function () {
  'use strict';

  /* 9.5.1: 화면에 보이는 버전 문자열의 출처를 <html data-cems-version> 하나로 모았다.
     이 상수와 learning-ui.js 의 상수가 서로 다른 값을 같은 DOM 에 쓰고 있어서
     9.5.0 빌드가 사용자에게 "v9.4.4" 로 보였고, data-cems-version 이 두 값 사이를
     오갔다(learning-ui 의 관찰자가 되돌려 쓰는 구조). 릴리스 시 바꿀 곳도 줄어든다. */
  var VERSION = document.documentElement.dataset.cemsVersion || '9.5.1';
  var LANG = (window.CEMS_LANG === 'zh' || (window.CEMS9 && CEMS9.LANG === 'zh') || (typeof DB_NAME !== 'undefined' && /ChineseVocab/.test(String(DB_NAME)))) ? 'zh' : 'en';
  var PREFIX = 'cemsUx26:' + LANG + ':';
  var state = {
    leanTab: read('leanTab', 'today'),
    studioStep: read('studioStep', '1'),
    statsTab: read('statsTab', 'summary'),
    dataTab: read('dataTab', 'library'),
    homeToolsOpen: '0',
    polishing: false,
    timer: 0,
    /* v9.5: 설치 여부는 모듈 스코프에서만 관리한다. 함수 프로퍼티 플래그는
       다른 모듈이 같은 전역을 갈아끼우면 사라져서 계속 다시 감싸지게 만든다. */
    excelWrapped: false,
    pageHookInstalled: false
  };

  function qs(selector, root) { return (root || document).querySelector(selector); }
  function qsa(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function text(value) { return String(value == null ? '' : value); }
  function esc(value) { return text(value).replace(/[&<>"']/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]; }); }
  function read(key, fallback) { try { var value = localStorage.getItem(PREFIX + key); return value == null ? fallback : value; } catch (_) { return fallback; } }
  function write(key, value) { try { localStorage.setItem(PREFIX + key, String(value)); } catch (_) {} }
  function visible(element) { if (!element) return false; var style = getComputedStyle(element), box = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0; }
  function make(tag, className, html) { var node = document.createElement(tag); if (className) node.className = className; if (html != null) node.innerHTML = html; return node; }
  function setHidden(node, hidden) { if (!node) return; node.hidden = !!hidden; node.setAttribute('aria-hidden', hidden ? 'true' : 'false'); }
  function announce(message) {
    var live = qs('#cems-ux25-live');
    if (!live) { live = make('div', 'cems-ux25-sr-only'); live.id = 'cems-ux25-live'; live.setAttribute('aria-live', 'polite'); document.body.appendChild(live); }
    live.textContent = ''; setTimeout(function () { live.textContent = message; }, 20);
  }

  function syncThemeMarker() {
    var theme = readLegacyTheme();
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.cemsAccent = readAccent();
    if (document.body) document.body.classList.toggle('light-theme', theme === 'light');
  }
  function readLegacyTheme() {
    try { return localStorage.getItem('theme') === 'light' ? 'light' : 'dark'; } catch (_) { return 'dark'; }
  }

  function readAccent() {
    var allowed = ['graphite','blue','brown','olive'];
    try { var value = localStorage.getItem('cemsAccent') || 'graphite'; return allowed.indexOf(value) >= 0 ? value : 'graphite'; } catch (_) { return 'graphite'; }
  }
  function renderAccentButtons() {
    var selected = readAccent();
    qsa('[data-ux25-action="accent"]').forEach(function (button) {
      var active = button.dataset.value === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  function applyAccentChoice(value, persist) {
    var allowed = ['graphite','blue','brown','olive'];
    if (allowed.indexOf(value) < 0) value = 'graphite';
    if (persist) { try { localStorage.setItem('cemsAccent', value); } catch (_) {} }
    document.documentElement.dataset.cemsAccent = value;
    if (typeof window.setCemsAccent === 'function') window.setCemsAccent(value);
    else if (typeof window.applyThemePalette === 'function') window.applyThemePalette(readLegacyTheme() !== 'light');
    renderAccentButtons();
    if (persist) announce('강조색을 변경했습니다.');
  }
  function ensureAccentControl(page) {
    if (!page || qs('#cems-theme-accent-setting', page)) { renderAccentButtons(); return; }
    var dark = qs('#setting-dark', page), row = dark && dark.closest('.toggle-row');
    if (!row) return;
    var box = make('section', 'cems-theme-accent-setting');
    box.id = 'cems-theme-accent-setting';
    box.innerHTML = '<div class="cems-theme-accent-head"><div><strong>강조색</strong><span>기본은 무채색입니다. 앱이 임의로 정하지 않으며 언제든 바꿀 수 있습니다.</span></div></div><div class="cems-theme-accent-options" role="group" aria-label="강조색 선택"><button type="button" class="cems-theme-accent-option" data-ux25-action="accent" data-value="graphite"><i aria-hidden="true"></i><span>무채색</span></button><button type="button" class="cems-theme-accent-option" data-ux25-action="accent" data-value="blue"><i aria-hidden="true"></i><span>파랑</span></button><button type="button" class="cems-theme-accent-option" data-ux25-action="accent" data-value="brown"><i aria-hidden="true"></i><span>브라운</span></button><button type="button" class="cems-theme-accent-option" data-ux25-action="accent" data-value="olive"><i aria-hidden="true"></i><span>올리브</span></button></div>';
    row.insertAdjacentElement('afterend', box);
    renderAccentButtons();
  }

  function syncVersion() {
    if (document.documentElement.dataset.cemsVersion !== VERSION) document.documentElement.dataset.cemsVersion = VERSION;
    var title = (LANG === 'zh' ? '中文學習' : 'CEMS English') + ' v' + VERSION;
    document.title = title;
    var meta = qs('meta[name="app-version"]'); if (meta) meta.content = VERSION;
    qsa('.splash-sub').forEach(function (node) { node.textContent = 'v' + VERSION + ' · 통합 학습 허브'; });
    qsa('.cems82-brand-sub').forEach(function (node) { node.textContent = '학습 분석 · FSRS-6 · v' + VERSION; });
    var versionCard = qsa('#page-settings .card').find(function (card) { var heading = qs('.card-title', card); return heading && heading.textContent.indexOf('버전 정보') >= 0; });
    var strong = versionCard && qs('strong', versionCard); if (strong) strong.textContent = (LANG === 'zh' ? '중국어 학습' : 'CEMS English') + ' v' + VERSION + ' · 통합 학습 허브';
    var build = qs('#phase8-build-status'); if (build) build.textContent = 'v' + VERSION;
  }

  function ensureAppbar() {
    var home = qs('#page-home');
    if (!home) return;
    var existing = qs('#cems82-appbar', home);
    if (!existing) {
      existing = make('header', 'cems82-appbar');
      existing.id = 'cems82-appbar';
      existing.innerHTML = '<div class="cems82-brand"><div class="cems82-logo' + (LANG === 'zh' ? ' chinese' : '') + '"></div><div class="cems82-brand-copy"><div class="cems82-brand-title">' + (LANG === 'zh' ? '中文學習' : 'CEMS English') + '</div><div class="cems82-brand-sub">학습 분석 · FSRS-6 · v' + VERSION + '</div></div></div><button type="button" class="btn btn-secondary cems82-icon-btn" id="cems82-settings" aria-label="설정 열기"></button>';
      home.insertBefore(existing, home.firstElementChild);
    }
    var button = qs('#cems82-settings', existing);
    if (button && button.dataset.ux25Bound !== '1') {
      button.dataset.ux25Bound = '1';
      button.addEventListener('click', function () { if (typeof window.showPage === 'function') window.showPage('settings'); });
    }
  }

  var MODE_GLYPHS = {
    flashcard:'▣', quiz:'?', reverse:'⇄', typing:'A', cloze:'□', collocation:'∞', listening:'◉', dictation:'✎',
    'pv-flashcard':'▣', 'pv-particle':'＋', 'pv-meaning':'≡', 'pv-reverse':'⇄', 'pv-listening':'◉', 'pv-dictation':'✎',
    'expr-fc':'▣', 'expr-quiz':'?', 'expr-cloze':'□', 'expr-typing':'A', 'expr-listening':'◉', 'expr-dictation':'✎',
    'zh-tone':'ˇ', 'zh-pinyin':'P', 'zh-script':'字', 'zh-classifier':'量', 'zh-order':'序', 'zh-dictation':'✎'
  };
  function glyphFromLabel(label, onclick) {
    label = text(label).replace(/\d+$/,'').trim(); onclick = text(onclick);
    if (/오답/.test(label)) return '!';
    if (/산출|쓰기|타이핑|철자/.test(label)) return 'A';
    if (/Particle|파티클/.test(label)) return '＋';
    if (/받아쓰기/.test(label)) return '✎';
    if (/리스닝|듣기/.test(label)) return '◉';
    if (/역방향/.test(label)) return '⇄';
    if (/빈칸/.test(label)) return '□';
    if (/연어|Collocation/i.test(label)) return '∞';
    if (/성조/.test(label)) return 'ˇ';
    if (/병음/.test(label)) return 'P';
    if (/간번체|문자/.test(label)) return '字';
    if (/양사/.test(label)) return '量';
    if (/어순/.test(label)) return '序';
    if (/퀴즈|선다|맞추기/.test(label) || /quiz/.test(onclick)) return '?';
    return '▣';
  }
  function makeKeyboardButton(node, label) {
    if (!node || node.dataset.ux25Keyboard === '1') return;
    node.dataset.ux25Keyboard = '1';
    if (!node.hasAttribute('role')) node.setAttribute('role','button');
    if (!node.hasAttribute('tabindex')) node.tabIndex = 0;
    if (label && !node.hasAttribute('aria-label')) node.setAttribute('aria-label',label);
    node.addEventListener('keydown',function(event){
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); node.click(); }
    });
  }
  function polishIcons() {
    qsa('.cems82-logo').forEach(function (logo) {
      logo.textContent = LANG === 'zh' ? '中' : 'C';
      logo.classList.add('cems-ux25-brand-glyph');
      logo.setAttribute('aria-hidden','true');
    });
    var settingsButton = qs('#cems82-settings');
    if (settingsButton) {
      settingsButton.textContent = '⚙';
      settingsButton.classList.add('cems-ux25-header-glyph');
      settingsButton.setAttribute('aria-label','설정 열기');
      settingsButton.title = '설정';
    }
    qsa('.mode-card').forEach(function (card) {
      var icon = qs('.mode-card-icon',card), label = text(qs('.mode-card-title',card) && qs('.mode-card-title',card).textContent).trim();
      if (icon && !icon.dataset.cems941Icon) icon.textContent = MODE_GLYPHS[card.dataset.mode] || glyphFromLabel(label,card.getAttribute('onclick'));
      makeKeyboardButton(card,label + ' 학습');
    });
    qsa('.quick-action').forEach(function (card) {
      var icon = qs('.quick-action-icon',card), label = text(qs('.quick-action-label',card) && qs('.quick-action-label',card).textContent).trim();
      if (icon && !icon.dataset.c943Icon && !icon.dataset.cems941Icon) icon.textContent = glyphFromLabel(label,card.getAttribute('onclick'));
      makeKeyboardButton(card,label + ' 시작');
    });
  }

  var XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  var xlsxPromise = null;
  function ensureXLSX() {
    if (window.XLSX && window.XLSX.read) return Promise.resolve(true);
    if (typeof window.phase8EnsureXLSX === 'function') return Promise.resolve(window.phase8EnsureXLSX(false));
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise(function (resolve) {
      var script = document.createElement('script'), timer, settled = false;
      script.src = XLSX_URL; script.async = true; script.dataset.cemsUx25Optional = 'xlsx';
      function finish(ok) { if (settled) return; settled = true; clearTimeout(timer); script.onload = script.onerror = null; if (!ok) script.remove(); resolve(!!ok); }
      script.onload = function () { finish(!!(window.XLSX && window.XLSX.read)); };
      script.onerror = function () { finish(false); };
      timer = setTimeout(function () { finish(false); }, 10000);
      document.head.appendChild(script);
    }).finally(function () { xlsxPromise = null; });
    return xlsxPromise;
  }
  /* v9.5: 이 함수는 polishAll() 안에서 불리므로 페이지 전환마다 실행된다.
     예전에는 함수 프로퍼티 플래그(__cemsUx25LazyXlsx)로 가드했는데,
     cems-9.4.1-stable.js 가 같은 전역(processFile 등)을 갈아끼우면 플래그가 사라져
     그 다음 polishAll 에서 또 감싸졌다 — 페이지를 옮길 때마다 겹이 늘었다.
     → 모듈 스코프 플래그로 딱 1회만 설치한다. */
  function wrapExcelFunctions() {
    if (LANG !== 'en' || state.excelWrapped) return;
    state.excelWrapped = true;
    ['processFile','processModalExcel','exportWithStats'].forEach(function (name) {
      var base = window[name];
      if (typeof base !== 'function') return;
      window[name] = async function () {
        var ok = await ensureXLSX();
        if (!ok) {
          if (typeof window.showToast === 'function') window.showToast('엑셀 기능은 처음 사용할 때 네트워크가 필요합니다. JSON·백업 기능은 오프라인에서 계속 사용할 수 있습니다.');
          return null;
        }
        return base.apply(this, arguments);
      };
    });
  }


  function syncTheme() {
    var light = false;
    try { light = localStorage.getItem('theme') === 'light'; } catch (_) {}
    document.body.classList.toggle('cems-ux25-light', light);
    document.documentElement.dataset.cemsAccent = readAccent();
    if (typeof window.applyThemePalette === 'function') window.applyThemePalette(!light);
    renderAccentButtons();
  }

  function tabBar(items, active, action, label) {
    return '<div class="cems-ux25-tabs" role="tablist" aria-label="' + esc(label || '보기 선택') + '">' + items.map(function (item) {
      return '<button type="button" role="tab" data-ux25-action="' + esc(action) + '" data-value="' + esc(item.value) + '" aria-selected="' + (item.value === active ? 'true' : 'false') + '" class="' + (item.value === active ? 'active' : '') + '"><span>' + esc(item.label) + '</span>' + (item.badge != null ? '<b>' + esc(item.badge) + '</b>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function activateLeanTab(value, silent) {
    var host = qs('#cems-lean-dashboard');
    if (!host) return;
    if (!['today', 'course', 'evidence'].includes(value)) value = 'today';
    state.leanTab = value; write('leanTab', value);
    if (value === 'evidence') {
      var details = qs('.cems-lean-stats-details', host);
      if (details) { addMetricBars(details); compactLeanStats(details); }
    }
    qsa('[data-ux25-lean-pane]', host).forEach(function (pane) { setHidden(pane, pane.dataset.ux25LeanPane !== value); });
    qsa('[data-ux25-action="lean-tab"]', host).forEach(function (button) { var active = button.dataset.value === value; button.classList.toggle('active', active); button.setAttribute('aria-selected', active ? 'true' : 'false'); });
    if (!silent) { window.scrollTo({ top: 0, behavior: 'smooth' }); announce(buttonLabel(value) + ' 보기'); }
  }
  function buttonLabel(value) { return value === 'course' ? '코스' : value === 'evidence' ? '학습 근거' : '오늘'; }

  function cloneActionableUnit(section) {
    var cards = qsa('.cems-lean-unit', section || document);
    var source = cards.find(function (card) { var button = qs('button[data-lean-action="start-unit"]', card); return button && !button.disabled; }) || cards[0];
    if (!source) return null;
    var clone = source.cloneNode(true);
    if (clone.id) clone.removeAttribute('id');
    qsa('[id]', clone).forEach(function (node) { node.removeAttribute('id'); });
    clone.classList.add('cems-ux25-current-unit');
    return clone;
  }

  function compactUnitSection(section) {
    if (!section || section.dataset.ux25Compact === '1') return;
    var list = qs('.cems-lean-units', section);
    if (!list) return;
    var cards = qsa('.cems-lean-unit', list);
    if (!cards.length) return;
    var current = cloneActionableUnit(section);
    var details = make('details', 'cems-ux25-unit-details');
    var summary = make('summary', '', '<span>전체 단원 보기</span><b>' + cards.length + '개</b>');
    details.appendChild(summary);
    list.parentNode.insertBefore(current, list);
    details.appendChild(list);
    current.parentNode.insertBefore(details, current.nextSibling);
    section.dataset.ux25Compact = '1';
  }

  function addMetricBars(root) {
    qsa('.cems-lean-stat', root).forEach(function (card) {
      var value = text(card.textContent).trim();
      var match = value.match(/([+-]?\d+(?:\.\d+)?)%/);
      var bar = qs(':scope > .cems-ux25-metric-track', card);
      if (!match) { if (bar) bar.remove(); card.dataset.ux25Bar = '0'; return; }
      var amount = Math.max(0, Math.min(100, Math.abs(Number(match[1]))));
      if (!bar) { bar = make('div', 'cems-ux25-metric-track', '<i></i>'); card.appendChild(bar); }
      var fill = qs('i', bar); if (fill) fill.style.width = amount + '%';
      bar.classList.toggle('negative', Number(match[1]) < 0);
      card.dataset.ux25Bar = '1';
    });
  }

  function compactLeanStats(root) {
    if (!root || qs('.cems-lf-evidence-intro', root)) return;
    var grid = qs(':scope > .cems-lean-stat-grid', root);
    if (!grid) return;
    var existing = qs(':scope > .cems-ux25-pending-metrics', root);
    if (existing) {
      qsa('.cems-lean-stat', existing).forEach(function (card) { grid.appendChild(card); });
      existing.remove();
      grid.hidden = false;
    }
    var cards = qsa(':scope > .cems-lean-stat', grid);
    var pending = cards.filter(function (card) {
      var value = text(card.textContent).replace(/\s+/g, ' ').trim();
      if (/미측정|자료 부족|비교 전/.test(value)) return true;
      if (/미해결 보충|놓친 3일 전이/.test(value)) {
        var strong = qs('b', card); return strong && Number(text(strong.textContent).trim()) === 0;
      }
      return false;
    });
    if (!pending.length) return;
    var details = make('details', 'cems-ux25-pending-metrics');
    details.innerHTML = '<summary><div><strong>아직 측정 전인 지표</strong><span>학습 기록이 생기면 자동으로 본문에 표시됩니다.</span></div><b>' + pending.length + '개</b></summary><div class="cems-lean-stat-grid"></div>';
    var pendingGrid = qs('.cems-lean-stat-grid', details);
    pending.forEach(function (card) { pendingGrid.appendChild(card); });
    grid.insertAdjacentElement('afterend', details);
    if (!qs(':scope > .cems-lean-stat', grid)) grid.hidden = true;
    var errors = qs(':scope > .cems-lean-errors', root);
    if (errors && /반복 오류 없음/.test(text(errors.textContent))) errors.classList.add('empty');
  }

  function polishLeanDashboard() {
    var host = qs('#cems-lean-dashboard');
    if (!host) return;
    if (qs(':scope > .cems-ux25-lean-nav', host)) {
      activateLeanTab(state.leanTab, true);
      return;
    }
    var children = qsa(':scope > *', host);
    var hero = children.find(function (node) { return node.matches('.cems-lean-hero'); });
    var courseSection = children.find(function (node) { return node.matches('.cems-lf-course-section'); });
    var units = children.find(function (node) { return node.matches('.cems-lf-units-section'); });
    var stats = children.find(function (node) { return node.matches('.cems-lean-stats-details'); });
    var note = children.find(function (node) { return node.matches('.cems-lean-note'); });
    if (!hero || !courseSection || !units || !stats) return;
    var nav = make('div', 'cems-ux25-lean-nav', tabBar([
      { value: 'today', label: '오늘' }, { value: 'course', label: '코스' }, { value: 'evidence', label: '학습 근거' }
    ], state.leanTab, 'lean-tab', '문맥 학습 코스 보기'));
    var today = make('section', 'cems-ux25-lean-pane'); today.dataset.ux25LeanPane = 'today';
    var course = make('section', 'cems-ux25-lean-pane'); course.dataset.ux25LeanPane = 'course';
    var evidence = make('section', 'cems-ux25-lean-pane'); evidence.dataset.ux25LeanPane = 'evidence';
    today.appendChild(hero);
    compactUnitSection(units);
    course.appendChild(courseSection);
    course.appendChild(units);
    stats.open = true; stats.classList.add('cems-ux25-evidence-open');
    evidence.appendChild(stats);
    if (note) {
      var interpretation = make('details', 'cems-ux25-interpretation');
      interpretation.innerHTML = '<summary>수치 해석 범위</summary>';
      interpretation.appendChild(note);
      evidence.appendChild(interpretation);
    }
    host.innerHTML = '';
    host.appendChild(nav); host.appendChild(today); host.appendChild(course); host.appendChild(evidence);
    activateLeanTab(state.leanTab, true);
  }

  function activateStudioStep(value, silent) {
    var page = qs('#page-lean-studio'); if (!page) return;
    if (!['1', '2', '3'].includes(String(value))) value = '1';
    state.studioStep = String(value); write('studioStep', state.studioStep);
    qsa('[data-ux25-studio-step]', page).forEach(function (node) { setHidden(node, node.dataset.ux25StudioStep !== state.studioStep); });
    qsa('[data-ux25-action="studio-step"]', page).forEach(function (button) { var active = button.dataset.value === state.studioStep; button.classList.toggle('active', active); button.setAttribute('aria-selected', active ? 'true' : 'false'); });
    if (!silent) { window.scrollTo({ top: 0, behavior: 'smooth' }); announce('콘텐츠 추가 ' + state.studioStep + '단계'); }
  }

  function polishStudio() {
    var page = qs('#page-lean-studio'), shell = qs('.cems-lean-studio-shell', page);
    if (!page || !shell) return;
    var header = qs(':scope > .cems-lean-header', shell);
    var intro = qs(':scope > .cems-lean-studio-intro', shell);
    var cards = qsa(':scope > .cems-lean-studio-card', shell);
    if (!header || !intro || cards.length < 3) return;
    if (!qs(':scope > .cems-ux25-studio-nav', shell)) {
      var nav = make('div', 'cems-ux25-studio-nav', tabBar([
        { value: '1', label: '설계' }, { value: '2', label: '검사·추가' }, { value: '3', label: '수정' }
      ], state.studioStep, 'studio-step', '콘텐츠 추가 단계'));
      header.insertAdjacentElement('afterend', nav);
    }
    intro.dataset.ux25StudioStep = '1'; cards[0].dataset.ux25StudioStep = '1'; cards[1].dataset.ux25StudioStep = '2'; cards[2].dataset.ux25StudioStep = '3';
    if (!qs('.cems-ux25-prompt-preview', cards[0])) {
      var prompt = qs('#cems-lean-studio-prompt', cards[0]);
      if (prompt) {
        var preview = make('details', 'cems-ux25-prompt-preview');
        preview.innerHTML = '<summary>생성 프롬프트 미리보기</summary>';
        prompt.parentNode.insertBefore(preview, prompt); preview.appendChild(prompt);
      }
    }
    if (!qs('.cems-ux25-step-next', cards[0])) {
      var nextTwo = make('button', 'btn btn-primary cems-ux25-step-next', '다음: JSON 검사');
      nextTwo.type = 'button'; nextTwo.dataset.ux25Action = 'studio-step'; nextTwo.dataset.value = '2'; cards[0].appendChild(nextTwo);
      var nextThree = make('button', 'btn btn-secondary cems-ux25-step-next', '문제 신고·수정 보기');
      nextThree.type = 'button'; nextThree.dataset.ux25Action = 'studio-step'; nextThree.dataset.value = '3'; cards[1].appendChild(nextThree);
      var backTwo = make('button', 'btn btn-secondary cems-ux25-step-next', 'JSON 검사로 돌아가기');
      backTwo.type = 'button'; backTwo.dataset.ux25Action = 'studio-step'; backTwo.dataset.value = '2'; cards[2].appendChild(backTwo);
    }
    activateStudioStep(state.studioStep, true);
  }

  function countCardData() {
    var jobs = [];
    try { if (typeof getAllWords === 'function') jobs.push(Promise.resolve(getAllWords())); } catch (_) {}
    try { if (typeof getAllPV === 'function') jobs.push(Promise.resolve(getAllPV())); } catch (_) {}
    try { if (typeof getAllExpr === 'function') jobs.push(Promise.resolve(getAllExpr())); } catch (_) {}
    if (!jobs.length) return Promise.resolve(0);
    return Promise.allSettled(jobs).then(function (rows) { return rows.reduce(function (sum, row) { return sum + (row.status === 'fulfilled' && Array.isArray(row.value) ? row.value.length : 0); }, 0); });
  }

  function polishHome() {
    var page = qs('#page-home'), lean = qs('#cems-lean-home-card', page);
    if (!page || !lean) return;
    qsa('[data-ux25-action="open-card-tools"]', lean).forEach(function (button) { button.remove(); });
    var start = qs('#daily-goal-card', page);
    if (start) {
      var title = qs('.card-title', start); if (title) title.innerHTML = '<span>오늘 활동량</span>';
    }
    var details = qs('#cems-ux25-home-tools', page);
    if (!details && start) {
      details = make('details', 'cems-ux25-home-tools'); details.id = 'cems-ux25-home-tools';
      details.appendChild(make('summary', '', '<div><strong>추가 학습·카드 관리</strong><span>개별 어휘·표현의 장기 기억을 보조하는 선택 기능</span></div><b>열기</b>'));
      start.parentNode.insertBefore(details, start);
      var move = [], node = start;
      while (node) { var next = node.nextSibling; if (node.nodeType === 1) move.push(node); node = next; }
      move.forEach(function (item) { details.appendChild(item); });
      details.addEventListener('toggle', function () { state.homeToolsOpen = details.open ? '1' : '0'; if (details.open) details.dataset.cems931UserOpened = '1'; var b = qs(':scope > summary > b', details); if (b) b.textContent = details.open ? '접기' : '열기'; });
    }
    if (!details) return;
    countCardData().then(function (count) {
      if (!details.dataset.cems931Initialized) { details.open = false; details.dataset.cems931Initialized = '1'; } else { details.open = state.homeToolsOpen === '1'; }
      var label = qs(':scope > summary span', details); if (label) label.textContent = count ? '카드 ' + count + '개 · 예정 복습과 개별 모드' : '카드 데이터 없음 · 필요할 때만 추가';
      var b = qs(':scope > summary > b', details); if (b) b.textContent = details.open ? '접기' : '열기';
      var smart = qs('#cems-ux-smart', details) || qs('#cems-ux-smart', page);
      if (smart) {
        smart.hidden = !count;
        var smartTitle = qs('.cems-ux-smart-title', smart); if (smartTitle) smartTitle.textContent = '카드 복습 추천';
        var online = qs('#cems-ux-online', smart); if (online) online.hidden = true;
      }
    });
  }

  function openCardTools() {
    var details = qs('#cems-ux25-home-tools');
    if (!details) return;
    details.open = true; state.homeToolsOpen = '1'; details.dataset.cems931UserOpened = '1';
    details.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function polishStudyContainer(container) {
    if (!container || container.dataset.ux25Polished === '1') return;
    var cards = qsa(':scope > .card', container);
    if (!cards.length) return;
    cards[0].classList.add('cems-ux25-mode-card');
    var countCard = cards.find(function (card) { var title = qs('.card-title', card); return title && title.textContent.indexOf('학습 분량') >= 0; });
    if (countCard) { countCard.classList.add('cems-ux25-count-source'); countCard.setAttribute('aria-hidden', 'true'); }
    var filterCard = cards.find(function (card) { var title = qs('.card-title', card); return title && title.textContent.indexOf('필터') >= 0; });
    if (filterCard && !qs('.cems-ux25-filter-details', filterCard)) {
      var quick = qs('.c86-quick-filters', filterCard);
      var detail = make('details', 'cems-ux25-filter-details');
      detail.innerHTML = '<summary><span>세부 조건</span><b>필요할 때 펼치기</b></summary>';
      var cursor = quick ? quick.nextSibling : qs('.card-title', filterCard).nextSibling;
      var moving = [];
      while (cursor) { var next = cursor.nextSibling; moving.push(cursor); cursor = next; }
      moving.forEach(function (node) { detail.appendChild(node); });
      filterCard.appendChild(detail);
    }
    container.dataset.ux25Polished = '1';
  }

  function polishStudy() {
    var page = qs('#page-study'); if (!page) return;
    page.classList.add('cems-ux25-study');
    ['study-vocab', 'study-phrasal', 'study-expr'].forEach(function (id) { polishStudyContainer(qs('#' + id)); });
    var orderCard = qsa(':scope > .card', page).find(function (card) { var title = qs('.card-title', card); return title && title.textContent.indexOf('순서') >= 0; });
    if (orderCard) orderCard.classList.add('cems-ux25-order-card');
    var dock = qs('#c86-study-dock');
    if (dock) dock.classList.add('cems-ux25-study-dock');
  }

  function settingsKey(card, index) {
    var title = text(qs('.card-title', card) && qs('.card-title', card).textContent).replace(/\s+/g, ' ').trim();
    return (card.id || title || 'card-' + index).slice(0, 80);
  }
  function setSettingsCard(card, open) {
    var body = qs(':scope > .cems-ux25-settings-body', card), button = qs(':scope > .card-title .cems-ux25-settings-toggle', card);
    card.classList.toggle('open', !!open); if (body) body.hidden = !open;
    if (button) { button.setAttribute('aria-expanded', open ? 'true' : 'false'); button.textContent = open ? '접기' : '펼치기'; }
    write('settings:' + card.dataset.ux25Key, open ? '1' : '0');
  }
  function polishSettings() {
    var page = qs('#page-settings'); if (!page) return;
    ensureAccentControl(page);
    var cards = qsa(':scope > .card', page);
    if (!cards.length) return;
    if (!qs(':scope > .cems-ux25-settings-toolbar', page)) {
      var bar = make('div', 'cems-ux25-settings-toolbar', '<div><strong>설정</strong><span>필요한 항목만 펼쳐 조정합니다.</span></div><div><button type="button" data-ux25-action="settings-basic">기본만</button><button type="button" data-ux25-action="settings-all">모두</button></div>');
      page.insertBefore(bar, cards[0]);
    }
    cards.forEach(function (card, index) {
      if (card.dataset.ux25Accordion === '1') return;
      var title = qs(':scope > .card-title', card); if (!title) return;
      var body = make('div', 'cems-ux25-settings-body');
      var cursor = title.nextSibling, moving = [];
      while (cursor) { var next = cursor.nextSibling; moving.push(cursor); cursor = next; }
      moving.forEach(function (node) { body.appendChild(node); }); card.appendChild(body);
      title.classList.add('cems-ux25-settings-title');
      var toggle = make('button', 'cems-ux25-settings-toggle', '펼치기'); toggle.type = 'button'; toggle.dataset.ux25Action = 'settings-card';
      title.appendChild(toggle);
      card.dataset.ux25Accordion = '1'; card.dataset.ux25Key = settingsKey(card, index);
      var saved = read('settings:' + card.dataset.ux25Key, '');
      setSettingsCard(card, saved === '1' || (saved === '' && index === 0));
    });
  }
  function settingsBasic() { qsa('#page-settings > .card[data-ux25-accordion="1"]').forEach(function (card, index) { setSettingsCard(card, index === 0); }); }
  function settingsAll() {
    var cards = qsa('#page-settings > .card[data-ux25-accordion="1"]');
    var shouldOpen = cards.some(function (card) { return !card.classList.contains('open'); });
    cards.forEach(function (card) { setSettingsCard(card, shouldOpen); });
  }

  function activateDataTab(value, silent) {
    var page = qs('#page-data'); if (!page) return;
    if (!['library', 'add', 'safety'].includes(value)) value = 'library';
    state.dataTab = value; write('dataTab', value);
    qsa('[data-ux25-data-pane]', page).forEach(function (pane) { setHidden(pane, pane.dataset.ux25DataPane !== value); });
    qsa('[data-ux25-action="data-tab"]', page).forEach(function (button) { var active = button.dataset.value === value; button.classList.toggle('active', active); button.setAttribute('aria-selected', active ? 'true' : 'false'); });
    if (!silent) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function polishData() {
    var page = qs('#page-data'); if (!page || qs(':scope > .cems-ux25-data-nav', page)) return;
    var typeTabs = qs(':scope > .type-tabs', page), cards = qsa(':scope > .card', page);
    if (!typeTabs || cards.length < 4) return;
    var nav = make('div', 'cems-ux25-data-nav', tabBar([
      { value: 'library', label: '목록' }, { value: 'add', label: '추가' }, { value: 'safety', label: '백업' }
    ], state.dataTab, 'data-tab', '데이터 화면 보기'));
    typeTabs.insertAdjacentElement('afterend', nav);
    var panes = { library: make('section', 'cems-ux25-data-pane'), add: make('section', 'cems-ux25-data-pane'), safety: make('section', 'cems-ux25-data-pane') };
    Object.keys(panes).forEach(function (key) { panes[key].dataset.ux25DataPane = key; page.appendChild(panes[key]); });
    cards.forEach(function (card) {
      var title = text(qs('.card-title', card) && qs('.card-title', card).textContent);
      if (card.id === 'cems-ux-data' || title.indexOf('데이터 관리') >= 0) panes.safety.appendChild(card);
      else if (card.classList.contains('ai-card') || title.indexOf('엑셀 업로드') >= 0 || title.indexOf('Excel') >= 0) panes.add.appendChild(card);
      else panes.library.appendChild(card);
    });
    activateDataTab(state.dataTab, true);
  }

  function activateStatsTab(value, silent) {
    var dashboard = qs('#cems83-dashboard'); if (!dashboard) return;
    if (!['summary', 'modes', 'quality'].includes(value)) value = 'summary';
    state.statsTab = value; write('statsTab', value);
    qsa('[data-ux25-stats-pane]', dashboard).forEach(function (pane) { setHidden(pane, pane.dataset.ux25StatsPane !== value); });
    qsa('[data-ux25-action="stats-tab"]', dashboard).forEach(function (button) { var active = button.dataset.value === value; button.classList.toggle('active', active); button.setAttribute('aria-selected', active ? 'true' : 'false'); });
    if (!silent) window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function statsGroup(title) {
    if (/학습 모드별|예정 복습량/.test(title)) return 'modes';
    if (/FSRS 예측|반복 노출|최근 학습/.test(title)) return 'quality';
    return 'summary';
  }
  function decorateLegacyStatsMeters() {
    qsa('#cems83-dashboard .c83-kpi').forEach(function (card) {
      var strong = qs('strong', card);
      var raw = text(strong && strong.textContent).trim();
      var match = raw.match(/^([+-]?\d+(?:\.\d+)?)%$/);
      var meter = qs(':scope > .cems-ux25-kpi-meter', card);
      if (!match) { if (meter) meter.remove(); return; }
      var amount = Math.max(0, Math.min(100, Math.abs(Number(match[1]))));
      if (!meter) { meter = make('div', 'cems-ux25-kpi-meter', '<i></i>'); card.appendChild(meter); }
      var fill = qs('i', meter); if (fill) fill.style.width = amount + '%';
      meter.classList.toggle('negative', Number(match[1]) < 0);
    });
  }

  function polishStats() {
    var dashboard = qs('#cems83-dashboard'); if (!dashboard || qs(':scope > .cems-ux25-stats-nav', dashboard)) return;
    var cards = qsa(':scope > .c83-card', dashboard); if (cards.length < 3) return;
    var nav = make('div', 'cems-ux25-stats-nav', tabBar([
      { value: 'summary', label: '카드 기억' }, { value: 'modes', label: '학습 방식' }, { value: 'quality', label: '예측 품질' }
    ], state.statsTab, 'stats-tab', '카드 기억 통계 보기'));
    /* v9.4.4: '카드 기억 보조 통계' 설명 배너 제거 (사용자 요청) */
    var panes = { summary: make('section', 'cems-ux25-stats-pane'), modes: make('section', 'cems-ux25-stats-pane'), quality: make('section', 'cems-ux25-stats-pane') };
    Object.keys(panes).forEach(function (key) { panes[key].dataset.ux25StatsPane = key; });
    dashboard.innerHTML = ''; dashboard.appendChild(nav); Object.keys(panes).forEach(function (key) { dashboard.appendChild(panes[key]); });
    cards.forEach(function (card) { var title = text(qs('.c83-card-title', card) && qs('.c83-card-title', card).textContent); panes[statsGroup(title)].appendChild(card); });
    var quality = qs('#c86-stats-quality'); if (quality) panes.quality.appendChild(quality);
    activateStatsTab(state.statsTab, true);
  }

  function updateStudioStatus() {
    var page = qs('#page-lean-studio'); if (!page) return;
    var prompt = qs('#cems-lean-studio-prompt', page);
    var jsonArea = qs('#cems-lean-studio-json', page);
    var importButton = qs('[data-lean-action="studio-import"]', page);
    var resultBox = qs('.cems-lean-studio-result', page);
    var validated = !!(jsonArea && jsonArea.value.trim() && importButton && !importButton.disabled);
    var hasRepair = !!text(qs('#cems-lean-studio-issues', page) && qs('#cems-lean-studio-issues', page).textContent).trim();
    qsa('[data-ux25-action="studio-step"]', page).forEach(function (button) {
      var value = button.dataset.value;
      var done = value === '1' ? !!(prompt && prompt.value.trim()) : value === '2' ? validated : hasRepair;
      button.classList.toggle('done', done);
    });
    if (resultBox) resultBox.setAttribute('aria-live', 'polite');
  }

  function polishAll() {
    if (state.polishing) return;
    state.polishing = true;
    try {
      syncThemeMarker(); ensureAppbar(); syncVersion(); syncTheme(); polishIcons(); wrapExcelFunctions(); polishHome(); polishStudy(); polishSettings(); polishData(); polishStats(); polishLeanDashboard(); polishStudio(); updateStudioStatus(); addMetricBars(qs('#cems-lean-dashboard') || document); compactLeanStats(qs('.cems-lean-stats-details')); decorateLegacyStatsMeters();
      document.body.classList.add('cems-ux25', 'cems-ux26', 'cems-ux27');
    } catch (error) { console.warn('[CEMS UX 9.3.2] polish', error); }
    finally { state.polishing = false; }
  }
  function schedule(delay) { clearTimeout(state.timer); state.timer = setTimeout(polishAll, delay == null ? 40 : delay); }

  function bind() {
    document.addEventListener('click', function (event) {
      var button = event.target && event.target.closest && event.target.closest('[data-ux25-action]'); if (!button) return;
      var action = button.dataset.ux25Action, value = button.dataset.value;
      if (action === 'accent') applyAccentChoice(value, true);
      else if (action === 'lean-tab') activateLeanTab(value);
      else if (action === 'studio-step') activateStudioStep(value);
      else if (action === 'open-card-tools') openCardTools();
      else if (action === 'settings-card') { var card = button.closest('.card'); if (card) setSettingsCard(card, !card.classList.contains('open')); }
      else if (action === 'settings-basic') settingsBasic();
      else if (action === 'settings-all') settingsAll();
      else if (action === 'data-tab') activateDataTab(value);
      else if (action === 'stats-tab') activateStatsTab(value);
    });
    document.addEventListener('input', function (event) { if (event.target && (event.target.id === 'cems-lean-studio-prompt' || event.target.id === 'cems-lean-studio-json' || event.target.matches('[data-studio-field]'))) schedule(20); });
    document.addEventListener('change', function (event) { if (event.target && event.target.id === 'setting-dark') setTimeout(function () { syncTheme(); }, 20); });
    window.addEventListener('hashchange', function () { schedule(60); });
    window.addEventListener('cems:lean-dashboard-rendered', function () {
      polishAll();
      setTimeout(polishAll, 120);
    });
    document.addEventListener('change', function (event) { if (event.target && event.target.id === 'setting-dark') setTimeout(function () { syncThemeMarker(); }, 20); });
    /* v9.5: showPage 전역 재정의 → afterPageShow 훅.
       이 모듈은 showPage 를 감싸던 5개 계층 중 하나였다. 각자 자기 함수 프로퍼티
       플래그만 확인해서 서로의 플래그를 지웠고, 결국 showPage 1회 호출에
       history.replaceState 가 5회 실행됐다. 훅은 'ux-polish' 키로 멱등 등록된다. */
    if (window.CEMSHooks && !state.pageHookInstalled) {
      state.pageHookInstalled = true;
      window.CEMSHooks.on('afterPageShow', 'ux-polish', function () {
        schedule(20);
        setTimeout(polishAll, 250);
      });
    }
    /* v9.4.4: document-wide DOM observation removed. Exact page events trigger polish explicitly. */
  }

  function init() {
    bind(); polishAll(); setTimeout(polishAll, 450);
  }

  window.CEMS_UX27 = {
    VERSION: VERSION,
    polishAll: polishAll,
    activateLeanTab: activateLeanTab,
    activateStudioStep: activateStudioStep,
    activateStatsTab: activateStatsTab,
    activateDataTab: activateDataTab,
    ensureXLSX: ensureXLSX,
    polishIcons: polishIcons,
    applyAccentChoice: applyAccentChoice,
    readAccent: readAccent,
    state: state
  };
  window.CEMS_UX26 = window.CEMS_UX27; /* v9.2.6 compatibility alias */
  window.CEMS_UX25 = window.CEMS_UX27; /* v9.2.5 compatibility alias */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 80); });
  else setTimeout(init, 80);
})();
