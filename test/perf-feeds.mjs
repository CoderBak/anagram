// test/perf-feeds.mjs — two long feed sessions for the performance budgets
// (test/pw/perf.spec.mjs), built to do to a page what an hour on X or Reddit does.
//
// X-LIKE: a virtualized timeline. Cells are absolutely positioned with translateY and
// measured after they render; cells more than two screens above or three below the view
// are removed, the next ten posts are appended as the end comes near, and a cell that
// grows (a card or a picture arriving) moves every cell under it — a style change on each.
// Every second the counters of the posts on screen tick, every five seconds every
// timestamp in the DOM is rewritten and the "new posts" pill counts up. Most posts are
// short, one in seven is a long one.
//
// REDDIT-LIKE: shreddit's shape. Each post is a custom element with an open shadow root
// of slots and its text in the light DOM; the next batch of 25 replaces a lazy partial at
// the end as it comes near, and nothing is ever removed, so the DOM grows for as long as
// the session lasts. Every second the scores of the posts on screen tick, every five
// seconds every "time ago" in the DOM is rewritten (thousands of text nodes in one burst,
// late in a session), and a post entering the view has its class changed.
//
// window.__feed.posts() says how many posts have been rendered, window.__feed.live() how
// many are in the DOM now. Nothing here waits on a network: the page is self-contained.

const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time because every station clock had been wrong in the same direction for years".split(" ");

const COMMON = `
const VOCAB=${JSON.stringify(VOCAB)};
const words=(seed,n)=>{const out=[];for(let i=0;i<n;i++)out.push(VOCAB[(seed*37+i*11+((seed*i)%7))%VOCAB.length]);return out.join(" ");};
const sentences=(seed,n)=>{let out="",i=0;while(i<n){const k=Math.min(n-i,9+((seed+i)%9));const s=words(seed*131+i,k);out+=s[0].toUpperCase()+s.slice(1)+". ";i+=k;}return out.trim();};
const count=(n)=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e4?Math.round(n/1e3)+"K":n>=1e3?(n/1e3).toFixed(1)+"K":String(n);
const inView=(el)=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight;};
`;

