import { LOGO_ICON } from "./logo";
// HTML for hometohost.com: collection page, one page per home, enquiry page.

export interface Home {
  rec: string; slug: string; name: string; area: string; place: string; outcode: string;
  beds: number | null; baths: number | null; sleeps: number | null; type: string; intro: string;
  body: string[]; highlights: string[]; amenities: string[]; photos: { k: "h" | "d"; u: string }[]; min_nights: number;
}

export const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export const photoUrl = (p: { k: string; u: string }, w = 1200) =>
  p.k === "d" ? `/img/d/${encodeURIComponent(p.u)}?w=${w}` : p.u;

export const where = (h: Pick<Home, "area" | "place">) =>
  h.area === "Outside London" ? h.place || "UK" : h.area === "London" ? "London" : `${h.area} London`;

const half = (x: number) => String(Math.round(x * 2) / 2);
const bedLabel = (b: number) => (b === 0 ? "Studio" : `${half(b)} bedroom${b === 1 ? "" : "s"}`);
export function facts(h: Home) {
  return [
    h.beds != null ? `<span>${bedLabel(h.beds)}</span>` : "",
    h.baths ? `<span>${half(h.baths)} bath${h.baths === 1 ? "" : "s"}</span>` : "",
    h.sleeps ? `<span>Sleeps ${h.sleeps}</span>` : "",
  ].join("");
}

