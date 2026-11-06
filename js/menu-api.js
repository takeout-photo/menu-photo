/* ============================================================
   menu-api.js — 메뉴 조회 앱 API 클라이언트
   이 파일에는 회사명·식당명·사업장 코드를 넣지 않는다(계획서 §3④).
   필요한 값은 전부 비공개 저장소의 config.json 에서 받아 쓴다:
     { origin, busiCd, compCd, store, name, no }
   ============================================================ */
(function (global) {
  'use strict';

  var MEALS = [
    { cd: 1, key: 'breakfast', label: '조식', icon: '🌅' },
    { cd: 2, key: 'lunch', label: '중식', icon: '☀️' },
    { cd: 3, key: 'dinner', label: '석식', icon: '🌙' }
  ];

  function mealLabel(cd) {
    var m = MEALS.filter(function (x) { return x.cd === Number(cd); })[0];
    return m ? m.label : String(cd);
  }

  /* 로컬 기준 YYYY-MM-DD. toISOString() 은 UTC 라 날짜가 밀린다 */
  function dateStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function shiftDate(s, days) {
    var p = s.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + days);
    return dateStr(d);
  }

  /* 현재 시각에 맞는 기본 끼니 */
  function currentMeal() {
    var m = new Date().getHours() * 60 + new Date().getMinutes();
    if (m >= 410 && m < 660) return 1;
    if (m >= 660 && m < 931) return 2;
    if (m >= 931 && m <= 1140) return 3;
    return 2;
  }

  /* 대상 판별 — 계획서 §1-2.
     [수제] 는 mainNm 과 itemNmDp 중 한쪽에만 있는 경우가 많다(실측 141건 중 22건).
     반드시 두 필드의 합집합으로 본다. 앞 공백이 붙는 항목이 있어 trim 필수. */
  function isTakeOut(it) {
    return /^take ?out/i.test(String(it.cnrNm || '').trim());
  }
  function isHandmade(it) {
    return /\[수제\]/.test(String(it.mainNm || '') + ' ' + String(it.itemNmDp || ''));
  }

  function cleanName(s) {
    return String(s || '').replace(/^\s*\*?품절\s*/, '').trim();
  }

  function isSoldOut(it) {
    var n = String(it.mainNm || '');
    return it.soldOutYn === 'Y' || /^\s*\*품절/.test(n) || /\(품절\)/.test(n);
  }

  /* 사진 슬롯 키 — {mealCd}_{cnrCd}_{itemCd}.
     같은 itemCd 가 다른 코너에 중복 등장하므로 cnrCd 를 넣는다(실측 확인). ASCII 만 들어간다 */
  function slotId(it, mealCd) {
    return [mealCd, it.cnrCd || 'NA', it.itemCd || 'NA'].join('_').replace(/[^A-Za-z0-9_]/g, '');
  }

  /* 식당 1곳 · 끼니 1개. storCd 에 여러 식당을 넘기면 응답이 잘리므로 항상 단일 코드 */
  async function fetchSlots(cfg, date, mealCd) {
    var p = new URLSearchParams({
      itemFg: '', packFg: '', today: new Date().toUTCString(),
      saleDt: date, listType: 'card', orderType: 'new',
      mealCd: String(mealCd),
      busiCd: cfg.busiCd, compCd: cfg.compCd, storCd: cfg.store
    });
    var res = await fetch(cfg.origin + '/v2/portal/dailyMenu?' + p.toString(), {
      headers: { 'Accept': 'application/json, text/plain, */*' },
      referrerPolicy: 'no-referrer'   // Referer 가 붙으면 404 로 차단된다
    });
    if (!res.ok) throw new Error('메뉴 조회 실패 (' + res.status + ')');
    var j = await res.json();
    var list = Array.isArray(j) ? j : (j.ds || j.data || j.result || j.list || j.items || []);

    return list.filter(function (it) {
      return isTakeOut(it) && isHandmade(it);
    }).map(function (it) {
      var f = it.fileUpload || null;
      var full = f && f.savePath ? cfg.origin + f.savePath : null;
      var thumb = f && f.thumbPath ? cfg.origin + f.thumbPath : full;
      return {
        slotId: slotId(it, mealCd),
        meal: Number(mealCd),
        store: cfg.store,
        name: cleanName(it.mainNm) || cleanName(it.itemNmDp),
        nameDp: cleanName(it.itemNmDp),
        corner: String(it.cnrNm || '').trim(),
        appPhoto: full,
        appThumb: thumb,
        soldOut: isSoldOut(it),
        kcal: Number(it.totCalorie || it.calorie || 0) || null
      };
    });
  }

  /* 한 식당의 하루치(3끼니). 호출 3회 */
  async function fetchDay(cfg, date) {
    var parts = await Promise.all(MEALS.map(function (m) {
      return fetchSlots(cfg, date, m.cd).catch(function () { return []; });
    }));
    return parts.reduce(function (a, b) { return a.concat(b); }, []);
  }

  global.MENU = {
    MEALS: MEALS, mealLabel: mealLabel,
    dateStr: dateStr, shiftDate: shiftDate, currentMeal: currentMeal,
    fetchSlots: fetchSlots, fetchDay: fetchDay, slotId: slotId
  };
})(window);
