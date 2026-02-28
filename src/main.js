/**
 * main.js - MV entry point (GPU Particle Text version)
 */

import './style.css';

// WebGPU unsupported fallback screen (reused for both sync and async failure paths)
function showUnsupportedPage() {
    const NICO_URL = 'https://www.nicovideo.jp/watch/sm45971593';
    const BASE = import.meta.env.BASE_URL;
    let lang = navigator.language?.startsWith('ja') ? 'ja' : 'en';

    const i18n = {
        ja: {
            note: 'このブラウザでは表示できません。',
            body: 'Google ChromeまたはMicrosoft Edgeでお試しください。',
            nico: 'ニコニコ動画で再生 ↗',
        },
        en: {
            note: 'This browser is not supported.',
            body: 'Please try Google Chrome or Microsoft Edge.',
            nico: 'Play on Niconico ↗',
        },
    };

    const app = document.querySelector('#app');
    const render = () => {
        const t = i18n[lang];
        const btnStyle = (active) =>
            `background:none;border:none;cursor:pointer;font-size:13px;padding:0;color:#fff;${active ? '' : 'opacity:0.35;'}`;
        app.innerHTML = `
            <div style="position:fixed;inset:0;background:#000;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-end;padding:48px;box-sizing:border-box;">
                <div style="margin:0 0 12px;">
                    <img src="${BASE}assets/svg/title.svg" alt="にび" style="height:48px;display:block;" />
                </div>
                <div style="margin:0 0 40px;">
                    <a href="https://monotonmusic.com" target="_blank" rel="noopener">
                        <img src="${BASE}assets/svg/monoton.svg" alt="monoton" style="height:16px;opacity:0.45;display:block;" />
                    </a>
                </div>
                <p style="margin:0 0 6px;color:#fff;font-family:sans-serif;font-size:14px;font-weight:500;">${t.note}</p>
                <p style="margin:0 0 32px;color:#fff;font-family:sans-serif;font-size:13px;opacity:0.55;line-height:1.8;">${t.body}</p>
                <a href="${NICO_URL}" target="_blank" rel="noopener" style="color:#fff;border:1px solid rgba(255,255,255,0.35);padding:10px 20px;text-decoration:none;font-family:sans-serif;font-size:14px;border-radius:2px;display:inline-block;margin-bottom:32px;">${t.nico}</a>
                <div style="font-family:sans-serif;">
                    <button class="mv-fb-lang" data-lang="ja" style="${btnStyle(lang === 'ja')}">日本語</button>
                    <span style="color:#fff;opacity:0.2;margin:0 6px;">/</span>
                    <button class="mv-fb-lang" data-lang="en" style="${btnStyle(lang === 'en')}">English</button>
                </div>
            </div>
        `;
        app.querySelectorAll('.mv-fb-lang').forEach(btn => {
            btn.addEventListener('click', () => { lang = btn.dataset.lang; render(); });
        });
    };
    render();
}

import { MVEngine } from './engine/index.js';
import { GPUParticleSystem } from './components/index.js';
import { rng, debugOverlay, SceneTuner } from './utils/index.js';

// Mobile detection (used for particle count reduction + pixelRatio cap)
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1 && window.innerWidth < 900);

// Container setup — replace HTML skeleton with engine container
document.querySelector('#app').innerHTML = `
  <div id="mv-container"></div>
`;

// Loading placeholder: visible during WebGPU init + scene compile (before start overlay appears)
{
  const el = document.createElement('div');
  el.id = 'mv-init-loading';
  // pointer-events:none on container, but children with links override it
  el.style.cssText = 'position:fixed;inset:0;z-index:90;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-end;padding:2rem;box-sizing:border-box;pointer-events:none;';
  const nicoUrl = 'https://www.nicovideo.jp/watch/sm45971593';
  const nicoLabel = navigator.language?.startsWith('ja') ? 'ニコニコ動画で再生 ↗' : 'Play on Niconico ↗';
  el.innerHTML = `
    <div style="margin:0 0 1.4rem;line-height:0;">
      <img src="${import.meta.env.BASE_URL}assets/svg/title.svg" alt="にび" style="height:clamp(3rem,7vw,5.5rem);width:auto;display:block;filter:invert(1);" />
    </div>
    <div style="margin:0 0 2rem;line-height:0;">
      <img src="${import.meta.env.BASE_URL}assets/svg/monoton.svg" alt="monoton" style="height:1.1rem;width:auto;display:block;filter:invert(1);opacity:0.45;" />
    </div>
    <div style="margin:0 0 1.5rem;pointer-events:auto;">
      <a href="${nicoUrl}" target="_blank" rel="noopener"
        style="color:#fff;font-family:sans-serif;font-size:0.95rem;opacity:0.7;text-decoration:none;">${nicoLabel}</a>
    </div>
    <p id="mv-init-status" class="mv-loading-status" style="margin:0;font-family:sans-serif;font-size:0.65rem;color:#fff;letter-spacing:0.08em;">読み込み中...</p>
  `;
  // Append scan-line bar (reuses CSS defined in index.html <style>)
  el.insertAdjacentHTML('beforeend', '<div class="mv-loading-bar"></div>');
  document.querySelector('#mv-container').appendChild(el);
}

