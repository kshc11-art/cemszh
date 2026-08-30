/* CEMS 9.4.4-final2 — final event ownership and compact controls */
(function(){
  'use strict';
  var handledFiles = new WeakSet();
  /* 9.4.4(항목 23): 죽은 코드 ICONS(inline SVG 8개, 참조 0건)를 제거했다.
     실제 아이콘은 cems-v9.4.4-final.css 의 CSS mask(--cfinal-icon)로 그린다
     (앱의 HTML 안전 계층이 inline <svg> 를 지우기 때문). */
  var ACTIONS = {
    'fc-prev-btn':['prev','이전 카드'],'fc-next-btn':['next','다음 카드'],'fc-speak-btn':['speak','발음 듣기'],
    'fc-bookmark-btn':['bookmark','북마크'],'fc-edit-btn':['edit','카드 수정'],'fc-exit-btn':['close','학습 종료'],
    'expr-fc-prev-btn':['prev','이전 카드'],'expr-fc-next-btn':['next','다음 카드'],'expr-fc-speak-btn':['speak','발음 듣기'],
    'expr-fc-bookmark-btn':['bookmark','북마크'],'expr-fc-edit-btn':['edit','카드 수정'],'expr-fc-exit-btn':['close','학습 종료'],
    'qs-speak-btn':['speak','발음 듣기'],'quiz-bookmark-btn':['bookmark','북마크'],'quiz-production-btn':['write','쓰기 연습'],
    'quiz-tag-btn':['tag','태그'],
    'expr-qs-speak-btn':['speak','발음 듣기'],'expr-quiz-bookmark-btn':['bookmark','북마크'],'expr-quiz-production-btn':['write','쓰기 연습'],
    'expr-quiz-tag-btn':['tag','태그']
  };
  var DYNAMIC_ACTIONS = [
    ['button[onclick="speakQuizWord()"]','speak','발음 듣기'],
    ['button[onclick="openQuizEdit()"]','edit','카드 수정'],
    ['button[onclick="speakExprQuiz()"]','speak','발음 듣기'],
    ['button[onclick="openExprQuizEdit()"]','edit','카드 수정'],
    ['button[onclick="playCurrentListening()"]','speak','발음 듣기'],
    ['button[onclick="openListeningEdit()"]','edit','카드 수정'],
    ['button[onclick="speakExprCloze()"]','speak','발음 듣기'],
    ['button[onclick="openExprClozeEdit()"]','edit','카드 수정']
  ];

  /* ── 북마크 활성 상태 표시 복구 (항목 24) ─────────────────────────────
     앱은 북마크 on/off 를 버튼 글자(★/⭐ vs ☆)로만 알린다. 예전 applyAction 은
     button.textContent='' 로 그 신호를 지웠고, .active 클래스나 aria-pressed 를
     세우는 곳도 없어서 CSS 규칙
       button.c944-final-action[data-final-action="bookmark"].active svg{fill:…}
     이 죽은 규칙이 됐다(게다가 svg 자체가 없다). 그래서 북마크 on/off 가
     시각적으로 전혀 구분되지 않았다.

     이제
       1) 북마크 버튼은 글자를 지우지 않는다(CSS font-size:0 이라 어차피 안 보인다).
          그 글자가 앱의 유일한 상태 신호이기 때문이다.
       2) 상태를 읽어 .active / aria-pressed / data-final-icon 을 세운다.
       3) CSS 담당자가 규칙을 넣기 전에도 보이도록, 켜짐일 때 --cfinal-icon 을
          채워진 북마크 마스크로 인라인 대체한다.
          (CSS 에 data-final-icon="bookmark-on" 규칙이 들어오면 이 인라인 대체는
           지워도 된다 — 보고서 참조.)
     ------------------------------------------------------------------ */
  var BOOKMARK_ON_TEXT = /[★⭐🔖]/;
  var BOOKMARK_ON_ICON = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\'%3E%3Cpath fill=\'black\' d=\'M5 3h14v19l-7-4.5L5 22z\'/%3E%3C/svg%3E")';

  function syncBookmarkState(button){
    var raw = String(button.textContent || '').trim();
    var on;
    if(raw){
      on = BOOKMARK_ON_TEXT.test(raw);
    }else if(button.classList.contains('c943-icon-button')){
      /* 글자가 이미 아이콘으로 대체된 버튼. cems-v9.4.4.js 의
         enhanceStudyActionIcons 가 대체 직전에 상태를 읽어 .is-active 로 남기고
         (그 레이어가 이 레이어보다 먼저 돈다) 이후에도 그 값을 유지하므로 그것만
         믿는다. 기억해 둔 옛 글자를 함께 OR 하면 해제가 반영되지 않는다. */
      on = button.classList.contains('is-active');
    }else{
      on = BOOKMARK_ON_TEXT.test(button.dataset.finalText || '');
    }
    button.dataset.finalText = on ? '★' : '☆';   // 다음 패스를 위한 상태 기억
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
    button.dataset.finalIcon = on ? 'bookmark-on' : 'bookmark';
    if(on) button.style.setProperty('--cfinal-icon', BOOKMARK_ON_ICON);
    else button.style.removeProperty('--cfinal-icon');
  }

  /* 북마크 상태는 앱이 비동기 저장 후에 글자만 바꿔 알린다. 재작업 패스 타이밍에
     의존하지 않도록, 해당 버튼 하나만 보는 좁은 관찰자를 1회 설치한다.
     (문서 전체 관찰이 아니라 버튼 노드의 자식/문자 변경만 본다.
      syncBookmarkState 는 속성만 건드리므로 스스로를 다시 깨우지 않는다.) */
  var watchedBookmarks = new WeakSet();
  function watchBookmark(button){
    if(watchedBookmarks.has(button))return;
    watchedBookmarks.add(button);
    try{
      new MutationObserver(function(){syncBookmarkState(button);})
        .observe(button,{childList:true,characterData:true,subtree:true});
    }catch(_){}
  }

  function applyAction(button,icon,label){
    if(!button)return;
    button.classList.add('c944-final-action');button.dataset.finalAction=icon;
    button.setAttribute('aria-label',label);button.title=label;
    if(icon==='bookmark'){
      watchBookmark(button);
      syncBookmarkState(button);
    }else if(button.dataset.finalIcon!==icon){
      button.textContent='';button.dataset.finalIcon=icon;
    }
    var row=button.parentElement;
    if(row){row.classList.add('c944-final-action-row');var count=Array.from(row.children).filter(function(el){return el.tagName==='BUTTON';}).length;row.style.setProperty('--cfinal-actions',String(Math.max(1,count)));}
  }
  function iconize(){
    DYNAMIC_ACTIONS.forEach(function(def){document.querySelectorAll(def[0]).forEach(function(button){applyAction(button,def[1],def[2]);});});
    Object.keys(ACTIONS).forEach(function(id){
      var button=document.getElementById(id); if(!button)return;
      var def=ACTIONS[id]; applyAction(button,def[0],def[1]);
    });
    /* 앱이 카드 이동·토글 직후 글자만 바꿔도 상태가 따라오도록 한 번 더 훑는다. */
    document.querySelectorAll('button[data-final-action="bookmark"]').forEach(syncBookmarkState);
  }

  function finalMeaning(item){
    if(!item)return '';
    try{if(typeof getMKO==='function')return String(getMKO(item)||'').trim();}catch(_){}
    return String(item.Meaning_KO||item.Meaning1_KO||item.MeaningKO||item.meaning||item.definition||item.gloss||'').trim();
  }
  function finalItemKey(item,type){
    if(!item)return '';
    try{if(typeof getItemKey==='function')return String(getItemKey(item,type)||'').trim();}catch(_){}
    return String(type==='expr'?(item.Expression||item.Grammar_Point||item.front||item.id):(item.Traditional_CH||item.Simplified_CH||item.Word||item.word||item.front||item.id)||'').trim();
  }

  /* ── 모드별 필수 데이터 (감사 H6) ────────────────────────────────────
     보충 후보는 필터되지 않은 전체 데이터셋(all)에서 오기 때문에, 뜻만 보고
     채우면 모드 적합성 필터로 배제됐던 카드가 그대로 다시 들어온다.
     (실측: collocation 모드에서 출제 10개 전부가 연어 데이터 없는 카드)
       typing/dictation → Pinyin
       cloze            → Example_CHT
       collocation      → Collocation_CHT
       reverse/quiz     → Meaning_KO
     ------------------------------------------------------------------ */
  var MODE_FIELD={
    typing:'pinyin','expr-typing':'pinyin',dictation:'pinyin','expr-dictation':'pinyin',
    cloze:'example','expr-cloze':'example',
    collocation:'collocation',
    reverse:'meaning',quiz:'meaning','expr-quiz':'meaning'
  };
  function fieldText(item,field){
    if(!item)return '';
    if(field==='pinyin'){
      try{if(typeof getPinyin==='function')return String(getPinyin(item)||'').trim();}catch(_){}
      return String(item.Pinyin||item.pinyin||'').trim();
    }
    if(field==='example'){
      try{if(typeof getEx==='function')return String(getEx(item)||'').trim();}catch(_){}
      return String(item.Example_CHT||item.Example1||item.Example||'').trim();
    }
    if(field==='collocation'){
      try{if(typeof getCollocation==='function')return String(getCollocation(item)||'').trim();}catch(_){}
      return String(item.Collocation_CHT||item.Key_Collocation||'').trim();
    }
    if(field==='meaning')return finalMeaning(item);
    return '';
  }
  function modeFits(item,type,mode){
    try{
      if(window.CEMS85&&typeof window.CEMS85.modeEligible==='function')return !!window.CEMS85.modeEligible(item,type,mode);
    }catch(_){}
    var field=MODE_FIELD[mode];
    return field?!!fieldText(item,field):true;
  }

  /* 9.4.4(항목 21): window.startQuiz 재정의를 제거하고 CEMSHooks 로 등록한다.
     보충할 때도 모드별 필수 필드를 검사하고, 적합한 후보가 모자라면 억지로
     채우지 않고 부족한 채로 돌려준 뒤 사용자에게 알린다. */
  function repairQuizItems(items,all,mode,type){
    var kind=type||'vocab';
    var source=Array.isArray(items)?items:[];
    var pool=Array.isArray(all)?all:source;
    var quizMode=mode||'quiz';
    var valid=source.filter(function(item){return !!finalMeaning(item)&&modeFits(item,kind,quizMode);});
    var wanted=Math.max(5,source.length||5);
    if(valid.length<5){
      var seen=new Set(valid.map(function(item){return finalItemKey(item,kind);}));
      for(var i=0;i<pool.length&&valid.length<wanted;i++){
        var item=pool[i],key=finalItemKey(item,kind);
        if(!key||seen.has(key))continue;
        if(!finalMeaning(item))continue;
        if(!modeFits(item,kind,quizMode))continue;   // ★ 모드 적합성까지 검사
        seen.add(key);valid.push(item);
      }
    }
    if(valid.length<5){
      /* 부족한 채로 돌려준다. 호출부(index.html startQuiz)가 5개 미만이면
         "뜻이 있는 단어가 부족합니다" 토스트를 띄우고 중단한다. */
      try{if(typeof showToast==='function')showToast('⚠️ 현재 모드에 필요한 데이터를 갖춘 카드가 부족합니다');}catch(_){}
    }
    return valid;
  }
  function installQuizRepair(){
    if(!window.CEMSHooks)return;
    window.CEMSHooks.on('quizItems','final-quiz-repair',function(items,all,mode,type){
      try{return repairQuizItems(items,all,mode,type);}
      catch(error){console.warn('[CEMS final quiz repair]',error);return items;}
    });
  }

  function isJson(file){return !!file && (/\.json$/i.test(file.name||'') || /application\/json/i.test(file.type||''));}
  function routeJson(file,input){
    if(!isJson(file))return false;
    if(handledFiles.has(file))return true;   // 같은 File 재진입 — 이미 우리가 처리 중
    handledFiles.add(file);
    Promise.resolve().then(function(){
      if(window.CEMS943&&typeof window.CEMS943.importJson==='function')return window.CEMS943.importJson(file);
      throw new Error('JSON 가져오기 모듈이 아직 준비되지 않았습니다.');
    }).catch(function(error){console.error('[CEMS final JSON]',error);try{showToast('JSON 파일 오류: '+(error&&error.message?error.message:'파일 구조를 확인해 주세요.'));}catch(_){}});
    if(input)input.value='';
    return true;
  }
  /* 9.4.4(항목 22):
     - routeJson 이 false 를 돌려주면(같은 File 재진입) 이벤트가 차단되지 않아
       .json 이 index.html 의 Excel 파서로 흘러갔다. → JSON 이면 결과와 무관하게 차단.
     - change 이벤트에서 preventDefault() 는 무의미하므로 제거.
     - handleJsonFile 이 이제 프로미스를 돌려주므로 위 .catch 가 Worker 실패도 잡는다. */
  document.addEventListener('change',function(event){
    var input=event.target;
    if(!input||input.id!=='file-input')return;
    var file=input.files&&input.files[0];
    if(!isJson(file))return;
    routeJson(file,input);
    event.stopImmediatePropagation();
  },true);
  document.addEventListener('drop',function(event){
    var zone=event.target&&event.target.closest&&event.target.closest('#upload-zone');
    if(!zone)return;
    var files=Array.from((event.dataTransfer&&event.dataTransfer.files)||[]),file=files.find(isJson);
    if(!file)return;
    routeJson(file,null);
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  document.addEventListener('dragover',function(event){
    if(event.target&&event.target.closest&&event.target.closest('#upload-zone'))event.preventDefault();
  },true);
  function removeDuplicateJsonCards(){
    var data=document.getElementById('page-data');if(!data)return;
    Array.from(data.querySelectorAll('.card,section,div')).forEach(function(node){
      if(node.id==='c943-json-import-card'||node.closest('#c943-json-import-card'))return;
      var title=node.querySelector(':scope > .card-title,:scope > [class*="title"]');
      var text=(title&&title.textContent||'').trim();
      if(/JSON\s*외부\s*라이브러리/i.test(text)&&!node.querySelector('#file-input'))node.remove();
    });
  }
  function showPromptTools(){
    var tools=document.getElementById('c944-r2-prompt-tools');
    if(tools){tools.hidden=false;tools.style.display='block';var parent=tools.closest('.c943-collapsed,.is-collapsed,[hidden]');if(parent){parent.classList.remove('c943-collapsed','is-collapsed');parent.hidden=false;}}
    var data=document.getElementById('page-data');if(!data)return;
    Array.from(data.querySelectorAll('.card')).forEach(function(card){
      if(/AI\s*(?:생성\s*)?프롬프트|DB\s*보완용\s*AI/i.test(card.textContent||'')){card.classList.remove('c943-collapsed','is-collapsed');card.hidden=false;}
    });
  }
  function markCompact(){
    document.body.classList.add('cems-v944');
    var order=document.getElementById('option-order');if(order){var card=order.closest('.card');if(card)card.classList.add('c944-r2-order-card');}
    var stats=document.getElementById('cems83-dashboard');if(stats)stats.classList.add('c944-final-stats');
    removeDuplicateJsonCards();showPromptTools();installQuizRepair();iconize();
  }
  /* 9.4.4(항목 25): 이 레이어의 캡처단계 document 클릭 리스너를 공용 UI 버스로
     합쳤다. 예전에는 클릭 한 번에 이 파일까지 4번째 전체 재작업이 예약됐다. */
  var bus=window.CEMS944UiBus;
  function schedule(){if(bus){bus.schedule(60);return;}clearTimeout(schedule.t);schedule.t=setTimeout(markCompact,30);}
  if(bus)bus.register('final-compact',markCompact,40);
  else document.addEventListener('click',schedule,false);
  window.addEventListener('cems:external-library-updated',schedule);
  window.addEventListener('cems:data-ready',schedule);
  window.addEventListener('pageshow',schedule);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){markCompact();if(!bus){setTimeout(markCompact,300);setTimeout(markCompact,1200);}},{once:true});
  else{markCompact();if(!bus){setTimeout(markCompact,300);setTimeout(markCompact,1200);}}
  window.CEMS944Final={version:'9.4.4-final2',refresh:markCompact};
})();
