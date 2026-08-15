/* CEMS v9.2.7 Learning-first — course packs, cold baseline, practice and delayed transfer/retention */
(function () {
  'use strict';

  var api = window.CEMS_LEAN = window.CEMS_LEAN || {};
  var modules = api._modules = api._modules || {};
  var schema = modules.schema;
  var REQUIRED_STORES = ['learningUnits', 'learningProgress', 'learningAttempts', 'learningRepairs', 'learningBenchmarks'];
  var FINAL_RESULTS = new Set(['independent', 'assisted', 'failed']);
  var BENCHMARK_RESULTS = new Set(['independent', 'failed']);
  var DAY = 86400000;
  var POST_EXPOSURE_GAP_DAYS = 7;

  function text(value) { return String(value == null ? '' : value); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function nowMs() {
    var injected = Number(window.__CEMS_LEAN_TEST_NOW);
    return Number.isFinite(injected) && injected > 0 ? injected : Date.now();
  }
  function nowIso() { return new Date(nowMs()).toISOString(); }
  function dayKey(value) {
    var date = value instanceof Date ? value : new Date(value || nowMs());
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function uid(prefix) {
    try { if (crypto && crypto.randomUUID) return prefix + '-' + crypto.randomUUID(); } catch (_) {}
    return prefix + '-' + nowMs().toString(36) + '-' + Math.random().toString(36).slice(2);
  }
  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + canonical(value[key]); }).join(',') + '}';
  }
  async function sha256(value) {
    if (!(crypto && crypto.subtle && crypto.subtle.digest)) return null;
    var buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
    return Array.from(new Uint8Array(buffer)).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }
  function comparableUnit(value) {
    var copy = clone(value || {});
    delete copy.qa;
    delete copy.courseVersion;
    return canonical(copy);
  }
  function unitsEquivalent(left, right) { return comparableUnit(left) === comparableUnit(right); }
  async function unitContentHash(unit) {
    var copy = clone(unit || {});
    delete copy.courseVersion;
    return sha256(copy);
  }
  function dbReady() {
    try { return typeof db !== 'undefined' && db && REQUIRED_STORES.every(function (name) { return db.objectStoreNames.contains(name); }); }
    catch (_) { return false; }
  }
  function waitForDb() {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function tick() {
        if (dbReady()) return resolve(db);
        tries += 1;
        if (tries > 240) return reject(new Error('Lean 학습 데이터베이스를 열지 못했습니다. 앱을 새로고침하십시오.'));
        setTimeout(tick, 100);
      })();
    });
  }
  function requestPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB 요청 실패')); };
    });
  }
  function transactionDone(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error || new Error('IndexedDB 트랜잭션 실패')); };
      transaction.onabort = function () { reject(transaction.error || new Error('IndexedDB 트랜잭션 중단')); };
    });
  }
  async function get(store, key) {
    await waitForDb();
    return requestPromise(db.transaction(store, 'readonly').objectStore(store).get(key));
  }
  async function getAll(store) {
    await waitForDb();
    return requestPromise(db.transaction(store, 'readonly').objectStore(store).getAll());
  }
  async function getAllByIndex(store, index, key) {
    await waitForDb();
    var objectStore = db.transaction(store, 'readonly').objectStore(store);
    if (!objectStore.indexNames.contains(index)) return [];
    return requestPromise(objectStore.index(index).getAll(IDBKeyRange.only(key)));
  }
  async function put(store, value) {
    await waitForDb();
    var transaction = db.transaction(store, 'readwrite');
    transaction.objectStore(store).put(value);
    await transactionDone(transaction);
    return value;
  }
  function runnableBenchmarkItems(unit) {
    var baseline = unit && Array.isArray(unit.baselineItems) ? unit.baselineItems : [];
    var delayed = unit && Array.isArray(unit.transferItems) ? unit.transferItems : [];
    return baseline.concat(delayed).filter(function (item) {
      return schema && typeof schema.runnableBenchmark === 'function'
        ? schema.runnableBenchmark(item)
        : !!(item && item.type && (item.benchmarkId || item.transferId || item.taskId));
    });
  }
  function unitRecordFrom(unit, source, hash, existing, timestamp) {
    return {
      unitId: unit.unitId,
      language: unit.language,
      version: Number(unit.version),
      packVersion: Number(source && source.packVersion || existing && (existing.packVersion || existing.source && existing.source.packVersion) || 0) || null,
      functionKo: unit.functionKo,
      situationKo: unit.situationKo,
      level: unit.level || null,
      primaryScript: unit.primaryScript || null,
      targetVariety: unit.targetVariety || null,
      courseId: unit.courseId || null,
      courseTitleKo: unit.courseTitleKo || null,
      sequence: Number(unit.sequence || unit.courseOrder || 0),
      prerequisiteUnitIds: (unit.prerequisiteUnitIds || unit.prerequisites || []).slice(),
      estimatedMinutes: Number(unit.estimatedMinutes || 10),
      qa: clone(unit.qa || {}),
      contentHash: hash,
      source: source || { type: 'local' },
      importedAt: existing ? existing.importedAt : timestamp,
      updatedAt: timestamp,
      unit: unit
    };
  }
  async function saveUnit(unit, source, overwrite) {
    await waitForDb();
    var existing = await get('learningUnits', unit.unitId);
    var hash = await unitContentHash(unit);
    if (existing) {
      if (Number(unit.version) < Number(existing.version)) {
        var lower = new Error('기존 v' + existing.version + '보다 낮은 단원은 덮어쓸 수 없습니다.');
        lower.code = 'UNIT_VERSION_LOWER'; throw lower;
      }
      if (Number(unit.version) === Number(existing.version) && (existing.contentHash === hash || unitsEquivalent(existing.unit, unit))) {
        var duplicateRecord = existing;
        if (existing.contentHash !== hash || Number(existing.packVersion || existing.source && existing.source.packVersion || 0) !== Number(source && source.packVersion || 0)) {
          duplicateRecord = unitRecordFrom(unit, source || existing.source, hash, existing, nowIso());
          var duplicateTx = db.transaction('learningUnits', 'readwrite');
          duplicateTx.objectStore('learningUnits').put(duplicateRecord);
          await transactionDone(duplicateTx);
        }
        try { await refreshScheduledBenchmarksForUnit(duplicateRecord); await ensureBenchmarksForUnit(duplicateRecord); } catch (_) {}
        return { duplicate: true, record: duplicateRecord };
      }
      if (Number(unit.version) === Number(existing.version)) {
        var stale = new Error('내용이 달라졌다면 단원 version을 v' + (Number(existing.version) + 1) + ' 이상으로 올려야 합니다.');
        stale.code = 'UNIT_VERSION_NOT_INCREMENTED'; stale.existing = existing; stale.incoming = unit; throw stale;
      }
      if (!overwrite) {
        var conflict = new Error('UNIT_EXISTS');
        conflict.code = 'UNIT_EXISTS'; conflict.existing = existing; conflict.incoming = unit; conflict.contentHash = hash;
        throw conflict;
      }
    }
    var timestamp = nowIso();
    var record = unitRecordFrom(unit, source, hash, existing, timestamp);
    var transaction = db.transaction('learningUnits', 'readwrite');
    transaction.objectStore('learningUnits').put(record);
    await transactionDone(transaction);
    try {
      if (existing) await refreshScheduledBenchmarksForUnit(record);
      await ensureBenchmarksForUnit(record);
    } catch (error) { console.warn('[CEMS Lean] benchmark refresh', error); }
    return { duplicate: false, record: record, replaced: !!existing };
  }
  async function saveUnitPack(pack, source, overwrite) {
    await waitForDb();
    if (!pack || !Array.isArray(pack.units) || !pack.units.length) throw new Error('가져올 단원 팩이 비어 있습니다.');
    var incomingPackVersion = Number(pack.version || 0);
    if (!Number.isInteger(incomingPackVersion) || incomingPackVersion < 1) {
      var invalidPackVersion = new Error('코스 팩 version은 1 이상의 정수여야 합니다.');
      invalidPackVersion.code = 'PACK_VERSION_INVALID'; throw invalidPackVersion;
    }
    var packSource = Object.assign({}, source || { type: 'local_pack' }, { packId: pack.packId, packVersion: incomingPackVersion });
    var existingRows = await getAll('learningUnits');
    var existingMap = new Map(existingRows.map(function (row) { return [row.unitId, row]; }));
    var sameCourseRows = existingRows.filter(function (row) { return text(row.courseId) === text(pack.packId); });
    var knownPackVersions = sameCourseRows.map(function (row) { return Number(row.packVersion || row.source && row.source.packVersion || 0); }).filter(function (value) { return Number.isInteger(value) && value > 0; });
    var existingPackVersion = knownPackVersions.length ? Math.max.apply(Math, knownPackVersions) : 0;
    if (existingPackVersion && incomingPackVersion < existingPackVersion) {
      var lowerPack = new Error('설치된 코스 팩 v' + existingPackVersion + '보다 낮은 version은 가져올 수 없습니다.');
      lowerPack.code = 'PACK_COURSE_VERSION_LOWER'; lowerPack.existingPackVersion = existingPackVersion; throw lowerPack;
    }
    var incomingOrder = (pack.unitOrder || pack.units.map(function (unit) { return unit.unitId; })).slice();
    var existingOrder = sameCourseRows.slice().sort(function (a, b) { return Number(a.sequence || 0) - Number(b.sequence || 0) || text(a.unitId).localeCompare(text(b.unitId)); }).map(function (row) { return row.unitId; });
    if (existingOrder.some(function (id, index) { return incomingOrder[index] !== id; })) {
      var composition = new Error('기존 코스 단원의 순서·구성을 바꿀 수 없습니다. 새 단원은 기존 마지막 단원 뒤에만 추가하십시오.');
      composition.code = 'PACK_COURSE_COMPOSITION_CHANGED'; composition.existingOrder = existingOrder; composition.incomingOrder = incomingOrder; throw composition;
    }
    var timestamp = nowIso(), prepared = [], metadataUpdates = [], duplicateCount = 0, replacedCount = 0;
    var courseChanged = sameCourseRows.length > 0 && incomingOrder.length !== existingOrder.length;
    for (var i = 0; i < pack.units.length; i += 1) {
      var unit = pack.units[i], existing = existingMap.get(unit.unitId), hash = await unitContentHash(unit);
      if (existing && text(existing.courseId) && text(existing.courseId) !== text(pack.packId)) {
        var moved = new Error('기존 unitId를 다른 코스로 이동할 수 없습니다: ' + unit.unitId);
        moved.code = 'PACK_UNIT_COURSE_CONFLICT'; moved.unitId = unit.unitId; throw moved;
      }
      if (existing && Number(unit.version) < Number(existing.version)) {
        var lower = new Error('설치된 v' + existing.version + '보다 낮은 단원은 가져올 수 없습니다: ' + unit.unitId); lower.code = 'PACK_VERSION_LOWER'; lower.unitId = unit.unitId; throw lower;
      }
      if (existing && Number(unit.version) === Number(existing.version) && (existing.contentHash === hash || unitsEquivalent(existing.unit, unit))) {
        var currentPackVersion = Number(existing.packVersion || existing.source && existing.source.packVersion || 0);
        if (existing.contentHash !== hash || currentPackVersion !== incomingPackVersion || !existing.source || Number(existing.source.packVersion || 0) !== incomingPackVersion || !unitsEquivalent(existing.unit, unit)) {
          metadataUpdates.push(unitRecordFrom(unit, packSource, hash, existing, timestamp));
        }
        duplicateCount += 1; continue;
      }
      if (existing) courseChanged = true;
      else if (sameCourseRows.length) courseChanged = true;
      if (existing && Number(unit.version) === Number(existing.version)) {
        var stale = new Error('내용이 달라졌다면 ' + unit.unitId + '의 version을 v' + (Number(existing.version) + 1) + ' 이상으로 올려야 합니다.');
        stale.code = 'PACK_VERSION_NOT_INCREMENTED'; stale.unitId = unit.unitId; stale.existing = existing; stale.incoming = unit; throw stale;
      }
      var existingBuiltIn = existing && existing.source && /^built_in_(pack|sample)/.test(text(existing.source.type));
      var incomingBuiltIn = /^built_in_(pack|sample)/.test(text(packSource.type));
      if (existing && !overwrite && !(existingBuiltIn && incomingBuiltIn)) {
        var conflict = new Error('PACK_CONFLICT'); conflict.code = 'PACK_CONFLICT'; conflict.unitId = unit.unitId; conflict.existing = existing; conflict.incoming = unit; throw conflict;
      }
      if (existing) replacedCount += 1;
      prepared.push(unitRecordFrom(unit, packSource, hash, existing, timestamp));
    }
    if (sameCourseRows.length && existingPackVersion && courseChanged && incomingPackVersion <= existingPackVersion) {
      var stalePack = new Error('코스 내용이나 단원 구성이 바뀌었다면 팩 version을 v' + (existingPackVersion + 1) + ' 이상으로 올려야 합니다.');
      stalePack.code = 'PACK_COURSE_VERSION_NOT_INCREMENTED'; stalePack.existingPackVersion = existingPackVersion; throw stalePack;
    }
    var writes = prepared.concat(metadataUpdates);
    if (writes.length) {
      var transaction = db.transaction('learningUnits', 'readwrite');
      var store = transaction.objectStore('learningUnits');
      writes.forEach(function (record) { store.put(record); });
      await transactionDone(transaction);
    }
    var records = [];
    for (var j = 0; j < pack.units.length; j += 1) {
      var record = await get('learningUnits', pack.units[j].unitId);
      if (record) {
        records.push(record);
        try { await refreshScheduledBenchmarksForUnit(record); await ensureBenchmarksForUnit(record); }
        catch (error) { console.warn('[CEMS Lean] benchmark refresh', error); }
      }
    }
    return { duplicate: prepared.length === 0, imported: prepared.length - replacedCount, replaced: replacedCount, skipped: duplicateCount, metadataUpdated: metadataUpdates.length, records: records, packId: pack.packId, packVersion: incomingPackVersion };
  }
  async function listUnits(language) {
    var rows = await getAll('learningUnits');
    return rows.filter(function (row) { return !language || row.language === language; }).sort(function (a, b) {
      var course = text(a.courseId).localeCompare(text(b.courseId));
      if (course) return course;
      var sequence = Number(a.sequence || 0) - Number(b.sequence || 0);
      return sequence || text(a.unitId).localeCompare(text(b.unitId));
    });
  }
  async function attemptsForUnit(unitId) { return getAllByIndex('learningAttempts', 'unitId', unitId); }
  async function progressForUnit(unitId) { return getAllByIndex('learningProgress', 'unitId', unitId); }
  async function benchmarksForUnit(unitId) { return getAllByIndex('learningBenchmarks', 'unitId', unitId); }
  async function completionForUnit(unitRecord) {
    var allAttempts = await attemptsForUnit(unitRecord.unitId);
    var attempts = allAttempts.filter(function (attempt) { return FINAL_RESULTS.has(attempt.result) && !attempt.isRepair && !attempt.isBenchmark; });
    var practice = unitRecord.unit.practicePlan || [];
    var practiceIds = new Set(practice.map(function (task) { return task.taskId; }));
    var firstSuccess = new Map();
    attempts.forEach(function (attempt) {
      if (attempt.result === 'failed' || !practiceIds.has(attempt.taskId)) return;
      var when = new Date(attempt.submittedAt || attempt.firstSubmittedAt || 0).getTime();
      if (!Number.isFinite(when) || when <= 0) return;
      if (!firstSuccess.has(attempt.taskId) || when < firstSuccess.get(attempt.taskId)) firstSuccess.set(attempt.taskId, when);
    });
    var completed = new Set(firstSuccess.keys());
    var complete = practice.length > 0 && completed.size >= practice.length;
    var completedAt = complete ? new Date(Math.max.apply(Math, Array.from(firstSuccess.values()))).toISOString() : null;
    return {
      completedTaskIds: completed,
      completed: practice.filter(function (task) { return completed.has(task.taskId); }).length,
      total: practice.length,
      complete: complete,
      completedAt: completedAt,
      attempts: attempts,
      allAttempts: allAttempts,
      pendingAttempts: allAttempts.filter(function (attempt) { return attempt.result === 'pending'; })
    };
  }
  function benchmarkRecordId(unitRecord, item) {
    return unitRecord.language + ':' + unitRecord.unitId + ':' + text(item.benchmarkId || item.transferId || item.taskId);
  }
  async function refreshScheduledBenchmarksForUnit(unitRecord) {
    if (!unitRecord || !unitRecord.unit) return [];
    var items = runnableBenchmarkItems(unitRecord.unit);
    var byContentId = new Map(items.map(function (item) { return [text(item.benchmarkId || item.transferId || item.taskId), item]; }));
    var rows = await benchmarksForUnit(unitRecord.unitId);
    var updates = [];
    rows.forEach(function (row) {
      if (!row || row.status !== 'scheduled' || row.attemptedAt || row.result) return;
      var item = byContentId.get(text(row.contentBenchmarkId));
      if (!item) return;
      updates.push(Object.assign({}, row, {
        taskId: item.taskId,
        taskType: item.type,
        form: item.form || null,
        probeDomain: item.probeDomain || 'production',
        targetIds: (item.targetRefs || []).slice(),
        targetId: (item.targetRefs || [])[0] || null,
        measurementKey: item.measurementKey || null,
        variantKey: item.variantKey || item.taskId,
        taskSnapshot: clone(item),
        contentVersion: Number(unitRecord.version),
        contentHash: unitRecord.contentHash || null,
        updatedAt: nowIso()
      }));
    });
    if (updates.length) {
      var transaction = db.transaction('learningBenchmarks', 'readwrite');
      var store = transaction.objectStore('learningBenchmarks');
      updates.forEach(function (row) { store.put(row); });
      await transactionDone(transaction);
    }
    return updates;
  }
  async function ensureBenchmarksForUnit(unitRecord) {
    if (!unitRecord || !unitRecord.unit) return [];
    var items = runnableBenchmarkItems(unitRecord.unit);
    if (!items.length) return [];
    var completion = await completionForUnit(unitRecord);
    var existing = await benchmarksForUnit(unitRecord.unitId);
    var existingIds = new Set(existing.map(function (row) { return row.benchmarkId; }));
    var priorExposure = completion.allAttempts.some(function (attempt) {
      return attempt && !attempt.isBenchmark && !attempt.isRepair && (attempt.result === 'pending' || FINAL_RESULTS.has(attempt.result));
    });
    var importedAt = unitRecord.importedAt || nowIso();
    var completionMs = completion.completedAt ? new Date(completion.completedAt).getTime() : NaN;
    var importedMs = new Date(importedAt).getTime();
    if (!Number.isFinite(importedMs)) importedMs = nowMs();
    var writes = [];
    items.forEach(function (item) {
      var id = benchmarkRecordId(unitRecord, item);
      if (existingIds.has(id)) return; /* 예약 당시의 문항을 콘텐츠 업데이트로 바꾸지 않는다. */
      var phase = text(item.phase);
      if (phase !== 'baseline' && (!completion.complete || !Number.isFinite(completionMs))) return;
      var delay = Math.max(0, Number(item.minimumDelayDays || 0));
      var anchorAt = phase === 'baseline' ? importedAt : completion.completedAt;
      var anchorMs = phase === 'baseline' ? importedMs : completionMs;
      var ineligible = phase === 'baseline' && priorExposure;
      writes.push({
        benchmarkId: id,
        contentBenchmarkId: text(item.benchmarkId || item.transferId || item.taskId),
        language: unitRecord.language,
        unitId: unitRecord.unitId,
        courseId: unitRecord.courseId || null,
        sequence: Number(unitRecord.sequence || 0),
        phase: phase,
        form: item.form || null,
        taskId: item.taskId,
        taskType: item.type,
        probeDomain: item.probeDomain || 'production',
        targetIds: (item.targetRefs || []).slice(),
        targetId: (item.targetRefs || [])[0] || null,
        measurementKey: item.measurementKey || null,
        variantKey: item.variantKey || item.taskId,
        minimumDelayDays: delay,
        anchorCompletedAt: anchorAt,
        dueAt: new Date(anchorMs + delay * DAY).toISOString(),
        notBeforeAt: null,
        status: ineligible ? 'not_eligible' : 'scheduled',
        ineligibleReason: ineligible ? 'prior_exposure' : null,
        contentVersion: Number(unitRecord.version),
        contentHash: unitRecord.contentHash || null,
        taskSnapshot: clone(item),
        scheduledAt: nowIso(),
        updatedAt: nowIso()
      });
    });
    if (writes.length) {
      var transaction = db.transaction('learningBenchmarks', 'readwrite');
      var store = transaction.objectStore('learningBenchmarks');
      writes.forEach(function (row) { store.put(row); });
      await transactionDone(transaction);
    }
    return benchmarksForUnit(unitRecord.unitId);
  }
  async function ensureAllBenchmarks(language) {
    var units = await listUnits(language);
    for (var i = 0; i < units.length; i += 1) await ensureBenchmarksForUnit(units[i]);
    return (await getAll('learningBenchmarks')).filter(function (row) { return !language || row.language === language; });
  }
  function phaseRows(row, rows, phase) {
    return (rows || []).filter(function (candidate) { return candidate.unitId === row.unitId && candidate.phase === phase; });
  }
  function effectiveBenchmarkDueMs(row, allRows) {
    var base = new Date(row && row.dueAt || 0).getTime();
    if (!Number.isFinite(base)) return Infinity;
    var notBefore = new Date(row && row.notBeforeAt || 0).getTime();
    if (Number.isFinite(notBefore) && notBefore > base) base = notBefore;
    if (row.phase !== 'retention') return base;
    var transferRows = phaseRows(row, allRows instanceof Map ? Array.from(allRows.values()) : allRows, 'transfer');
    if (!transferRows.length) return base;
    /* 3일 전이를 14일 유지 시점까지 하지 않았다면 그 측정은 소급 시행하지 않는다.
       missed_late는 노출 없이 측정 창을 놓쳤다는 뜻이며, 유지 문항은 그대로 실시한다. */
    if (transferRows.some(function (item) { return item.status === 'scheduled'; })) return Infinity;
    var completedTransfers = transferRows.filter(function (item) { return item.status === 'completed'; });
    if (!completedTransfers.length) return base;
    var latestTransfer = Math.max.apply(Math, completedTransfers.map(function (item) { return new Date(item.attemptedAt || 0).getTime(); }));
    if (!Number.isFinite(latestTransfer) || latestTransfer <= 0) return base;
    return Math.max(base, latestTransfer + POST_EXPOSURE_GAP_DAYS * DAY);
  }
  async function markMissedTransfers(rows, atMs) {
    rows = Array.isArray(rows) ? rows : [];
    var now = Number(atMs == null ? nowMs() : atMs);
    var byUnit = new Map();
    rows.forEach(function (row) {
      if (!byUnit.has(row.unitId)) byUnit.set(row.unitId, []);
      byUnit.get(row.unitId).push(row);
    });
    var missed = [];
    byUnit.forEach(function (unitRows) {
      var retentionCutoffs = unitRows.filter(function (row) { return row.phase === 'retention' && row.status === 'scheduled'; })
        .map(function (row) { return new Date(row.dueAt || 0).getTime(); }).filter(Number.isFinite);
      if (!retentionCutoffs.length) return;
      var cutoff = Math.min.apply(Math, retentionCutoffs);
      if (now < cutoff) return;
      unitRows.filter(function (row) { return row.phase === 'transfer' && row.status === 'scheduled'; }).forEach(function (row) {
        row.status = 'missed_late';
        row.missedAt = new Date(now).toISOString();
        row.missedReason = 'retention_window_opened';
        row.updatedAt = row.missedAt;
        missed.push(row);
      });
    });
    if (!missed.length) return rows;
    var transaction = db.transaction('learningBenchmarks', 'readwrite');
    var store = transaction.objectStore('learningBenchmarks');
    missed.forEach(function (row) { store.put(row); });
    await transactionDone(transaction);
    return rows;
  }
  function benchmarkIsDue(row, allRows, atMs) {
    if (!row || row.status !== 'scheduled') return false;
    var rows = allRows instanceof Map ? Array.from(allRows.values()) : (allRows || []);
    return effectiveBenchmarkDueMs(row, rows) <= Number(atMs == null ? nowMs() : atMs);
  }
  async function dueBenchmarks(language, maxCount, atMs) {
    var rows = await ensureAllBenchmarks(language);
    var now = Number(atMs == null ? nowMs() : atMs);
    rows = await markMissedTransfers(rows, now);
    return rows.filter(function (row) { return benchmarkIsDue(row, rows, now); }).map(function (row) {
      var copy = clone(row); copy.effectiveDueAt = new Date(effectiveBenchmarkDueMs(row, rows)).toISOString(); return copy;
    }).sort(function (a, b) {
      var priority = { transfer: 0, retention: 1, baseline: 2 };
      var phase = Number(priority[a.phase] == null ? 9 : priority[a.phase]) - Number(priority[b.phase] == null ? 9 : priority[b.phase]);
      if (phase) return phase;
      var due = text(a.effectiveDueAt).localeCompare(text(b.effectiveDueAt));
      if (due) return due;
      return text(a.benchmarkId).localeCompare(text(b.benchmarkId));
    }).slice(0, Number(maxCount || 2));
  }
  async function benchmarkStateForUnit(unitRecord) {
    var rows = await ensureBenchmarksForUnit(unitRecord);
    rows = await markMissedTransfers(rows, nowMs());
    var scheduled = rows.filter(function (row) { return row.status === 'scheduled'; });
    var completed = rows.filter(function (row) { return row.status === 'completed'; });
    var due = scheduled.filter(function (row) { return benchmarkIsDue(row, rows, nowMs()); });
    var candidates = scheduled.map(function (row) { return { row: row, ms: effectiveBenchmarkDueMs(row, rows) }; })
      .filter(function (entry) { return Number.isFinite(entry.ms); }).sort(function (a, b) { return a.ms - b.ms; });
    var baseline = rows.filter(function (row) { return row.phase === 'baseline'; });
    var transfer = rows.filter(function (row) { return row.phase === 'transfer'; });
    var retention = rows.filter(function (row) { return row.phase === 'retention'; });
    var baselineSatisfied = !baseline.length || baseline.every(function (row) { return row.status === 'completed' || row.status === 'not_eligible'; });
    return {
      rows: rows,
      scheduled: scheduled,
      completed: completed,
      due: due,
      dueCount: due.length,
      baseline: baseline,
      baselineDue: baseline.filter(function (row) { return benchmarkIsDue(row, rows, nowMs()); }),
      baselineCompleted: !!baseline.length && baseline.every(function (row) { return row.status === 'completed'; }),
      baselineEligible: baseline.some(function (row) { return row.status !== 'not_eligible'; }),
      baselineNotEligible: baseline.some(function (row) { return row.status === 'not_eligible'; }),
      baselineSatisfied: baselineSatisfied,
      transfer: transfer,
      retention: retention,
      transferCompleted: !!transfer.length && transfer.every(function (row) { return row.status === 'completed' || row.status === 'missed_late'; }),
      transferConfirmed: !!transfer.length && transfer.every(function (row) { return row.status === 'completed' && row.result === 'independent'; }),
      transferMissed: transfer.some(function (row) { return row.status === 'missed_late'; }),
      retentionCompleted: !!retention.length && retention.every(function (row) { return row.status === 'completed'; }),
      retentionConfirmed: !!retention.length && retention.every(function (row) { return row.status === 'completed' && row.result === 'independent'; }),
      nextBenchmark: candidates.length ? candidates[0].row : null,
      nextDueAt: candidates.length ? new Date(candidates[0].ms).toISOString() : null
    };
  }
  async function postponeRetentionAfterExposure(unitId, exposureAt) {
    var when = new Date(exposureAt || nowIso()).getTime();
    if (!Number.isFinite(when) || when <= 0) return 0;
    var rows = await benchmarksForUnit(unitId);
    var threshold = new Date(when + POST_EXPOSURE_GAP_DAYS * DAY).toISOString();
    var changed = rows.filter(function (row) { return row.phase === 'retention' && row.status === 'scheduled'; }).filter(function (row) {
      return !row.notBeforeAt || new Date(row.notBeforeAt).getTime() < new Date(threshold).getTime();
    });
    if (!changed.length) return 0;
    var transaction = db.transaction('learningBenchmarks', 'readwrite');
    var store = transaction.objectStore('learningBenchmarks');
    changed.forEach(function (row) { row.notBeforeAt = threshold; row.updatedAt = nowIso(); store.put(row); });
    await transactionDone(transaction);
    return changed.length;
  }
  function chooseRepairTask(unit, errorCode, sourceTask, existingRepairs) {
    var rule = (unit.repairRules || []).find(function (item) { return item.errorCode === errorCode; });
    if (!rule) return null;
    var repairMap = new Map((unit.repairPlan || []).map(function (task) { return [task.taskId, task]; }));
    var candidates = (rule.repairTaskRefs || []).map(function (id) { return repairMap.get(id); }).filter(Boolean).filter(function (task) {
      return !sourceTask || !sourceTask.variantKey || task.variantKey !== sourceTask.variantKey;
    });
    if (!candidates.length) return null;
    var used = new Set((existingRepairs || []).filter(function (repair) { return repair.errorCode === errorCode; }).map(function (repair) { return repair.repairTaskId; }));
    return candidates.find(function (task) { return !used.has(task.taskId); }) || candidates[0];
  }
  async function ensureRepair(attempt, unit, task) {
    if (!attempt.errorCode || attempt.result === 'independent') return null;
    var all = await getAll('learningRepairs');
    var targetId = attempt.targetId || (attempt.targetIds || [])[0];
    var existing = all.find(function (repair) {
      return repair.unitId === attempt.unitId && repair.targetId === targetId && repair.errorCode === attempt.errorCode && repair.resolved !== true;
    });
    if (existing) return existing;
    var repairTask = chooseRepairTask(unit, attempt.errorCode, task, all);
    if (!repairTask) return null;
    var timestamp = nowIso();
    var repair = {
      repairId: uid('repair'),
      language: attempt.language,
      unitId: attempt.unitId,
      targetId: targetId,
      sourceAttemptId: attempt.sourceKind === 'benchmark' ? null : attempt.attemptId,
      sourceBenchmarkId: attempt.sourceKind === 'benchmark' ? attempt.benchmarkId : null,
      sourceKind: attempt.sourceKind || 'practice',
      sourceTaskId: attempt.taskId,
      sourceVariantKey: task.variantKey || task.taskId,
      repairTaskId: repairTask.taskId,
      repairVariantKey: repairTask.variantKey || repairTask.taskId,
      errorCode: attempt.errorCode,
      createdAt: timestamp,
      dueAt: timestamp,
      eligibleAfterIndex: Number(attempt.sessionIndex || 0) + 3 + (Math.abs(text(attempt.taskId).length + text(attempt.errorCode).length) % 4),
      resolved: false,
      successCount: 0,
      lastAttemptAt: null
    };
    await put('learningRepairs', repair);
    return repair;
  }
  async function resolveOrDeferRepair(repairId, result) {
    if (!repairId) return null;
    var repair = await get('learningRepairs', repairId);
    if (!repair) return null;
    repair.lastAttemptAt = nowIso();
    if (result === 'independent') {
      repair.resolved = true;
      repair.resolvedAt = repair.lastAttemptAt;
      repair.successCount = Number(repair.successCount || 0) + 1;
    } else {
      repair.resolved = false;
      repair.dueAt = new Date(nowMs() + DAY).toISOString();
      if (result === 'assisted') repair.successCount = Number(repair.successCount || 0) + 1;
    }
    await put('learningRepairs', repair);
    await postponeRetentionAfterExposure(repair.unitId, repair.lastAttemptAt);
    return repair;
  }
  function prepareAttempt(attempt, task) {
    attempt.attemptId = attempt.attemptId || uid('attempt');
    attempt.submittedAt = attempt.submittedAt || nowIso();
    attempt.dayKey = attempt.dayKey || dayKey(attempt.submittedAt);
    attempt.targetIds = Array.isArray(attempt.targetIds) ? attempt.targetIds.slice() : (task.targetRefs || []).slice();
    attempt.targetId = attempt.targetId || attempt.targetIds[0] || null;
    attempt.taskType = attempt.taskType || task.type;
    attempt.domain = attempt.domain || task.domain;
    attempt.isRepair = !!task.isRepair;
    attempt.isBenchmark = false;
    return attempt;
  }
  async function recordFirstSubmission(attempt, unit, task) {
    await waitForDb();
    prepareAttempt(attempt, task);
    attempt.result = 'pending';
    attempt.status = 'pending';
    attempt.firstSubmittedAt = attempt.firstSubmittedAt || attempt.submittedAt;
    await put('learningAttempts', attempt);
    if (!task.isRepair) await postponeRetentionAfterExposure(attempt.unitId, attempt.firstSubmittedAt || attempt.submittedAt);
    var repair = task.isRepair ? null : await ensureRepair(attempt, unit, task);
    return { attempt: attempt, repair: repair };
  }
  async function recordAttempt(attempt, unit, task) {
    await waitForDb();
    prepareAttempt(attempt, task);
    if (!FINAL_RESULTS.has(attempt.result)) throw new Error('최종 시도의 result가 올바르지 않습니다.');
    var existingAttempt = await get('learningAttempts', attempt.attemptId);
    if (existingAttempt && existingAttempt.status === 'final' && FINAL_RESULTS.has(existingAttempt.result)) {
      return { attempt: existingAttempt, repair: existingAttempt.repairId ? await get('learningRepairs', existingAttempt.repairId) : null, duplicate: true };
    }
    attempt.status = 'final';
    var stores = task.isRepair ? ['learningAttempts'] : ['learningAttempts', 'learningProgress'];
    var transaction = db.transaction(stores, 'readwrite');
    transaction.objectStore('learningAttempts').put(attempt);
    var requests = [];
    if (!task.isRepair) {
      var progressStore = transaction.objectStore('learningProgress');
      requests = attempt.targetIds.map(function (targetId) {
        return new Promise(function (resolve, reject) {
          var progressId = attempt.language + ':' + attempt.unitId + ':' + targetId;
          var request = progressStore.get(progressId);
          request.onerror = function () { reject(request.error); };
          request.onsuccess = function () {
            var row = request.result || {
              progressId: progressId,
              language: attempt.language,
              unitId: attempt.unitId,
              targetId: targetId,
              counts: { independent: 0, assisted: 0, failed: 0 },
              domainCounts: { comprehension: { independent: 0, assisted: 0, failed: 0 }, production: { independent: 0, assisted: 0, failed: 0 } },
              completedTaskIds: []
            };
            row.counts[attempt.result] = Number(row.counts[attempt.result] || 0) + 1;
            var domain = attempt.domain === 'production' ? 'production' : 'comprehension';
            row.domainCounts[domain] = row.domainCounts[domain] || { independent: 0, assisted: 0, failed: 0 };
            row.domainCounts[domain][attempt.result] = Number(row.domainCounts[domain][attempt.result] || 0) + 1;
            if (attempt.result !== 'failed') row.completedTaskIds = Array.from(new Set((row.completedTaskIds || []).concat(attempt.taskId)));
            row.lastStudiedAt = attempt.submittedAt;
            row.lastResult = attempt.result;
            row.lastTaskType = attempt.taskType;
            progressStore.put(row);
            resolve(row);
          };
        });
      });
    }
    await Promise.all(requests);
    await transactionDone(transaction);
    var repair = task.isRepair ? await resolveOrDeferRepair(attempt.repairId, attempt.result) : await ensureRepair(attempt, unit, task);
    if (!task.isRepair) {
      try {
        var record = await get('learningUnits', attempt.unitId);
        if (record) await ensureBenchmarksForUnit(record);
        await postponeRetentionAfterExposure(attempt.unitId, attempt.submittedAt);
      } catch (_) {}
    }
    return { attempt: attempt, repair: repair, duplicate: false };
  }
  async function recordBenchmarkResult(benchmarkId, grade, response, unit, task) {
    await waitForDb();
    var row = await get('learningBenchmarks', benchmarkId);
    if (!row) throw new Error('기준선·전이·유지 일정을 찾지 못했습니다.');
    if (row.status === 'completed' && BENCHMARK_RESULTS.has(row.result)) return { benchmark: row, repair: null, duplicate: true };
    var all = await benchmarksForUnit(row.unitId);
    if (!benchmarkIsDue(row, all, nowMs())) throw new Error('아직 이 확인 문항을 실시할 수 없습니다.');
    var timestamp = nowIso();
    var result = grade && grade.correct ? 'independent' : 'failed';
    row.status = 'completed';
    row.result = result;
    row.firstAttemptCorrect = result === 'independent';
    row.attemptedAt = timestamp;
    row.dayKey = dayKey(timestamp);
    /* 학습 전 기준선은 성공 여부만 보존한다. 입력 문장과 정답 표면형은 저장하지 않는다. */
    row.responseNormalized = row.phase === 'baseline' ? null : (grade ? grade.normalized : '');
    row.answerDisplay = row.phase === 'baseline' ? null : (grade ? grade.answerDisplay : '');
    row.errorCode = row.phase !== 'baseline' && result === 'failed' ? (grade && grade.errorCode || text(task && task.feedback && task.feedback.errorCode) || null) : null;
    row.responseKind = task.type === 'tokenOrder' ? 'tokens' : task.type === 'contextChoice' ? 'option' : 'text';
    row.updatedAt = timestamp;
    row.attemptCount = 1;
    await put('learningBenchmarks', row);
    var repair = null;
    if (row.phase !== 'baseline' && result === 'failed') {
      var pseudo = {
        sourceKind: 'benchmark', benchmarkId: row.benchmarkId,
        attemptId: null, language: row.language, unitId: row.unitId,
        targetIds: (row.targetIds || []).slice(), targetId: row.targetId,
        taskId: row.taskId, sessionIndex: 0, result: result, errorCode: row.errorCode
      };
      repair = await ensureRepair(pseudo, unit, task);
    }
    return { benchmark: row, repair: repair, duplicate: false };
  }
  async function dueRepairs(language, maxCount) {
    var now = nowMs();
    var rows = await getAll('learningRepairs');
    return rows.filter(function (repair) {
      return repair.language === language && repair.resolved !== true && new Date(repair.dueAt || 0).getTime() <= now;
    }).sort(function (a, b) { return text(a.dueAt).localeCompare(text(b.dueAt)); }).slice(0, Number(maxCount || 2));
  }
  function summarizeAttempts(attempts) {
    var practice = (Array.isArray(attempts) ? attempts : []).filter(function (attempt) {
      return FINAL_RESULTS.has(attempt.result) && !attempt.isRepair && !attempt.isBenchmark;
    });
    function domainSummary(domain) {
      var rows = practice.filter(function (attempt) { return attempt.domain === domain; });
      var independent = rows.filter(function (attempt) { return attempt.result === 'independent'; }).length;
      return { independent: independent, total: rows.length, rate: rows.length ? independent / rows.length : null };
    }
    var hints = practice.filter(function (attempt) { return Number(attempt.hintsUsed || 0) > 0 || attempt.assistanceUsed === true; }).length;
    var resultCounts = { independent: 0, assisted: 0, failed: 0 };
    var errors = {};
    practice.forEach(function (attempt) {
      if (resultCounts[attempt.result] != null) resultCounts[attempt.result] += 1;
      if (attempt.errorCode && (attempt.firstAttemptCorrect === false || attempt.result === 'failed')) errors[attempt.errorCode] = Number(errors[attempt.errorCode] || 0) + 1;
    });
    var topErrors = Object.keys(errors).map(function (code) { return { errorCode: code, count: errors[code] }; }).sort(function (a, b) { return b.count - a.count || a.errorCode.localeCompare(b.errorCode); }).slice(0, 3);
    return {
      total: practice.length,
      results: resultCounts,
      comprehension: domainSummary('comprehension'),
      production: domainSummary('production'),
      hintDependence: { used: hints, total: practice.length, rate: practice.length ? hints / practice.length : null },
      topErrors: topErrors
    };
  }
  function summarizeRepairAttempts(attempts) {
    var rows = (attempts || []).filter(function (attempt) { return FINAL_RESULTS.has(attempt.result) && attempt.isRepair === true; });
    return {
      total: rows.length,
      independent: rows.filter(function (row) { return row.result === 'independent'; }).length,
      assisted: rows.filter(function (row) { return row.result === 'assisted'; }).length,
      failed: rows.filter(function (row) { return row.result === 'failed'; }).length
    };
  }
  function summarizeBenchmarks(rows, phase) {
    var phaseRowsList = (rows || []).filter(function (row) { return row.phase === phase; });
    var completed = phaseRowsList.filter(function (row) { return row.status === 'completed' && BENCHMARK_RESULTS.has(row.result); });
    var independent = completed.filter(function (row) { return row.result === 'independent'; }).length;
    return {
      independent: independent,
      failed: completed.length - independent,
      total: completed.length,
      scheduled: phaseRowsList.filter(function (row) { return row.status === 'scheduled'; }).length,
      rate: completed.length ? independent / completed.length : null
    };
  }
  function summarizeBlindedBaselines(rows) {
    var phaseRowsList = (rows || []).filter(function (row) { return row.phase === 'baseline'; });
    var completed = phaseRowsList.filter(function (row) { return row.status === 'completed' && BENCHMARK_RESULTS.has(row.result); });
    var endpointUnits = new Set((rows || []).filter(function (row) {
      return (row.phase === 'transfer' || row.phase === 'retention') && row.status === 'completed' && BENCHMARK_RESULTS.has(row.result);
    }).map(function (row) { return row.unitId; }));
    return {
      independent: null,
      failed: null,
      total: completed.length,
      completed: completed.length,
      scheduled: phaseRowsList.filter(function (row) { return row.status === 'scheduled'; }).length,
      rate: null,
      blinded: true,
      resultsRevealedInPairs: completed.filter(function (row) { return endpointUnits.has(row.unitId); }).length
    };
  }
  function pairedOutcomeSummary(rows, endpointPhase) {
    endpointPhase = endpointPhase || 'retention';
    var byUnit = new Map();
    (rows || []).forEach(function (row) {
      if (!byUnit.has(row.unitId)) byUnit.set(row.unitId, []);
      byUnit.get(row.unitId).push(row);
    });
    var result = {
      endpointPhase: endpointPhase,
      improved: 0, maintained: 0, declined: 0, unchangedFail: 0,
      paired: 0, unpaired: 0, constructMismatch: 0, baselineIndependent: 0, endpointIndependent: 0,
      baselineRate: null, endpointRate: null, deltaPercentagePoints: null
    };
    byUnit.forEach(function (unitRows) {
      var baseline = unitRows.find(function (row) { return row.phase === 'baseline' && row.status === 'completed' && BENCHMARK_RESULTS.has(row.result); });
      var endpoint = unitRows.find(function (row) { return row.phase === endpointPhase && row.status === 'completed' && BENCHMARK_RESULTS.has(row.result); });
      if (!baseline || !endpoint) { result.unpaired += 1; return; }
      if (baseline.measurementKey && endpoint.measurementKey && baseline.measurementKey !== endpoint.measurementKey) {
        result.constructMismatch += 1; result.unpaired += 1; return;
      }
      result.paired += 1;
      if (baseline.result === 'independent') result.baselineIndependent += 1;
      if (endpoint.result === 'independent') result.endpointIndependent += 1;
      if (baseline.result === 'failed' && endpoint.result === 'independent') result.improved += 1;
      else if (baseline.result === 'independent' && endpoint.result === 'independent') result.maintained += 1;
      else if (baseline.result === 'independent' && endpoint.result === 'failed') result.declined += 1;
      else result.unchangedFail += 1;
    });
    if (result.paired) {
      result.baselineRate = result.baselineIndependent / result.paired;
      result.endpointRate = result.endpointIndependent / result.paired;
      result.deltaPercentagePoints = Math.round((result.endpointRate - result.baselineRate) * 1000) / 10;
    }
    return result;
  }

  async function courseProgressSummary(language) {
    var units = await listUnits(language), completed = 0, started = 0, courses = {};
    for (var i = 0; i < units.length; i += 1) {
      var completion = await completionForUnit(units[i]);
      if (completion.complete) completed += 1;
      if (completion.allAttempts.length) started += 1;
      var key = units[i].courseId || 'uncategorized';
      if (!courses[key]) courses[key] = { courseId: key, titleKo: units[i].courseTitleKo || '마이크로 단원', totalUnits: 0, completedUnits: 0, startedUnits: 0 };
      courses[key].totalUnits += 1;
      if (completion.complete) courses[key].completedUnits += 1;
      if (completion.allAttempts.length) courses[key].startedUnits += 1;
    }
    return { totalUnits: units.length, completedUnits: completed, startedUnits: started, courses: Object.keys(courses).map(function (key) { return courses[key]; }) };
  }
  async function buildPilotReport(language) {
    var units = await listUnits(language);
    var attempts = (await getAll('learningAttempts')).filter(function (row) { return !language || row.language === language; });
    var benchmarks = (await ensureAllBenchmarks(language)).filter(function (row) { return !language || row.language === language; });
    var summary = await getProgressSummary(language);
    var unitRows = [];
    for (var i = 0; i < units.length; i += 1) {
      var unit = units[i], completion = await completionForUnit(unit);
      var checks = benchmarks.filter(function (row) { return row.unitId === unit.unitId; });
      var endpointCompleted = checks.some(function (item) {
        return (item.phase === 'transfer' || item.phase === 'retention') && item.status === 'completed' && BENCHMARK_RESULTS.has(item.result);
      });
      function compactPhase(phase) {
        var row = checks.find(function (item) { return item.phase === phase; });
        if (!row) return null;
        var resultBlinded = phase === 'baseline' && !endpointCompleted;
        return {
          status: row.status,
          result: resultBlinded ? null : (row.result || null),
          resultBlinded: resultBlinded,
          dayKey: row.dayKey || null,
          dueAt: row.dueAt || null,
          ineligibleReason: row.ineligibleReason || null,
          measurementKey: row.measurementKey || null
        };
      }
      var unitAttempts = attempts.filter(function (row) { return row.unitId === unit.unitId && FINAL_RESULTS.has(row.result) && !row.isRepair; });
      var baselineRow = checks.find(function (item) { return item.phase === 'baseline'; });
      unitRows.push({
        unitId: unit.unitId, courseId: unit.courseId || null, sequence: Number(unit.sequence || 0),
        measurementKey: baselineRow && baselineRow.measurementKey || null,
        qaStatus: unit.qa && unit.qa.status || null, languageReviewed: !!(unit.qa && unit.qa.languageReviewed),
        practice: { completedTasks: completion.completed, totalTasks: completion.total, independent: unitAttempts.filter(function (row) { return row.result === 'independent'; }).length, assisted: unitAttempts.filter(function (row) { return row.result === 'assisted'; }).length, failed: unitAttempts.filter(function (row) { return row.result === 'failed'; }).length },
        baseline: compactPhase('baseline'), transfer: compactPhase('transfer'), retention: compactPhase('retention')
      });
    }
    var activityDayValues = attempts.filter(function (row) { return FINAL_RESULTS.has(row.result); }).map(function (row) { return row.dayKey; })
      .concat(benchmarks.filter(function (row) { return row.status === 'completed' && BENCHMARK_RESULTS.has(row.result); }).map(function (row) { return row.dayKey; }));
    var activeDays = Array.from(new Set(activityDayValues.filter(Boolean))).sort();
    return {
      schemaVersion: 'cems-lean-pilot-report-1', generatedAt: nowIso(), language: language || null,
      privacy: { containsRawResponses: false, containsAnswerKeys: false, localOnlyUntilExported: true, baselineResultsBlindedUntilEndpoint: true },
      methodology: { pairedOnlyWhenMeasurementKeyMatches: true, unitEntryBaseline: true, causalEffectNotEstablished: true },
      participation: {
        activeDays: activeDays.length, firstActiveDay: activeDays[0] || null, lastActiveDay: activeDays[activeDays.length - 1] || null,
        practiceAttempts: attempts.filter(function (row) { return FINAL_RESULTS.has(row.result) && !row.isRepair; }).length,
        repairAttempts: attempts.filter(function (row) { return FINAL_RESULTS.has(row.result) && row.isRepair; }).length,
        benchmarkAttempts: benchmarks.filter(function (row) { return row.status === 'completed' && BENCHMARK_RESULTS.has(row.result); }).length,
        finalPracticeAttempts: attempts.filter(function (row) { return FINAL_RESULTS.has(row.result) && !row.isRepair; }).length,
        completedChecks: benchmarks.filter(function (row) { return row.status === 'completed' && BENCHMARK_RESULTS.has(row.result); }).length
      },
      aggregate: {
        course: summary.course, comprehension: summary.comprehension, production: summary.production,
        hintDependence: summary.hintDependence, baseline: summary.baseline, transfer: summary.transfer,
        retention: summary.retention, baselineToTransfer: summary.baselineToTransfer, baselineToRetention: summary.baselineToRetention,
        openRepairs: summary.openRepairs, missedTransfers: summary.missedTransfers
      },
      units: unitRows
    };
  }
  function pilotReportToCsv(report) {
    function cell(value) {
      if (value == null) return '';
      var string = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return /[",\n\r]/.test(string) ? '"' + string.replace(/"/g, '""') + '"' : string;
    }
    var header = [
      'language','courseId','courseOrder','unitId','measurementKey','qaStatus','languageReviewed',
      'practiceCompleted','practiceTotal','practiceIndependent','practiceAssisted','practiceFailed',
      'baselineStatus','baselineResult','baselineDay',
      'transferStatus','transferResult','transferDay',
      'retentionStatus','retentionResult','retentionDay'
    ];
    var rows = [header];
    (report && report.units || []).forEach(function (unit) {
      rows.push([
        report.language, unit.courseId, unit.sequence, unit.unitId, unit.measurementKey, unit.qaStatus, unit.languageReviewed,
        unit.practice.completedTasks, unit.practice.totalTasks, unit.practice.independent, unit.practice.assisted, unit.practice.failed,
        unit.baseline && unit.baseline.status, unit.baseline && unit.baseline.result, unit.baseline && unit.baseline.dayKey,
        unit.transfer && unit.transfer.status, unit.transfer && unit.transfer.result, unit.transfer && unit.transfer.dayKey,
        unit.retention && unit.retention.status, unit.retention && unit.retention.result, unit.retention && unit.retention.dayKey
      ]);
    });
    return rows.map(function (row) { return row.map(cell).join(','); }).join('\r\n');
  }

  async function getProgressSummary(language) {
    var attempts = (await getAll('learningAttempts')).filter(function (attempt) { return !language || attempt.language === language; });
    var repairs = (await getAll('learningRepairs')).filter(function (repair) { return !language || repair.language === language; });
    var benchmarks = await ensureAllBenchmarks(language);
    benchmarks = await markMissedTransfers(benchmarks, nowMs());
    var summary = summarizeAttempts(attempts);
    summary.repairAttempts = summarizeRepairAttempts(attempts);
    var recentCutoff = nowMs() - 30 * DAY;
    var recentAttempts = attempts.filter(function (attempt) {
      var when = new Date(attempt.submittedAt || attempt.firstSubmittedAt || attempt.startedAt || 0).getTime();
      return Number.isFinite(when) && when >= recentCutoff;
    });
    summary.recent30 = summarizeAttempts(recentAttempts);
    summary.recent30.repairAttempts = summarizeRepairAttempts(recentAttempts);
    summary.recent30.windowDays = 30;
    summary.recent30.fromDayKey = dayKey(recentCutoff);
    summary.openRepairs = repairs.filter(function (repair) { return repair.resolved !== true; }).length;
    summary.resolvedRepairs = repairs.filter(function (repair) { return repair.resolved === true; }).length;
    summary.pendingAttempts = attempts.filter(function (attempt) { return attempt.result === 'pending'; }).length;
    summary.baseline = summarizeBlindedBaselines(benchmarks);
    summary.transfer = summarizeBenchmarks(benchmarks, 'transfer');
    summary.retention = summarizeBenchmarks(benchmarks, 'retention');
    summary.dueBenchmarks = benchmarks.filter(function (row) { return benchmarkIsDue(row, benchmarks, nowMs()); }).length;
    summary.scheduledBenchmarks = benchmarks.filter(function (row) { return row.status === 'scheduled'; }).length;
    summary.completedBenchmarks = benchmarks.filter(function (row) { return row.status === 'completed'; }).length;
    summary.missedTransfers = benchmarks.filter(function (row) { return row.phase === 'transfer' && row.status === 'missed_late'; }).length;
    summary.ineligibleBaselines = benchmarks.filter(function (row) { return row.phase === 'baseline' && row.status === 'not_eligible'; }).length;
    summary.baselineToTransfer = pairedOutcomeSummary(benchmarks, 'transfer');
    summary.baselineToRetention = pairedOutcomeSummary(benchmarks, 'retention');
    summary.pairedOutcomes = summary.baselineToRetention; /* v9.2.2 호환 별칭 */
    summary.course = await courseProgressSummary(language);
    return summary;
  }
  async function clearLearningData() {
    await waitForDb();
    var transaction = db.transaction(REQUIRED_STORES, 'readwrite');
    REQUIRED_STORES.forEach(function (store) { transaction.objectStore(store).clear(); });
    await transactionDone(transaction);
    return true;
  }

  modules.progress = {
    DAY: DAY,
    POST_EXPOSURE_GAP_DAYS: POST_EXPOSURE_GAP_DAYS,
    nowMs: nowMs,
    nowIso: nowIso,
    dayKey: dayKey,
    uid: uid,
    sha256: sha256,
    waitForDb: waitForDb,
    get: get,
    getAll: getAll,
    getAllByIndex: getAllByIndex,
    put: put,
    saveUnit: saveUnit,
    saveUnitPack: saveUnitPack,
    refreshScheduledBenchmarksForUnit: refreshScheduledBenchmarksForUnit,
    listUnits: listUnits,
    attemptsForUnit: attemptsForUnit,
    progressForUnit: progressForUnit,
    benchmarksForUnit: benchmarksForUnit,
    completionForUnit: completionForUnit,
    ensureBenchmarksForUnit: ensureBenchmarksForUnit,
    ensureAllBenchmarks: ensureAllBenchmarks,
    dueBenchmarks: dueBenchmarks,
    benchmarkStateForUnit: benchmarkStateForUnit,
    benchmarkIsDue: benchmarkIsDue,
    markMissedTransfers: markMissedTransfers,
    effectiveBenchmarkDueMs: effectiveBenchmarkDueMs,
    postponeRetentionAfterExposure: postponeRetentionAfterExposure,
    recordFirstSubmission: recordFirstSubmission,
    recordAttempt: recordAttempt,
    recordBenchmarkResult: recordBenchmarkResult,
    dueRepairs: dueRepairs,
    summarizeAttempts: summarizeAttempts,
    summarizeRepairAttempts: summarizeRepairAttempts,
    summarizeBenchmarks: summarizeBenchmarks,
    summarizeBlindedBaselines: summarizeBlindedBaselines,
    pairedOutcomeSummary: pairedOutcomeSummary,
    courseProgressSummary: courseProgressSummary,
    buildPilotReport: buildPilotReport,
    pilotReportToCsv: pilotReportToCsv,
    getProgressSummary: getProgressSummary,
    clearLearningData: clearLearningData
  };
})();