const CSS = `
:root{--navy:#0E1A2B;--navy-2:#1B2A41;--navy-3:#2A3B55;--gold:#C2A06B;--gold-deep:#8A6A35;--ivory:#F5F2EC;--sand:#E9E3D8;--paper:#FFF;--ink:#1A1E26;--muted:#535A66;--line:#DCD5C8;--on-navy:#F5F2EC;--on-navy-muted:#C9C3B6;--display:"Cormorant Garamond","Iowan Old Style",Georgia,serif;--body:"Montserrat","Helvetica Neue",Arial,sans-serif;--wrap:1320px;color-scheme:light}
*{box-sizing:border-box}[hidden]{display:none!important}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--ivory);color:var(--ink);font-family:var(--body);font-size:15px;line-height:1.7}
a{color:inherit}img{max-width:100%;display:block}button,input,select,textarea{font:inherit;color:inherit}:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
.gutter{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}.wrap{max-width:var(--wrap);margin:0 auto}
.eyebrow{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--gold-deep);font-weight:500}.on-dark .eyebrow{color:var(--gold)}
h1,h2,h3{font-family:var(--display);font-weight:400;margin:0;text-wrap:balance;line-height:1.08}
header.mast{background:var(--navy);color:var(--on-navy);position:sticky;top:0;z-index:5}
header.mast .wrap{padding-block:16px;display:flex;flex-wrap:wrap;gap:12px 28px;align-items:center;justify-content:space-between}
.brand{text-decoration:none;display:flex;flex-direction:column;gap:1px}.brand b{font-family:var(--display);font-weight:500;font-size:26px;letter-spacing:.2em}.brand-t>span{font-size:9.5px;letter-spacing:.42em;color:var(--gold)}
nav.top{display:flex;flex-wrap:wrap;gap:6px 26px;align-items:center;font-size:12.5px;letter-spacing:.06em}nav.top a{text-decoration:none;color:var(--on-navy-muted)}nav.top a:hover{color:var(--on-navy)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 24px;border:0;cursor:pointer;text-decoration:none;font-size:11.5px;letter-spacing:.2em;font-weight:600;text-transform:uppercase}
nav.top .btn-gold,.btn-gold{background:var(--gold);color:var(--navy)}.btn-gold:hover{background:#D1B27F}.btn-navy{background:var(--navy);color:var(--on-navy)}.btn-navy:hover{background:var(--navy-2)}
.btn-line{background:transparent;color:var(--navy);border:1px solid var(--navy)}.btn-line:hover{background:var(--navy);color:var(--on-navy)}
.ph{position:relative;overflow:hidden;background:var(--navy-3);aspect-ratio:3/2;max-width:100%}.ph img{width:100%;height:100%;object-fit:cover;transition:transform 1.2s ease}.card:hover .ph img{transform:scale(1.04)}
.hero{background:var(--navy);color:var(--on-navy)}.hero .wrap{padding-block:0 72px}.hero-frame{position:relative;min-height:540px;display:flex;align-items:flex-end;overflow:hidden}
.hero-frame>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.hero-frame::before{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(90deg,rgba(14,26,43,.68) 0%,rgba(14,26,43,0) 65%),linear-gradient(180deg,rgba(14,26,43,0) 30%,rgba(14,26,43,.85) 100%)}
.hero-copy{position:relative;z-index:2;padding:56px clamp(20px,5vw,64px);max-width:800px;display:flex;flex-direction:column;gap:18px}.hero-copy h1{font-size:clamp(42px,6.2vw,78px)}.hero-copy p{margin:0;font-size:16.5px;font-weight:300;color:#E6E1D6;max-width:34em}
.hero2{position:relative;height:100vh;height:100svh;min-height:620px;max-height:1100px;overflow:hidden;background:var(--navy);color:var(--on-navy)}
.hero2 .slide{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity 1.8s ease;transform:scale(1.02)}
.hero2 .slide.on{opacity:1;animation:hth-zoom 9s ease-out forwards}
@keyframes hth-zoom{from{transform:scale(1.02) translate3d(0,0,0)}to{transform:scale(1.14) translate3d(-1.5%,-1%,0)}}
.hero2::before{content:"";position:absolute;inset:0;z-index:1;background:linear-gradient(180deg,rgba(14,26,43,.55) 0%,rgba(14,26,43,0) 26%),linear-gradient(90deg,rgba(14,26,43,.62) 0%,rgba(14,26,43,.1) 60%),linear-gradient(180deg,rgba(14,26,43,0) 45%,rgba(14,26,43,.78) 100%)}
.hero2 .hero-copy{position:absolute;z-index:2;left:0;right:0;bottom:96px;margin:0 auto;max-width:var(--wrap);padding:0 max(16px,env(safe-area-inset-left,0px))}
.hero2 .hero-copy{text-shadow:0 2px 20px rgba(8,14,28,.5)}.hero2 .eyebrow{color:#DCC08F}.hero2 .hero-copy>*{max-width:760px}.hero2 h1{font-size:clamp(44px,7vw,92px)}.hero2 p{margin:0;font-size:17px;font-weight:300;color:#EAE5DA;max-width:34em}
.hero2 .dots{position:absolute;z-index:2;right:max(16px,calc((100vw - var(--wrap))/2));bottom:104px;display:flex;gap:10px}
.hero2 .dots button{width:28px;height:2px;padding:0;border:0;background:rgba(245,242,236,.4);cursor:pointer}.hero2 .dots button[aria-current=true]{background:var(--gold)}
.search-wrap{position:relative;z-index:3;margin-top:-48px}.search-wrap .search{margin:0}
body.home header.mast{position:fixed;left:0;right:0;background:transparent;transition:background .35s ease,box-shadow .35s ease}
body.home header.mast.solid{background:var(--navy);box-shadow:0 6px 24px rgba(8,14,28,.25)}
@media (prefers-reduced-motion:reduce){.hero2 .slide.on{animation:none}.hero2 .slide{transition:none}}
@media (max-width:700px){.hero2 .hero-copy{bottom:84px}.hero2 .dots{display:none}}
.pop{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,14,28,.55);opacity:0;transition:opacity .35s ease}
.pop.open{opacity:1}.pop-card{position:relative;display:flex;width:min(880px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--paper);color:var(--ink);box-shadow:0 30px 80px rgba(8,14,28,.4);transform:translateY(14px);transition:transform .35s ease}
.pop.open .pop-card{transform:none}.pop-text{flex:1 1 380px;padding:clamp(28px,5vw,56px);display:flex;flex-direction:column;gap:18px}
.pop-text h2{font-size:clamp(30px,3.6vw,40px);padding-bottom:18px;border-bottom:1px solid var(--gold)}.pop-text p{margin:0;font-size:14.5px;color:#333A45}
.pop-btns{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px}.pop-img{flex:1 1 400px;min-height:440px;background:var(--navy-3) center/cover no-repeat}
.pop-x{position:absolute;top:14px;left:14px;width:40px;height:40px;border:0;background:transparent;cursor:pointer;font-size:28px;line-height:1;color:var(--ink)}
.pop-text{padding-top:72px}@media (max-width:760px){.pop-img{display:none}}
.band-cta{grid-column:1/-1;background:var(--navy);color:var(--on-navy);padding:clamp(36px,5vw,60px) 24px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px}
.band-cta h3{font-size:clamp(28px,3.4vw,42px);max-width:22em}.band-cta p{margin:0 0 8px;color:var(--gold);font-size:16px}
.brand{color:var(--on-navy);display:flex;align-items:center;gap:14px;flex-direction:row}.brand .logo-i{display:block;height:46px;width:auto;flex:0 0 auto}.brand-t{display:flex;flex-direction:column;gap:1px}@media (max-width:700px){.brand .logo-i{height:38px}}.f-logo{color:var(--on-navy);display:block;width:170px}.f-logo svg{display:block;width:100%;height:auto}
.search{background:var(--paper);color:var(--ink);display:flex;flex-wrap:wrap;margin:-40px clamp(0px,3vw,40px) 0;position:relative;z-index:3;box-shadow:0 24px 60px rgba(8,14,28,.28)}
.search label{flex:1 1 170px;padding:15px 20px;display:flex;flex-direction:column;gap:4px;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.search select,.search input{border:0;background:transparent;font-size:15px;letter-spacing:0;text-transform:none;padding:4px 0;color:var(--ink);min-width:0}
.search .count{flex:1 0 150px;display:flex;align-items:center;justify-content:center;padding:0 22px;background:var(--navy);color:var(--on-navy);font-size:12px;letter-spacing:.16em;text-transform:uppercase;min-height:72px;font-variant-numeric:tabular-nums}.search .count b{color:var(--gold);font-weight:600;margin-right:8px;font-size:16px;letter-spacing:0}
section{padding-block:88px}.sec-head{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:40px}.sec-head h2{font-size:clamp(34px,4.2vw,52px)}.sec-head>div{display:flex;flex-direction:column;gap:12px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:-16px 0 36px}.chips button{min-height:40px;padding:0 16px;border:1px solid #C9C0AE;background:transparent;cursor:pointer;font-size:12.5px;color:var(--ink)}.chips button[aria-pressed=true]{background:var(--navy);color:var(--on-navy);border-color:var(--navy)}.chips button span{color:var(--muted);margin-left:6px}.chips button[aria-pressed=true] span{color:var(--gold)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:44px 28px}.card{text-decoration:none;display:flex;flex-direction:column;gap:14px;color:var(--ink)}
.card-body{display:flex;flex-direction:column;gap:3px}.card-body .area{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold-deep)}.card-body h3{font-size:27px}
.facts{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}.facts span+span::before{content:"·";margin-right:12px;color:#B9B0A0}
.more{display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:56px;color:var(--muted);font-size:13px}.empty{padding:48px 0;color:var(--muted)}
.band{background:var(--sand)}.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:36px}.steps div{border-top:1px solid var(--navy);padding-top:20px;display:flex;flex-direction:column;gap:10px}.steps i{font-style:normal;font-family:var(--display);font-size:40px;color:var(--gold-deep);line-height:1}.steps b{font-weight:500;font-size:17px}.steps p{margin:0;color:var(--muted);font-size:14.5px}
.navy-band{background:var(--navy);color:var(--on-navy)}.split{display:flex;flex-wrap:wrap;gap:56px;align-items:center}.split>*{flex:1 1 420px;min-width:0}.split h2{font-size:clamp(34px,4.2vw,52px);margin:14px 0 18px}.split p{margin:0 0 24px;color:var(--on-navy-muted);font-weight:300;max-width:34em}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--navy-3);border:1px solid var(--navy-3)}.stats div{background:var(--navy);padding:28px;display:flex;flex-direction:column;gap:6px}.stats b{font-family:var(--display);font-weight:400;font-size:44px;color:var(--gold);line-height:1}.stats span{font-size:13px;color:var(--on-navy-muted)}
.crumb{font-size:11.5px;letter-spacing:.2em;text-transform:uppercase;text-decoration:none;color:var(--muted)}.crumb:hover{color:var(--ink)}
.d-head{padding-block:40px 26px;display:flex;flex-wrap:wrap;gap:20px 40px;justify-content:space-between;align-items:flex-end}.d-head>div:first-child{display:flex;flex-direction:column;gap:12px;min-width:0}.d-head h1{font-size:clamp(40px,5.6vw,68px)}
.kf{display:flex;flex-wrap:wrap;gap:28px}.kf div{display:flex;flex-direction:column;gap:2px}.kf small{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted)}.kf b{font-family:var(--display);font-weight:500;font-size:32px;line-height:1.1}
.gallery{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,1fr);gap:10px;align-items:start}.gallery .side{display:grid;gap:10px}.gallery .side button{padding:0;border:0;cursor:pointer;background:none}.gallery .side button[aria-current=true] .ph{outline:2px solid var(--gold);outline-offset:-2px}
.thumbs{display:flex;gap:8px;overflow-x:auto;margin-top:10px}.thumbs button{flex:0 0 120px;padding:0;border:0;cursor:pointer;background:none}.thumbs button[aria-current=true] .ph{outline:2px solid var(--gold);outline-offset:-2px}
@media (max-width:760px){.gallery{grid-template-columns:1fr}.gallery .side{grid-template-columns:repeat(3,minmax(0,1fr))}}
.d-body{display:flex;flex-wrap:wrap;gap:56px;align-items:flex-start;padding-block:52px 96px}.d-main{flex:999 1 520px;min-width:0;display:flex;flex-direction:column;gap:40px}.d-main h2{font-size:34px}.d-main p{margin:0 0 14px;max-width:62ch;color:#333A45}
.block{border-top:1px solid var(--line);padding-top:30px;display:flex;flex-direction:column;gap:18px}.hl-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));gap:12px 28px}.hl-list li{display:flex;gap:12px;align-items:flex-start;font-size:14.5px}.hl-list svg{flex:0 0 auto;margin-top:5px}
.amen{display:flex;flex-wrap:wrap;gap:8px}.amen span{font-size:12.5px;padding:6px 12px;border:1px solid var(--line);background:var(--paper)}
.aside{flex:1 1 320px;position:sticky;top:96px;background:var(--navy);color:var(--on-navy);padding:34px 30px;display:flex;flex-direction:column;gap:16px}.aside h3{font-size:30px}.aside p{margin:0;font-size:13.5px;color:var(--on-navy-muted);font-weight:300}@media (max-width:900px){.aside{position:static}}
.form{background:var(--paper);border:1px solid var(--line);padding:clamp(24px,4vw,48px);display:flex;flex-direction:column;gap:26px}.types{display:flex;flex-wrap:wrap;gap:10px}.types label{min-height:44px;padding:0 18px;border:1px solid #BDB4A3;display:inline-flex;align-items:center;cursor:pointer;font-size:13px}.types input{position:absolute;opacity:0}.types label:has(input:checked){background:var(--navy);border-color:var(--navy);color:var(--on-navy)}.types label:has(input:focus-visible){outline:2px solid var(--gold);outline-offset:3px}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:22px 26px}.field{display:flex;flex-direction:column;gap:6px;font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);min-width:0}
.field input,.field select,.field textarea{border:0;border-bottom:1px solid #BDB4A3;padding:9px 0;font-size:15.5px;letter-spacing:0;text-transform:none;background:transparent;color:var(--ink);border-radius:0;min-width:0}.field textarea{border:1px solid var(--line);padding:12px;background:#FBFAF7;resize:vertical;min-height:110px}
.form-foot{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}.form-foot small{color:var(--muted);max-width:36em;font-size:12.5px}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.thanks{display:flex;flex-direction:column;gap:16px;align-items:flex-start}.thanks h2{font-size:42px}.thanks p{margin:0;color:var(--muted);max-width:40em}.err{color:#9B2C2C}
footer{background:var(--navy);color:var(--on-navy-muted);font-size:13px}footer .wrap{padding-block:56px 36px;display:flex;flex-direction:column;gap:36px}.f-top{display:flex;flex-wrap:wrap;gap:32px;justify-content:space-between}.f-top b{font-family:var(--display);font-weight:500;font-size:24px;letter-spacing:.2em;color:var(--on-navy);display:block;margin-bottom:6px}
.f-cols{display:flex;flex-wrap:wrap;gap:56px;line-height:2}.f-cols div{display:flex;flex-direction:column}.f-cols small{font-size:10.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold);margin-bottom:6px}.f-cols a{text-decoration:none;color:#E3DED2}
.f-base{border-top:1px solid var(--navy-3);padding-top:20px;display:flex;flex-wrap:wrap;gap:10px;justify-content:space-between;font-size:12px}`;

