/* ============================================================
   photo-io.js — 사진 처리 공통부

   업체 화면(upload.html)과 관리자 화면(index.html)이 같은 규격으로 사진을
   줄이고, 같은 경로에 올리고, 같은 형식의 커밋 메시지를 남겨야 한다.
   이걸 두 파일에 각각 두면 한쪽만 고쳐지는 사고가 난다
   (CLAUDE.md 의 index_portal / hub-embed 사례가 정확히 그 경우다).

   특히 커밋 메시지 형식은 관리자 화면이 업로드 시각을 되살리는 유일한 단서다
   (index.html 의 /^(\S+)\s+(\d{2}:\d{2})/). 여기서만 만든다.
   외부 라이브러리 없음.
   ============================================================ */
(function (global) {
  'use strict';

  var MAX_EDGE = 1280;   // 긴 변
  var JPEG_Q = 0.8;      // → 약 150KB

  /* EXIF 회전을 반영해 비트맵을 얻는다. createImageBitmap 미지원 브라우저는 <img> 로 우회 */
  async function loadBitmap(file) {
    if (global.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) {
        try { return await createImageBitmap(file); } catch (e2) { /* 아래로 */ }
      }
    }
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), im = new Image();
      im.onload = function () { res(im); setTimeout(function () { URL.revokeObjectURL(u); }, 0); };
      im.onerror = function () { URL.revokeObjectURL(u); rej(new Error('이미지를 읽지 못했습니다')); };
      im.src = u;
    });
  }

  /* 긴 변 1280px, JPEG 0.8. 촬영한 사진은 same-origin 이라 canvas 제약이 없다
     (앱 등록 사진은 ACAO 가 없어 canvas 로 못 굽는다 — 계획서 §1-1) */
  async function shrink(file) {
    var src = await loadBitmap(file);
    var w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
    if (!w0 || !h0) throw new Error('이미지 크기를 알 수 없습니다');
    var k = Math.min(1, MAX_EDGE / Math.max(w0, h0));
    var w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
    var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d', { alpha: false }).drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    var blob = await new Promise(function (r) { cv.toBlob(r, 'image/jpeg', JPEG_Q); });
    if (!blob) throw new Error('이미지 변환에 실패했습니다');
    return blob;
  }

  function hhmmNow() {
    var d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function photoPath(dateStr, slotId) { return 'photos/' + dateStr + '/' + slotId + '.jpg'; }

  /* 업로드 커밋 메시지 — "slotId HH:MM | 메뉴명". 관리자 화면이 이 앞부분을 읽어
     업로드 시각을 복원하므로 앞의 두 토큰 순서를 바꾸면 안 된다.
     by 를 주면 뒤에만 덧붙는다(관리자가 대신 올린 건지 로그로 구분하기 위함) */
  function uploadMsg(slotId, name, by) {
    return slotId + ' ' + hhmmNow() + ' | ' + (name || '') + (by ? ' · ' + by : '');
  }

  /* 삭제 커밋 메시지 — 일부러 slotId 로 시작하지 않는다.
     "slotId HH:MM" 꼴로 시작하면 관리자 화면이 삭제 커밋을 업로드 시각으로 읽는다 */
  function deleteMsg(slotId, name, by) {
    return '사진 삭제 ' + slotId + (name ? ' | ' + name : '') + (by ? ' · ' + by : '');
  }

  /* 올리기 실패 문구.
     사내 프록시는 본문 50KB 이상인 요청을 막는다. 사진은 base64 로 1.37배가 되어
     150KB 사진이 약 205KB 본문이 된다 → 회사망에서는 반드시 막힌다.
     차단 응답에는 ACAO 가 없어 상태코드도 본문도 못 읽는다 → network 플래그로만 구분된다 */
  /* 권한 때문에 막힌 403 인가. GH 가 아직 안 올라왔으면(스크립트 순서 사고)
     권한 쪽으로 본다 — 쓸 수 없는 키에 "기다리면 된다" 고 안내하는 쪽이 더 나쁘다 */
  function denied(e) {
    return !(global.GH && GH.isDenied) || GH.isDenied(e);
  }

  function uploadErrText(e, opt) {
    opt = opt || {};
    if (e && e.network) {
      return '사진을 올리지 못했습니다.\n\n'
        + '회사 망(사내 WiFi · 사내 유선)에서는 사진이 올라가지 않습니다.\n'
        + (opt.admin
            ? 'PC 가 사내망에 있으면 막히니, 폰을 모바일 데이터(LTE)로 바꿔 올리거나\n'
              + '폰 테더링으로 연결한 뒤 다시 눌러 주세요.\n'
            : '폰의 WiFi 를 끄고 모바일 데이터(LTE)로 바꾼 뒤 다시 눌러 주세요.\n')
        + '지금까지 올라간 사진은 그대로 남아 있습니다.';
    }
    if (e && e.status === 401) {
      return opt.admin
        ? '키가 만료됐거나 올바르지 않습니다. 새 키로 다시 로그인해 주세요.'
        : '업로드 키가 만료된 것 같습니다. 담당자에게 새 키를 받아주세요.';
    }
    if (e && e.status === 403) {
      if (!denied(e)) {
        return '요청이 잠시 몰렸습니다. 10분쯤 뒤에 다시 눌러 주세요.\n'
          + '지금까지 올라간 사진은 그대로 남아 있습니다.';
      }
      return '이 키로는 사진을 올릴 수 없습니다(조회 전용).\n담당자에게 문의하세요.';
    }
    return '업로드에 실패했습니다. 잠시 후 다시 시도해 주세요.\n(' + ((e && e.message) || '알 수 없는 오류') + ')';
  }

  /* 지우기 실패 문구. 삭제 요청의 본문은 100바이트 남짓이라 프록시 50KB 한도에
     걸리지 않는다 → 회사망에서도 삭제는 된다. 그래서 network 안내가 올리기와 다르다 */
  function deleteErrText(e) {
    if (e && e.network) {
      return '사진을 지우지 못했습니다. 네트워크에서 요청이 막혔습니다.\n'
        + '잠시 후 다시 시도해 주세요. 사진은 그대로 남아 있습니다.';
    }
    if (e && e.status === 403) {
      if (!denied(e)) return '요청이 잠시 몰렸습니다. 10분쯤 뒤에 다시 눌러 주세요.';
      return '이 키로는 사진을 지울 수 없습니다(조회 전용).\n담당자에게 문의하세요.';
    }
    if (e && e.status === 401) {
      return '키가 만료됐거나 올바르지 않습니다. 다시 로그인해 주세요.';
    }
    return '삭제에 실패했습니다. 잠시 후 다시 시도해 주세요.\n(' + ((e && e.message) || '알 수 없는 오류') + ')';
  }

  /* ---------- 확대 보기 ----------
     비교 화면의 사진은 1:1 로 잘라 보여준다(object-fit:cover). 가장자리가 잘려서
     "같은 메뉴인가" 는 봐도 "구성과 양이 같은가" 는 잘 안 보인다. 눌러서 크게 본다.
     앱 사진은 화면에 거는 게 썸네일이라, 확대할 때 원본(savePath)으로 바꿔 받는다.
     원본은 CORS 헤더가 없어 canvas 로는 못 읽지만 <img> 표시는 된다(계획서 §1-1).
     사진에 tabindex 는 걸지 않는다 — 하루 141장이면 탭 순회가 282번 늘어 키보드 이동이 망가진다 */
  var zEl = null, zPrev = null;

  function zBuild() {
    var el = document.createElement('div');
    el.className = 'zoom no-print';
    el.hidden = true;
    el.innerHTML =
      '<div class="zoom-bd"></div>' +
      '<figure class="zoom-fig">' +
        '<div class="zoom-ph">' +
          '<img alt="" referrerpolicy="no-referrer">' +
          '<span class="zoom-spin" hidden></span>' +
        '</div>' +
        '<figcaption><b></b><span></span></figcaption>' +
      '</figure>' +
      '<button type="button" class="zoom-x" aria-label="닫기">&times;</button>';
    /* 사진 자체를 누른 건 더 보려는 동작이라 닫지 않는다. 바깥과 × 는 닫는다 */
    el.addEventListener('click', function (ev) {
      if (!ev.target.closest('.zoom-ph')) closeZoom();
    });
    document.addEventListener('keydown', function (ev) {
      if (zEl && !zEl.hidden && ev.key === 'Escape') { ev.preventDefault(); closeZoom(); }
    });
    document.body.appendChild(el);
    return el;
  }

  function closeZoom() {
    if (!zEl || zEl.hidden) return;
    zEl.hidden = true;
    zEl.dataset.want = '';
    zEl.querySelector('img').removeAttribute('src');   // blob 을 붙잡고 있지 않게
    document.documentElement.style.overflow = '';
    if (zPrev && zPrev.focus) { try { zPrev.focus(); } catch (e) {} }
    zPrev = null;
  }

  /* opt: { src 지금 보여줄 주소(이미 받아둔 썸네일·blob),
            full 원본(없으면 생략), caption 메뉴명, sub 보조설명 } */
  function zoom(opt) {
    opt = opt || {};
    var src = opt.src || opt.full;
    if (!src) return;
    if (!zEl) zEl = zBuild();
    var img = zEl.querySelector('img'), spin = zEl.querySelector('.zoom-spin');
    zEl.querySelector('figcaption b').textContent = opt.caption || '';
    zEl.querySelector('figcaption span').textContent = opt.sub || '';
    img.src = src;
    zPrev = document.activeElement;
    zEl.hidden = false;
    document.documentElement.style.overflow = 'hidden';   // 뒷면이 같이 스크롤되지 않게
    zEl.querySelector('.zoom-x').focus();

    /* 썸네일을 먼저 띄우고 원본을 받아 바꿔 끼운다 — 빈 화면을 보여주지 않으려고.
       받는 사이에 다른 사진을 열 수 있으니 want 로 마지막 요청만 반영한다 */
    var want = (opt.full && opt.full !== src) ? opt.full : '';
    zEl.dataset.want = want;
    spin.hidden = !want;
    if (!want) return;
    var pre = new Image();
    pre.referrerPolicy = 'no-referrer';
    pre.onload = function () {
      if (zEl.hidden || zEl.dataset.want !== want) return;
      spin.hidden = true; img.src = want;
    };
    pre.onerror = function () {        // 원본이 없거나 못 받으면 썸네일 그대로 둔다
      if (zEl.dataset.want === want) spin.hidden = true;
    };
    pre.src = want;
  }

  /* <img data-zoom="원본주소" data-zcap="제목" data-zsub="설명"> 을 눌렀을 때.
     실물 사진은 지연 로딩이라 src 가 아직 안 붙었을 수 있다 — 그때는 열지 않는다 */
  function zoomImg(img) {
    if (!img) return;
    var src = img.currentSrc || img.getAttribute('src') || '';
    if (!src) return;
    zoom({ src: src, full: img.getAttribute('data-zoom') || '',
           caption: img.getAttribute('data-zcap') || '', sub: img.getAttribute('data-zsub') || '' });
  }

  /* ---------- 1:1 자르기 ----------
     카드도 리포트도 사진을 1:1 로 잘라 보여준다(.ph 는 object-fit:cover,
     리포트는 height:30mm 고정). 폰 사진은 4:3·3:4 라 긴 쪽이 잘리는데,
     어디가 잘릴지는 올리고 나서야 안다. 그래서 올린 뒤 고치는 자리를 둔다.

     비율 선택지는 두지 않는다 — 4:3 으로 잘라도 카드에서 다시 잘려
     "고른 대로 안 나오는" 메뉴가 된다. 고르는 건 '꽉 채우기 / 전체 담기' 와
     위치·배율뿐이고, 화면에 보이는 네모가 그대로 저장된다. */
  var CROP_EDGE = 1080;   // 저장 한 변의 상한. 1280 긴 변과 화소 수가 비슷해 용량도 비슷하다
  var cEl = null, cS = null, cPrev = null;

  /* 회전을 반영한 '화면에 놓이는' 원본 크기 */
  function cEff() {
    var r = cS.rot % 180 !== 0;
    return { w: r ? cS.ih : cS.iw, h: r ? cS.iw : cS.ih };
  }

  /* min = 사진 전체가 네모 안에 들어가는 배율, cover = 네모를 빈틈없이 채우는 배율 */
  function cBase() {
    var e = cEff();
    return { min: Math.min(cS.S / e.w, cS.S / e.h), cover: Math.max(cS.S / e.w, cS.S / e.h) };
  }

  function cClampScale(s) {
    var b = cBase();
    return Math.min(b.min * 8, Math.max(b.min, s));
  }

  /* 네모보다 큰 축은 빈틈이 생기지 않게 가두고, 작은 축은 가운데로 붙인다.
     '전체 담기' 에서 사진이 네모보다 작아지면 이 규칙이 저절로 가운데 정렬이 된다 */
  function cClamp() {
    var e = cEff(), ew = e.w * cS.scale, eh = e.h * cS.scale;
    var mx = Math.max(0, (ew - cS.S) / 2), my = Math.max(0, (eh - cS.S) / 2);
    cS.tx = Math.min(mx, Math.max(-mx, cS.tx));
    cS.ty = Math.min(my, Math.max(-my, cS.ty));
  }

  /* 미리보기와 저장본이 같은 그림이 되도록 한 함수로 그린다. size 만 다르다.
     '전체 담기' 의 여백은 흰색 — 카드 배경과 인쇄 양쪽에서 가장 덜 튄다 */
  function cPaint(ctx, size) {
    var k = size / cS.S;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.translate(size / 2 + cS.tx * k, size / 2 + cS.ty * k);
    ctx.rotate(cS.rot * Math.PI / 180);
    ctx.scale(cS.scale * k, cS.scale * k);
    ctx.drawImage(cS.img, -cS.iw / 2, -cS.ih / 2, cS.iw, cS.ih);
    ctx.restore();
  }

  function cDraw() {
    var cv = cEl.querySelector('canvas');
    cPaint(cv.getContext('2d', { alpha: false }), cv.width);
    var atMin = cS.scale <= cBase().min * 1.001;
    cEl.querySelectorAll('[data-fit]').forEach(function (x) {
      x.classList.toggle('on', (x.getAttribute('data-fit') === 'contain') === atMin);
    });
  }

  function cFit(mode) {
    var b = cBase();
    cS.scale = (mode === 'contain') ? b.min : b.cover;
    cS.tx = 0; cS.ty = 0;
    cClamp(); cDraw();
  }

  function cZoom(f) {
    cS.scale = cClampScale(cS.scale * f);
    cClamp(); cDraw();
  }

  /* 네모 한 변에 들어온 원본 화소 수를 넘겨 키우지 않는다 — 늘려봐야 흐려지기만 하고
     용량만 는다. 꽉 채운 4:3 사진이면 대개 짧은 변(960px)이 그대로 한 변이 된다 */
  function cBake() {
    var size = Math.max(480, Math.min(CROP_EDGE, Math.round(cS.S / cS.scale)));
    var out = document.createElement('canvas');
    out.width = size; out.height = size;
    cPaint(out.getContext('2d', { alpha: false }), size);
    return new Promise(function (r) { out.toBlob(r, 'image/jpeg', JPEG_Q); });
  }

  function cClose(blob) {
    if (!cS) return;
    var r = cS.resolve, img = cS.img;
    cS = null;
    cEl.hidden = true;
    document.documentElement.style.overflow = '';
    if (img && img.close) img.close();
    if (cPrev && cPrev.focus) { try { cPrev.focus(); } catch (e) {} }
    cPrev = null;
    r(blob || null);
  }

  /* 한 손가락은 이동, 두 손가락은 확대·축소. 마우스는 끌기 + 휠.
     Pointer Events 하나로 둘 다 받는다 — touch 와 mouse 를 따로 달면
     폰에서 같은 동작이 두 번 들어온다 */
  function cBindDrag(cv) {
    var pts = {}, st = null;
    function count() { var n = 0, k; for (k in pts) n++; return n; }
    cv.addEventListener('pointerdown', function (ev) {
      if (!cS) return;
      try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
      pts[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      st = null;
    });
    cv.addEventListener('pointermove', function (ev) {
      if (!cS || !pts[ev.pointerId]) return;
      ev.preventDefault();
      pts[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
      var ids = [], k;
      for (k in pts) ids.push(k);
      if (count() >= 2) {
        var a = pts[ids[0]], b = pts[ids[1]];
        var d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (!st || st.n !== 2) { st = { n: 2, d: d, mx: mx, my: my, s: cS.scale, tx: cS.tx, ty: cS.ty }; return; }
        cS.scale = cClampScale(st.s * (d / st.d));
        cS.tx = st.tx + (mx - st.mx);
        cS.ty = st.ty + (my - st.my);
      } else {
        var p = pts[ids[0]];
        if (!st || st.n !== 1) { st = { n: 1, x: p.x, y: p.y, tx: cS.tx, ty: cS.ty }; return; }
        cS.tx = st.tx + (p.x - st.x);
        cS.ty = st.ty + (p.y - st.y);
      }
      cClamp(); cDraw();
    });
    function up(ev) { delete pts[ev.pointerId]; st = null; }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
  }

  function cBuild() {
    var el = document.createElement('div');
    el.className = 'crop no-print';
    el.hidden = true;
    el.innerHTML =
      '<div class="crop-bd"></div>' +
      '<div class="crop-box" role="dialog" aria-modal="true" aria-label="사진 맞추기">' +
        '<div class="crop-hd"><b>사진 맞추기</b><span class="crop-cap"></span></div>' +
        '<div class="crop-stage"><canvas></canvas><div class="crop-grid"></div></div>' +
        '<p class="crop-tip">끌어서 위치를, 두 손가락(또는 휠)으로 크기를 맞춥니다. ' +
          '네모 안에 보이는 그대로 저장됩니다.</p>' +
        '<div class="crop-tools">' +
          '<button type="button" data-fit="cover">꽉 채우기</button>' +
          '<button type="button" data-fit="contain">전체 담기</button>' +
          '<button type="button" data-rot>90° 회전</button>' +
          '<button type="button" data-z="1" aria-label="확대">＋</button>' +
          '<button type="button" data-z="-1" aria-label="축소">－</button>' +
        '</div>' +
        '<div class="crop-act">' +
          '<button type="button" data-cancel>취소</button>' +
          '<button type="button" class="primary" data-ok>이대로 올리기</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);

    el.addEventListener('click', function (ev) {
      if (!cS) return;
      var b = ev.target.closest ? ev.target.closest('button') : null;
      if (!b) {
        /* 바깥을 누르면 덮는다. 취소해도 올라가 있는 사진은 그대로라 잃는 게 없다 */
        if (!ev.target.closest('.crop-box')) cClose(null);
        return;
      }
      if (b.hasAttribute('data-cancel')) { cClose(null); return; }
      if (b.hasAttribute('data-ok')) {
        if (cS.busy) return;
        cS.busy = true;
        b.textContent = '만드는 중…';
        cBake().then(function (blob) { cClose(blob); b.textContent = '이대로 올리기'; });
        return;
      }
      if (b.hasAttribute('data-rot')) { cS.rot = (cS.rot + 90) % 360; cFit('cover'); return; }
      if (b.hasAttribute('data-fit')) { cFit(b.getAttribute('data-fit')); return; }
      if (b.hasAttribute('data-z')) { cZoom(Number(b.getAttribute('data-z')) > 0 ? 1.25 : 1 / 1.25); return; }
    });
    document.addEventListener('keydown', function (ev) {
      if (cEl && !cEl.hidden && ev.key === 'Escape') { ev.preventDefault(); cClose(null); }
    });
    var cv = el.querySelector('canvas');
    cv.addEventListener('wheel', function (ev) {
      if (!cS) return;
      ev.preventDefault();
      cZoom(Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });
    cBindDrag(cv);
    return el;
  }

  /* src: File·Blob 또는 주소(이미 받아둔 blob: URL).
     돌려주는 건 잘라 구운 JPEG blob, 취소하면 null.
     주소를 주면 blob 으로 받아 loadBitmap 을 태운다 — EXIF 회전 처리를 한 곳에 둔다 */
  async function crop(src, opt) {
    opt = opt || {};
    var blob = (typeof src === 'string') ? await (await fetch(src)).blob() : src;
    var img = await loadBitmap(blob);
    var iw = img.width || img.naturalWidth, ih = img.height || img.naturalHeight;
    if (!iw || !ih) throw new Error('이미지 크기를 알 수 없습니다');

    if (!cEl) cEl = cBuild();
    cEl.querySelector('.crop-cap').textContent = opt.caption || '';
    cPrev = document.activeElement;
    cEl.hidden = false;
    document.documentElement.style.overflow = 'hidden';   // 뒷면이 같이 스크롤되지 않게

    /* 무대 크기는 열고 나서 재야 한다 — hidden 인 동안은 폭이 0 이다 */
    var S = Math.round(cEl.querySelector('.crop-stage').clientWidth) || 320;
    var cv = cEl.querySelector('canvas');
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    cv.width = Math.round(S * dpr); cv.height = Math.round(S * dpr);
    cv.style.width = S + 'px'; cv.style.height = S + 'px';

    return new Promise(function (res) {
      cS = { img: img, iw: iw, ih: ih, S: S, rot: 0, scale: 1, tx: 0, ty: 0, busy: false, resolve: res };
      cFit('cover');
      cEl.querySelector('[data-ok]').focus();
    });
  }

  global.PHOTO = {
    MAX_EDGE: MAX_EDGE, JPEG_Q: JPEG_Q,
    loadBitmap: loadBitmap, shrink: shrink, hhmmNow: hhmmNow,
    photoPath: photoPath, uploadMsg: uploadMsg, deleteMsg: deleteMsg,
    uploadErrText: uploadErrText, deleteErrText: deleteErrText,
    zoom: zoom, zoomImg: zoomImg, closeZoom: closeZoom,
    CROP_EDGE: CROP_EDGE, crop: crop
  };
})(window);