function setLoadingStatus(text) {
  const el = document.getElementById('mv-init-status');
  if (el) el.textContent = text;
}

// MV engine initialization
const engine = new MVEngine('#mv-container');
window.engine = engine; // For DevTools
let mvDataCache = null;
let mvDataTextCache = null;

// Register components (GPUParticleSystem only)
engine.registerComponent('GPUParticleSystem', GPUParticleSystem);

const urlParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : new URLSearchParams();
const forceWebGL = urlParams.get('forceWebGL') === '1';
const versionParam = urlParams.get('version') || '';
const startSceneId = urlParams.get('scene');
const loopEnabled = urlParams.get('loop') === '1' || urlParams.get('loop') === 'true';
const autoplayEnabled = urlParams.get('autoplay') === '1' || urlParams.get('autoplay') === 'true';
const autoStartDelay = urlParams.get('autostart');
const watchEnabled = urlParams.get('watch') === '1' || import.meta.env.DEV;
const tunerEnabled = urlParams.get('tuner') === '1' || urlParams.get('debug') === '1';
const lyricsParam = urlParams.get('lyrics');
const showEnd = urlParams.get('end') === '1';
const exportEnabled = urlParams.get('export') === '1';
const exportWidth = parseInt(urlParams.get('width')) || 1920;
const exportHeight = parseInt(urlParams.get('height')) || 1080;
const exportFps = parseInt(urlParams.get('fps')) || 60;
const exportCodec = urlParams.get('codec') || 'h264';   // h264 | vp9
const exportQuality = urlParams.get('quality') || 'high'; // standard | high | max
const exportFrom = parseFloat(urlParams.get('from')) || 0;       // start seconds
const exportTo = urlParams.get('to') ? parseFloat(urlParams.get('to')) : null; // end seconds (null = until the end)
const demoEnabled = urlParams.get('demo') === '1';
const galleryEnabled = import.meta.env.DEV && urlParams.get('gallery') === '1';
// In particle text MV, lyrics = text targets, so enabled by default
// Disable explicitly with ?lyrics=0
const lyricsEnabled = demoEnabled ? false : (lyricsParam !== '0' && lyricsParam !== 'false' && lyricsParam !== 'off');

// Mobile: reduce particle count for performance
if (isMobile) {
  engine.sceneManager.setComponentParamOverrides('GPUParticleSystem', { count: 100000 });
}
engine.setMobile(isMobile);

engine.setStartScene(startSceneId);
engine.setSceneLoop(startSceneId, autoplayEnabled ? true : loopEnabled);
if (autoplayEnabled) {
  engine.setAutoStart(true, 0);
} else if (autoStartDelay) {
  const delayValue = Number.parseFloat(autoStartDelay);
  if (!Number.isNaN(delayValue)) {
    engine.setAutoStart(true, delayValue);
  }
}
engine.setLyricsEnabled(lyricsEnabled);

const mvDataFilename = versionParam ? `mv-data-${versionParam.toLowerCase()}.json` : 'mv-data.json';

async function loadMvData({ cacheBust = false } = {}) {
  const cacheKey = cacheBust ? `?t=${Date.now()}` : '';
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${mvDataFilename}${cacheKey}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('not found');
    const text = await res.text();
    return { data: JSON.parse(text), text };
  } catch {
    if (mvDataFilename !== 'mv-data.json') {
      console.warn(`[MV] ${mvDataFilename} not found, falling back to mv-data.json`);
      const res = await fetch(`${import.meta.env.BASE_URL}mv-data.json${cacheKey}`, { cache: 'no-store' });
      const text = await res.text();
      return { data: JSON.parse(text), text };
    }
    throw new Error('mv-data.json not found');
  }
}

