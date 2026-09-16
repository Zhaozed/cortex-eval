/** Surface/phase replay v2. Isolated production viewer host: no business bridge, no screenshot or payload persistence. */
export const livePreviewHost = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,"><link rel="stylesheet" href="/static/a2ui_viewer.css">
<link rel="stylesheet" href="/static/a2ui_catalog.css">
<style>html,body{margin:0;height:100%;background:#17191d;color:#eee;overflow:hidden}
.a2ui-panel{padding:0}.a2ui-stage{height:100%}#error{padding:16px;font:14px sans-serif}</style>
</head><body><section class="a2ui-panel" id="panel"><div class="a2ui-stage" id="surface"></div></section>
<div id="error" hidden>卡片渲染失败，请重新加载。</div>
<script src="/static/a2ui/a2ui_viewer_message_groups.js"></script>
<script src="/static/a2ui/a2ui_viewer_runtime_host.js"></script>
<script src="/static/a2ui_viewer.js"></script><script>
(() => {
  const parentOrigin = new URLSearchParams(location.search).get('parent');
  if (!['http://127.0.0.1:4310','http://localhost:4310'].includes(parentOrigin)) return;
  const scrollbarCss='*{scrollbar-width:thin;scrollbar-color:#d6dfe680 transparent}*::-webkit-scrollbar{width:5px;height:5px}*::-webkit-scrollbar-track{background:transparent}*::-webkit-scrollbar-thumb{background:#d6dfe680;border-radius:8px}';
  const softenScrollbars=doc=>{const style=doc.createElement('style');style.textContent=scrollbarCss;doc.head.appendChild(style);};
  softenScrollbars(document);
  let viewer, received=false, failed=false, token='', frame, checks=0, timer, lastState='', pendingPayloads=[], submitted=false;
  const reasons={RESOURCE:'卡片依赖资源加载失败',RUNTIME:'卡片运行时异常',POLICY:'卡片资源被安全策略拦截',ANIMATION:'卡片动画渲染失败',EMPTY:'未渲染出可见卡片',TIMEOUT:'卡片渲染超时',PAYLOAD:'卡片数据无法被渲染器识别'};
  const notify = (state,code) => { if(state===lastState) return; lastState=state; parent.postMessage({type:'cortex-eval-preview',token,state,...(code?{code}: {})},parentOrigin); };
  const fail = (code='RUNTIME') => { failed=true; clearTimeout(timer); notify('ERROR',code); const error=document.getElementById('error'); error.textContent=reasons[code]||reasons.RUNTIME; error.hidden=false; };
  const runtimeError=event=>fail(event.target && event.target!==event.currentTarget ? 'RESOURCE' : 'RUNTIME');
  // Browser sandbox/CSP enforce isolation. These guards additionally prevent link navigation.
  const blockLinks = doc => doc.addEventListener('click',event=>{
    if(event.target instanceof doc.defaultView.Element && event.target.closest('a')) event.preventDefault();
  },true);
  blockLinks(document); window.open=()=>null;
  window.addEventListener('error',runtimeError,true);
  window.addEventListener('unhandledrejection',()=>fail('RUNTIME'));
  const check = async () => {
    if(failed) return;
    checks++;
    frame=document.querySelector('iframe');
    const doc=frame && frame.contentDocument;
    if(doc && frame.dataset.runtimeReady==='true') {
      if(!doc.documentElement.dataset.evalGuarded) {
        doc.documentElement.dataset.evalGuarded='true'; blockLinks(doc); softenScrollbars(doc);
        frame.contentWindow.open=()=>null;
        frame.contentWindow.addEventListener('error',runtimeError,true);
        frame.contentWindow.addEventListener('unhandledrejection',()=>fail('RUNTIME'));
        doc.addEventListener('securitypolicyviolation',()=>fail('POLICY'));
        const originalError=frame.contentWindow.console.error;
        frame.contentWindow.console.error=(...args)=>{
          originalError.apply(frame.contentWindow.console,args);
          if(typeof args[0]==='string' && args[0].includes('[surfaceLifecycle] processMessages failed')) fail('RUNTIME');
        };
      }
      if(!submitted) {
        submitted=true;
        try {
          // Submit the selected replay once, not repeatedly replay the growing prefix.
          const messages=pendingPayloads.flatMap(p=>Array.isArray(p.messages)?p.messages:[]);
          if(!viewer.handleAgentResponse({response:{msg_id:'preview',a2ui:{messages}}})) {fail('PAYLOAD');return;}
        } catch {fail('RUNTIME');return;}
      }
      if(failed) return;
      if(doc.querySelector('[data-rive-fallback]')) {fail('ANIMATION');return;}
      const surfaces=[...doc.querySelectorAll('[data-component="SurfaceHost"],[data-component="InfoChip"]')];
      if(surfaces.length && surfaces.every(node=>node.getBoundingClientRect().height>0)) {
        try { await doc.fonts.ready; } catch {fail('RESOURCE');return;}
        if(failed) return;
        const badImage=[...doc.images].some(image=>image.complete && image.naturalWidth===0);
        const badFont=[...doc.fonts].some(font=>font.status==='error');
        if(badImage||badFont) {fail('RESOURCE');return;}
        if([...doc.images].some(image=>!image.complete)) {timer=setTimeout(check,250);return;}
        if(checks>=4) notify('READY');
      } else if(checks>80) {fail('TIMEOUT');return;}
    } else if(checks>80) {fail('TIMEOUT');return;}
    timer=setTimeout(check,250);
  };
  window.addEventListener('message',event=>{
    if(event.source!==parent || event.origin!==parentOrigin || received) return;
    const data=event.data;
    if(!data || data.type!=='cortex-eval-preview-load' || typeof data.token!=='string' || !Array.isArray(data.payloads)) return;
    received=true; token=data.token;
    try {
      viewer=window.CortexA2uiViewer.createA2uiViewer({
        panelEl:document.getElementById('panel'),surfaceEl:document.getElementById('surface'),
        lifecycleMode:'preview',lazyMountRuntimeFrame:false,muted:true,
        // No onAction: tool/business events are intentionally disconnected.
        onRuntimeRenderState:s=>{if(s.state==='empty') fail('EMPTY');}
      });
      pendingPayloads=data.payloads;
      check();
    } catch {fail();}
  });
  window.addEventListener('pagehide',()=>{clearTimeout(timer);viewer?.destroy();});
  parent.postMessage({type:'cortex-eval-preview-host'},parentOrigin);
})();</script></body></html>`;