const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8A6A35" stroke-width="2" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>';

export function page(opts: { title: string; description: string; canonical: string; body: string; image?: string; script?: string; bodyClass?: string; popup?: boolean }) {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(opts.title)}</title><meta name="description" content="${esc(opts.description)}"><link rel="canonical" href="${esc(opts.canonical)}">
<meta property="og:title" content="${esc(opts.title)}"><meta property="og:description" content="${esc(opts.description)}"><meta property="og:type" content="website">
${opts.image ? `<meta property="og:image" content="${esc(opts.image)}">` : ""}<meta name="theme-color" content="#0E1A2B"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Montserrat:wght@300;400;500;600&display=swap">
<style>${CSS}</style></head><body${opts.bodyClass ? ` class="${opts.bodyClass}"` : ""}>
<header class="mast gutter"><div class="wrap"><a class="brand" href="/" aria-label="Home to Host, home page">${LOGO_ICON}<span class="brand-t"><b>HOME TO HOST</b><span>PRIVATE STAYS · LONDON &amp; UK</span></span></a>
<nav class="top" aria-label="Main"><a href="/#homes">Our homes</a><a href="/#corporate">Corporate stays</a><a href="/#how">How it works</a><a class="btn btn-gold" href="/enquire">Enquire</a></nav></div></header>
<main>${opts.body}</main>
<footer class="gutter"><div class="wrap"><div class="f-top"><div style="max-width:320px;display:flex;flex-direction:column;gap:16px"><span class="brand f-brand">${LOGO_ICON}<span class="brand-t"><b>HOME TO HOST</b><span>PRIVATE STAYS · LONDON &amp; UK</span></span></span>Private homes and personally hosted stays across London and the UK.</div>
<div class="f-cols"><div><small>Stays</small><a href="/#homes">Our homes</a><a href="/#corporate">Corporate stays</a><a href="/enquire">Enquire</a></div>
<div><small>Contact</small><a href="tel:+442034882323">020 3488 2323</a><a href="mailto:info@hometohost.com">info@hometohost.com</a><span>Out of hours: 07588 098809</span></div></div></div>
<div class="f-base"><span>© ${new Date().getFullYear()} Home to Host Ltd · Company no. 12184608</span><span>hometohost.com</span></div></div></footer>
${opts.popup === false ? "" : POPUP}
${opts.script ? `<script>${opts.script}</script>` : ""}</body></html>`;
}

// ---------- enquiry pop-up (shown once, after a visitor has scrolled for a while) ----------

const POPUP = `<div class="pop" id="pop" role="dialog" aria-modal="true" aria-labelledby="pop-title" hidden>
<div class="pop-card"><button class="pop-x" type="button" aria-label="Close" data-close>&times;</button>
<div class="pop-text"><h2 id="pop-title">Planning a stay in London or further afield?</h2>
<p>From apartments in the heart of the city to family houses with gardens and homes by the sea, our team will find the one that fits your dates, your group and the way you like to stay.</p>
<p>Looking to let your home instead? Speak to our team about having it looked after by Home to Host.</p>
<div class="pop-btns"><a class="btn btn-navy" href="/enquire?type=stay">Find your stay</a><a class="btn btn-line" href="/enquire?type=owner">List your home</a></div></div>
<div class="pop-img" style="background-image:url(/hero/3.jpg)" role="img" aria-label="A period living room with tall bay windows"></div></div></div>
<script>(()=>{const K="hth-pop",el=document.getElementById("pop");let seen=0;try{seen=+localStorage.getItem(K)||0;if(sessionStorage.getItem(K))seen=Date.now()}catch(e){}
if(Date.now()-seen<7*864e5)return;let shown=false,last=null;
const open=()=>{if(shown)return;shown=true;try{localStorage.setItem(K,String(Date.now()));sessionStorage.setItem(K,"1")}catch(e){}
last=document.activeElement;el.hidden=false;requestAnimationFrame(()=>el.classList.add("open"));el.querySelector(".pop-x").focus();cleanup()};
const close=()=>{el.classList.remove("open");setTimeout(()=>{el.hidden=true},350);last&&last.focus&&last.focus()};
el.addEventListener("click",e=>{if(e.target===el||e.target.closest("[data-close]"))close()});
addEventListener("keydown",e=>{if(e.key==="Escape"&&!el.hidden)close()});
const onScroll=()=>{const h=document.documentElement;if(scrollY>Math.min(1400,(h.scrollHeight-innerHeight)*.4))open()};
const onLeave=e=>{if(e.clientY<=0)open()};const timer=setTimeout(open,40000);
const cleanup=()=>{removeEventListener("scroll",onScroll);document.removeEventListener("mouseout",onLeave);clearTimeout(timer)};
setTimeout(()=>{addEventListener("scroll",onScroll,{passive:true});document.addEventListener("mouseout",onLeave)},8000)})();</script>`;

// ---------- collection page ----------

const HERO = [
  { src: "/hero/1.jpg", alt: "A bright open-plan living room with floor-to-ceiling windows and a beamed wooden ceiling" },
  { src: "/hero/2.jpg", alt: "An open-plan kitchen and dining room opening onto a landscaped garden" },
  { src: "/hero/3.jpg", alt: "A period living room with a leather sofa and tall bay windows" },
  { src: "/hero/4.jpg", alt: "A covered swimming pool set in a large garden" },
  { src: "/hero/5.jpg", alt: "A seafront garden with loungers at sunset" },
];

// Crossfading, slowly zooming photos at the top of the home page; header turns solid on scroll.
const HERO_JS = `(()=>{const hdr=document.querySelector("header.mast"),hero=document.getElementById("hero");const solid=()=>hdr.classList.toggle("solid",scrollY>40);addEventListener("scroll",solid,{passive:true});solid();
const S=[...hero.querySelectorAll(".slide")],D=[...hero.querySelectorAll(".dots button")];let i=0,t;
addEventListener("load",()=>S.forEach(s=>{if(s.dataset.src){s.src=s.dataset.src}}));
const show=n=>{if(!S[n].complete||!S[n].src)return;S[i].classList.remove("on");D[i].removeAttribute("aria-current");i=n;void S[i].offsetWidth;S[i].classList.add("on");D[i].setAttribute("aria-current","true")};
const go=()=>{clearInterval(t);t=setInterval(()=>show((i+1)%S.length),6500)};
D.forEach(b=>b.addEventListener("click",()=>{show(+b.dataset.i);go()}));
if(!matchMedia("(prefers-reduced-motion: reduce)").matches)go()})();`;

export function homePage(homes: Home[], site: string) {
  const data = homes.map((h) => ({
    s: h.slug, n: h.name, a: h.area, w: where(h), o: h.outcode, b: h.beds, ba: h.baths, sl: h.sleeps, t: h.type,
    c: h.photos[0] ? photoUrl(h.photos[0], 800) : "",
  }));
  const body = `