// Load MV data and audio
async function init() {
  // Pass forceWebGL to SceneManager so it can request WebGL backend
  if (forceWebGL) {
    engine.sceneManager._forceWebGL = true;
  }

  let tuner = null;
  try {
    setLoadingStatus('データを読み込み中...');
    const { data, text } = await loadMvData();
    mvDataCache = data;
    mvDataTextCache = text;
    setLoadingStatus('初期化中...');
    await engine.load(mvDataCache, `${import.meta.env.BASE_URL}assets/audio/demo.mp3`, {
      onProgress: (step) => {
        if (step === 'audio') setLoadingStatus('音声を読み込み中...');
      }
    });
    console.log('MV loaded successfully');
  } catch (error) {
    // If the renderer was never created, this is a GPU/WebGL support failure
    if (!engine.sceneManager?.renderer) {
      document.getElementById('mv-init-loading')?.remove();
      showUnsupportedPage();
      return;
    }

    console.warn('Audio file not found, running in preview mode:', error.message);

    const { data, text } = await loadMvData();
    mvDataCache = data;
    mvDataTextCache = text;

    // Preview mode: async initialization of SceneManager
    await engine.sceneManager.init();
    engine.timeline.loadScenes(mvDataCache.scenes || []);
    engine.timeline.loadEvents(mvDataCache.events || []);

    showPreviewMessage();
  }

  if (showEnd) {
    engine._startBackgroundRender();
    engine._showEndScreen();
  }

  if (exportEnabled) {
    await engine.start();
    engine.startExport({ width: exportWidth, height: exportHeight, fps: exportFps, codec: exportCodec, quality: exportQuality, startTime: exportFrom, duration: exportTo != null ? exportTo - exportFrom : null });
  }

  // Pattern gallery mode (dev only): ?gallery=1
  if (galleryEnabled) {
    // Remove start overlay (bg render is already running from load())
    if (engine.overlay) {
      engine.overlay.remove();
      engine.overlay = null;
    }
    // Wait for scene + component to be ready
    setTimeout(async () => {
      const { PatternGallery } = await import('./dev/PatternGallery.js');
      const gallery = new PatternGallery(engine);
      window._gallery = gallery;
      await gallery.start();
    }, 800);
    return;
  }

  if (tunerEnabled) {
    tuner = new SceneTuner({
      engine,
      getData: () => mvDataCache,
      onApply: async (nextData) => {
        mvDataCache = nextData;
        await engine.reloadData(mvDataCache, { preserveTime: true, reloadScene: true });
      }
    });
  }

  if (watchEnabled && !demoEnabled) {
    let lastText = mvDataTextCache;
    setInterval(async () => {
      try {
        const { data, text } = await loadMvData({ cacheBust: true });
        if (text !== lastText) {
          lastText = text;
          mvDataCache = data;
          await engine.reloadData(mvDataCache, { preserveTime: true, reloadScene: true });
          if (tuner) {
            tuner.refresh();
          }
          console.log('[MV] mv-data.json reloaded');
        }
      } catch (error) {
        console.warn('[MV] mv-data.json reload failed:', error.message);
      }
    }, 1500);
  }

  // Demo mode: auto-start and cycle through all flow patterns
  if (demoEnabled) {
    engine.setAutoStart(true, 0);
    engine.setLyricsEnabled(false);
    // Wait for scene to be ready, then start demo
    setTimeout(() => initDemoMode(), 500);
  }
}

function showPreviewMessage() {
  const msg = document.createElement('div');
  msg.innerHTML = `
    <div style="
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.8);
      color: #fff;
      padding: 12px 24px;
      border-radius: 8px;
      font-family: sans-serif;
      font-size: 14px;
      z-index: 1000;
    ">
      音楽ファイルがありません。<code>public/assets/audio/demo.mp3</code> を配置してください。
    </div>
  `;
  document.body.appendChild(msg);
  setTimeout(() => msg.remove(), 5000);
}

// === Demo mode ===
let demoState = null;

function initDemoMode() {
  // Use full pattern list (GPU + CPU) from active component
  let patterns = GPUParticleSystem.getPatternNames();
  for (const comp of engine.sceneManager.activeComponents) {
    if (comp.getAllPatternNames) { patterns = comp.getAllPatternNames(); break; }
  }
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:1000;font-family:monospace;font-size:13px;color:#000;pointer-events:none;text-shadow:0 0 3px rgba(255,255,255,0.5);';
  document.body.appendChild(overlay);

  demoState = { patterns, idx: 0, overlay, intervalId: null };
  applyDemoPattern(0);

  demoState.intervalId = setInterval(() => {
    demoState.idx = (demoState.idx + 1) % patterns.length;
    applyDemoPattern(demoState.idx);
  }, 4000);
}

