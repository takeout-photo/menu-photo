/* ============================================================
   chart-kit.js — 의존성 없는 SVG 차트 + KPI/슬라이더 유틸 (dashboard-design-system)
   closure_tool.html 에서 검증된 코드를 그대로 일반화. 외부 라이브러리 사용 금지(사내망 CDN 차단 대비).
   필요한 DOM: <div class="tip" id="tip"></div> (툴팁), 차트 컨테이너 <div class="chart" id="...">
   ============================================================ */
const $=id=>document.getElementById(id);
/* 숫자 표기 규칙: 1,000 이상은 천 단위 쉼표 (예: 2,012). 화면에 숫자를 쓸 때는 항상 num()/pct()를 거친다. ID·코드·연도는 제외 */
const num=(v,d=0)=>Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=x=>num(Math.round(x*100))+'%';
const hhmm=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
/* 상태 색 규칙: 비율(값/한계) 기준. 1 초과=bad, 0.9 이상=warn, 그 외 ok */
const cls=ratio=>ratio>1?'bad':ratio>=0.9?'warn':'ok';
let CHARTS={};

/* KPI 카드 1장: 제목 1줄 · 큰 숫자 1줄 · 보조 2줄 (모든 카드가 같은 구조여야 높이가 같다). t 는 HTML 가능(title 툴팁용 span) */
const kpi=(t,v,d1,d2,c)=>`<div class="kpi"><div class="t">${t}</div><div class="v ${c}">${v}</div><div class="d">${d1}</div><div class="d">${d2}</div></div>`;

/* 슬라이더 채움(--p) 갱신: 값이 바뀔 때마다 호출 (theme.css 의 input[type=range] 가 --p 를 사용) */
function paintRanges(){
  document.querySelectorAll('input[type=range]').forEach(r=>r.style.setProperty('--p',((r.value-r.min)/(r.max-r.min)*100)+'%'));
}

/* ---------- 라인 차트 (시간축) ----------
   o = { m0: 시작 분(예: 660=11:00), lo, hi: 표시 구간(분 오프셋), yMax, unit:'%'|'명'..,
         series:[{n:'이름', c:'#색', d:배열}], hl:[{y, c, l:'라벨'}] (가로 기준선, 점선),
         band:{low:배열, up:배열} (선택: 범위 음영) }                                   */