<div class="hero2 on-dark" id="hero">
${HERO.map((x, i) => `<img class="slide${i === 0 ? " on" : ""}" ${i === 0 ? `src="${x.src}" fetchpriority="high"` : `data-src="${x.src}"`} alt="${esc(x.alt)}"${i === 0 ? "" : ' aria-hidden="true"'}>`).join("")}
<div class="hero-copy"><span class="eyebrow">London &amp; across the UK</span><h1>Homes across London, and further afield.</h1>
<p>Apartments, townhouses and grand houses by the sea, each prepared and looked after by our own team. Tell us your dates and we'll come back with the homes that fit.</p></div>
<div class="dots" aria-label="Photos">${HERO.map((_, i) => `<button type="button" data-i="${i}" aria-label="Photo ${i + 1}"${i === 0 ? ' aria-current="true"' : ""}></button>`).join("")}</div></div>
<div class="search-wrap gutter"><div class="wrap"><form class="search" id="filters" aria-label="Filter homes" onsubmit="return false">
<label for="f-q">Search<input id="f-q" type="search" placeholder="Street, area or postcode" autocomplete="off"></label>
<label for="f-beds">Bedrooms<select id="f-beds"><option value="0">Any</option><option value="1">1+</option><option value="2">2+</option><option value="3">3+</option><option value="4">4+</option><option value="5">5+</option><option value="6">6+</option></select></label>
<label for="f-guests">Guests<select id="f-guests"><option value="0">Any</option><option value="2">2+</option><option value="4">4+</option><option value="6">6+</option><option value="8">8+</option><option value="10">10+</option><option value="12">12+</option></select></label>
<a class="count" href="/enquire" style="text-decoration:none">Make an enquiry</a></form></div></div>
<section id="homes" class="gutter"><div class="wrap"><div class="sec-head"><div><span class="eyebrow">The collection</span><h2>Every home, prepared by our team</h2></div><a class="btn btn-line" href="/enquire">Ask about a home</a></div>
<div class="chips" id="chips" role="group" aria-label="Area"></div><div class="grid" id="grid"></div>
<p class="empty" id="empty" hidden>No homes match. Try fewer bedrooms or guests, or a different area.</p>
<div class="more" id="more" hidden><span id="more-label"></span><button class="btn btn-line" type="button" id="more-btn">Show more homes</button></div>
<noscript><ul>${homes.map((h) => `<li><a href="/homes/${esc(h.slug)}">${esc(h.name)}, ${esc(where(h))}</a></li>`).join("")}</ul></noscript></div></section>
<section id="how" class="band gutter"><div class="wrap"><div class="sec-head"><div><span class="eyebrow">How an enquiry works</span><h2>One conversation, no booking engine</h2></div></div>
<div class="steps"><div><i>1</i><b>Tell us about your stay</b><p>Dates, guests, area and anything you need, such as parking, pets or a desk for working.</p></div>
<div><i>2</i><b>Get a personal shortlist</b><p>We reply with the homes that suit, honest notes on each and a rate for your dates.</p></div>
<div><i>3</i><b>Confirm directly with us</b><p>Agree the details with the team. We prepare the home and stay in touch until you leave.</p></div></div></div></section>
<section id="corporate" class="navy-band gutter on-dark"><div class="wrap split"><div><span class="eyebrow">Corporate &amp; extended stays</span><h2>A home for the whole assignment.</h2>
<p>Relocations, project teams, insurance placements and long stays. One contact for your booking team, homes prepared to the same standard every time, and straightforward invoicing.</p>
<a class="btn btn-gold" href="/enquire?type=corporate">Corporate enquiry</a></div>
<div class="stats"><div><b>1,000+</b><span>homes across the UK</span></div><div><b>24/7</b><span>guest support line</span></div><div><b>700+</b><span>homes in London</span></div><div><b>Pets</b><span>welcome in our homes</span></div></div></div></section>`;
  const script = HERO_JS + `const H=${JSON.stringify(data).replace(/</g, "\\u003c")};const PAGE=24;let shown=PAGE,area="All";const $=i=>document.getElementById(i);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));const half=x=>String(Math.round(x*2)/2);
