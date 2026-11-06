/* ============================================================
   github-api.js — GitHub REST 단일 창구
   설계 근거(계획서 §2-1):
   1) PUT /contents 는 매번 브랜치 ref 를 전진시킨다. 같은 저장소에 동시 PUT 하면
      두 번째가 409 Conflict 를 받는다. 레이트리밋이 아니라 git 구조 문제라
      재시도 튜닝으로 해결되지 않는다 → 모든 쓰기는 직렬 큐로 1초 간격.
   2) DELETE /contents 도 커밋을 만든다(시간당 500건 content-creating 한도를
      전 계정이 공유). 일괄 삭제는 Git Data API 로 커밋 1개에 처리한다.
   3) credentials:'include' 금지 — ACAO:* 와 충돌해 브라우저가 막는다.
      커스텀 헤더도 추가 금지 — 프리플라이트가 실패한다.
   외부 라이브러리 없음.
   ============================================================ */
(function (global) {
  'use strict';

  var API = 'https://api.github.com';
  var WRITE_GAP_MS = 1000;   // 쓰기 간 최소 간격
  var MAX_TRIES = 4;

  var TOKEN = null;
  var RATE = { remaining: null, limit: null, reset: null };

  /* ---------- 공통 ---------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function HttpError(status, payload, res) {
    var e = new Error('GitHub ' + status + ': ' + ((payload && payload.message) || ''));
    e.name = 'HttpError';
    e.status = status;
    e.payload = payload;
    e.res = res;
    return e;
  }

  /* 네트워크 단에서 끊긴 요청. 사내 프록시가 업로드(본문 50KB 이상)를 막는 경우가 대표적이다.
     프록시의 차단 응답에는 Access-Control-Allow-Origin 이 없어 브라우저가 CORS 단계에서
     거부한다 → 상태코드도 본문(policy_denied)도 JS 로는 못 읽는다. 호출자가 권한 오류와
     구분할 수 있도록 여기서 network 플래그를 달아 던진다 */
  function NetError(cause) {
    var e = new Error('네트워크에서 요청이 막혔거나 끊겼습니다');
    e.name = 'NetworkError';
    e.network = true;
    e.cause = cause;
    return e;
  }

  /* 경로의 각 구간만 인코딩한다. encodeURIComponent 를 통째로 쓰면 '/' 가 %2F 가 되어 깨진다 */
  function encPath(p) {
    return String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
  }

  function readRate(res) {
    var rem = res.headers.get('X-RateLimit-Remaining');
    if (rem !== null) {
      RATE.remaining = Number(rem);
      RATE.limit = Number(res.headers.get('X-RateLimit-Limit'));
      RATE.reset = Number(res.headers.get('X-RateLimit-Reset'));
    }
  }

  /* 단일 요청. accept 를 바꾸면 raw 바이트도 받을 수 있다 */
  async function raw(path, opt) {
    opt = opt || {};
    var url = path.indexOf('http') === 0 ? path : API + path;
    var h = { 'Accept': opt.accept || 'application/vnd.github+json' };
    if (TOKEN) h['Authorization'] = 'Bearer ' + TOKEN;
    if (opt.body !== undefined && opt.body !== null) h['Content-Type'] = 'application/json';

    var res;
    try {
      res = await fetch(url, {
        method: opt.method || 'GET',
        headers: h,
        /* GitHub API 응답은 Cache-Control: private, max-age=60 을 달고 온다.
           그대로 두면 ref 를 옮긴 직후에도 브라우저가 60초간 예전 sha 를
           돌려준다 → 그 sha 를 부모로 커밋을 만들면 ref 갱신이 422
           'Update is not a fast forward' 로 거절된다(poc 7번 실패 원인).
           사진도 캐시에 안 남아 공용 기기 측면에서도 유리하다 */
        cache: 'no-store',
        body: (opt.body === undefined || opt.body === null) ? null : JSON.stringify(opt.body)
        // credentials 는 기본값(same-origin) 그대로 둔다 — include 로 바꾸면 ACAO:* 와 충돌한다
      });
    } catch (e) {
      throw NetError(e);   // 끊김·프록시 차단. isRetryable 은 status 를 보므로 재시도하지 않는다
    }
    readRate(res);
    return res;
  }

  async function req(path, opt) {
    var res = await raw(path, opt);
    if (res.status === 204) return null;
    if (!res.ok) {
      var payload = null;
      try { payload = await res.json(); } catch (e) {
        try { payload = { message: await res.text() }; } catch (e2) { payload = null; }
      }
      throw HttpError(res.status, payload, res);
    }
    return res.json();
  }

  /* 403 은 레이트리밋과 권한 부족에 함께 쓰인다. 권한 부족은 몇 번을 다시 걸어도
     같은 답이라, 전부 재시도하면 14초를 버리고 사용자는 "왜 이렇게 느리지" 만 겪는다.
     레이트리밋 신호(Retry-After / 잔여 0 / 메시지)가 있을 때만 다시 건다 */
  function isRetryable(e) {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
    if (e.status !== 403) return false;
    var ra = e.res && e.res.headers.get('Retry-After');
    var rem = e.res && e.res.headers.get('X-RateLimit-Remaining');
    var m = String((e.payload && e.payload.message) || '').toLowerCase();
    return !!ra || rem === '0' ||
      m.indexOf('rate limit') >= 0 || m.indexOf('abuse') >= 0 || m.indexOf('try again') >= 0;
  }

  /* 일시 오류 재시도. Retry-After 를 우선 존중한다 */
  async function withRetry(fn) {
    var delay = 2000;
    for (var i = 0; i < MAX_TRIES; i++) {
      try { return await fn(); }
      catch (e) {
        if (!isRetryable(e) || i === MAX_TRIES - 1) throw e;
        var ra = e.res && Number(e.res.headers.get('Retry-After'));
        await sleep(ra > 0 ? ra * 1000 : delay);
        delay *= 2;
      }
    }
  }

  /* 읽기 전용 재시도. 쓰기용 withRetry 와 같은 정책이지만 직렬 큐를 타지 않는다.
     읽기에 재시도가 없으면 일시적인 500 하나로 마감 전체가 중단된다 */
  function rd(fn) { return withRetry(fn); }

  /* 쓰기 직렬 큐 — 동시 PUT 으로 인한 409 를 원천 차단한다 */
  var tail = Promise.resolve();
  var lastWrite = 0;
  function serial(fn) {
    var run = tail.then(async function () {
      var wait = WRITE_GAP_MS - (Date.now() - lastWrite);
      if (wait > 0) await sleep(wait);
      try { return await fn(); }
      finally { lastWrite = Date.now(); }
    });
    tail = run.catch(function () { });
    return run;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
      fr.onerror = function () { reject(fr.error || new Error('읽기 실패')); };
      fr.readAsDataURL(blob);
    });
  }

  /* ---------- 계정 / 저장소 ---------- */

  function setToken(t) { TOKEN = t ? String(t).trim() : null; }
  function hasToken() { return !!TOKEN; }
  function rate() { return { remaining: RATE.remaining, limit: RATE.limit, reset: RATE.reset }; }

  function me() { return rd(function(){ return req('/user'); }); }

  /* fine-grained PAT 은 선택된 저장소만 돌려준다 → 이게 곧 권한 범위다 */
  function myRepos() {
    return rd(async function () {
      var out = [], page = 1;
      while (page <= 5) {
        var batch = await req('/user/repos?per_page=100&affiliation=owner,collaborator&page=' + page);
        if (!batch || !batch.length) break;
        out = out.concat(batch);
        if (batch.length < 100) break;
        page++;
      }
      return out;
    });
  }

  function repoInfo(full) { return rd(function(){ return req('/repos/' + full); }); }

  /* ---------- 읽기 ---------- */

  /* 파일 메타(sha 포함). 없으면 null */
  function statFile(full, path) {
    return rd(async function () {
      var res = await raw('/repos/' + full + '/contents/' + encPath(path));
      if (res.status === 404) return null;
      if (!res.ok) throw HttpError(res.status, null, res);
      return res.json();
    });
  }

  /* 텍스트 파일. base64 를 거치지 않고 raw 로 받는다 */
  function getText(full, path) {
    return rd(async function () {
      var res = await raw('/repos/' + full + '/contents/' + encPath(path), { accept: 'application/vnd.github.raw' });
      if (res.status === 404) return null;
      if (!res.ok) throw HttpError(res.status, null, res);
      return res.text();
    });
  }

  async function getJson(full, path) {
    var t = await getText(full, path);
    if (t === null) return null;
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /* 이미지. base64(1.37배 부풀림) 대신 raw → Blob → objectURL.
     쓴 쪽에서 반드시 URL.revokeObjectURL 로 해제할 것 */
  function getObjectUrl(full, path) {
    return rd(async function () {
      var res = await raw('/repos/' + full + '/contents/' + encPath(path), { accept: 'application/vnd.github.raw' });
      if (res.status === 404) return null;
      if (!res.ok) throw HttpError(res.status, null, res);
      var blob = await res.blob();
      return URL.createObjectURL(blob);
    });
  }

  /* 디렉터리 목록. 없으면 [] (GET /contents 는 최대 1,000개) */
  function listDir(full, path) {
    return rd(async function () {
      var res = await raw('/repos/' + full + '/contents/' + encPath(path));
      if (res.status === 404) return [];
      if (!res.ok) throw HttpError(res.status, null, res);
      var j = await res.json();
      return Array.isArray(j) ? j : [];
    });
  }

  /* 저장소 전체 트리 (일괄 삭제 대상 수집용) */
  function tree(full, branch) {
    return rd(async function () {
      var ref = await req('/repos/' + full + '/git/ref/heads/' + encodeURIComponent(branch));
      var commit = await req('/repos/' + full + '/git/commits/' + ref.object.sha);
      var t = await req('/repos/' + full + '/git/trees/' + commit.tree.sha + '?recursive=1');
      return { headSha: ref.object.sha, treeSha: commit.tree.sha, entries: t.tree || [], truncated: !!t.truncated };
    });
  }

  /* 최근 커밋 (업로드 시각 복원용) */
  function commits(full, params) {
    var qs = new URLSearchParams(params || {}).toString();
    return rd(function () {
      return req('/repos/' + full + '/commits' + (qs ? '?' + qs : ''));
    });
  }

  /* ---------- 쓰기 ---------- */

  /* 파일 1개 업로드. 신규면 요청 1회, 덮어쓰기면 sha 조회 후 1회 더.
     409(ref 전진) 는 큐가 막아주지만, 다른 기기와 겹칠 수 있어 한 번 더 받아낸다 */
  function putFile(full, path, blob, message) {
    return serial(function () {
      return withRetry(async function () {
        var b64 = await blobToBase64(blob);
        var body = { message: message || ('upload ' + path), content: b64 };
        var res = await raw('/repos/' + full + '/contents/' + encPath(path), { method: 'PUT', body: body });

        /* 이미 있는 파일이면 sha 를 요구한다(422), ref 가 움직였으면 409 */
        if (res.status === 422 || res.status === 409) {
          var cur = await statFile(full, path);
          if (cur && cur.sha) body.sha = cur.sha;
          res = await raw('/repos/' + full + '/contents/' + encPath(path), { method: 'PUT', body: body });
        }
        if (!res.ok) {
          var payload = null; try { payload = await res.json(); } catch (e) { }
          throw HttpError(res.status, payload, res);
        }
        return res.json();
      });
    });
  }

  function putJson(full, path, obj, message) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    return putFile(full, path, blob, message);
  }

  /* ---------- Git Data 일괄 커밋 ----------
     삭제 141건을 DELETE 141콜로 하면 시간당 content-creating 한도(500)를 먹는다.
     base_tree 를 둔 트리에서 sha:null 인 항목은 삭제를 뜻한다 → 커밋 1개로 끝낸다. */
  /* ref → commit → tree → commit → ref 는 원자적이지 않다. head 를 읽은 뒤
     누가 끼어들면(협력사 사진 업로드, 직전 이력 축소 후 ref 전파 지연)
     마지막 PATCH 가 422 'Update is not a fast forward' 로 거절된다.
     force 로 밀면 그 사이에 들어온 사진 커밋이 사라지므로, head 를 다시 읽어
     처음부터 다시 쌓는다. 마감은 협력사가 올리는 중에도 돌아갈 수 있다 */
  function isNotFastForward(e) {
    if (!e || e.status !== 422) return false;
    var m = String((e.payload && e.payload.message) || e.message || '').toLowerCase();
    return m.indexOf('fast forward') >= 0 || m.indexOf('fast-forward') >= 0;
  }

  function batchCommit(full, opt) {
    opt = opt || {};
    var branch = opt.branch || 'main';
    var deletePaths = opt.deletePaths || [];
    var message = opt.message || 'batch update';
    if (!deletePaths.length) return Promise.resolve(null);

    return serial(function () {
      return withRetry(async function () {
        var last = null;
        for (var attempt = 0; attempt < 3; attempt++) {
          var ref = await req('/repos/' + full + '/git/ref/heads/' + encodeURIComponent(branch));
          var head = ref.object.sha;
          var commit = await req('/repos/' + full + '/git/commits/' + head);

          var entries = deletePaths.map(function (p) {
            return { path: p, mode: '100644', type: 'blob', sha: null };
          });

          var newTree = await req('/repos/' + full + '/git/trees', {
            method: 'POST',
            body: { base_tree: commit.tree.sha, tree: entries }
          });
          var newCommit = await req('/repos/' + full + '/git/commits', {
            method: 'POST',
            body: { message: message, tree: newTree.sha, parents: [head] }
          });
          try {
            await req('/repos/' + full + '/git/refs/heads/' + encodeURIComponent(branch), {
              method: 'PATCH',
              body: { sha: newCommit.sha }
            });
            return newCommit;
          } catch (e) {
            if (!isNotFastForward(e)) throw e;   // force 는 쓰지 않는다
            last = e;
            await sleep(1000 * (attempt + 1) * (attempt + 1));   // 1s, 4s — 진짜 동시 쓰기까지 기다린다
          }
        }
        throw last;
      });
    });
  }

  /* 히스토리 축소 — 부모 없는 커밋으로 ref 를 강제 갱신한다.
     주의: 도달 불가 객체는 한동안 SHA 로 꺼낼 수 있다. 확실한 폐기는 저장소 재생성뿐(계획서 §3①) */
  function collapseHistory(full, opt) {
    opt = opt || {};
    var branch = opt.branch || 'main';
    var message = opt.message || 'reset history';
    return serial(function () {
      return withRetry(async function () {
        var ref = await req('/repos/' + full + '/git/ref/heads/' + encodeURIComponent(branch));
        var commit = await req('/repos/' + full + '/git/commits/' + ref.object.sha);
        var fresh = await req('/repos/' + full + '/git/commits', {
          method: 'POST',
          body: { message: message, tree: commit.tree.sha, parents: [] }
        });
        await req('/repos/' + full + '/git/refs/heads/' + encodeURIComponent(branch), {
          method: 'PATCH',
          body: { sha: fresh.sha, force: true }
        });
        return fresh;
      });
    });
  }

  global.GH = {
    setToken: setToken, hasToken: hasToken, rate: rate,
    me: me, myRepos: myRepos, repoInfo: repoInfo,
    statFile: statFile, getText: getText, getJson: getJson,
    getObjectUrl: getObjectUrl, listDir: listDir, tree: tree, commits: commits,
    putFile: putFile, putJson: putJson,
    batchCommit: batchCommit, collapseHistory: collapseHistory,
    _req: req, _raw: raw
  };
})(window);
