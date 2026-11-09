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

  global.PHOTO = {
    MAX_EDGE: MAX_EDGE, JPEG_Q: JPEG_Q,
    loadBitmap: loadBitmap, shrink: shrink, hhmmNow: hhmmNow,
    photoPath: photoPath, uploadMsg: uploadMsg, deleteMsg: deleteMsg,
    uploadErrText: uploadErrText, deleteErrText: deleteErrText,
    zoom: zoom, zoomImg: zoomImg, closeZoom: closeZoom
  };
})(window);