function applyDemoPattern(idx) {
  const { patterns, overlay } = demoState;
  const name = patterns[idx];
  for (const comp of engine.sceneManager.activeComponents) {
    if (comp.setFlowTargets) {
      comp.setFlowTargets(name);
      comp._phase = 'flow';
      comp._targetConvergence = 0.10;
      comp._currentText = '';
      comp._sweepDir = [0, 0, 0];
    }
  }
  overlay.textContent = `[${idx + 1}/${patterns.length}] ${name}`;
}

// === Export dialog ===
const expSettings = { w: '1920', h: '1080', scale: '100', dot: '1.0', stillTime: '', fps: '60', codec: 'h264', quality: 'high', range: 'full' };

function showExportDialog() {
  if (document.querySelector('.export-dialog')) return;

  const currentTime = engine.audio?.currentTime || 0;
  const totalDuration = engine.audio?.getDuration() || 130;

  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
  bg.className = 'export-dialog';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#fff;color:#111;border-radius:8px;padding:24px 28px;font-family:"SF Mono","Menlo",monospace;font-size:12px;min-width:320px;';

  const row = (label, html) => `<div style="display:flex;align-items:center;justify-content:space-between;margin:8px 0;gap:12px;"><label style="white-space:nowrap;">${label}</label>${html}</div>`;
  const input = (id, val, w = '80px') => `<input id="exp-${id}" value="${val}" style="width:${w};padding:3px 6px;border:1px solid #ccc;border-radius:3px;font:inherit;text-align:right;" />`;
  const select = (id, opts) => `<select id="exp-${id}" style="padding:3px 6px;border:1px solid #ccc;border-radius:3px;font:inherit;">${opts.map(([v, l, sel]) => `<option value="${v}"${sel ? ' selected' : ''}>${l}</option>`).join('')}</select>`;

  dialog.innerHTML = `
    <div style="font-size:14px;font-weight:bold;margin-bottom:12px;">Export MP4</div>
    ${row('Resolution', `${input('w', expSettings.w, '60px')} x ${input('h', expSettings.h, '60px')}`)}
    ${row('Scale %', input('scale', expSettings.scale, '50px'))}
    ${row('Dot size', input('dot', expSettings.dot, '50px'))}
    ${row('Time (sec)', `${input('time', expSettings.stillTime || currentTime.toFixed(2), '60px')} <span style="opacity:0.4;font-size:10px;">blank=current</span>`)}
    ${row('FPS', input('fps', expSettings.fps, '50px'))}
    ${row('Codec', select('codec', [['h264', 'H.264', expSettings.codec === 'h264'], ['vp9', 'VP9', expSettings.codec === 'vp9']]))}
    ${row('Quality', select('quality', [['standard', 'Standard', expSettings.quality === 'standard'], ['high', 'High', expSettings.quality === 'high'], ['max', 'Max', expSettings.quality === 'max']]))}
    <hr style="border:none;border-top:1px solid #eee;margin:14px 0;" />
    ${row('Range', select('range', [['full', 'Full', expSettings.range === 'full'], ['current', `From current (${currentTime.toFixed(1)}s)`, expSettings.range === 'current'], ['custom', 'Custom range', expSettings.range === 'custom']]))}
    <div id="exp-custom-range" style="display:none;">
      ${row('From (sec)', input('from', '0', '60px'))}
      ${row('To (sec)', input('to', totalDuration.toFixed(1), '60px'))}
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
      <button id="exp-cancel" style="padding:6px 16px;border:1px solid #ccc;border-radius:4px;background:none;font:inherit;cursor:pointer;">Cancel</button>
      <button id="exp-still" style="padding:6px 16px;border:1px solid #888;border-radius:4px;background:none;font:inherit;cursor:pointer;">Still (PNG)</button>
      <button id="exp-start" style="padding:6px 16px;border:none;border-radius:4px;background:#111;color:#fff;font:inherit;cursor:pointer;">Export</button>
    </div>
  `;

  bg.appendChild(dialog);
  document.body.appendChild(bg);

  const rangeSelect = dialog.querySelector('#exp-range');
  const customDiv = dialog.querySelector('#exp-custom-range');
  rangeSelect.addEventListener('change', () => {
    customDiv.style.display = rangeSelect.value === 'custom' ? '' : 'none';
    if (rangeSelect.value === 'current') {
      dialog.querySelector('#exp-from').value = currentTime.toFixed(1);
    }
  });

  const saveSettings = () => {
    expSettings.w = dialog.querySelector('#exp-w').value;
    expSettings.h = dialog.querySelector('#exp-h').value;
    expSettings.scale = dialog.querySelector('#exp-scale').value;
    expSettings.dot = dialog.querySelector('#exp-dot').value;
    expSettings.stillTime = dialog.querySelector('#exp-time').value;
    expSettings.fps = dialog.querySelector('#exp-fps').value;
    expSettings.codec = dialog.querySelector('#exp-codec').value;
    expSettings.quality = dialog.querySelector('#exp-quality').value;
    expSettings.range = rangeSelect.value;
  };
  const close = () => { saveSettings(); bg.remove(); };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  dialog.querySelector('#exp-cancel').addEventListener('click', close);
  document.addEventListener('keydown', function onKey(e) {
    if (e.code === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });

  dialog.querySelector('#exp-still').addEventListener('click', async () => {
    const width = parseInt(dialog.querySelector('#exp-w').value) || 1920;
    const height = parseInt(dialog.querySelector('#exp-h').value) || 1080;
    const scale = parseInt(dialog.querySelector('#exp-scale').value) || 100;
    const dotScale = parseFloat(dialog.querySelector('#exp-dot').value) || 1;
    const timeVal = dialog.querySelector('#exp-time').value.trim();
    const targetTime = timeVal !== '' ? parseFloat(timeVal) : null;
    await engine.captureStill({ width, height, scale, dotScale, targetTime });
    close();
  });

  dialog.querySelector('#exp-start').addEventListener('click', () => {
    const width = parseInt(dialog.querySelector('#exp-w').value) || 1920;
    const height = parseInt(dialog.querySelector('#exp-h').value) || 1080;
    const fps = parseInt(dialog.querySelector('#exp-fps').value) || 60;
    const codec = dialog.querySelector('#exp-codec').value;
    const quality = dialog.querySelector('#exp-quality').value;
    const range = rangeSelect.value;

    let startTime = 0;
    let duration = null;
    if (range === 'current') {
      startTime = currentTime;
    } else if (range === 'custom') {
      startTime = parseFloat(dialog.querySelector('#exp-from').value) || 0;
      const to = parseFloat(dialog.querySelector('#exp-to').value);
      if (to > startTime) duration = to - startTime;
    }

    close();
    engine.startExport({ width, height, fps, codec, quality, startTime, duration });
  });
}

// Keyboard shortcuts
document.addEventListener('keydown', async (e) => {
  // Demo mode arrow key navigation
  if (demoState) {
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      clearInterval(demoState.intervalId);
      demoState.idx = (demoState.idx + 1) % demoState.patterns.length;
      applyDemoPattern(demoState.idx);
      demoState.intervalId = setInterval(() => {
        demoState.idx = (demoState.idx + 1) % demoState.patterns.length;
        applyDemoPattern(demoState.idx);
      }, 4000);
      return;
    }
    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      clearInterval(demoState.intervalId);
      demoState.idx = (demoState.idx - 1 + demoState.patterns.length) % demoState.patterns.length;
      applyDemoPattern(demoState.idx);
      demoState.intervalId = setInterval(() => {
        demoState.idx = (demoState.idx + 1) % demoState.patterns.length;
        applyDemoPattern(demoState.idx);
      }, 4000);
      return;
    }
  }

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      await engine.toggle();
      break;
    case 'KeyP':
      e.preventDefault();
      await engine.toggle();
      break;
    case 'KeyR':
      engine.seekToTime(0);
      engine.audio.pause();
      engine.isPlaying = false;
      break;
    case 'BracketLeft': {
      const prevIndex = engine.timeline.currentSceneIndex - 1;
      engine.seekToScene(Math.max(0, prevIndex));
      break;
    }
    case 'BracketRight': {
      const nextIndex = engine.timeline.currentSceneIndex + 1;
      engine.seekToScene(Math.min(engine.timeline.scenes.length - 1, nextIndex));
      break;
    }
    case 'KeyD':
      debugOverlay.toggle();
      break;
    case 'KeyB':
      engine.toggleBreakdown();
      break;
    case 'KeyC':
      if (engine._breakdownMode) {
        e.preventDefault();
        engine.resetToAuthoredView();
      }
      break;
    case 'KeyV':
      if (engine._breakdownMode) {
        e.preventDefault();
        engine.toggleCameraPathViz();
      }
      break;
    case 'KeyE':
      if (e.shiftKey && import.meta.env.DEV) {
        e.preventDefault();
        showExportDialog();
      }
      break;
  }
});

init();
