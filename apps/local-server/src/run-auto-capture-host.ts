/** Reuses the production Web viewer and catalog CSS, not an independent template renderer. */
export const runCaptureHost = `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8">
<link rel="icon" href="data:,"><link rel="stylesheet" href="/static/a2ui_viewer.css">
<link rel="stylesheet" href="/static/a2ui_catalog.css"></head><body>
<div class="a2ui-doc-stage" id="captureStage"><section class="a2ui-panel" id="capturePanel">
<div class="a2ui-stage" id="captureSurface"></div></section></div>
<script src="/static/a2ui_viewer.js"></script><script>
window.captureStates = [];
window.captureViewer = window.CortexA2uiViewer.createA2uiViewer({
  panelEl: document.getElementById('capturePanel'), surfaceEl: document.getElementById('captureSurface'),
  lifecycleMode: 'preview', lazyMountRuntimeFrame: false, muted: true,
  onRuntimeRenderState: state => window.captureStates.push(state)
});</script></body></html>`;