const facts=h=>[h.b!=null?"<span>"+(h.b===0?"Studio":half(h.b)+" bedroom"+(h.b===1?"":"s"))+"</span>":"",h.ba?"<span>"+half(h.ba)+" bath"+(h.ba===1?"":"s")+"</span>":"",h.sl?"<span>Sleeps "+h.sl+"</span>":""].join("");
const BAND='<div class="band-cta"><h3>Short on time, booking for a team, or need something specific?</h3><p>Tell us what you\\'re looking for and we\\'ll do the rest.</p><a class="btn btn-gold" href="/enquire">Tell us what you need</a></div>';
const AREAS=["North","East","South","West","Central","Outside London"];
function list(){const q=$("f-q").value.trim().toLowerCase(),b=+$("f-beds").value,g=+$("f-guests").value;return H.filter(h=>(area==="All"||h.a===area)&&(!b||(h.b||0)>=b)&&(!g||(h.sl||0)>=g)&&(!q||(h.n+" "+h.w+" "+h.o+" "+(h.t||"")).toLowerCase().includes(q)))}
function chips(){$("chips").innerHTML=[["All",H.length],...AREAS.map(a=>[a,H.filter(h=>h.a===a).length])].filter(x=>x[1]).map(([k,c])=>'<button type="button" data-a="'+k+'" aria-pressed="'+(k===area)+'">'+(k==="All"||k==="Outside London"?k:k+" London")+"</button>").join("")}
function grid(){const l=list(),cols=getComputedStyle($("grid")).gridTemplateColumns.split(" ").length||3,bandAt=cols*2;$("grid").innerHTML=l.slice(0,shown).map((h,i)=>'<a class="card" href="/homes/'+esc(h.s)+'"><div class="ph">'+(h.c?'<img src="'+esc(h.c)+'" alt="'+esc(h.n)+'" loading="'+(i<6?"eager":"lazy")+'" decoding="async">':"")+'</div><div class="card-body"><span class="area">'+esc(h.w)+(h.o?" · "+esc(h.o):"")+"</span><h3>"+esc(h.n)+'</h3><div class="facts">'+facts(h)+"</div></div></a>"+(i===bandAt-1&&l.length>bandAt+2?BAND:"")).join("");
$("empty").hidden=l.length>0;$("more").hidden=l.length<=shown;$("more-label").textContent=""}
$("filters").addEventListener("input",()=>{shown=PAGE;grid()});$("chips").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;area=b.dataset.a;chips();shown=PAGE;grid()});
$("more-btn").addEventListener("click",()=>{shown+=PAGE;grid()});let rz,lc=0;addEventListener("resize",()=>{clearTimeout(rz);rz=setTimeout(()=>{const c=getComputedStyle($("grid")).gridTemplateColumns.split(" ").length;if(c!==lc){lc=c;grid()}},200)});chips();grid();`;
  return page({
    title: "Home to Host · Private homes in London and across the UK",
    description: `Over 1,000 private homes in London and across the UK, from apartments to large family houses. Enquire for a personal shortlist and rate.`,
    canonical: site + "/", image: site + "/hero.jpg", body, script, bodyClass: "home",
  });
}

// ---------- one home ----------

export function homeDetail(h: Home, site: string) {
  const photos = h.photos.slice(0, 9);
  const main = photos[0];
  const side = photos.slice(1, 4);
  const extra = photos.length > 4 ? photos : [];
  const btn = (p: Home["photos"][number], i: number) =>
    `<button type="button" data-src="${esc(photoUrl(p, 1600))}" aria-label="Show photo ${i + 1}"${i === 0 ? ' aria-current="true"' : ""}><div class="ph"><img src="${esc(photoUrl(p, 500))}" alt="" loading="lazy" decoding="async"></div></button>`;
  const body = `<div class="gutter"><div class="wrap">