function lineChart(id,o){
  const W=560,H=210,L=40,Rr=10,T=10,B=24;
  const X=t=>L+(t-o.lo)/(o.hi-o.lo||1)*(W-L-Rr), Y=v=>T+(1-v/o.yMax)*(H-T-B);
  let s=`<svg viewBox="0 0 ${W} ${H}" width="100%">`;
  const step=o.yMax>150?50:o.yMax>60?20:o.yMax>25?10:5;
  for(let v=0;v<=o.yMax;v+=step) s+=`<line x1="${L}" x2="${W-Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eceff3"/><text x="${L-5}" y="${Y(v)+4}" text-anchor="end" font-size="10" fill="#6b7280">${num(v)}</text>`;
  for(let t=Math.ceil((o.m0+o.lo)/15)*15;t<=o.m0+o.hi;t+=15){const x=X(t-o.m0);
    s+=`<line x1="${x}" x2="${x}" y1="${H-B}" y2="${H-B+4}" stroke="#9aa3b2"/><text x="${x}" y="${H-8}" text-anchor="middle" font-size="10" fill="#6b7280">${hhmm(t)}</text>`;}
  for(const h of (o.hl||[])) s+=`<line x1="${L}" x2="${W-Rr}" y1="${Y(h.y)}" y2="${Y(h.y)}" stroke="${h.c}" stroke-dasharray="5 3"/><text x="${L+4}" y="${Y(h.y)-3}" font-size="10" fill="${h.c}">${h.l}</text>`;
  if(o.band){let p='';
    for(let t=o.lo;t<=o.hi;t++) p+=(t===o.lo?'M':'L')+X(t).toFixed(1)+','+Y(o.band.up[t]).toFixed(1);
    for(let t=o.hi;t>=o.lo;t--) p+='L'+X(t).toFixed(1)+','+Y(o.band.low[t]).toFixed(1);
    s+=`<path d="${p}Z" fill="#e45756" fill-opacity=".22" stroke="none"/>`;}
  for(const se of o.series){let p='';for(let t=o.lo;t<=o.hi;t++) p+=(t===o.lo?'M':'L')+X(t).toFixed(1)+','+Y(se.d[t]).toFixed(1);
    s+=`<path d="${p}" fill="none" stroke="${se.c}" stroke-width="2"/>`;}
  s+=`<line id="${id}v" y1="${T}" y2="${H-B}" stroke="#888" visibility="hidden"/><rect id="${id}r" x="${L}" y="${T}" width="${W-L-Rr}" height="${H-T-B}" fill="transparent"/></svg>`;
  $(id).innerHTML=s; CHARTS[id]={o,X,W,L,Rr};
  const rect=$(id+'r'); rect.onmousemove=e=>{
    const svg=rect.ownerSVGElement, r=svg.getBoundingClientRect(), px=(e.clientX-r.left)/r.width*W;
    const t=Math.max(o.lo,Math.min(o.hi,Math.round(o.lo+(px-L)/(W-L-Rr)*(o.hi-o.lo))));
    const v=$(id+'v'); v.setAttribute('x1',X(t));v.setAttribute('x2',X(t));v.setAttribute('visibility','visible');
    const tip=$('tip'); tip.style.display='block'; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px';
    tip.textContent=hhmm(o.m0+t)+'\n'+o.series.map(se=>`${se.n}: ${num(se.d[t],o.unit==='%'?0:1)}${o.unit}`).join('\n')
      +(o.band?`\n범위(낙관~비관): ${num(o.band.low[t],1)}~${num(o.band.up[t],1)}${o.unit}`:'');};
  rect.onmouseleave=()=>{$('tip').style.display='none';$(id+'v').setAttribute('visibility','hidden');};
}

/* ---------- 가로 막대 차트 (항목별 전/후 비교) ----------
   rows = [{label, b: 이전 비율(0~), s: 이후 비율, flag: true 면 라벨 앞에 빨간 ● (예: 포화 의심)}], 100% 기준선 표시 */
function barChart(id,rows){
  const W=560,rowH=26,L=190,T=8,H=T+rows.length*rowH+22, mx=Math.max(1.2,...rows.map(l=>l.s))*1.05;
  const X=v=>L+v/mx*(W-L-95);
  let s=`<svg viewBox="0 0 ${W} ${H}" width="100%">`;
  rows.forEach((l,i)=>{const y=T+i*rowH, lab=l.label.length>22?l.label.slice(0,21)+'…':l.label;
    s+=`<text x="${L-6}" y="${y+16}" text-anchor="end" font-size="11" fill="#3b4252">${l.flag?'<tspan fill="#e45756">● </tspan>':''}${lab}</text>
      <rect x="${L}" y="${y+3}" width="${X(l.b)-L}" height="8" fill="#4c78a8"/>
      <rect x="${L}" y="${y+12}" width="${X(l.s)-L}" height="8" fill="${l.s>1?'#e45756':'#e9a09f'}"/>
      <text x="${X(l.s)+4}" y="${y+20}" font-size="10" fill="${l.s>1?'#d6453d':'#6b7280'}">${pct(l.b)} → ${pct(l.s)}</text>`;});
  s+=`<line x1="${X(1)}" x2="${X(1)}" y1="${T}" y2="${H-18}" stroke="#444" stroke-dasharray="4 3"/><text x="${X(1)}" y="${H-5}" text-anchor="middle" font-size="10" fill="#444">100%</text></svg>`;
  $(id).innerHTML=s;
}