/** The X-like timeline. */
export const X_FEED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home / X-like</title>
<style>
body{margin:0;font:15px/1.4 system-ui;background:#fff;color:#0f1419}
header{position:sticky;top:0;z-index:2;background:rgba(255,255,255,.9);border-bottom:1px solid #eee;height:53px;display:flex;align-items:center;justify-content:center}
#pill{font-size:13px;background:#1d9bf0;color:#fff;border-radius:16px;padding:4px 12px}
main{display:flex;justify-content:center}
nav{width:260px;padding:12px}nav a{display:block;padding:10px;font-size:19px;color:#0f1419;text-decoration:none}
section{width:600px;border-left:1px solid #eee;border-right:1px solid #eee}
#timeline{position:relative}
[data-testid=cellInnerDiv]{position:absolute;left:0;right:0}
article{padding:12px 16px;border-bottom:1px solid #eee;display:flex;gap:12px}
.avatar{width:40px;height:40px;border-radius:50%;background:#ccd6dd;flex:none}
.body{flex:1;min-width:0}.who{font-size:15px}.who span{color:#536471}
[data-testid=tweetText]{white-space:pre-wrap;word-wrap:break-word;margin:2px 0 10px}
.media{border:1px solid #cfd9de;border-radius:16px;background:#f7f9f9;height:0;overflow:hidden}
[role=group]{display:flex;justify-content:space-between;max-width:425px;color:#536471;font-size:13px}
aside{width:350px;padding:12px}aside p{font-size:14px;color:#536471}
</style></head><body>
<header><div id="pill">Show 0 posts</div></header>
<main>
<nav><a href="/home">Home</a><a href="/explore">Explore</a><a href="/notifications">Notifications</a><a href="/messages">Messages</a><a href="/profile">Profile</a></nav>
<section aria-label="Timeline: Your Home Timeline"><div id="timeline"></div></section>
<aside><h2>What's happening</h2><p>Trending in your area</p><p>Sports · Trending</p><p>Technology · Trending</p></aside>
</main>
<script>
${COMMON}
const timeline=document.getElementById("timeline");
const cells=[]; // {i, el, top, height} in order; el null once virtualized away
let seq=0, bottom=0, pill=0, minute=0;
function tweet(i){
  const long=i%7===0;
  const n=long?90+(i%5)*35:10+(i*13)%38;
  const cell=document.createElement("div");
  cell.setAttribute("data-testid","cellInnerDiv");
  cell.innerHTML='<article data-testid="tweet" role="article" tabindex="0"><div class="avatar"></div><div class="body">'+
    '<div class="who"><a href="/user'+i+'"><b>Author '+i+'</b></a> <span>@user'+i+' · <time datetime="2026-09-27T10:00:00Z">'+(1+i%50)+'m</time></span></div>'+
    '<div data-testid="tweetText" lang="en"><span>'+sentences(i,n)+'</span></div>'+
    '<div class="media"></div>'+
    '<div role="group" aria-label="actions"><span data-c="reply">'+count(i*7%300)+'</span><span data-c="repost">'+count(i*13%900)+'</span><span data-c="like">'+count(i*97%20000)+'</span><span data-c="views">'+count(i*1301%900000)+'</span></div>'+
    '</div></article>';
  return cell;
}
function place(from){
  // X measures a cell after it renders and moves every cell under it to fit.
  let top=from===0?0:cells[from-1].top+cells[from-1].height;
  for(let k=from;k<cells.length;k++){
    const c=cells[k];
    if(c.el){c.height=c.el.offsetHeight;const t="translateY("+top+"px)";if(c.el.style.transform!==t)c.el.style.transform=t;}
    c.top=top;top+=c.height;
  }
  bottom=top;timeline.style.height=bottom+"px";
}
function append(n){
  const from=cells.length;
  for(let k=0;k<n;k++){const i=seq++;const el=tweet(i);timeline.appendChild(el);cells.push({i,el,top:0,height:0});}
  place(from);
}
function virtualize(){
  const lo=scrollY-2*innerHeight, hi=scrollY+3*innerHeight;
  for(const c of cells){
    const keep=c.top+c.height>lo&&c.top<hi;
    if(!keep&&c.el){c.el.remove();c.el=null;}
    else if(keep&&!c.el){c.el=tweet(c.i);c.el.style.transform="translateY("+c.top+"px)";timeline.appendChild(c.el);}
  }
  if(bottom-(scrollY+innerHeight)<2*innerHeight)append(10);
}
append(20);
addEventListener("scroll",()=>requestAnimationFrame(virtualize),{passive:true});
setInterval(()=>{ // counters on screen
  for(const c of cells){if(!c.el||!inView(c.el))continue;
    for(const s of c.el.querySelectorAll("[data-c=like],[data-c=views]")){const v=parseInt(s.textContent.replace(/\\D/g,""))||0;s.textContent=count(v+1+(c.i%3));}}
},1000);
setInterval(()=>{ // every timestamp in the DOM, and the pill
  minute++;
  for(const t of timeline.querySelectorAll("time"))t.textContent=(1+minute+(t.closest("[data-testid=cellInnerDiv]")?1:0))+"m";
},5000);
setInterval(()=>{document.getElementById("pill").textContent="Show "+(++pill)+" posts";},2000);
setInterval(()=>{ // a card arrives in a post on screen: it grows, and everything under it moves
  const on=cells.filter((c)=>c.el&&inView(c.el)&&c.el.querySelector(".media").style.height==="");
  const c=on[(minute*7)%Math.max(1,on.length)];if(!c)return;
  c.el.querySelector(".media").style.height="180px";place(cells.indexOf(c));
},3000);
window.__feed={posts:()=>seq,live:()=>timeline.children.length};
</script></body></html>`;

/** The Reddit-like feed. */
export const REDDIT_FEED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reddit-like</title>
<style>
body{margin:0;font:14px/1.5 system-ui;background:#fff;color:#1c1c1c}
header{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #eee;height:56px}
#main-content{max-width:756px;margin:0 auto;padding:8px 16px}
article{display:block;border-radius:16px;margin:4px 0}
article:hover,article.in-view{background:#f6f8f9}
hr{border:0;border-top:1px solid #eee;margin:4px 0}
shreddit-post{display:block;padding:8px 16px}
[slot=title]{display:block;font-size:18px;font-weight:600;color:#1c1c1c;text-decoration:none;margin:4px 0}
.md p{margin:0 0 10px}
faceplate-partial{display:block;height:400px}
</style></head><body>
<header></header>
<shreddit-app><div id="main-content"><shreddit-feed id="feed"></shreddit-feed></div></shreddit-app>
<script>
${COMMON}
customElements.define("shreddit-post",class extends HTMLElement{constructor(){super();
  this.attachShadow({mode:"open"}).innerHTML='<style>:host{display:block}footer{display:flex;gap:8px;align-items:center;color:#576f76;font-size:12px}button{border:0;background:#eee;border-radius:12px;padding:2px 8px}</style>'+
  '<div class="post"><header><slot name="credit-bar"></slot></header><slot name="title"></slot><slot name="text-body"></slot>'+
  '<footer><button aria-label="upvote">▲</button><slot name="score"></slot><button aria-label="downvote">▼</button><slot name="comments"></slot><button>Share</button></footer></div>';}});
customElements.define("faceplate-timeago",class extends HTMLElement{});
customElements.define("faceplate-number",class extends HTMLElement{});
const feed=document.getElementById("feed");
let seq=0, tick=0;
function post(i){
  const text=i%3!==2; // a third are links and pictures: a title and nothing to read
  const paras=text?1+(i%4):0;
  let body="";
  for(let k=0;k<paras;k++)body+="<p>"+sentences(i*5+k,28+((i+k)*17)%70)+"</p>";
  const a=document.createElement("article");
  a.setAttribute("aria-label","Post "+i);
  a.innerHTML='<shreddit-post id="t3_'+i.toString(36)+'" score="'+(i*37%5000)+'" comment-count="'+(i*11%800)+'">'+
    '<span slot="credit-bar"><a href="/r/sub'+(i%40)+'">r/sub'+(i%40)+'</a> · <faceplate-timeago ts="2026-09-27T10:00:00Z"><time>'+(1+i%23)+' hr. ago</time></faceplate-timeago></span>'+
    '<a slot="title" href="/r/sub/comments/'+i.toString(36)+'">'+sentences(i*3+1,6+i%10)+'</a>'+
    (text?'<div slot="text-body"><div class="md">'+body+'</div></div>':'')+
    '<faceplate-number slot="score" number="'+(i*37%5000)+'">'+count(i*37%5000)+'</faceplate-number>'+
    '<a slot="comments" href="/r/sub/comments/'+i.toString(36)+'#comments">'+count(i*11%800)+' comments</a>'+
    '</shreddit-post>';
  return a;
}
function batch(){
  const frag=document.createDocumentFragment();
  for(let k=0;k<25;k++){frag.appendChild(post(seq++));frag.appendChild(document.createElement("hr"));}
  const partial=document.createElement("faceplate-partial");partial.setAttribute("loading","lazy");
  frag.appendChild(partial);
  return {frag,partial};
}
let {frag,partial}=batch();feed.appendChild(frag);
const more=new IntersectionObserver((entries)=>{for(const e of entries){if(!e.isIntersecting)continue;more.unobserve(e.target);
  setTimeout(()=>{const next=batch();e.target.replaceWith(next.frag);more.observe(next.partial);},150);}},{rootMargin:"800px"});
more.observe(partial);
const seen=new IntersectionObserver((entries)=>{for(const e of entries)if(e.isIntersecting)e.target.classList.add("in-view");},{threshold:0.5});
new MutationObserver((records)=>{for(const r of records)for(const n of r.addedNodes)if(n.nodeName==="ARTICLE")seen.observe(n);}).observe(feed,{childList:true});
for(const a of feed.querySelectorAll("article"))seen.observe(a);
setInterval(()=>{ // scores on screen
  for(const n of feed.querySelectorAll("faceplate-number")){if(!inView(n.parentElement))continue;
    const v=Number(n.getAttribute("number"))+1;n.setAttribute("number",v);n.textContent=count(v);}
},1000);
setInterval(()=>{ // every "time ago" in the DOM
  tick++;for(const t of feed.querySelectorAll("faceplate-timeago time"))t.textContent=(1+tick+(t.textContent.length%3))+" hr. ago";
},5000);
window.__feed={posts:()=>seq,live:()=>feed.querySelectorAll("article").length};
</script></body></html>`;

/**
 * Read like somebody on a feed for `seconds`: a steady scroll at reading speed, and every
 * eight seconds a flick of two screens; `pace` scrolls that many times as fast, to reach a
 * long page sooner. `onTick(elapsedMs)` is called about once a second.
 */
export async function scrollSession(page, seconds, { pace = 1, onTick = async () => {} } = {}) {
  const started = Date.now();
  let lastTick = 0;
  while (Date.now() - started < seconds * 1000) {
    const t = Date.now() - started;
    const flick = Math.floor(t / 1000) % 8 === 7;
    await page.evaluate((dy) => window.scrollBy(0, dy), Math.round((flick ? 160 : 18) * pace));
    await page.waitForTimeout(50);
    if (t - lastTick >= 1000) {
      lastTick = t;
      await onTick(t);
    }
  }
}