<div class="d-head"><div><a class="crumb" href="/#homes">← The collection</a><span class="eyebrow">${esc(where(h))}${h.outcode ? " · " + esc(h.outcode) : ""}</span><h1>${esc(h.name)}</h1></div>
<div class="kf">${h.beds != null ? `<div><small>Bedrooms</small><b>${h.beds === 0 ? "Studio" : half(h.beds)}</b></div>` : ""}${h.baths ? `<div><small>Bathrooms</small><b>${half(h.baths)}</b></div>` : ""}${h.sleeps ? `<div><small>Sleeps</small><b>${h.sleeps}</b></div>` : ""}</div></div>
<div class="gallery"${side.length ? "" : ' style="grid-template-columns:1fr"'}><div class="ph"><img id="main-photo" src="${main ? esc(photoUrl(main, 1600)) : ""}" alt="${esc(h.name)}" fetchpriority="high"></div>
${side.length ? `<div class="side">${side.map((p, i) => btn(p, i + 1)).join("")}</div>` : ""}</div>
${extra.length ? `<div class="thumbs" aria-label="More photos">${extra.map((p, i) => btn(p, i)).join("")}</div>` : ""}
<div class="d-body"><div class="d-main"><div style="display:flex;flex-direction:column;gap:14px">${h.intro ? `<h2>${esc(h.intro)}</h2>` : ""}${h.body.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
${h.highlights.length ? `<div class="block"><span class="eyebrow">Highlights</span><ul class="hl-list">${h.highlights.map((x) => `<li>${CHECK}<span>${esc(x)}</span></li>`).join("")}</ul></div>` : ""}
${h.amenities.length ? `<div class="block"><span class="eyebrow">In the home</span><div class="amen">${h.amenities.map((x) => `<span>${esc(x)}</span>`).join("")}</div></div>` : ""}
<div class="block"><span class="eyebrow">Every stay includes</span><ul class="hl-list">${["24/7 guest support", "Professional clean before arrival", "Fresh linen and towels", "Self check-in"].map((x) => `<li>${CHECK}<span>${x}</span></li>`).join("")}</ul></div></div>
<aside class="aside on-dark"><span class="eyebrow">Enquire about this home</span><h3>Rates on enquiry</h3>
<p>Send your dates and we'll confirm availability and a rate for your stay. Nothing is booked until you've agreed it with us.${h.min_nights >= 28 ? " This home is available for stays of 28 nights or more." : ""}</p>
<a class="btn btn-gold" href="/enquire?home=${encodeURIComponent(h.slug)}">Enquire now</a><p>Or call <a href="tel:+442034882323" style="color:var(--on-navy)">020 3488 2323</a></p></aside></div></div></div>`;
  const script = `document.addEventListener("click",e=>{const b=e.target.closest("button[data-src]");if(!b)return;document.getElementById("main-photo").src=b.dataset.src;document.querySelectorAll("button[data-src]").forEach(x=>x.toggleAttribute("aria-current",x.dataset.src===b.dataset.src))});`;
  return page({
    title: `${h.name}, ${where(h)} · Home to Host`,
    description: (h.intro || `${h.name} in ${where(h)}`).slice(0, 155),
    canonical: `${site}/homes/${h.slug}`, image: main ? (main.k === "h" ? main.u : site + photoUrl(main, 1200)) : undefined, body, script,
  });
}

// ---------- enquiry page ----------

export function enquirePage(_homes: unknown[], site: string, preset: { home?: string; type?: string }) {
  const types = [["stay", "A stay"], ["corporate", "Corporate / long stay"], ["owner", "Listing my home"]];
  const pick = types.some((t) => t[0] === preset.type) ? preset.type : "stay";
  const owner = pick === "owner";
  const hide = owner ? " hidden" : "";
  const body = `<section class="gutter"><div class="wrap split" style="align-items:flex-start">
<div style="flex:1 1 320px;display:flex;flex-direction:column;gap:18px"><a class="crumb" href="/#homes">← The collection</a><span class="eyebrow">Enquire</span>
<h1 style="font-size:clamp(42px,5.6vw,66px)" id="e-title">${owner ? "Tell us about your home." : "Tell us about your stay."}</h1>
<p style="margin:0;color:var(--muted);max-width:34em" id="e-lead">${owner ? OWNER_LEAD : STAY_LEAD}</p>
<div style="display:flex;flex-direction:column;gap:14px;border-top:1px solid var(--line);padding-top:22px"><div><div class="eyebrow" style="color:var(--muted)">Call</div><a href="tel:+442034882323" style="font-size:18px;text-decoration:none">020 3488 2323</a></div>
<div><div class="eyebrow" style="color:var(--muted)">Email</div><a href="mailto:info@hometohost.com" style="font-size:18px;text-decoration:none">info@hometohost.com</a></div></div></div>
<div style="flex:999 1 560px;min-width:0"><form class="form" id="enq" method="post" action="/api/enquire" novalidate>
<fieldset style="border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:12px"><legend class="field" style="padding:0;margin-bottom:12px">I'm enquiring about</legend><div class="types">
${types.map(([v, l]) => `<label><input type="radio" name="type" value="${v}"${v === pick ? " checked" : ""}>${l}</label>`).join("")}</div></fieldset>
${preset.home ? `<input type="hidden" name="home" value="${esc(preset.home)}">` : ""}
<div class="fields">
<label class="field stay-only" for="e-guests"${hide}>Guests<select id="e-guests" name="guests"><option>1–2</option><option>3–4</option><option>5–8</option><option>9–12</option><option>13+</option></select></label>
<label class="field stay-only" for="e-in"${hide}>Arrival<input id="e-in" name="arrival" type="date"></label><label class="field stay-only" for="e-out"${hide}>Departure<input id="e-out" name="departure" type="date"></label>
<label class="field" for="e-name">Full name<input id="e-name" name="name" type="text" autocomplete="name" required maxlength="120"></label>
<label class="field" for="e-email">Email<input id="e-email" name="email" type="email" autocomplete="email" required maxlength="200"></label>
<label class="field" for="e-phone">Phone<input id="e-phone" name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
<label class="field" for="e-co">Company (optional)<input id="e-co" name="company" type="text" autocomplete="organization" maxlength="120"></label></div>
<label class="field" for="e-msg"><span id="e-msg-label">${owner ? "About your home" : "Anything we should know?"}</span><textarea id="e-msg" name="message" maxlength="4000" placeholder="${owner ? OWNER_PH : STAY_PH}"></textarea></label>
<div class="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabindex="-1" autocomplete="off"></label></div>
<div class="form-foot"><small id="e-hint">${owner ? OWNER_HINT : STAY_HINT}</small><button class="btn btn-navy" type="submit" id="e-send">Send enquiry</button></div></form>
<div class="form thanks" id="thanks" hidden tabindex="-1"><span class="eyebrow">Received</span><h2>Thank you. We'll be in touch.</h2>
<p id="e-thanks">${owner ? OWNER_THANKS : STAY_THANKS}</p><a class="btn btn-line" href="/#homes">Back to the collection</a></div></div></div></section>`;
  const T = { stay: ["Tell us about your stay.", STAY_LEAD, "Anything we should know?", STAY_PH, STAY_HINT, STAY_THANKS],
    owner: ["Tell us about your home.", OWNER_LEAD, "About your home", OWNER_PH, OWNER_HINT, OWNER_THANKS] };
  const script = `const T=${JSON.stringify(T)};const f=document.getElementById("enq"),hint=document.getElementById("e-hint"),send=document.getElementById("e-send");
function mode(){const o=f.querySelector("input[name=type]:checked")?.value==="owner",t=T[o?"owner":"stay"];document.querySelectorAll(".stay-only").forEach(x=>x.hidden=o);
document.getElementById("e-title").textContent=t[0];document.getElementById("e-lead").textContent=t[1];document.getElementById("e-msg-label").textContent=t[2];document.getElementById("e-msg").placeholder=t[3];hint.textContent=t[4];hint.className="";document.getElementById("e-thanks").textContent=t[5]}
f.addEventListener("change",e=>{if(e.target.name==="type")mode()});
f.addEventListener("submit",async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(f));if(d.type==="owner"){delete d.guests;delete d.arrival;delete d.departure}
if(!String(d.name||"").trim()||!/^\\S+@\\S+\\.\\S+$/.test(String(d.email||"").trim())){hint.textContent="Add your name and a valid email so we can reply.";hint.className="err";return}
send.disabled=true;send.textContent="Sending…";try{const r=await fetch("/api/enquire",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});const j=await r.json().catch(()=>({}));
if(!r.ok)throw new Error(j.error||"Something went wrong");f.hidden=true;const t=document.getElementById("thanks");t.hidden=false;t.focus()}catch(err){hint.textContent=(err.message||"Something went wrong")+". Please try again, or email info@hometohost.com.";hint.className="err";send.disabled=false;send.textContent="Send enquiry"}});`;
  return page({ title: "Enquire · Home to Host", description: "Tell us about your stay, or about a home you'd like us to look after, and we'll reply personally.", canonical: site + "/enquire", body, script, popup: false });
}

const STAY_LEAD = "There's no instant booking. Send a few details and someone from our team will reply personally with suitable homes, availability and a rate.";
const OWNER_LEAD = "Thinking about letting your home with us? Send a few details and someone from our team will be in touch to talk it through.";
const STAY_PH = "Area, parking, pets, workspace, accessibility…";
const OWNER_PH = "Address or postcode, number of bedrooms, and anything else you'd like us to know…";
const STAY_HINT = "Sending this doesn't book anything. It starts a conversation with our team.";
const OWNER_HINT = "Sending this doesn't commit you to anything. It starts a conversation with our team.";
const STAY_THANKS = "Someone from our team will reply personally with availability and a rate. If your stay is urgent, call us on 020 3488 2323.";
const OWNER_THANKS = "Someone from our team will be in touch to talk about your home. You can also call us on 020 3488 2323.";

export function notFoundPage(site: string) {
  return page({ title: "Not found · Home to Host", description: "This page isn't available.", canonical: site + "/",
    body: `<section class="gutter"><div class="wrap" style="display:flex;flex-direction:column;gap:18px;align-items:flex-start"><span class="eyebrow">Not found</span><h1 style="font-size:52px">This home isn't available any more.</h1><p style="margin:0;color:var(--muted)">It may have been taken off the website. Browse the collection or tell us what you need.</p><div style="display:flex;gap:12px;flex-wrap:wrap"><a class="btn btn-navy" href="/#homes">See the collection</a><a class="btn btn-line" href="/enquire">Make an enquiry</a></div></div></section>` });
}
