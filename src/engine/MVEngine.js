/**
 * MVEngine - Main engine that orchestrates the entire application
 *
 * Flow:
 * 1. load() → page load
 * 2. showStartScreen() → fullscreen prompt + play button
 * 3. start() → enter fullscreen + begin playback
 * 4. (continuous playback)
 * 5. showEndScreen() → display end screen
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import gsap from 'gsap';
import { AudioManager } from './AudioManager.js';
import { Timeline } from './Timeline.js';
import { SceneManager } from './SceneManager.js';
import { debugOverlay, rng } from '../utils/index.js';

export class MVEngine {
    constructor(containerSelector) {
        this.container = document.querySelector(containerSelector);

        if (!this.container) {
            throw new Error(`Container not found: ${containerSelector}`);
        }

        // Core modules
        this.audio = new AudioManager();
        this.timeline = new Timeline();
        this.sceneManager = new SceneManager(this.container);

        // State
        this.isPlaying = false;
        this.isLoaded = false;
        this.rafId = null;
        this.mvData = null;
        this._suppressSceneChange = false;
        this._fpsMonitor = {
            lastTime: performance.now(),
            frameCount: 0,
            fps: 60,
            lowFpsFrames: 0,
            highFpsFrames: 0,
            cooldownUntil: 0
        };
        this._targetFps = 60;
        this._statsMonitor = {
            lastTime: 0,
            interval: 500
        };

        // Lyrics
        this.lyrics = [];
        this.firedLyricIndices = new Set();
        this.startSceneId = null;
        this.loopSceneId = null;
        this.loopEnabled = false;
        this.lastLoopAt = -1;
        this.lyricsEnabled = true;

        // UI elements
        this.overlay = null;
        this.endScreen = null;
        this._autoStart = { enabled: false, delay: 0 };
        this._autoStartTimer = null;
        this._audioUnlockOverlay = null;

        // Breakdown mode
        this._breakdownMode = false;
        this._breakdownUI = null;
        this._orbitControls = null;
        this._bdFps = { last: 0, frames: 0, value: 0 };
        this._bdLogs = [];
        this._bdLang = 'ja';
        this._bdSeeking = false;
        this._bdPatternIdx = 0;
        this._bdAllPatterns = null; // lazy-init from component
        this._bdCameraPathViz = null; // camera path 3D objects
        this._bdCameraFrustumViz = null; // camera frustum 3D wireframe
        this._bdHiddenByUser = false; // user explicitly pressed B to hide

        // End screen configuration
        this.endScreenConfig = {
            title: 'Title',
        };

        // Event connections
        this._setupConnections();

        console.log('[MVEngine] Initialized');
    }

    /**
     * Set up connections between modules
     */
    _setupConnections() {
        // Timeline is updated every frame in the render loop
        // (audio.onTimeUpdate fires ~250ms intervals and is too imprecise)

        // Scene change → update SceneManager
        this.timeline.onSceneChange((nextScene, prevScene) => {
            if (this._suppressSceneChange) return;
            if (this._breakdownMode) {
                this._bdLog('scene', `${prevScene?.id || '-'} → ${nextScene?.id || '-'}`);
            }
            this.sceneManager.loadScene(nextScene, prevScene).then(() => {
                this._hookComponentLogs();
            });
        });

        // Track end → show end screen
        this.audio.onEnded(() => {
            this.isPlaying = false;
            console.log('[MVEngine] Playback ended');
            this._showEndScreen();
        });

        // Event → trigger effect
        this.timeline.onEvent((event) => {
            this._handleEvent(event);
        });
    }

    /**
     * Handle timeline events
     */
    _handleEvent(event) {
        switch (event.type) {
            case 'glitch':
                if (this.sceneManager.postProcessing) {
                    this.sceneManager.postProcessing.triggerGlitch(
                        event.intensity ?? 1,
                        event.duration ?? 0.1
                    );
                }
                if (this._breakdownMode) this._bdLog('fx', `glitch i=${(event.intensity ?? 1).toFixed(2)} d=${event.duration ?? 0.1}s`);
                break;
            case 'flash':
                if (this.sceneManager.postProcessing) {
                    const prev = this.sceneManager.postProcessing.uniforms.tmExposure.value;
                    this.sceneManager.postProcessing.uniforms.tmExposure.value = event.intensity ?? 3;
                    setTimeout(() => {
                        this.sceneManager.postProcessing.uniforms.tmExposure.value = prev;
                    }, (event.duration ?? 0.1) * 1000);
                }
                if (this._breakdownMode) this._bdLog('fx', `flash i=${(event.intensity ?? 3).toFixed(1)} d=${event.duration ?? 0.1}s`);
                break;
            case 'cameraShake':
                if (this.sceneManager.cameraController) {
                    this.sceneManager.cameraController.currentShake = event.intensity ?? 0.5;
                }
                if (this._breakdownMode) this._bdLog('cam', `shake i=${(event.intensity ?? 0.5).toFixed(2)}`);
                break;
            case 'particleMode':
                for (const comp of this.sceneManager.activeComponents) {
                    if (comp.setMode) {
                        comp.setMode(event.mode || 'flow', event.pattern);
                        break;
                    }
                }
                if (this._breakdownMode) this._bdLog('particle', `mode=${event.mode || 'flow'} ${event.pattern || ''}`);
                break;
            case 'postProcessing':
                if (event.config) {
                    this.sceneManager.applyPostProcessingConfig(event.config);
                }
                if (this._breakdownMode) this._bdLog('post', JSON.stringify(event.config || {}));
                break;
            default:
                if (this._breakdownMode) this._bdLog('event', event.type);
                break;
        }
    }

    /**
     * Register a component
     */
    registerComponent(type, ComponentClass) {
        this.sceneManager.registerComponent(type, ComponentClass);
    }

    /**
     * Set the start scene
     */
    setStartScene(sceneId) {
        this.startSceneId = sceneId || null;
    }

    /**
     * Enable or disable lyrics display
     */
    setLyricsEnabled(enabled = true) {
        this.lyricsEnabled = !!enabled;
    }

    /**
     * Configure scene looping
     */
    setSceneLoop(sceneId, enabled = true) {
        this.loopSceneId = sceneId || null;
        this.loopEnabled = enabled;
    }

    /**
     * Configure auto-start
     */
    setAutoStart(enabled = true, delay = 0) {
        this._autoStart.enabled = enabled;
        this._autoStart.delay = Math.max(0, delay);
    }

    /**
     * Set mobile mode (reduced particles, touch-friendly UI, pixelRatio cap)
     */
    setMobile(isMobile) {
        this._isMobileDevice = !!isMobile;
        this.sceneManager._mobileMode = !!isMobile;
    }

    /**
     * Configure the end screen
     */
    setEndScreen(config) {
        this.endScreenConfig = { ...this.endScreenConfig, ...config };
    }

    /**
     * Load MV data and audio
     */
    async load(mvData, audioUrl, { onProgress } = {}) {
        let data = mvData;
        if (typeof mvData === 'string') {
            const response = await fetch(mvData);
            data = await response.json();
        }

        this.mvData = data;

        // Bar number → seconds conversion
        if (data.bpm) {
            this._preprocessBarTiming(data);
        }

        // Async WebGPURenderer initialization
        await this.sceneManager.init();
        onProgress?.('renderer_ready');

        if (data.scenes) {
            this.timeline.loadScenes(data.scenes);
        }
        if (data.events) {
            this.timeline.loadEvents(data.events);
        }
        if (data.postProcessing) {
            this.sceneManager.applyPostProcessingConfig(data.postProcessing);
            this.sceneManager._globalPostProcessingConfig = data.postProcessing;
        }

        // Load lyrics
        if (data.lyrics) {
            this.lyrics = data.lyrics.map((lyric, index) => ({
                ...lyric,
                index,
                fired: false
            }));
            console.log('[MVEngine] Loaded lyrics:', this.lyrics.length);
        }

        // Apply end screen config if present
        if (data.endScreen) {
            this.setEndScreen(data.endScreen);
        }

        // Show start overlay immediately after WebGPU is ready (particles render in background)
        // Audio loading continues in parallel; play buttons are dimmed until ready
        this._createStartOverlay();
        this._setOverlayAudioLoading(true);
        onProgress?.('audio');

        await this.audio.load(audioUrl);

        this._setOverlayAudioLoading(false);
        this.isLoaded = true;
        console.log('[MVEngine] Loaded');

        // Schedule auto-start only after audio is ready
        if (this._autoStart.enabled) {
            this._autoStartTimer = setTimeout(async () => {
                await this.start();
            }, this._autoStart.delay * 1000);
        }
    }

    /**
     * Reload only MV data (for hot-reload)
     */
    async reloadData(data, options = {}) {
        const { preserveTime = true, reloadScene = true } = options;
        this.mvData = data;

        // Bar number → seconds conversion (also on hot-reload)
        if (data.bpm) {
            this._preprocessBarTiming(data);
        }

        if (data.scenes) {
            this.timeline.loadScenes(data.scenes);
        }
        if (data.events) {
            this.timeline.loadEvents(data.events);
        }
        if (data.postProcessing) {
            this.sceneManager.applyPostProcessingConfig(data.postProcessing);
        }

        if (data.lyrics) {
            this.lyrics = data.lyrics.map((lyric, index) => ({
                ...lyric,
                index,
                fired: false
            }));
        } else {
            this.lyrics = [];
        }
        this._resetLyricsFromTime(preserveTime ? this.audio.getCurrentTime() : 0);

        if (data.endScreen) {
            this.setEndScreen(data.endScreen);
        }

        const targetTime = preserveTime ? this.audio.getCurrentTime() : 0;
        this._suppressSceneChange = true;
        this.timeline.seek(targetTime);
        this._suppressSceneChange = false;

        if (reloadScene) {
            const scene = this.timeline.getCurrentScene();
            if (scene) {
                await this.sceneManager.loadScene(scene, null, {
                    skipTransitionOut: true,
                    skipTransitionIn: true
                });
            }
        }
    }

    /**
     * Seek to a specific time (also syncs timeline and lyrics)
     */
    seekToTime(time) {
        const clamped = Math.max(0, time);
        this.audio.seek(clamped);
        this._suppressSceneChange = true;
        this.timeline.seek(clamped);
        this._suppressSceneChange = false;
        this._resetLyricsFromTime(clamped);

        // Re-apply the active lyric state so particles show the correct formation
        const active = this._getActiveLyricAtTime(clamped);
        if (active) this._reapplyLyric(active, clamped);
    }

    /**
     * Jump to a scene
     */
    seekToScene(sceneIdOrIndex) {
        let scene = null;
        if (typeof sceneIdOrIndex === 'string') {
            scene = this.timeline.scenes.find(s => s.id === sceneIdOrIndex);
        } else if (Number.isInteger(sceneIdOrIndex)) {
            scene = this.timeline.scenes[sceneIdOrIndex] || null;
        }

        if (!scene) return false;
        this.seekToTime(scene.startTime);
        return true;
    }

    /**
     * Reset lyrics that fall after the given time
     */
    _resetLyricsFromTime(time) {
        this.firedLyricIndices = new Set(
            this.lyrics
                .filter(lyric => lyric.time <= time)
                .map(lyric => lyric.index)
        );
    }

    /**
     * Reset only lyrics within a time range (for looping)
     */
    _resetLyricsInRange(startTime, endTime) {
        for (const lyric of this.lyrics) {
            if (lyric.time >= startTime && lyric.time < endTime) {
                this.firedLyricIndices.delete(lyric.index);
            }
        }
    }

    /**
     * Find the lyric that should be active at a given time
     * (the last lyric whose effective fire time <= time)
     */
    _getActiveLyricAtTime(time) {
        const textLookahead = 1.5;
        const flowLookahead = this._flowLookahead || 0;
        let best = null, bestTime = -Infinity;
        for (const lyric of this.lyrics) {
            const hasText = lyric.text && lyric.text.length > 0;
            const isFlow = lyric.mode === 'flow';
            const eff = hasText ? lyric.time - textLookahead
                : isFlow ? lyric.time - flowLookahead : lyric.time;
            if (eff <= time && eff > bestTime) { bestTime = eff; best = lyric; }
        }
        return best;
    }

    /**
     * Re-apply a lyric's state to the particle system (for seek restoration)
     */
    _reapplyLyric(lyric, seekTime) {
        for (const comp of this.sceneManager.activeComponents) {
            if (!comp.setText) continue;

            const hasText = lyric.text && lyric.text.length > 0;

            // Physics override params
            const physicsOpts = {};
            for (const pk of ['spring', 'damping', 'noiseStrength', 'noiseScale', 'vortex', 'wave', 'gravity', 'pointScale', 'convUp', 'convDn', 'lerpRate']) {
                if (lyric[pk] != null) physicsOpts[pk] = lyric[pk];
            }

            // Multi-layer flow
            if (lyric.layers && comp.setFlowTargetsMultiLayer) {
                comp.setFlowTargetsMultiLayer(lyric.layers);
                if (comp.setMode) comp.setMode('flow');
            } else {
                // Single-layer origin/scale
                if (comp.setFlowOrigin && lyric.origin) {
                    comp.setFlowOrigin(lyric.origin[0] || 0, lyric.origin[1] || 0, lyric.origin[2] || 0);
                }
                if (comp.setFlowScale && lyric.scale != null) {
                    comp.setFlowScale(lyric.scale);
                }

                if (lyric.mode === 'sculpture' && lyric.textB && comp.setShadowSculptureTarget) {
                    comp.setShadowSculptureTarget(lyric.text, lyric.textB, {
                        maxConvergence: lyric.maxConvergence,
                        holdDuration: lyric.holdDuration,
                        releaseSpeed: lyric.releaseSpeed,
                        ...physicsOpts
                    });
                } else if (hasText) {
                    comp.setText(lyric.text, {
                        animation: lyric.animation,
                        viewDirection: lyric.viewDirection,
                        maxConvergence: lyric.maxConvergence,
                        holdDuration: lyric.holdDuration,
                        releaseSpeed: lyric.releaseSpeed,
                        dissolveMode: lyric.dissolveMode,
                        origin: lyric.origin,
                        targetWidth: lyric.targetWidth,
                        backgroundPattern: lyric.backgroundPattern,
                        textRatio: lyric.textRatio,
                        align: lyric.align,
                        particleGroup: lyric.particleGroup ?? 0,
                        groupBPattern: lyric.groupBPattern,
                        groupBConvergence: lyric.groupBConvergence,
                        groupBOrigin: lyric.groupBOrigin,
                        groupBScale: lyric.groupBScale,
                        ...physicsOpts
                    });
                }
                if (comp.setMode) {
                    comp.setMode(lyric.mode || 'text', lyric.pattern, physicsOpts);
                }
            }

            // If the lyric has text and we seeked past its fire time, snap particles
            if (hasText && seekTime >= lyric.time && comp.snapToTargets) {
                comp.snapToTargets();
            }

            break;
        }
    }

    /**
     * Preprocessor that converts bar-number-based timing to seconds
     */
    _preprocessBarTiming(data) {
        const bpm = data.bpm;
        const beatsPerBar = data.beatsPerBar || 4;
        const dawStartBar = data.dawStartBar || 1;
        const secPerBeat = 60 / bpm;

        // flowLookahead: specified in beats → convert to seconds and store
        if (data.flowLookahead != null) {
            this._flowLookahead = data.flowLookahead * secPerBeat;
        }

        const barToTime = (bar) => {
            let b, beat, tick;
            if (typeof bar === 'number') {
                b = bar; beat = 1; tick = 0;
            } else {
                const parts = String(bar).split('.');
                b = parseInt(parts[0]);
                beat = parts[1] ? parseInt(parts[1]) : 1;
                tick = parts[2] ? parseInt(parts[2]) : 0;
            }
            return ((b - dawStartBar) * beatsPerBar + (beat - 1) + tick / 480) * secPerBeat;
        };

        const barsToSec = (bars) => bars * beatsPerBar * secPerBeat;

        // lyrics
        if (data.lyrics) {
            for (const l of data.lyrics) {
                if (l.bar != null) l.time = barToTime(l.bar);
            }
        }
        // camera keyframes
        if (data.camera?.keyframes) {
            for (const kf of data.camera.keyframes) {
                if (kf.bar != null) kf.time = barToTime(kf.bar);
                if (kf.durBars != null) kf.duration = barsToSec(kf.durBars);
            }
        }
        // camera keyframes inside scenes
        if (data.scenes) {
            for (const s of data.scenes) {
                if (s.bar != null) s.startTime = barToTime(s.bar);
                if (s.durBars != null) s.duration = barsToSec(s.durBars);
                if (s.camera?.keyframes) {
                    for (const kf of s.camera.keyframes) {
                        if (kf.bar != null) kf.time = barToTime(kf.bar);
                        if (kf.durBars != null) kf.duration = barsToSec(kf.durBars);
                    }
                }
            }
        }
        // events
        if (data.events) {
            for (const e of data.events) {
                if (e.bar != null) e.time = barToTime(e.bar);
            }
        }
    }

    /**
     * Create the start overlay (user chooses fullscreen or windowed)
     */
    _createStartOverlay() {
        // Transparent overlay so particles are visible behind it
        this.overlay = document.createElement('div');
        this.overlay.className = 'mv-start-overlay';
        this._startLang = 'ja';
        const startI18n = {
            ja: {
                play: '音楽をスタート',
                fullscreen: 'フルスクリーンにする',
                nico: 'ニコニコ動画で再生 ↗',
                about: '制作について',
            },
            en: {
                play: 'Start Music',
                fullscreen: 'Go Fullscreen',
                nico: 'Play on Niconico ↗',
                about: 'About',
            }
        };
        this._startI18n = startI18n;

        this.overlay.innerHTML = `
      <div class="mv-start-content">
        <div class="mv-start-title"><img src="${import.meta.env.BASE_URL}assets/svg/title.svg" alt="にび" class="mv-svg-title" /></div>
        <div class="mv-start-meta"><a class="mv-meta-link" href="https://monotonmusic.com" target="_blank" rel="noopener"><img src="${import.meta.env.BASE_URL}assets/svg/monoton.svg" alt="monoton" class="mv-svg-monoton" /></a></div>
        <div class="mv-start-primary">
          <button class="mv-start-btn mv-play-btn mv-windowed-play-btn"></button>
          <button class="mv-start-btn mv-sub-btn mv-fullscreen-play-btn"></button>
        </div>
        <div class="mv-start-nico">
          <a class="mv-start-btn mv-nico-link" href="https://www.nicovideo.jp/watch/sm45971593" target="_blank" rel="noopener"></a>
        </div>
        <div class="mv-start-about">
          <button class="mv-start-btn mv-start-about-btn"></button>
        </div>
        <div class="mv-start-lang">
          <button class="mv-start-lang-btn" data-lang="ja">日本語</button>
          <span class="mv-start-lang-sep">/</span>
          <button class="mv-start-lang-btn" data-lang="en">English</button>
        </div>
      </div>
    `;

        this._applyStartOverlayStyles();

        const fsPlayBtn = this.overlay.querySelector('.mv-fullscreen-play-btn');
        fsPlayBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            this._cancelAutoStart();
            await this._requestFullscreen();
            await this.start();
        });

        const winPlayBtn = this.overlay.querySelector('.mv-windowed-play-btn');
        winPlayBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            this._cancelAutoStart();
            await this.start();
        });

        this.overlay.querySelector('.mv-start-about-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this._showAboutModal(this._startLang);
        });

        this.overlay.querySelectorAll('.mv-start-lang-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._startLang = btn.dataset.lang;
                this._updateStartTexts();
            });
        });
        this._updateStartTexts();

        // Load the scene first so particles render in the background
        this._startBackgroundRender();

        // Remove the JS-inserted loading placeholder and hand off to overlay
        document.getElementById('mv-init-loading')?.remove();
        // Set white background so overlay text is readable before first WebGPU frame
        this.container.style.background = '#fff';
        this.container.style.touchAction = 'none';

        this.container.appendChild(this.overlay);
    }

    _updateStartTexts() {
        if (!this.overlay) return;
        const t = this._startI18n[this._startLang] || this._startI18n.ja;
        this.overlay.querySelector('.mv-windowed-play-btn').textContent = t.play;
        this.overlay.querySelector('.mv-fullscreen-play-btn').textContent = t.fullscreen;
        this.overlay.querySelector('.mv-nico-link').textContent = t.nico;
        this.overlay.querySelector('.mv-start-about-btn').textContent = t.about;
        this.overlay.querySelectorAll('.mv-start-lang-btn').forEach(btn => {
            btn.style.opacity = btn.dataset.lang === this._startLang ? '1' : '0.4';
        });
        // On mobile: hide fullscreen button
        if (this._isMobileDevice) {
            this.overlay.querySelector('.mv-fullscreen-play-btn').style.display = 'none';
        }
    }

    /**
     * Start screen: render only the particles in the background
     */
    async _startBackgroundRender() {
        this._bgRunning = true;
        const firstScene = this.timeline.scenes[0];
        if (firstScene) {
            await this.sceneManager.loadScene(firstScene, null);
        }

        // start() may have cancelled bg render during our await
        if (!this._bgRunning) return;

        // Apply first lyric's flow pattern so wait screen matches playback start
        const activeLyric = this._getActiveLyricAtTime(0);
        if (activeLyric) {
            this._reapplyLyric(activeLyric, 0);
        }

        const bgRender = () => {
            if (!this._bgRunning) return;
            this._bgRafId = requestAnimationFrame(bgRender);
            this.sceneManager.update(0, 0);
        };
        this._bgRafId = requestAnimationFrame(bgRender);
    }

    _cancelAutoStart() {
        if (this._autoStartTimer) {
            clearTimeout(this._autoStartTimer);
            this._autoStartTimer = null;
        }
    }

    _applyStartOverlayStyles() {
        // CSS for hover animations
        if (!document.getElementById('mv-engine-styles')) {
            const style = document.createElement('style');
            style.id = 'mv-engine-styles';
            style.textContent = `
                .mv-start-btn:hover, .mv-end-btn:hover, .mv-meta-link:hover {
                    opacity: 0.5;
                }
                .mv-start-btn {
                    line-height: 1.2;
                    white-space: nowrap;
                    min-height: 44px;
                    display: inline-flex;
                    align-items: center;
                }
                .mv-meta-link, .mv-nico-link, .mv-end-nico-link {
                    color: inherit;
                    text-decoration: none;
                    transition: opacity 0.2s ease;
                }
                .mv-start-overlay, .mv-end-screen {
                    transition: opacity 0.5s ease;
                }
                .mv-play-btn {
                    font-size: 1.1rem !important;
                    letter-spacing: 0.08em !important;
                }
                .mv-sub-btn {
                    opacity: 0.45;
                    font-size: 0.75rem !important;
                }
                .mv-help-link {
                    font-size: 0.7rem !important;
                    opacity: 0.35;
                }
                .mv-nico-link {
                    font-size: 0.95rem !important;
                    opacity: 0.7;
                    text-decoration: none;
                }
                .mv-start-lang-btn {
                    background: none;
                    border: none;
                    padding: 0;
                    font: inherit;
                    font-size: 0.65rem !important;
                    line-height: 1.2;
                    color: inherit;
                    cursor: pointer;
                    letter-spacing: 0.05em;
                    white-space: nowrap;
                }
                .mv-start-lang-sep {
                    font-size: 0.65rem;
                    opacity: 0.3;
                }
            `;
            document.head.appendChild(style);
        }

        this.overlay.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      z-index: 100;
      overflow: hidden;
      pointer-events: auto;
      background: transparent;
    `;

        const content = this.overlay.querySelector('.mv-start-content');
        content.style.cssText = `
      position: relative;
      text-align: left;
      color: #000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: clamp(1.2rem, 4vw, 2rem);
      z-index: 1;
      -webkit-font-smoothing: antialiased;
    `;

        const title = this.overlay.querySelector('.mv-start-title');
        title.style.cssText = `
      margin-bottom: 1.4rem;
      line-height: 0;
    `;
        const titleImg = title.querySelector('.mv-svg-title');
        if (titleImg) titleImg.style.cssText = `
      height: clamp(3rem, 7vw, 5.5rem);
      width: auto;
      display: block;
    `;

        const meta = this.overlay.querySelector('.mv-start-meta');
        meta.style.cssText = `
      margin-bottom: 2rem;
      line-height: 0;
    `;
        const metaImg = meta.querySelector('.mv-svg-monoton');
        if (metaImg) metaImg.style.cssText = `
      height: 1.1rem;
      width: auto;
      display: block;
    `;

        const primary = this.overlay.querySelector('.mv-start-primary');
        primary.style.cssText = `
      display: flex;
      align-items: baseline;
      gap: 1rem;
      margin-bottom: 0.4rem;
    `;

        const nico = this.overlay.querySelector('.mv-start-nico');
        nico.style.cssText = `
      margin-bottom: 1.5rem;
    `;

        const lang = this.overlay.querySelector('.mv-start-lang');
        lang.style.cssText = `
    `;

        this.overlay.querySelectorAll('.mv-start-btn').forEach(btn => {
            btn.style.cssText += `
        position: relative;
        background: transparent;
        color: #000;
        border: none;
        padding: 0.3rem 0;
        font-size: 0.85rem;
        line-height: 1.2;
        letter-spacing: 0.05em;
        cursor: pointer;
        font-family: inherit;
        transition: opacity 0.2s ease;
        -webkit-font-smoothing: antialiased;
        white-space: nowrap;
      `;
        });
    }

    /**
     * Dim/restore play buttons while audio is loading
     */
    _setOverlayAudioLoading(loading) {
        if (!this.overlay) return;
        const primary = this.overlay.querySelector('.mv-start-primary');
        if (loading) {
            if (primary) { primary.style.opacity = '0.2'; primary.style.pointerEvents = 'none'; }
        } else {
            if (primary) { primary.style.opacity = ''; primary.style.pointerEvents = ''; }
        }
    }

    /**
     * Request fullscreen
     */
    async _requestFullscreen() {
        // Fullscreen document.body, not the container —
        // using the container can cause CSS layout issues
        const elem = document.body;

        try {
            if (elem.requestFullscreen) {
                await elem.requestFullscreen();
            } else if (elem.webkitRequestFullscreen) {
                // For Safari
                await elem.webkitRequestFullscreen();
            } else if (elem.mozRequestFullScreen) {
                // For Firefox
                await elem.mozRequestFullScreen();
            } else if (elem.msRequestFullscreen) {
                // For IE/Edge
                await elem.msRequestFullscreen();
            }
            console.log('[MVEngine] Entered fullscreen');
        } catch (error) {
            console.error('[MVEngine] Fullscreen request failed:', error);
            // Feedback for the user (dev only)
            console.warn('[MVEngine] Fullscreen may require user gesture or be blocked by browser policy');
        }
    }

    /**
     * Start playback
     */
    async start() {
        if (!this.isLoaded) {
            console.warn('[MVEngine] Not loaded yet');
            return;
        }
        if (this._starting) return;
        this._starting = true;

        try {
            // Stop any existing render loop (prevents multiple loops on re-start)
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }

            // Stop background rendering
            this._bgRunning = false;
            if (this._bgRafId) {
                cancelAnimationFrame(this._bgRafId);
                this._bgRafId = null;
            }

            // Fade out overlay
            if (this.overlay) {
                this.overlay.style.opacity = '0';
                const overlayRef = this.overlay;
                setTimeout(() => {
                    overlayRef.remove();
                    if (this.overlay === overlayRef) this.overlay = null;
                }, 500);
            }

            // Start audio playback FIRST to preserve user gesture context
            // (await loadScene below can break the gesture chain on replay)
            try {
                await this.audio.play();
                this.isPlaying = true;
            } catch (error) {
                this.isPlaying = false;
                this._showAudioUnlockOverlay();
                console.warn('[MVEngine] Audio playback blocked:', error);
            }

            const startScene = this.startSceneId
                ? this.timeline.scenes.find(scene => scene.id === this.startSceneId)
                : this.timeline.scenes[0];

            if (startScene) {
                this.seekToTime(startScene.startTime);
                await this.sceneManager.loadScene(startScene, null, {
                    skipTransitionIn: true,
                    skipTransitionOut: true
                });
            }

            // Start render loop
            this._startRenderLoop();

            // Persistent nico link (PC only)
            this._showPersistentBar();

            // Enable breakdown UI by default
            this._breakdownMode = true;
            this._bdHiddenByUser = false;
            this._enableBreakdown();

            console.log('[MVEngine] Started');
        } finally {
            this._starting = false;
        }
    }

    /**
     * Render loop
     */
    _startRenderLoop() {
        // Set seed info for debug overlay
        debugOverlay.setData('seed', rng.seed);

        const render = () => {
            this.rafId = requestAnimationFrame(render);

            const now = performance.now();

            const freqData = this.audio.getFrequencyData();
            const avgVolume = this.audio.getAverageVolume();
            this.sceneManager.updateAudioData(freqData, avgVolume);

            const musicTime = this.audio.getCurrentTime();
            this.timeline.update(musicTime);
            const sceneProgress = this.timeline.getSceneProgress();

            // Process lyrics
            this._processLyrics(musicTime);

            // Update OrbitControls (in Breakdown mode)
            if (this._orbitControls) {
                this._orbitControls.update();
            }

            this.sceneManager.update(musicTime, sceneProgress);

            // Update Breakdown UI
            if (this._breakdownMode) {
                this._updateBreakdownUI(musicTime);
            }

            // Update debug overlay
            const currentScene = this.timeline.getCurrentScene();
            debugOverlay.setData('time', musicTime);
            debugOverlay.setData('sceneId', currentScene?.id || '-');
            const renderScale = this.sceneManager.renderScale || 1;
            const drawSize = new THREE.Vector2();
            this.sceneManager.renderer.getDrawingBufferSize(drawSize);
            const renderSize = `${Math.round(drawSize.x)}x${Math.round(drawSize.y)}`;
            debugOverlay.setData('renderScale', renderScale.toFixed(2));
            debugOverlay.setData('renderSize', renderSize);
            debugOverlay.setData('fpsTarget', this._targetFps);
            const qualityMode = renderScale >= 0.99 ? 'full' : 'scaled';
            debugOverlay.setData('qualityMode', qualityMode);
            if (now - this._statsMonitor.lastTime >= this._statsMonitor.interval) {
                const stats = this.sceneManager.getRenderStats();
                debugOverlay.setData('particleCount', stats.particles);
                debugOverlay.setData('objectCount', stats.objects);
                debugOverlay.setData('instanceCount', stats.instances);
                debugOverlay.setData('lightCount', stats.lights);
                const breakdown = Object.entries(stats.byType || {})
                    .map(([type, entry]) => ({
                        type,
                        instances: entry.instances || 0,
                        objects: entry.objects || 0,
                        particles: entry.particles || 0
                    }))
                    .filter(entry => entry.instances || entry.objects || entry.particles)
                    .sort((a, b) => b.instances - a.instances || b.objects - a.objects);
                const nameWidth = Math.min(
                    18,
                    Math.max(9, ...breakdown.map(entry => entry.type.length))
                );
                const header = `${'component'.padEnd(nameWidth)}  ${'inst'.padStart(5)}  ${'obj'.padStart(4)}  ${'part'.padStart(5)}`;
                const breakdownLines = [
                    header,
                    ...breakdown.slice(0, 8).map(entry =>
                        `${entry.type.padEnd(nameWidth)}  ${String(entry.instances).padStart(5)}  ${String(entry.objects).padStart(4)}  ${String(entry.particles).padStart(5)}`
                    )
                ];
                debugOverlay.setData('breakdown', breakdownLines);
                this._statsMonitor.lastTime = now;
            }
            debugOverlay.update();

            this._handleSceneLoop(currentScene, musicTime);
            this._monitorPerformance();
        };

        render();
    }

    _handleSceneLoop(currentScene, musicTime) {
        if (!this.loopEnabled) return;

        const targetScene = this.loopSceneId
            ? this.timeline.scenes.find(scene => scene.id === this.loopSceneId)
            : currentScene;

        if (!targetScene) return;
        if (musicTime < targetScene.endTime - 0.02) return;

        if (this.lastLoopAt > 0 && musicTime - this.lastLoopAt < 0.1) {
            return;
        }

        this.lastLoopAt = musicTime;
        const loopTime = targetScene.startTime + 0.001;
        this.audio.seek(loopTime);
        this._suppressSceneChange = true;
        this.timeline.seek(loopTime);
        this._suppressSceneChange = false;
        this._resetLyricsInRange(targetScene.startTime, targetScene.endTime);
    }

    _monitorPerformance() {
        const now = performance.now();
        const monitor = this._fpsMonitor;
        monitor.frameCount += 1;

        const elapsed = now - monitor.lastTime;
        if (elapsed < 1000) return;

        monitor.fps = (monitor.frameCount * 1000) / elapsed;
        monitor.frameCount = 0;
        monitor.lastTime = now;

        if (now < monitor.cooldownUntil) return;

        if (monitor.fps < 45) {
            monitor.lowFpsFrames += 1;
            monitor.highFpsFrames = 0;
        } else if (monitor.fps > 58) {
            monitor.highFpsFrames += 1;
            monitor.lowFpsFrames = 0;
        } else {
            monitor.lowFpsFrames = 0;
            monitor.highFpsFrames = 0;
        }

        if (monitor.lowFpsFrames >= 3) {
            this.sceneManager.setRenderScale(this.sceneManager.renderScale - 0.1);
            monitor.lowFpsFrames = 0;
            monitor.cooldownUntil = now + 4000;
        } else if (monitor.highFpsFrames >= 6) {
            this.sceneManager.setRenderScale(this.sceneManager.renderScale + 0.1);
            monitor.highFpsFrames = 0;
            monitor.cooldownUntil = now + 6000;
        }
    }

    /**
     * Process lyrics — send text targets to GPUParticleSystem.
     * Text lyrics are fired with lookahead (formation takes time).
     */
    _processLyrics(currentTime) {
        if (!this.lyricsEnabled || this._bdSeeking) return;
        const textLookahead = 1.5; // lookahead time needed for text formation
        const flowLookahead = this._flowLookahead || 0; // flow pattern lookahead (seconds)

        for (const lyric of this.lyrics) {
            if (this.firedLyricIndices.has(lyric.index)) continue;

            const hasText = lyric.text && lyric.text.length > 0;
            const isFlow = lyric.mode === 'flow';
            const effectiveTime = hasText ? lyric.time - textLookahead
                : isFlow ? lyric.time - flowLookahead : lyric.time;

            if (currentTime >= effectiveTime) {
                this.firedLyricIndices.add(lyric.index);

                for (const comp of this.sceneManager.activeComponents) {
                    if (comp.setText) {
                        // Multi-layer flow (layers array)
                        if (lyric.layers && comp.setFlowTargetsMultiLayer) {
                            comp.setFlowTargetsMultiLayer(lyric.layers);
                            if (comp.setMode) comp.setMode('flow');
                        } else {
                            // Single-layer origin/scale
                            if (comp.setFlowOrigin && lyric.origin) {
                                comp.setFlowOrigin(lyric.origin[0] || 0, lyric.origin[1] || 0, lyric.origin[2] || 0);
                            }
                            if (comp.setFlowScale && lyric.scale != null) {
                                comp.setFlowScale(lyric.scale);
                            }

                            // Physics override params (passed to all modes)
                            const physicsOpts = {};
                            for (const pk of ['spring', 'damping', 'noiseStrength', 'noiseScale', 'vortex', 'wave', 'gravity', 'pointScale', 'convUp', 'convDn', 'lerpRate']) {
                                if (lyric[pk] != null) physicsOpts[pk] = lyric[pk];
                            }

                            if (lyric.mode === 'sculpture' && lyric.textB && comp.setShadowSculptureTarget) {
                                comp.setShadowSculptureTarget(lyric.text, lyric.textB, {
                                    maxConvergence: lyric.maxConvergence,
                                    holdDuration: lyric.holdDuration,
                                    releaseSpeed: lyric.releaseSpeed,
                                    ...physicsOpts
                                });
                            } else if (hasText) {
                                comp.setText(lyric.text, {
                                    animation: lyric.animation,
                                    viewDirection: lyric.viewDirection,
                                    maxConvergence: lyric.maxConvergence,
                                    holdDuration: lyric.holdDuration,
                                    releaseSpeed: lyric.releaseSpeed,
                                    dissolveMode: lyric.dissolveMode,
                                    origin: lyric.origin,
                                    targetWidth: lyric.targetWidth,
                                    backgroundPattern: lyric.backgroundPattern,
                                    textRatio: lyric.textRatio,
                                    align: lyric.align,
                                    particleGroup: lyric.particleGroup ?? 0,
                                    groupBPattern: lyric.groupBPattern,
                                    groupBConvergence: lyric.groupBConvergence,
                                    groupBOrigin: lyric.groupBOrigin,
                                    groupBScale: lyric.groupBScale,
                                    ...physicsOpts
                                });
                            }
                            if (comp.setMode) {
                                comp.setMode(lyric.mode || 'text', lyric.pattern, physicsOpts);
                            }
                        }
                        break;
                    }
                }

                // Lyric-level projection switching
                if (lyric.projection) {
                    this.sceneManager.switchProjectionLive(lyric.projection, {
                        orthoSize: lyric.orthoSize
                    });
                    // Update OrbitControls camera reference if in explore mode
                    if (this._orbitControls) {
                        this._orbitControls.object = this.sceneManager.camera;
                    }
                }

                console.log('[MVEngine] Lyric → particle text:', lyric.text || `[${lyric.mode}]`);
                if (this._breakdownMode) {
                    if (hasText) {
                        const extras = [];
                        if (lyric.animation) extras.push(lyric.animation);
                        if (lyric.holdDuration) extras.push(`hold=${lyric.holdDuration}s`);
                        if (lyric.spring) extras.push(`spring=${lyric.spring}`);
                        if (lyric.convUp) extras.push(`convUp=${lyric.convUp}`);
                        if (lyric.viewDirection) extras.push(`dir=[${lyric.viewDirection}]`);
                        this._bdLog('lyric', `"${lyric.text}" ${extras.length ? '[' + extras.join(', ') + ']' : ''}`);
                    } else {
                        const extras = [];
                        if (lyric.pattern) extras.push(lyric.pattern);
                        if (lyric.spring) extras.push(`spring=${lyric.spring}`);
                        if (lyric.noiseStrength) extras.push(`noise=${lyric.noiseStrength}`);
                        if (lyric.vortex) extras.push(`vortex=${lyric.vortex}`);
                        if (lyric.lerpRate) extras.push(`lerp=${lyric.lerpRate}`);
                        this._bdLog('flow', extras.join(', ') || 'auto');
                    }
                }
            }
        }
    }

    /**
     * Show the end screen
     */
    _showEndScreen() {
        this._removePersistentBar();

        // Hide explore mode UI
        if (this._breakdownMode) {
            this._breakdownMode = false;
            this._disableBreakdown();
        }

        // Remove start screen if still present
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        // Remove help overlay if still present
        if (this._helpOverlay) {
            this._helpOverlay.remove();
            this._helpOverlay = null;
        }

        // Don't create a duplicate end screen
        if (this.endScreen) return;

        // Do not stop rendering — particles keep drifting in the background

        const config = this.endScreenConfig;
        this._endLang = this._startLang || 'ja';

        const endI18n = {
            ja: { replay: 'もう一度', nico: 'ニコニコ動画で再生 ↗', about: '制作について' },
            en: { replay: 'Replay', nico: 'Play on Niconico ↗', about: 'About' },
        };
        this._endI18n = endI18n;

        this.endScreen = document.createElement('div');
        this.endScreen.className = 'mv-end-screen';

        this.endScreen.innerHTML = `
      <div class="mv-end-content">
        <div class="mv-end-title"><img src="${import.meta.env.BASE_URL}assets/svg/title.svg" alt="にび" class="mv-svg-title" /></div>
        <div class="mv-end-meta"><a class="mv-meta-link" href="https://monotonmusic.com" target="_blank" rel="noopener"><img src="${import.meta.env.BASE_URL}assets/svg/monoton.svg" alt="monoton" class="mv-svg-monoton" /></a></div>
        <div class="mv-end-actions">
          <button class="mv-end-btn mv-replay-button"></button>
        </div>
        <div class="mv-end-nico-row">
          <a class="mv-end-btn mv-end-nico-link" href="https://www.nicovideo.jp/watch/sm45971593" target="_blank" rel="noopener"></a>
        </div>
        <div class="mv-end-about">
          <button class="mv-end-btn mv-end-about-btn"></button>
        </div>
        <div class="mv-end-bottom">
          <span class="mv-end-lang">
            <button class="mv-end-lang-btn" data-lang="ja">日本語</button>
            <span class="mv-end-lang-sep">/</span>
            <button class="mv-end-lang-btn" data-lang="en">English</button>
          </span>
        </div>
      </div>
    `;

        this._applyEndScreenStyles();

        const replayBtn = this.endScreen.querySelector('.mv-replay-button');
        replayBtn.addEventListener('click', () => this._replay());

        this.endScreen.querySelector('.mv-end-about-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this._showAboutModal(this._endLang);
        });

        this.endScreen.querySelectorAll('.mv-end-lang-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._endLang = btn.dataset.lang;
                this._updateEndTexts();
            });
        });
        this._updateEndTexts();

        this.container.appendChild(this.endScreen);

        setTimeout(() => {
            if (this.endScreen) this.endScreen.style.opacity = '1';
        }, 50);

        console.log('[MVEngine] End screen displayed');
    }

    _updateEndTexts() {
        if (!this.endScreen) return;
        const t = this._endI18n[this._endLang] || this._endI18n.ja;
        this.endScreen.querySelector('.mv-replay-button').textContent = t.replay;
        this.endScreen.querySelector('.mv-end-nico-link').textContent = t.nico;
        this.endScreen.querySelector('.mv-end-about-btn').textContent = t.about;
        this.endScreen.querySelectorAll('.mv-end-lang-btn').forEach(btn => {
            btn.style.opacity = btn.dataset.lang === this._endLang ? '1' : '0.4';
        });
    }

    _applyEndScreenStyles() {
        this.endScreen.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      align-items: flex-end;
      justify-content: flex-start;
      z-index: 100;
      opacity: 0;
      overflow: hidden;
      background: transparent;
      transition: opacity 0.8s ease;
    `;

        const content = this.endScreen.querySelector('.mv-end-content');
        content.style.cssText = `
      position: relative;
      text-align: left;
      color: #000;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 2rem;
      z-index: 1;
      -webkit-font-smoothing: antialiased;
    `;

        const title = this.endScreen.querySelector('.mv-end-title');
        title.style.cssText = `
      margin-bottom: 1.2rem;
      line-height: 0;
    `;
        const titleImg = title.querySelector('.mv-svg-title');
        if (titleImg) titleImg.style.cssText = `
      height: clamp(2.5rem, 5vw, 4.5rem);
      width: auto;
      display: block;
    `;

        const credits = this.endScreen.querySelector('.mv-end-credits');
        if (credits) {
            credits.style.cssText = `
        margin-bottom: 2rem;
      `;
        }
        const creditLine = this.endScreen.querySelector('.mv-end-credit-line');
        if (creditLine) {
            creditLine.style.cssText = `
        font-size: 0.65rem;
        opacity: 0.4;
        letter-spacing: 0.03em;
      `;
        }

        const meta = this.endScreen.querySelector('.mv-end-meta');
        if (meta) {
            meta.style.cssText = `
        line-height: 0;
        margin-bottom: 0.6rem;
      `;
            const metaImg = meta.querySelector('.mv-svg-monoton');
            if (metaImg) metaImg.style.cssText = `
        height: 1rem;
        width: auto;
        display: block;
      `;
        }

        const actions = this.endScreen.querySelector('.mv-end-actions');
        if (actions) {
            actions.style.cssText = `
        display: flex;
        gap: 0.75rem;
      `;
        }

        this.endScreen.querySelectorAll('.mv-end-btn').forEach(btn => {
            btn.style.cssText = `
        position: relative;
        background: transparent;
        color: #000;
        border: none;
        padding: 0.3rem 0;
        font-size: 0.85rem;
        letter-spacing: 0.05em;
        cursor: pointer;
        font-family: inherit;
        transition: opacity 0.2s ease;
        -webkit-font-smoothing: antialiased;
      `;
        });

        const nicoRow = this.endScreen.querySelector('.mv-end-nico-row');
        if (nicoRow) {
            nicoRow.style.cssText = `margin-top: 1rem;`;
        }
        const nicoLink = this.endScreen.querySelector('.mv-end-nico-link');
        if (nicoLink) {
            nicoLink.style.cssText += `
        font-size: 0.95rem !important;
        opacity: 0.7;
        text-decoration: none;
      `;
        }

        const bottomDiv = this.endScreen.querySelector('.mv-end-bottom');
        if (bottomDiv) {
            bottomDiv.style.cssText = `margin-top: 0.8rem;`;
        }
        this.endScreen.querySelectorAll('.mv-end-lang-btn').forEach(btn => {
            btn.style.cssText = `
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        font-size: 0.65rem;
        color: inherit;
        cursor: pointer;
        letter-spacing: 0.05em;
      `;
        });
        this.endScreen.querySelectorAll('.mv-end-lang-sep').forEach(sep => {
            sep.style.cssText = `font-size: 0.65rem; opacity: 0.3;`;
        });
    }

    /**
     * Toggle fullscreen
     */
    async _toggleFullscreen() {
        const doc = document;
        const elem = document.documentElement;

        if (doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement) {
            // Exit fullscreen
            if (doc.exitFullscreen) {
                await doc.exitFullscreen();
            } else if (doc.webkitExitFullscreen) {
                await doc.webkitExitFullscreen();
            } else if (doc.msExitFullscreen) {
                await doc.msExitFullscreen();
            }
        } else {
            // Enter fullscreen
            await this._requestFullscreen();
        }

        // Update button text
        const fsBtn = this.endScreen?.querySelector('.mv-fullscreen-button');
        if (fsBtn) {
            this._updateFullscreenButton(fsBtn);
        }
    }

    /**
     * Update fullscreen button text
     */
    _updateFullscreenButton(btn) {
        const doc = document;
        const isFullscreen = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
        btn.textContent = isFullscreen ? 'フルスクリーン解除' : 'フルスクリーン';
    }

    /**
     * Replay (return to start screen)
     */
    async _replay() {
        this._removePauseOverlay();
        this._removePersistentBar();

        // Remove end screen
        if (this.endScreen) {
            this.endScreen.remove();
            this.endScreen = null;
        }

        // Turn off Breakdown mode
        if (this._breakdownMode) {
            this._breakdownMode = false;
            this._disableBreakdown();
        }

        // Stop existing render loop
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        // Stop background rendering too
        this._bgRunning = false;
        if (this._bgRafId) {
            cancelAnimationFrame(this._bgRafId);
            this._bgRafId = null;
        }

        // Reset audio
        this.audio.pause();
        this.audio.seek(0);

        // Reset engine state
        this.timeline.reset();
        this.firedLyricIndices.clear();
        this.isPlaying = false;
        this._starting = false;

        // Kill lingering GSAP tweens on canvas
        if (this.sceneManager.renderer?.domElement) {
            gsap.killTweensOf(this.sceneManager.renderer.domElement);
        }

        // Reset components to initial state WITHOUT dispose/recreate
        // (avoids costly WebGPU shader recompilation that causes freeze)
        for (const comp of this.sceneManager.activeComponents) {
            if (comp.setMode) comp.setMode('flow');
        }

        // Reset camera to initial position
        if (this.sceneManager.cameraController) {
            const camConfig = this.sceneManager.currentSceneData?.camera;
            if (camConfig?.keyframes) {
                this.sceneManager.cameraController.loadKeyframes(camConfig.keyframes);
            }
            if (camConfig?.position) {
                this.sceneManager.camera.position.set(...camConfig.position);
            }
            if (camConfig?.lookAt) {
                this.sceneManager.cameraController.lookAtTarget.set(...camConfig.lookAt);
                this.sceneManager.camera.lookAt(this.sceneManager.cameraController.lookAtTarget);
            }
        }

        // Recreate start overlay (bg render skips loadScene since scene already loaded)
        this._createStartOverlay();

        console.log('[MVEngine] Replay started');
    }

    /**
     * Toggle pause/play (for debug use)
     */
    async toggle() {
        try {
            await this.audio.toggle();
            this.isPlaying = this.audio.isPlaying;
            if (this.isPlaying) {
                this._removePauseOverlay();
                // If user hid breakdown with B, keep it hidden on resume
                if (this._bdHiddenByUser && this._breakdownMode) {
                    this._breakdownMode = false;
                    this._disableBreakdown();
                }
            } else {
                // Always show breakdown UI when paused (has its own play/pause button)
                if (!this._breakdownMode) {
                    this._breakdownMode = true;
                    this._enableBreakdown();
                }
            }
        } catch (error) {
            this._showAudioUnlockOverlay();
            console.warn('[MVEngine] Audio toggle blocked:', error);
        }
    }

    _showPauseOverlay() {
        if (this._pauseOverlay) return;
        const lang = this._bdLang || this._startLang || 'ja';
        const tapHint = lang === 'en' ? 'Tap to resume' : 'タップで再開';

        const el = document.createElement('div');
        el.className = 'mv-pause-overlay';
        el.innerHTML = `<div class="mv-pause-hint">${tapHint}</div>`;
        Object.assign(el.style, {
            position: 'absolute',
            inset: '0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: '85',
            opacity: '0',
            transition: 'opacity 0.3s ease',
            cursor: 'pointer',
        });
        const hint = el.querySelector('.mv-pause-hint');
        Object.assign(hint.style, {
            fontFamily: "'Zen Kaku Gothic New', sans-serif",
            fontSize: '0.7rem',
            color: '#000',
            opacity: '0.35',
        });

        el.addEventListener('click', () => this.toggle());

        this.container.appendChild(el);
        this._pauseOverlay = el;
        requestAnimationFrame(() => { el.style.opacity = '1'; });
    }

    _removePauseOverlay() {
        if (!this._pauseOverlay) return;
        const el = this._pauseOverlay;
        this._pauseOverlay = null;
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    }

    _showPersistentBar() {
        if (this._persistentBar) return;
        const lang = this._startLang || 'ja';
        const nicoText = lang === 'en' ? 'Watch on niconico ↗' : 'ニコニコ動画で再生 ↗';
        const showVolume = window.innerWidth >= 600;
        const curVol = this.audio.audioElement ? this.audio.audioElement.volume : 1;

        const bar = document.createElement('div');
        bar.className = 'mv-persistent-bar';
        bar.innerHTML = `<a class="mv-bar-nico" href="https://www.nicovideo.jp/watch/sm45971593" target="_blank" rel="noopener">${nicoText}</a>`;
        Object.assign(bar.style, {
            position: 'fixed',
            bottom: '3.4rem',
            right: '0.6rem',
            display: 'flex',
            alignItems: 'center',
            fontFamily: "'Zen Kaku Gothic New', sans-serif",
            zIndex: '92',
            pointerEvents: 'auto',
        });
        const nico = bar.querySelector('.mv-bar-nico');
        Object.assign(nico.style, {
            color: '#000',
            textDecoration: 'underline',
            textUnderlineOffset: '3px',
            opacity: '0.8',
            transition: 'opacity 0.2s',
            whiteSpace: 'nowrap',
            fontSize: '1rem',
            fontWeight: '600',
        });
        nico.addEventListener('mouseenter', () => { nico.style.opacity = '1'; });
        nico.addEventListener('mouseleave', () => { nico.style.opacity = '0.8'; });

        this.container.appendChild(bar);
        this._persistentBar = bar;
    }

    _removePersistentBar() {
        if (this._persistentBar) {
            this._persistentBar.remove();
            this._persistentBar = null;
        }
    }

    _showAudioUnlockOverlay() {
        if (this._audioUnlockOverlay) return;
        const overlay = document.createElement('div');
        overlay.className = 'mv-audio-unlock';
        overlay.innerHTML = `
      <div class="mv-audio-unlock-content">
        <div class="mv-audio-unlock-title">Audio Locked</div>
        <div class="mv-audio-unlock-subtitle">Click to enable sound</div>
      </div>
    `;
        overlay.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(5, 6, 7, 0.65);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      z-index: 120;
      cursor: pointer;
      text-align: center;
    `;
        const content = overlay.querySelector('.mv-audio-unlock-content');
        content.style.cssText = `
      padding: 18px 22px;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 12px;
      backdrop-filter: blur(6px);
      background: rgba(0, 0, 0, 0.35);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 0.75rem;
    `;
        const title = overlay.querySelector('.mv-audio-unlock-title');
        title.style.cssText = `
      font-size: 0.85rem;
      margin-bottom: 0.35rem;
      opacity: 0.9;
    `;
        const subtitle = overlay.querySelector('.mv-audio-unlock-subtitle');
        subtitle.style.cssText = `
      font-size: 0.7rem;
      opacity: 0.6;
    `;

        overlay.addEventListener('click', async () => {
            try {
                await this.audio.play();
                this.isPlaying = true;
                overlay.remove();
                this._audioUnlockOverlay = null;
            } catch (error) {
                console.warn('[MVEngine] Audio unlock failed:', error);
            }
        });

        this._audioUnlockOverlay = overlay;
        this.container.appendChild(overlay);
    }

    /**
     * Help overlay (how to play)
     */
    _showAboutModal(initialLang) {
        if (this._aboutModal) return;

        const i18n = {
            ja: {
                title: '制作について',
                credits: [
                    { label: '制作', value: 'monoton / Haruma Tasaki (Philtz)' },
                    { label: '', value: '<a class="mv-meta-link" href="https://monotonmusic.com" target="_blank" rel="noopener">monotonmusic.com</a> · <a class="mv-meta-link" href="https://philtz.com" target="_blank" rel="noopener">philtz.com</a>' },
                    { label: 'システム', value: '自作のWebベース実行型MVシステム' },
                    { label: '描画', value: 'Three.js WebGPU / WebGL 2' },
                    { label: 'パーティクル演算', value: 'TSL Compute Shaders' },
                    { label: '音声解析', value: 'Web Audio API' },
                    { label: 'ビルド', value: 'Vite' },
                    { label: '動画', value: '<a class="mv-meta-link" href="https://www.nicovideo.jp/watch/sm45971593" target="_blank" rel="noopener">nicovideo.jp/watch/sm45971593</a>' },
                ],
                note: 'この作品は<a class="mv-meta-link" href="https://www.nicovideo.jp/watch/sm45971593" target="_blank" rel="noopener">ボカコレ2026冬 ルーキー</a>に参加しています。',
                thanks: 'Special Thanks: デバッグに協力してくれた<a class="mv-meta-link" href="https://philtz.com" target="_blank" rel="noopener">Philtz</a>の皆さん',
                close: '×',
            },
            en: {
                title: 'About',
                credits: [
                    { label: 'Created by', value: 'monoton / Haruma Tasaki (Philtz)' },
                    { label: '', value: '<a class="mv-meta-link" href="https://monotonmusic.com" target="_blank" rel="noopener">monotonmusic.com</a> · <a class="mv-meta-link" href="https://philtz.com" target="_blank" rel="noopener">philtz.com</a>' },
                    { label: 'System', value: 'Self-built web-based executable MV system' },
                    { label: 'Rendering', value: 'Three.js WebGPU / WebGL 2' },
                    { label: 'Particle physics', value: 'TSL Compute Shaders' },
                    { label: 'Audio analysis', value: 'Web Audio API' },
                    { label: 'Build', value: 'Vite' },
                    { label: 'Video', value: '<a class="mv-meta-link" href="https://www.nicovideo.jp/watch/sm45971593" target="_blank" rel="noopener">nicovideo.jp/watch/sm45971593</a>' },
                ],
                note: 'This work is an entry for <a class="mv-meta-link" href="https://www.nicovideo.jp/watch/sm45971593" target="_blank" rel="noopener">Vocaloid Collection 2026 Winter (Rookie)</a>.',
                thanks: 'Special Thanks: Everyone at <a class="mv-meta-link" href="https://philtz.com" target="_blank" rel="noopener">Philtz</a> for debugging support',
                close: '×',
            },
        };

        let lang = initialLang || 'ja';

        const modal = document.createElement('div');
        this._aboutModal = modal;

        const render = () => {
            const t = i18n[lang];
            const creditsHtml = t.credits.map(c =>
                `<div class="mv-about-row"><div class="mv-about-label">${c.label}</div><div class="mv-about-value">${c.value}</div></div>`
            ).join('');
            modal.innerHTML = `
                <div class="mv-about-content">
                    <div class="mv-about-header">
                        <div class="mv-about-title">${t.title}</div>
                        <button class="mv-about-close">${t.close}</button>
                    </div>
                    <div class="mv-about-credits">${creditsHtml}</div>
                    ${t.note ? `<div class="mv-about-note">${t.note}</div>` : ''}
                    ${t.thanks ? `<div class="mv-about-thanks">${t.thanks}</div>` : ''}
                </div>
            `;

            modal.style.cssText = `
                position: absolute;
                inset: 0;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 120;
                background: rgba(0,0,0,0.6);
            `;
            const content = modal.querySelector('.mv-about-content');
            content.style.cssText = `
                background: #fff;
                color: #000;
                padding: 2rem;
                max-width: min(480px, 90vw);
                width: 100%;
                font-family: neue-haas-grotesk-display, sans-serif;
                font-size: 0.8rem;
                letter-spacing: 0.02em;
            `;
            modal.querySelector('.mv-about-header').style.cssText = `
                display: flex;
                justify-content: space-between;
                align-items: baseline;
                margin-bottom: 1.5rem;
            `;
            modal.querySelector('.mv-about-title').style.cssText = `
                font-size: 0.9rem;
                font-weight: 500;
                letter-spacing: 0.05em;
            `;
            modal.querySelector('.mv-about-close').style.cssText = `
                background: none;
                border: none;
                cursor: pointer;
                font-size: 1.1rem;
                color: #000;
                padding: 0;
                line-height: 1;
            `;
            modal.querySelectorAll('.mv-about-row').forEach(row => {
                row.style.cssText = `
                    display: grid;
                    grid-template-columns: 1fr 1.6fr;
                    gap: 0.5rem;
                    margin-bottom: 0.8rem;
                    align-items: start;
                `;
            });
            modal.querySelectorAll('.mv-about-label').forEach(el => {
                el.style.cssText = `opacity: 0.5; font-size: 0.72rem;`;
            });
            const noteEl = modal.querySelector('.mv-about-note');
            if (noteEl) noteEl.style.cssText = `margin-top: 1.2rem; font-size: 0.75rem; opacity: 0.6; line-height: 1.6;`;
            const thanksEl = modal.querySelector('.mv-about-thanks');
            if (thanksEl) thanksEl.style.cssText = `margin-top: 0.8rem; font-size: 0.72rem; opacity: 0.45; line-height: 1.6;`;

            const close = () => {
                modal.remove();
                this._aboutModal = null;
            };
            modal.querySelector('.mv-about-close').addEventListener('click', close);
            modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
        };

        render();
        this.container.appendChild(modal);
    }

    _showHelpOverlay() {
        if (this._helpOverlay) return;

        const i18n = {
            ja: {
                title: '操作方法',
                modesHeading: '再生モード',
                modesText: '一時停止中にマウスで視点を自由に動かせます',
                keyboardHeading: 'キーボード操作',
                keys: '<span class="mv-help-key">Space</span> 再生 / 一時停止<br><span class="mv-help-key">B</span> 操作パネルの表示切替<br><span class="mv-help-key">R</span> 最初から再生',
                interactiveHeading: 'カメラ操作',
                interactiveText: 'マウスドラッグ — 視点を動かす<br>スクロール — 近づく・離れる',
                credit: 'Music, Visuals and Web Development by <a class="mv-meta-link" href="https://monotonmusic.com" target="_blank" rel="noopener">monoton / Haruma Tasaki</a> (<a class="mv-meta-link" href="https://philtz.com" target="_blank" rel="noopener">Philtz</a>)',
                close: '\u00d7',
            },
            en: {
                title: 'Controls',
                modesHeading: 'Modes',
                modesText: '<strong>Play</strong> — Playback<br><strong>Fullscreen</strong> — Fullscreen playback<br><strong>Free Camera</strong> — Move the camera freely',
                keyboardHeading: 'Keyboard',
                keys: '<span class="mv-help-key">Space</span> pause / play<br><span class="mv-help-key">B</span> toggle free camera<br><span class="mv-help-key">R</span> restart',
                interactiveHeading: 'Free Camera',
                interactiveText: 'Drag — rotate view<br>Scroll — zoom',
                credit: 'Music, Visuals and Web Development by <a class="mv-meta-link" href="https://monotonmusic.com" target="_blank" rel="noopener">monoton / Haruma Tasaki</a> (<a class="mv-meta-link" href="https://philtz.com" target="_blank" rel="noopener">Philtz</a>)',
                close: '\u00d7',
            }
        };

        let lang = 'ja';

        const overlay = document.createElement('div');
        overlay.className = 'mv-help-overlay';

        const render = () => {
            const t = i18n[lang];
            overlay.innerHTML = `
                <div class="mv-help-content">
                    <div class="mv-help-top">
                        <div class="mv-help-title">${t.title}</div>
                        <div class="mv-help-lang">
                            <button class="mv-help-lang-btn ${lang === 'ja' ? 'active' : ''}" data-lang="ja">日本語</button>
                            <span class="mv-help-lang-sep">/</span>
                            <button class="mv-help-lang-btn ${lang === 'en' ? 'active' : ''}" data-lang="en">English</button>
                        </div>
                    </div>
                    <div class="mv-help-section">
                        <div class="mv-help-heading">${t.modesHeading}</div>
                        <div class="mv-help-text">${t.modesText}</div>
                    </div>
                    <div class="mv-help-section">
                        <div class="mv-help-heading">${t.keyboardHeading}</div>
                        <div class="mv-help-keys">${t.keys}</div>
                    </div>
                    <div class="mv-help-section">
                        <div class="mv-help-heading">${t.interactiveHeading}</div>
                        <div class="mv-help-text">${t.interactiveText}</div>
                    </div>
                    <div class="mv-help-credit">${t.credit}</div>
                    <button class="mv-help-close">${t.close}</button>
                </div>
            `;
            this._applyHelpStyles(overlay);

            overlay.querySelector('.mv-help-close').addEventListener('click', close);
            overlay.querySelectorAll('.mv-help-lang-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    lang = btn.dataset.lang;
                    render();
                });
            });
        };

        overlay.style.cssText = `
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 110;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(6px);
            cursor: pointer;
        `;

        const close = () => {
            overlay.remove();
            this._helpOverlay = null;
        };

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });

        render();
        this._helpOverlay = overlay;
        this.container.appendChild(overlay);
    }

    _applyHelpStyles(overlay) {
        const content = overlay.querySelector('.mv-help-content');
        content.style.cssText = `
            position: relative;
            background: rgba(255, 255, 255, 0.95);
            color: #111;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            padding: 2rem 2.5rem;
            border-radius: 8px;
            max-width: 420px;
            width: 90%;
            cursor: default;
            -webkit-font-smoothing: antialiased;
        `;

        const top = overlay.querySelector('.mv-help-top');
        top.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 1.2rem;
        `;

        overlay.querySelector('.mv-help-title').style.cssText = `
            font-size: 1.1rem;
            font-weight: 500;
        `;

        const langWrap = overlay.querySelector('.mv-help-lang');
        langWrap.style.cssText = `
            display: flex;
            align-items: center;
            gap: 0.2rem;
        `;
        overlay.querySelectorAll('.mv-help-lang-btn').forEach(btn => {
            const isActive = btn.classList.contains('active');
            btn.style.cssText = `
                background: none;
                border: none;
                font-family: inherit;
                font-size: 0.7rem;
                letter-spacing: 0.05em;
                cursor: pointer;
                padding: 0;
                color: #111;
                opacity: ${isActive ? '0.8' : '0.3'};
                transition: opacity 0.15s;
            `;
        });
        overlay.querySelector('.mv-help-lang-sep').style.cssText = `
            font-size: 0.65rem;
            opacity: 0.2;
        `;

        overlay.querySelectorAll('.mv-help-section').forEach(s => {
            s.style.cssText = `margin-bottom: 1rem;`;
        });
        overlay.querySelectorAll('.mv-help-heading').forEach(h => {
            h.style.cssText = `
                font-size: 0.7rem;
                text-transform: uppercase;
                letter-spacing: 0.1em;
                opacity: 0.4;
                margin-bottom: 0.3rem;
            `;
        });
        overlay.querySelectorAll('.mv-help-text, .mv-help-keys').forEach(t => {
            t.style.cssText = `
                font-size: 0.82rem;
                line-height: 1.7;
                opacity: 0.75;
            `;
        });
        overlay.querySelectorAll('.mv-help-key').forEach(k => {
            k.style.cssText = `
                display: inline-block;
                background: rgba(0,0,0,0.08);
                border-radius: 3px;
                padding: 0 0.4em;
                font-family: 'SF Mono', 'Menlo', monospace;
                font-size: 0.75rem;
                margin-right: 0.2em;
            `;
        });

        const credit = overlay.querySelector('.mv-help-credit');
        if (credit) {
            credit.style.cssText = `
                font-size: 0.65rem;
                opacity: 0.35;
                margin-top: 1.2rem;
                padding-top: 1rem;
                border-top: 1px solid rgba(0,0,0,0.08);
                line-height: 1.5;
            `;
        }

        const closeBtn = overlay.querySelector('.mv-help-close');
        closeBtn.style.cssText = `
            position: absolute;
            top: 0.8rem;
            right: 0.8rem;
            background: transparent;
            border: none;
            color: #111;
            font-size: 1rem;
            line-height: 1;
            cursor: pointer;
            opacity: 0.4;
            font-family: inherit;
            padding: 0.2em 0.35em;
        `;
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = '#111';
            closeBtn.style.color = '#fff';
            closeBtn.style.opacity = '1';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'transparent';
            closeBtn.style.color = '#111';
            closeBtn.style.opacity = '0.4';
        });
    }

    /**
     * Toggle Breakdown/Cinema mode
     */
    toggleBreakdown() {
        this._breakdownMode = !this._breakdownMode;
        this._bdHiddenByUser = !this._breakdownMode;
        if (this._breakdownMode) {
            this._enableBreakdown();
        } else {
            this._disableBreakdown();
        }
    }

    /**
     * Cycle patterns in explore mode (left/right arrow keys)
     */
    cyclePattern(delta) {
        if (!this._breakdownMode) return;

        // Lazy-init: build combined pattern list from component
        if (!this._bdAllPatterns) {
            for (const comp of this.sceneManager.activeComponents) {
                if (comp.getAllPatternNames) {
                    this._bdAllPatterns = comp.getAllPatternNames();
                    break;
                }
            }
            if (!this._bdAllPatterns) return;
        }

        const len = this._bdAllPatterns.length;
        this._bdPatternIdx = ((this._bdPatternIdx + delta) % len + len) % len;
        const name = this._bdAllPatterns[this._bdPatternIdx];

        for (const comp of this.sceneManager.activeComponents) {
            if (comp.setMode) {
                comp.setMode('flow', name);
                break;
            }
        }
        this._bdLog('flow', `${name} (${this._bdPatternIdx + 1}/${len})`);
    }

    /**
     * Reset camera to authored view at current musicTime (C key)
     */
    resetToAuthoredView() {
        if (!this._breakdownMode) return;
        const cc = this.sceneManager.cameraController;
        if (!cc) return;

        // Disable OrbitControls and switch to authored path following
        if (this._orbitControls) {
            this._orbitControls.enabled = false;
        }
        cc.setMode('path');
        this._followingAuthoredPath = true;

        // Listen for user interaction to break out of path following
        if (!this._bdPathBreakHandler) {
            this._bdPathBreakHandler = () => {
                if (this._followingAuthoredPath) {
                    this._followingAuthoredPath = false;
                    if (cc) cc.setMode('static');

                    // Reset to orbit view looking at origin, pulled back from frustum
                    const cam = this.sceneManager.camera;
                    if (cam && this._orbitControls) {
                        const dir = new THREE.Vector3();
                        cam.getWorldDirection(dir);
                        cam.position.addScaledVector(dir, -2.0);
                        this._orbitControls.target.set(0, 0, 0);
                        cam.fov = 50;
                        cam.updateProjectionMatrix();
                        this._orbitControls.enabled = true;
                        this._orbitControls.update();
                    }

                    this._showBdIndicator(this._bdLang === 'ja' ? '自由操作' : 'free control');
                    this._bdLog('cam', 'returned to free control');
                }
            };
            const el = this.sceneManager.renderer?.domElement;
            if (el) {
                el.addEventListener('mousedown', this._bdPathBreakHandler);
                el.addEventListener('touchstart', this._bdPathBreakHandler);
                el.addEventListener('wheel', this._bdPathBreakHandler);
            }
        }

        this._showBdIndicator(this._bdLang === 'ja' ? '演出パスに追従中' : 'following authored path');
        this._bdLog('cam', `following authored path`);
    }

    /**
     * Toggle camera path visualization (V key)
     */
    toggleCameraPathViz() {
        if (!this._breakdownMode) return;
        if (this._bdCameraPathViz) {
            this._removeCameraPathViz();
        } else {
            this._createCameraPathViz();
        }
    }

    _createCameraPathViz() {
        const cc = this.sceneManager.cameraController;
        if (!cc || !cc.keyframes || cc.keyframes.length === 0) return;

        const scene = this.sceneManager.scene;
        const group = new THREE.Group();
        group.name = 'cameraPathViz';

        // Sample path with time info
        const duration = this.audio.getDuration() || 160;
        const sampleTimes = [];
        const positions = [];
        for (let t = 0; t <= duration; t += 0.25) {
            const state = cc.getAuthoredStateAtTime(t);
            if (state) {
                sampleTimes.push(t);
                positions.push(state.position[0], state.position[1], state.position[2]);
            }
        }

        // Active segment line (2 points: start keyframe → end keyframe, updated per frame)
        const segPositions = new Float32Array(2 * 3);
        const segGeo = new THREE.BufferGeometry();
        segGeo.setAttribute('position', new THREE.BufferAttribute(segPositions, 3));
        const segMat = new THREE.LineBasicMaterial({
            color: 0x00ffff, // PP inverts → red
            linewidth: 3,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
            depthWrite: false
        });
        const segLine = new THREE.Line(segGeo, segMat);
        segLine.name = 'pathLine';
        segLine.renderOrder = 999;
        segLine.visible = false;
        group.add(segLine);

        // Store sorted keyframe data for segment lookup
        this._bdPathKfData = cc.keyframes
            .map(kf => ({ time: kf.time != null ? kf.time : 0 }))
            .sort((a, b) => a.time - b.time);
        // Resolve positions for each keyframe
        for (const kd of this._bdPathKfData) {
            const s = cc.getAuthoredStateAtTime(kd.time);
            if (s) kd.pos = new THREE.Vector3(s.position[0], s.position[1], s.position[2]);
        }

        // Endpoint markers (2 spheres, repositioned per frame)
        const sphereGeo = new THREE.SphereGeometry(0.012, 6, 6);
        const mkMat = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            depthTest: false, depthWrite: false
        });
        const mkStart = new THREE.Mesh(sphereGeo, mkMat.clone());
        const mkEnd = new THREE.Mesh(sphereGeo, mkMat);
        mkStart.name = 'segStart'; mkEnd.name = 'segEnd';
        mkStart.renderOrder = 1000; mkEnd.renderOrder = 1000;
        mkStart.visible = false; mkEnd.visible = false;
        group.add(mkStart); group.add(mkEnd);

        // Current position marker
        const cursorGeo = new THREE.SphereGeometry(0.03, 10, 10);
        const cursorMat = new THREE.MeshBasicMaterial({
            color: 0xff0000,
            opacity: 1.0,
            transparent: false,
            depthTest: false,
            depthWrite: false
        });
        const cursor = new THREE.Mesh(cursorGeo, cursorMat);
        cursor.renderOrder = 1001;
        cursor.name = 'pathCursor';
        cursor.visible = false;
        group.add(cursor);

        scene.add(group);
        this._bdCameraPathViz = group;
        this._bdLog('cam', 'path visualization ON');
    }

    _removeCameraPathViz() {
        if (this._bdCameraPathViz) {
            // Dispose geometries and materials
            this._bdCameraPathViz.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) obj.material.dispose();
            });
            this._bdCameraPathViz.removeFromParent();
            this._bdCameraPathViz = null;
            this._bdPathSampleTimes = null;
            this._bdPathKfData = null;
            this._bdLog('cam', 'path visualization OFF');
        }
    }

    _updateCameraPathCursor(musicTime) {
        if (!this._bdCameraPathViz) return;
        const cc = this.sceneManager.cameraController;
        if (!cc) return;
        const state = cc.getAuthoredStateAtTime(musicTime);
        if (!state) return;

        const ppOn = this.sceneManager.postProcessing?.enabled !== false;
        const segColor = ppOn ? 0x00ffff : 0xff0000;

        // Find current segment (prev keyframe → next keyframe)
        const kfData = this._bdPathKfData;
        const line = this._bdCameraPathViz.getObjectByName('pathLine');
        const mkStart = this._bdCameraPathViz.getObjectByName('segStart');
        const mkEnd = this._bdCameraPathViz.getObjectByName('segEnd');

        if (line && kfData && kfData.length >= 2) {
            let fromIdx = -1;
            for (let i = 0; i < kfData.length - 1; i++) {
                if (musicTime >= kfData[i].time && musicTime < kfData[i + 1].time) {
                    fromIdx = i; break;
                }
            }

            if (fromIdx >= 0 && kfData[fromIdx]?.pos && kfData[fromIdx + 1]?.pos) {
                const from = kfData[fromIdx], to = kfData[fromIdx + 1];
                // Detect segment change → start extend animation
                if (this._bdPathSegIdx !== fromIdx) {
                    this._bdPathSegIdx = fromIdx;
                    this._bdPathExtendStart = performance.now();
                }

                const extendDur = 300; // ms, linear
                const elapsed = performance.now() - (this._bdPathExtendStart || 0);
                const t = Math.min(elapsed / extendDur, 1.0);

                // Line from start → animated endpoint
                const endX = from.pos.x + (to.pos.x - from.pos.x) * t;
                const endY = from.pos.y + (to.pos.y - from.pos.y) * t;
                const endZ = from.pos.z + (to.pos.z - from.pos.z) * t;

                const arr = line.geometry.attributes.position.array;
                arr[0] = from.pos.x; arr[1] = from.pos.y; arr[2] = from.pos.z;
                arr[3] = endX;        arr[4] = endY;        arr[5] = endZ;
                line.geometry.attributes.position.needsUpdate = true;
                line.material.color.setHex(segColor);
                line.visible = true;

                if (mkStart) { mkStart.position.copy(from.pos); mkStart.material.color.setHex(segColor); mkStart.visible = true; }
                if (mkEnd) { mkEnd.position.set(endX, endY, endZ); mkEnd.material.color.setHex(segColor); mkEnd.visible = t >= 1.0; }
            } else {
                line.visible = false;
                if (mkStart) mkStart.visible = false;
                if (mkEnd) mkEnd.visible = false;
            }
        }

        // Cursor
        const cursorColor = ppOn ? 0x00ffff : 0xff0000;
        const cursor = this._bdCameraPathViz.getObjectByName('pathCursor');
        if (cursor) {
            cursor.material.color.setHex(cursorColor);
            cursor.position.set(state.position[0], state.position[1], state.position[2]);
            cursor.visible = true;
        }
    }

    _createCameraFrustumViz() {
        const cc = this.sceneManager.cameraController;
        if (!cc || !cc.keyframes || cc.keyframes.length === 0) return;
        const scene = this.sceneManager.scene;
        if (!scene) return;

        const group = new THREE.Group();
        group.name = 'cameraFrustumViz';

        const lineMat = new THREE.LineBasicMaterial({
            color: 0x000000, opacity: 0.85, transparent: true,
            depthTest: true, depthWrite: false
        });

        // Camera body wireframe box
        const boxGeo = new THREE.BoxGeometry(0.2, 0.14, 0.25);
        const edgesGeo = new THREE.EdgesGeometry(boxGeo);
        const boxLines = new THREE.LineSegments(edgesGeo, lineMat);
        boxLines.name = 'frustumBody';
        boxLines.renderOrder = 1002;
        group.add(boxLines);
        boxGeo.dispose();

        // FOV pyramid lines (4 lines from camera to near plane corners)
        const pyramidPositions = new Float32Array(4 * 2 * 3); // 4 lines × 2 points × 3 coords
        const pyramidGeo = new THREE.BufferGeometry();
        pyramidGeo.setAttribute('position', new THREE.BufferAttribute(pyramidPositions, 3));
        const pyramidLines = new THREE.LineSegments(pyramidGeo, lineMat);
        pyramidLines.name = 'frustumPyramid';
        pyramidLines.renderOrder = 1002;
        group.add(pyramidLines);

        // Near plane rectangle (4 lines)
        const nearPositions = new Float32Array(4 * 2 * 3); // 4 edges × 2 points × 3 coords
        const nearGeo = new THREE.BufferGeometry();
        nearGeo.setAttribute('position', new THREE.BufferAttribute(nearPositions, 3));
        const nearLines = new THREE.LineSegments(nearGeo, lineMat);
        nearLines.name = 'frustumNear';
        nearLines.renderOrder = 1002;
        group.add(nearLines);

        // Near plane preview mesh (textured quad showing authored camera view)
        const previewW = 384, previewH = 216;
        const previewRT = new THREE.RenderTarget(previewW, previewH);
        this._bdFrustumPreviewRT = previewRT;
        this._bdFrustumPreviewCam = new THREE.PerspectiveCamera(45, previewW / previewH, 0.1, 100);
        this._bdFrustumPreviewFrame = 0;

        const planeGeo = new THREE.BufferGeometry();
        // 4 vertices (TL, TR, BR, BL), updated each frame
        const planePos = new Float32Array(4 * 3);
        planeGeo.setAttribute('position', new THREE.BufferAttribute(planePos, 3));
        planeGeo.setIndex([0, 3, 1, 1, 3, 2]); // two triangles
        const planeUVs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
        planeGeo.setAttribute('uv', new THREE.BufferAttribute(planeUVs, 2));

        const planeMat = new THREE.MeshBasicMaterial({
            map: previewRT.texture,
            side: THREE.DoubleSide,
            depthTest: true,
            depthWrite: false,
            transparent: true,
            opacity: 1.0,
        });
        const planeMesh = new THREE.Mesh(planeGeo, planeMat);
        planeMesh.name = 'frustumPreview';
        planeMesh.renderOrder = 1001;
        group.add(planeMesh);

        // Status label (HTML overlay, screen-space — constant size)
        const labelEl = document.createElement('div');
        labelEl.style.cssText = "position:fixed;pointer-events:none;font:bold 11px 'SF Mono','Menlo',monospace;white-space:nowrap;z-index:100;display:none;";
        document.body.appendChild(labelEl);
        this._bdFrustumLabel = labelEl;

        group.visible = false; // hidden until first _updateCameraFrustumViz positions geometry
        scene.add(group);
        this._bdCameraFrustumViz = group;
    }

    _updateCameraFrustumViz(musicTime) {
        if (!this._bdCameraFrustumViz) return;

        // Hide frustum viz while following authored path (preview plane would cover the screen)
        if (this._followingAuthoredPath) {
            this._bdCameraFrustumViz.visible = false;
            if (this._bdFrustumLabel) this._bdFrustumLabel.style.display = 'none';
            return;
        }

        const cc = this.sceneManager.cameraController;
        if (!cc) return;
        const state = cc.getAuthoredStateAtTime(musicTime);
        if (!state) return;

        // Use white when PP inverts (so it becomes black), black when PP is off
        const ppOn = this.sceneManager.postProcessing?.enabled !== false;
        const lineColor = ppOn ? 0xffffff : 0x000000;
        this._bdCameraFrustumViz.traverse(obj => {
            if (obj.name === 'frustumPreview') return;
            if (obj.material && obj.material.color) obj.material.color.setHex(lineColor);
        });

        const pos = new THREE.Vector3(state.position[0], state.position[1], state.position[2]);
        const lookAt = new THREE.Vector3(state.lookAt[0], state.lookAt[1], state.lookAt[2]);
        const fov = state.fov || 45;
        const roll = state.roll || 0;

        // Compute orientation quaternion
        const forward = new THREE.Vector3().subVectors(lookAt, pos).normalize();
        const quat = new THREE.Quaternion();
        const mat = new THREE.Matrix4();
        const up = new THREE.Vector3(0, 1, 0);
        mat.lookAt(pos, lookAt, up);
        quat.setFromRotationMatrix(mat);
        // Apply roll
        if (roll !== 0) {
            const rollQuat = new THREE.Quaternion().setFromAxisAngle(forward, roll);
            quat.premultiply(rollQuat);
        }

        // Position and orient the body box
        const body = this._bdCameraFrustumViz.getObjectByName('frustumBody');
        if (body) {
            body.position.copy(pos);
            body.quaternion.copy(quat);
        }

        // Update status label (HTML overlay projected to screen)
        if (this._bdFrustumLabel && cc.keyframes) {
            // Project camera body top to screen
            const upDir2 = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
            const labelWorld = pos.clone().addScaledVector(upDir2, 0.2);
            const cam = this.sceneManager.camera;
            const projected = labelWorld.project(cam);
            const el = this.sceneManager.renderer?.domElement;
            if (el) {
                const x = (projected.x * 0.5 + 0.5) * el.clientWidth;
                const y = (-projected.y * 0.5 + 0.5) * el.clientHeight;
                // Hide if behind camera
                if (projected.z > 1) {
                    this._bdFrustumLabel.style.display = 'none';
                } else {
                    this._bdFrustumLabel.style.display = '';
                    this._bdFrustumLabel.style.left = x + 'px';
                    this._bdFrustumLabel.style.top = (y - 16) + 'px';
                    this._bdFrustumLabel.style.transform = 'translateX(-50%)';
                    this._bdFrustumLabel.style.color = ppOn ? '#000' : '#fff';

                    // Find current keyframe movement and progress within it
                    const kfs = cc.keyframes;
                    let kfIdx = 0, progress = 0, easing = '', dur = 0;
                    for (let i = 1; i < kfs.length; i++) {
                        const t0 = kfs[i].time != null ? kfs[i].time : 0;
                        dur = kfs[i].duration || 2;
                        if (musicTime >= t0 && musicTime < t0 + dur) {
                            kfIdx = i;
                            progress = (musicTime - t0) / dur;
                            easing = kfs[i].easing || 'power2.inOut';
                            break;
                        }
                    }
                    const pct = (progress * 100).toFixed(0);
                    this._bdFrustumLabel.textContent = `KF${kfIdx-1}→${kfIdx} ${pct}% ${dur.toFixed(1)}s ${easing} FOV${fov.toFixed(0)}`;
                }
            }
        }

        // Compute near plane corners
        const near = 0.8;
        const aspect = 16 / 9; // MV is always 16:9 regardless of viewport
        const halfH = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * near;
        const halfW = halfH * aspect;

        // Local directions
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
        const upDir = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);

        const nearCenter = new THREE.Vector3().copy(pos).addScaledVector(forward, near);
        const corners = [
            new THREE.Vector3().copy(nearCenter).addScaledVector(right, -halfW).addScaledVector(upDir, halfH),  // top-left
            new THREE.Vector3().copy(nearCenter).addScaledVector(right, halfW).addScaledVector(upDir, halfH),   // top-right
            new THREE.Vector3().copy(nearCenter).addScaledVector(right, halfW).addScaledVector(upDir, -halfH),  // bottom-right
            new THREE.Vector3().copy(nearCenter).addScaledVector(right, -halfW).addScaledVector(upDir, -halfH), // bottom-left
        ];

        // Update pyramid lines (4 lines from pos to each corner)
        const pyramid = this._bdCameraFrustumViz.getObjectByName('frustumPyramid');
        if (pyramid) {
            const arr = pyramid.geometry.attributes.position.array;
            for (let i = 0; i < 4; i++) {
                arr[i * 6 + 0] = pos.x; arr[i * 6 + 1] = pos.y; arr[i * 6 + 2] = pos.z;
                arr[i * 6 + 3] = corners[i].x; arr[i * 6 + 4] = corners[i].y; arr[i * 6 + 5] = corners[i].z;
            }
            pyramid.geometry.attributes.position.needsUpdate = true;
        }

        // Update near plane rectangle (4 edges: TL-TR, TR-BR, BR-BL, BL-TL)
        const nearLines = this._bdCameraFrustumViz.getObjectByName('frustumNear');
        if (nearLines) {
            const arr = nearLines.geometry.attributes.position.array;
            const edges = [[0, 1], [1, 2], [2, 3], [3, 0]];
            for (let i = 0; i < 4; i++) {
                const [a, b] = edges[i];
                arr[i * 6 + 0] = corners[a].x; arr[i * 6 + 1] = corners[a].y; arr[i * 6 + 2] = corners[a].z;
                arr[i * 6 + 3] = corners[b].x; arr[i * 6 + 4] = corners[b].y; arr[i * 6 + 5] = corners[b].z;
            }
            nearLines.geometry.attributes.position.needsUpdate = true;
        }

        // Update preview plane vertices to match near plane corners (TL, TR, BR, BL)
        const previewMesh = this._bdCameraFrustumViz.getObjectByName('frustumPreview');
        if (previewMesh) {
            const arr = previewMesh.geometry.attributes.position.array;
            for (let i = 0; i < 4; i++) {
                arr[i * 3 + 0] = corners[i].x;
                arr[i * 3 + 1] = corners[i].y;
                arr[i * 3 + 2] = corners[i].z;
            }
            previewMesh.geometry.attributes.position.needsUpdate = true;
        }

        // Make visible after first geometry update (prevents phantom at origin)
        if (!this._bdCameraFrustumViz.visible) this._bdCameraFrustumViz.visible = true;

        // Render preview from authored camera (every 3 frames to save perf)
        this._bdFrustumPreviewFrame = (this._bdFrustumPreviewFrame || 0) + 1;
        if (this._bdFrustumPreviewRT && this._bdFrustumPreviewCam && this._bdFrustumPreviewFrame % 3 === 0) {
            const renderer = this.sceneManager.renderer;
            const scene = this.sceneManager.scene;
            if (renderer && scene) {
                const cam = this._bdFrustumPreviewCam;
                cam.fov = fov;
                cam.position.copy(pos);
                cam.lookAt(lookAt);
                cam.updateProjectionMatrix();
                // Hide frustum viz and camera path during preview render
                this._bdCameraFrustumViz.visible = false;
                if (this._bdCameraPathViz) this._bdCameraPathViz.visible = false;
                renderer.setRenderTarget(this._bdFrustumPreviewRT);
                renderer.render(scene, cam);
                renderer.setRenderTarget(null);
                this._bdCameraFrustumViz.visible = true;
                if (this._bdCameraPathViz) this._bdCameraPathViz.visible = true;
            }
        }
    }

    _removeCameraFrustumViz() {
        if (this._bdCameraFrustumViz) {
            this._bdCameraFrustumViz.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (obj.material.map) obj.material.map = null;
                    obj.material.dispose();
                }
            });
            this._bdCameraFrustumViz.removeFromParent();
            this._bdCameraFrustumViz = null;
        }
        if (this._bdFrustumPreviewRT) {
            this._bdFrustumPreviewRT.dispose();
            this._bdFrustumPreviewRT = null;
        }
        this._bdFrustumPreviewCam = null;
        if (this._bdFrustumLabel) { this._bdFrustumLabel.remove(); this._bdFrustumLabel = null; }
    }

    _createAxisGizmo() {
        if (this._isMobileDevice) return;
        const size = 70;
        const canvas = document.createElement('canvas');
        canvas.width = size * 2; // retina
        canvas.height = size * 2;
        canvas.className = 'mv-bd-axis-gizmo';
        Object.assign(canvas.style, {
            position: 'fixed',
            bottom: '5.2rem',
            right: '0.6rem',
            width: `${size}px`,
            height: `${size}px`,
            zIndex: '91',
            pointerEvents: 'none',
            opacity: '0.7',
        });
        this.container.appendChild(canvas);
        this._bdAxisGizmo = canvas;
    }

    _updateAxisGizmo() {
        if (!this._bdAxisGizmo) return;
        const cam = this.sceneManager.camera;
        if (!cam) return;

        const canvas = this._bdAxisGizmo;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const cx = w / 2;
        const cy = h / 2;
        const len = w * 0.32;

        ctx.clearRect(0, 0, w, h);

        // Get camera rotation matrix (view matrix inverse rotation)
        const mat = new THREE.Matrix4().copy(cam.matrixWorldInverse);
        // Zero out translation
        mat.elements[12] = 0;
        mat.elements[13] = 0;
        mat.elements[14] = 0;

        // Axes in world space → project through camera rotation to screen
        const axes = [
            { dir: new THREE.Vector3(1, 0, 0), color: '#c03030', label: 'X' },
            { dir: new THREE.Vector3(0, 1, 0), color: '#30a030', label: 'Y' },
            { dir: new THREE.Vector3(0, 0, 1), color: '#222222', label: 'Z' },
        ];

        // Sort by depth (draw furthest first), with hysteresis to prevent flicker
        const projected = axes.map(a => {
            const v = a.dir.clone().applyMatrix4(mat);
            return { ...a, x: v.x, y: -v.y, z: v.z };
        });
        // Use previous order if depth differences are small
        if (this._bdAxisPrevOrder) {
            const prev = this._bdAxisPrevOrder;
            const needsResort = projected.some((a, i) => {
                const other = projected.find(p => p.label === prev[i]);
                if (!other) return true;
                return Math.abs(a.z - other.z) > 0.05;
            });
            if (!needsResort) {
                projected.sort((a, b) => prev.indexOf(a.label) - prev.indexOf(b.label));
            } else {
                projected.sort((a, b) => a.z - b.z);
            }
        } else {
            projected.sort((a, b) => a.z - b.z);
        }
        this._bdAxisPrevOrder = projected.map(p => p.label);

        for (const axis of projected) {
            const ex = cx + axis.x * len;
            const ey = cy + axis.y * len;
            // Fade axes pointing away
            const alpha = 0.3 + 0.7 * Math.max(0, (axis.z + 1) / 2);

            // Line
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(ex, ey);
            ctx.strokeStyle = axis.color;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = 2.5;
            ctx.stroke();

            // Arrowhead circle
            ctx.beginPath();
            ctx.arc(ex, ey, 5, 0, Math.PI * 2);
            ctx.fillStyle = axis.color;
            ctx.fill();

            // Label
            ctx.font = 'bold 16px SF Mono, Menlo, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = axis.color;
            ctx.fillText(axis.label, ex + (axis.x > 0 ? 10 : -10), ey + (axis.y > 0 ? 10 : -10));
            ctx.globalAlpha = 1;
        }
    }

    _removeAxisGizmo() {
        if (this._bdAxisGizmo) {
            this._bdAxisGizmo.remove();
            this._bdAxisGizmo = null;
        }
    }

    /**
     * Toggle post-processing CMYK inversion (F key)
     */
    togglePostProcessing() {
        if (!this._breakdownMode) return;
        const pp = this.sceneManager.postProcessing;
        if (!pp) return;
        pp.enabled = !pp.enabled;
        const state = pp.enabled ? 'CMYK' : 'RGB';
        this._showBdIndicator(state);
        this._bdLog('post', `${state} mode`);
    }

    /**
     * Brief centered indicator (fades out after 1s)
     */
    _showBdIndicator(text, persistent = false) {
        // Remove existing indicator
        const existing = this.container.querySelector('.mv-bd-indicator');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.className = 'mv-bd-indicator';
        el.textContent = text;
        el.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-family: 'Zen Kaku Gothic New', 'SF Mono', 'Menlo', monospace;
            font-size: 18px;
            color: #000;
            opacity: 0.7;
            pointer-events: none;
            z-index: 95;
            transition: opacity 0.5s ease;
            -webkit-font-smoothing: antialiased;
        `;
        this.container.appendChild(el);
        if (persistent) {
            // Dismiss on any user interaction
            const dismiss = () => {
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 500);
                document.removeEventListener('mousedown', dismiss);
                document.removeEventListener('touchstart', dismiss);
                document.removeEventListener('wheel', dismiss);
                document.removeEventListener('keydown', dismiss);
            };
            document.addEventListener('mousedown', dismiss, { once: true });
            document.addEventListener('touchstart', dismiss, { once: true });
            document.addEventListener('wheel', dismiss, { once: true });
            document.addEventListener('keydown', dismiss, { once: true });
        } else {
            setTimeout(() => { el.style.opacity = '0'; }, 2000);
            setTimeout(() => { el.remove(); }, 2500);
        }
    }

    _enableBreakdown() {
        // Enable OrbitControls
        if (this.sceneManager.renderer && this.sceneManager.camera) {
            this._orbitControls = new OrbitControls(
                this.sceneManager.camera,
                this.sceneManager.renderer.domElement
            );
            this._orbitControls.enableDamping = true;
            this._orbitControls.dampingFactor = 0.08;
            this._orbitControls.minDistance = 1;
            this._orbitControls.maxDistance = 20;
            this._orbitControls.enablePan = false; // prevent 2-finger pan from shifting target
            this._orbitControls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
            // Set initial view: slightly above, looking down at origin
            this._orbitControls.target.set(0, 0, 0);
            const cam = this.sceneManager.camera;
            cam.position.set(0, 6, 12);
            cam.fov = 50;
            cam.updateProjectionMatrix();
            cam.lookAt(0, 0, 0);
            this._orbitControls.update();
        }

        // Disable CameraController path/orbit
        if (this.sceneManager.cameraController) {
            this._prevCameraMode = this.sceneManager.cameraController.mode;
            this.sceneManager.cameraController.mode = 'static';
        }

        this._createBreakdownUI();
        this._hookComponentLogs();

        // Mobile: suppress browser double-tap zoom on canvas
        if (this._isMobileDevice && this.sceneManager.renderer) {
            this._bdTouchPreventHandler = (e) => { e.preventDefault(); };
            this.sceneManager.renderer.domElement.addEventListener(
                'touchstart', this._bdTouchPreventHandler, { passive: false }
            );
        }

        // Create camera frustum visualization (always on in explore mode)
        this._createCameraFrustumViz();

        // Create camera path visualization (on by default)
        this._createCameraPathViz();

        // Create axis orientation gizmo (PC only)
        this._createAxisGizmo();

        // Log initial state
        this._bdLog('mode', 'interactive ON');
        const t = this.audio.getCurrentTime();
        const scene = this.timeline.getCurrentScene();
        if (scene) this._bdLog('scene', `${scene.id} (${t.toFixed(1)}s)`);
        for (const comp of this.sceneManager.activeComponents) {
            if (comp._phase) this._bdLog('particle', `phase=${comp._phase} conv=${comp._convergence?.toFixed(3) || '?'}`);
            if (comp._currentText) this._bdLog('lyric', `"${comp._currentText}"`);
            const gpuId = comp._uniforms?.uGPUPatternId?.value;
            if (gpuId != null) this._bdLog('flow', `GPU pattern #${gpuId}`);
        }
        const pp = this.sceneManager.postProcessing;
        if (pp) this._bdLog('post', pp.enabled ? 'CMYK' : 'RGB');

        // Show initial hint (persistent — dismissed on first interaction)
        setTimeout(() => {
            if (this._breakdownMode) {
                this._showBdIndicator(
                    this._bdLang === 'ja'
                        ? 'ドラッグ・スクロールで視点操作'
                        : 'drag / scroll to move camera',
                    true
                );
            }
        }, 300);
    }

    _hookComponentLogs() {
        if (!this._breakdownMode) return;
        const log = (tag, msg) => this._bdLog(tag, msg);
        for (const comp of this.sceneManager.activeComponents) {
            if (comp._onLog !== undefined) comp._onLog = log;
        }
        if (this.sceneManager.cameraController?._onLog !== undefined) {
            this.sceneManager.cameraController._onLog = log;
        }
    }

    _disableBreakdown() {
        // Disable OrbitControls
        if (this._orbitControls) {
            this._orbitControls.dispose();
            this._orbitControls = null;
        }

        // Restore CameraController
        if (this.sceneManager.cameraController && this._prevCameraMode) {
            this.sceneManager.cameraController.mode = this._prevCameraMode;
        }

        // Clean up mobile touchstart preventDefault handler
        if (this._bdTouchPreventHandler && this.sceneManager.renderer) {
            this.sceneManager.renderer.domElement.removeEventListener('touchstart', this._bdTouchPreventHandler);
            this._bdTouchPreventHandler = null;
        }

        // Clean up path break handler
        if (this._bdPathBreakHandler && this.sceneManager.renderer) {
            const el = this.sceneManager.renderer.domElement;
            el.removeEventListener('mousedown', this._bdPathBreakHandler);
            el.removeEventListener('touchstart', this._bdPathBreakHandler);
            el.removeEventListener('wheel', this._bdPathBreakHandler);
            this._bdPathBreakHandler = null;
        }
        this._followingAuthoredPath = false;

        // Clean up camera path visualization
        this._removeCameraPathViz();

        // Clean up camera frustum visualization
        this._removeCameraFrustumViz();

        // Clean up axis gizmo
        this._removeAxisGizmo();

        // Remove any lingering indicator
        const indicator = this.container.querySelector('.mv-bd-indicator');
        if (indicator) indicator.remove();

        this._removeBreakdownUI();
    }

    _createBreakdownUI() {
        if (this._breakdownUI) return;

        const ui = document.createElement('div');
        ui.className = 'mv-breakdown-ui';
        ui.innerHTML = `
            <pre class="mv-bd-text"></pre>
            <div class="mv-bd-controls">
                <div class="mv-bd-cam-status"></div>
                <table class="mv-bd-controls-text"></table>
                <div class="mv-bd-lang-toggle">
                    <button class="mv-bd-lang-btn" data-lang="ja">日本語</button>
                    <span class="mv-bd-lang-sep">/</span>
                    <button class="mv-bd-lang-btn" data-lang="en">English</button>
                </div>
            </div>
            <div class="mv-bd-seekbar-wrap">
                <button class="mv-bd-back" aria-label="back to start"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></button>
                <button class="mv-bd-playpause" aria-label="play/pause"><svg class="mv-bd-pp-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg></button>
                <div class="mv-bd-seekbar-track">
                    <input type="range" class="mv-bd-seekbar" min="0" max="160" step="0.1" value="0">
                    <div class="mv-bd-seekbar-markers"></div>
                </div>
                <span class="mv-bd-seekbar-time">0:00 / 0:00</span>
                <button class="mv-bd-vol-btn" aria-label="mute"><svg class="mv-bd-vol-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path class="mv-bd-vol-wave" d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg></button>
                <input type="range" class="mv-bd-vol-slider" min="0" max="1" step="0.01" value="1">
            </div>
            <pre class="mv-bd-log"></pre>
        `;

        this._applyBreakdownStyles(ui);
        this._breakdownUI = ui;
        this.container.appendChild(ui);

        // Seekbar — suppress scene changes during drag, full lyric reset on release
        const seekbar = ui.querySelector('.mv-bd-seekbar');
        seekbar.addEventListener('input', () => {
            this._bdSeeking = true;
            const t = parseFloat(seekbar.value);
            this.audio.seek(t);
            this._suppressSceneChange = true;
            this.timeline.seek(t);
            this._suppressSceneChange = false;
        });
        seekbar.addEventListener('change', () => {
            this._bdSeeking = false;
            this.seekToTime(parseFloat(seekbar.value));
        });
        seekbar.addEventListener('mousedown', () => { this._bdSeeking = true; });
        seekbar.addEventListener('touchstart', () => { this._bdSeeking = true; });
        seekbar.addEventListener('touchend', () => {
            this._bdSeeking = false;
            this.seekToTime(parseFloat(seekbar.value));
        });

        // Back to start button
        const backBtn = ui.querySelector('.mv-bd-back');
        if (backBtn) {
            backBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._replay();
            });
        }

        // Play/pause button
        const ppBtn = ui.querySelector('.mv-bd-playpause');
        if (ppBtn) {
            ppBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggle();
            });
        }

        // Volume mute toggle
        const volBtn = ui.querySelector('.mv-bd-vol-btn');
        const volSlider = ui.querySelector('.mv-bd-vol-slider');
        if (volBtn && volSlider) {
            this._bdVolBeforeMute = null;
            volBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this.audio.audioElement) return;
                const el = this.audio.audioElement;
                if (el.volume > 0) {
                    this._bdVolBeforeMute = el.volume;
                    el.volume = 0;
                    volSlider.value = 0;
                    volBtn.querySelector('.mv-bd-vol-wave').style.display = 'none';
                } else {
                    el.volume = this._bdVolBeforeMute || 1;
                    volSlider.value = el.volume;
                    volBtn.querySelector('.mv-bd-vol-wave').style.display = '';
                }
            });
        }

        // Volume slider in seekbar area
        if (volSlider) {
            const curVol = this.audio.audioElement ? this.audio.audioElement.volume : 1;
            volSlider.value = curVol;
            volSlider.addEventListener('input', () => {
                if (this.audio.audioElement) {
                    this.audio.audioElement.volume = parseFloat(volSlider.value);
                    // Update icon wave visibility
                    const wave = ui.querySelector('.mv-bd-vol-wave');
                    if (wave) wave.style.display = parseFloat(volSlider.value) > 0 ? '' : 'none';
                }
            });
        }

        // Lang toggle
        ui.querySelectorAll('.mv-bd-lang-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._bdLang = btn.dataset.lang;
                this._updateBdControlsText();
            });
        });
        this._updateBdControlsText();
        this._populateSeekbarMarkers();

        // Mobile: hide volume/log, keep seekbar + back/play buttons visible
        if (this._isMobileDevice) {
            ui.querySelector('.mv-bd-log').style.display = 'none';

            const controls = ui.querySelector('.mv-bd-controls');
            const bdText = ui.querySelector('.mv-bd-text');
            bdText.after(controls);
            Object.assign(controls.style, {
                position: 'static',
                top: '',
                right: '',
                textAlign: 'left',
            });
            controls.querySelector('.mv-bd-cam-status').style.textAlign = 'left';
        }
    }

    _updateBdControlsText() {
        if (!this._breakdownUI) return;
        if (this._isMobileDevice) {
            const el = this._breakdownUI.querySelector('.mv-bd-controls-text');
            if (el) el.innerHTML = '';
            this._breakdownUI.querySelectorAll('.mv-bd-lang-btn').forEach(btn => {
                btn.style.opacity = btn.dataset.lang === this._bdLang ? '1' : '0.4';
            });
            return;
        }
        const rows = {
            ja: [
                ['ドラッグ', '視点を動かす（一時停止中）'],
                ['スクロール', '近づく・離れる（一時停止中）'],
                ['Space', '再生 / 一時停止'],
                ['C', '元のカメラに戻す'],
                ['V', 'カメラの動きを表示'],
                ['B', '映像のみ表示'],
            ],
            en: [
                ['Drag', 'move viewpoint (while paused)'],
                ['Scroll', 'zoom in / out (while paused)'],
                ['Space', 'play / pause'],
                ['C', 'reset camera'],
                ['V', 'show camera movement'],
                ['B', 'video only'],
            ],
        };
        const el = this._breakdownUI.querySelector('.mv-bd-controls-text');
        if (el) {
            const lang = this._bdLang || 'ja';
            const data = rows[lang] || rows.ja;
            el.innerHTML = data.map(([key, desc]) => {
                if (!key && !desc) return '';
                if (!key) return `<tr><td colspan="2" style="opacity:0.5;padding-top:0.3em">${desc}</td></tr>`;
                return `<tr><td style="text-align:right;padding-right:0.8em;opacity:0.6;white-space:nowrap">${key}</td><td>${desc}</td></tr>`;
            }).join('');
            el.style.borderCollapse = 'collapse';
        }
        this._breakdownUI.querySelectorAll('.mv-bd-lang-btn').forEach(btn => {
            btn.style.opacity = btn.dataset.lang === this._bdLang ? '1' : '0.4';
        });
    }

    _applyBreakdownStyles(ui) {
        if (!document.getElementById('mv-breakdown-styles')) {
            const style = document.createElement('style');
            style.id = 'mv-breakdown-styles';
            style.textContent = `
                .mv-breakdown-ui {
                    position: absolute;
                    top: 1rem;
                    left: 1rem;
                    z-index: 90;
                    pointer-events: none;
                }
                .mv-bd-text {
                    margin: 0;
                    font-family: 'SF Mono', 'Menlo', monospace;
                    font-size: 10px;
                    line-height: 1.6;
                    color: #000;
                    -webkit-font-smoothing: antialiased;
                }
                .mv-bd-controls {
                    position: fixed;
                    top: 1rem;
                    right: 1rem;
                    margin: 0;
                    font-family: 'SF Mono', 'Menlo', monospace;
                    font-size: 10px;
                    line-height: 1.6;
                    color: #000;
                    text-align: right;
                    pointer-events: auto;
                    -webkit-font-smoothing: antialiased;
                }
                .mv-bd-cam-status {
                    margin-bottom: 0.6em;
                    font: inherit;
                    opacity: 0.7;
                    text-align: right;
                }
                .mv-bd-controls-text {
                    margin: 0;
                    font: inherit;
                    margin-left: auto;
                }
                .mv-bd-lang-toggle {
                    margin-top: 0.5em;
                }
                .mv-bd-lang-sep {
                    opacity: 0.3;
                }
                .mv-bd-lang-btn {
                    background: none;
                    border: none;
                    padding: 0;
                    font: inherit;
                    color: inherit;
                    cursor: pointer;
                }
                .mv-bd-seekbar-wrap {
                    position: fixed;
                    bottom: 1rem;
                    left: 1rem;
                    right: 2.5rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    pointer-events: auto;
                    z-index: 91;
                }
                @media (max-width: 599px) {
                    .mv-bd-seekbar-wrap { right: 1rem !important; }
                    .mv-bd-controls-text { display: none !important; }
                }
                .mv-bd-seekbar-track {
                    flex: 1;
                    position: relative;
                    height: 16px;
                    display: flex;
                    align-items: center;
                }
                .mv-bd-seekbar {
                    width: 100%;
                    height: 2px;
                    -webkit-appearance: none;
                    appearance: none;
                    background: rgba(0, 0, 0, 0.2);
                    outline: none;
                    cursor: pointer;
                    position: relative;
                    z-index: 2;
                }
                .mv-bd-seekbar-markers {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    pointer-events: none;
                    z-index: 1;
                }
                .mv-bd-marker {
                    position: absolute;
                    top: 50%;
                    transform: translate(-50%, -50%);
                    pointer-events: auto;
                    cursor: pointer;
                }
                .mv-bd-marker-lyric {
                    width: 3px;
                    height: 10px;
                    background: rgba(0, 0, 0, 0.5);
                    border-radius: 1px;
                }
                .mv-bd-marker-flow {
                    width: 2px;
                    height: 6px;
                    background: rgba(0, 0, 0, 0.2);
                    border-radius: 1px;
                }
                .mv-bd-marker-cam {
                    width: 5px;
                    height: 5px;
                    background: rgba(200, 0, 0, 0.4);
                    border-radius: 50%;
                }
                .mv-bd-marker-tooltip {
                    position: absolute;
                    bottom: 14px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(0, 0, 0, 0.75);
                    color: #fff;
                    font-family: 'SF Mono', 'Menlo', monospace;
                    font-size: 9px;
                    padding: 2px 6px;
                    border-radius: 3px;
                    white-space: nowrap;
                    pointer-events: none;
                    display: none;
                    z-index: 100;
                }
                .mv-bd-marker:hover .mv-bd-marker-tooltip {
                    display: block;
                }
                .mv-bd-seekbar::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    background: #000;
                    cursor: pointer;
                }
                .mv-bd-seekbar::-moz-range-thumb {
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    background: #000;
                    border: none;
                    cursor: pointer;
                }
                .mv-bd-seekbar::-moz-range-track {
                    height: 2px;
                    background: rgba(0, 0, 0, 0.2);
                }
                .mv-bd-seekbar-time {
                    font-family: 'SF Mono', 'Menlo', monospace;
                    font-size: 10px;
                    color: #000;
                    white-space: nowrap;
                    -webkit-font-smoothing: antialiased;
                }
                .mv-bd-playpause {
                    background: none;
                    border: none;
                    padding: 0;
                    margin: 0;
                    cursor: pointer;
                    color: rgba(0, 0, 0, 0.6);
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    transition: color 0.15s;
                }
                .mv-bd-playpause:hover { color: rgba(0, 0, 0, 0.9); }
                .mv-bd-back {
                    background: none;
                    border: none;
                    padding: 0;
                    margin: 0;
                    cursor: pointer;
                    color: rgba(0, 0, 0, 0.6);
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    transition: color 0.15s;
                }
                .mv-bd-back:hover { color: rgba(0, 0, 0, 0.9); }
                .mv-bd-vol-btn {
                    background: none;
                    border: none;
                    padding: 0;
                    margin: 0 0 0 0.4rem;
                    cursor: pointer;
                    color: rgba(0, 0, 0, 0.5);
                    flex-shrink: 0;
                    display: flex;
                    align-items: center;
                    transition: color 0.15s;
                }
                .mv-bd-vol-btn:hover { color: rgba(0, 0, 0, 0.8); }
                @media (max-width: 599px) {
                    .mv-bd-vol-btn { display: none; }
                }
                .mv-bd-vol-slider {
                    width: 60px;
                    height: 3px;
                    -webkit-appearance: none;
                    appearance: none;
                    background: rgba(0, 0, 0, 0.3);
                    outline: none;
                    cursor: pointer;
                    border-radius: 2px;
                    flex-shrink: 0;
                }
                .mv-bd-vol-slider::-webkit-slider-thumb {
                    -webkit-appearance: none;
                    width: 6px;
                    height: 16px;
                    background: rgba(0, 0, 0, 0.7);
                    border-radius: 2px;
                    border: none;
                    cursor: pointer;
                }
                .mv-bd-vol-slider::-moz-range-thumb {
                    width: 6px;
                    height: 16px;
                    background: rgba(0, 0, 0, 0.7);
                    border-radius: 2px;
                    border: none;
                    cursor: pointer;
                }
                .mv-bd-vol-slider::-moz-range-track {
                    height: 3px;
                    background: rgba(0, 0, 0, 0.3);
                    border-radius: 2px;
                }
                @media (max-width: 599px) {
                    .mv-bd-vol-slider { display: none; }
                }
                .mv-bd-log {
                    position: fixed;
                    bottom: 3rem;
                    left: 1rem;
                    margin: 0;
                    font-family: 'SF Mono', 'Menlo', monospace;
                    font-size: 10px;
                    line-height: 1.6;
                    color: #000;
                    -webkit-font-smoothing: antialiased;
                }
            `;
            document.head.appendChild(style);
        }
    }

    _removeBreakdownUI() {
        if (this._breakdownUI) {
            this._breakdownUI.remove();
            this._breakdownUI = null;
        }
    }

    /**
     * Populate seekbar with lyric and camera keyframe markers
     */
    _populateSeekbarMarkers() {
        if (!this._breakdownUI) return;
        const markersEl = this._breakdownUI.querySelector('.mv-bd-seekbar-markers');
        if (!markersEl) return;
        markersEl.innerHTML = '';

        const duration = this.audio.getDuration() || 160;
        if (duration <= 0) return;

        const fmt = (t) => {
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        };

        // Lyric markers
        for (const lyric of this.lyrics) {
            const pct = (lyric.time / duration) * 100;
            const hasText = lyric.text && lyric.text.length > 0;
            const marker = document.createElement('div');
            marker.className = `mv-bd-marker ${hasText ? 'mv-bd-marker-lyric' : 'mv-bd-marker-flow'}`;
            marker.style.left = `${pct}%`;

            const tooltip = document.createElement('div');
            tooltip.className = 'mv-bd-marker-tooltip';
            tooltip.textContent = hasText
                ? `${fmt(lyric.time)} "${lyric.text}"`
                : `${fmt(lyric.time)} [${lyric.pattern || 'flow'}]`;
            marker.appendChild(tooltip);

            marker.addEventListener('click', (e) => {
                e.stopPropagation();
                this.seekToTime(lyric.time);
            });
            markersEl.appendChild(marker);
        }

        // Camera keyframe markers
        const cc = this.sceneManager.cameraController;
        if (cc?.keyframes) {
            for (const kf of cc.keyframes) {
                const t = kf.time != null ? kf.time : 0;
                const pct = (t / duration) * 100;
                const marker = document.createElement('div');
                marker.className = 'mv-bd-marker mv-bd-marker-cam';
                marker.style.left = `${pct}%`;
                const tooltip = document.createElement('div');
                tooltip.className = 'mv-bd-marker-tooltip';
                tooltip.textContent = `${fmt(t)} [cam]`;
                marker.appendChild(tooltip);
                marker.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.seekToTime(t);
                });
                markersEl.appendChild(marker);
            }
        }
    }

    _updateBreakdownUI(musicTime) {
        if (!this._breakdownUI) return;

        // FPS
        const now = performance.now();
        this._bdFps.frames++;
        if (now - this._bdFps.last >= 1000) {
            this._bdFps.value = Math.round((this._bdFps.frames * 1000) / (now - this._bdFps.last));
            this._bdFps.frames = 0;
            this._bdFps.last = now;
        }

        // Scene
        const currentScene = this.timeline.getCurrentScene();
        const sceneId = currentScene?.id || '-';

        // Particle system info
        let phase = '-', animName = '-', convergence = 0, targetConv = 0;
        let particles = 0, flowPattern = '-';
        let gpuPatternId = 0, currentText = '', numLayers = 1;
        let macro = null, physOv = null;
        let holdDurOv = null, releaseSpd = 1, maxConv = 1;
        let sweepX = 0, sweepY = 0, sweepZ = 0;
        let lastTextTime = 0, formPending = false;
        for (const comp of this.sceneManager.activeComponents) {
            if (comp._phase !== undefined) {
                phase = comp._phase;
                animName = comp._animType || '-';
                convergence = comp._convergence || 0;
                targetConv = comp._targetConvergence || 0;
                flowPattern = comp._currentFlowPattern || '-';
                currentText = comp._currentText || '';
                gpuPatternId = comp._uniforms?.uGPUPatternId?.value || 0;
                numLayers = comp._uniforms?.uNumLayers?.value || 1;
                macro = comp._macro;
                physOv = comp._physicsOverrides;
                holdDurOv = comp._holdDurationOverride;
                releaseSpd = comp._releaseSpeed || 1;
                maxConv = comp._maxConvergence ?? 1;
                sweepX = comp._currentSweepX || 0;
                sweepY = comp._currentSweepY || 0;
                sweepZ = comp._currentSweepZ || 0;
                lastTextTime = comp._lastTextTime || 0;
                formPending = comp._formationPending || false;
            }
            if (comp.getStats) {
                const s = comp.getStats();
                if (s.particles) particles = s.particles;
            }
        }

        // Timeline
        const duration = this.audio.getDuration() || 160;
        const fmtShort = (t) => {
            const m = Math.floor(t / 60);
            const s = Math.floor(t % 60);
            return `${m}:${s.toString().padStart(2, '0')}`;
        };
        const fmtDetail = (t) => {
            const m = Math.floor(t / 60);
            const s = (t % 60).toFixed(2);
            return `${m}:${s.padStart(5, '0')}`;
        };
        const time = `${fmtDetail(musicTime)} / ${fmtDetail(duration)}`;
        const timeShort = `${fmtShort(musicTime)} / ${fmtShort(duration)}`;

        // Post-processing state
        const ppEnabled = this.sceneManager.postProcessing?.enabled !== false;
        const ppState = ppEnabled ? 'CMYK' : 'RGB';

        // Camera info
        const cam = this.sceneManager.camera;
        const camPos = cam ? `[${cam.position.x.toFixed(2)}, ${cam.position.y.toFixed(2)}, ${cam.position.z.toFixed(2)}]` : '-';
        const camLookAt = this.sceneManager.cameraController?.lookAtTarget;
        const lookAtStr = camLookAt ? `[${camLookAt.x.toFixed(2)}, ${camLookAt.y.toFixed(2)}, ${camLookAt.z.toFixed(2)}]` : '-';
        const fov = cam?.fov ? cam.fov.toFixed(1) : '-';
        const camMode = this.sceneManager.cameraController?.mode || '-';

        // Render quality
        const renderScale = this.sceneManager.renderScale || 1;
        const dpr = window.devicePixelRatio || 1;
        const w = this.sceneManager.renderer?.domElement?.width || 0;
        const h = this.sceneManager.renderer?.domElement?.height || 0;

        // GPU backend detection
        const renderer = this.sceneManager.renderer;
        let gpuBackend = '-';
        if (renderer) {
            const be = renderer.backend;
            if (be?.constructor?.name === 'WebGPUBackend') {
                gpuBackend = 'WebGPU';
            } else if (be?.constructor?.name === 'WebGLBackend') {
                gpuBackend = 'WebGL (fallback)';
            } else if (be) {
                gpuBackend = be.constructor?.name || 'unknown';
            }
        }

        // Audio
        const playing = this.audio.isPlaying ? 'playing' : 'paused';

        // Bar/beat from musicTime
        const bpm = this.mvData?.bpm || 171;
        const beatsPerBar = this.mvData?.beatsPerBar || 4;
        const dawStartBar = this.mvData?.dawStartBar || 4;
        const secPerBeat = 60 / bpm;
        const totalBeats = musicTime / secPerBeat;
        const currentBar = Math.floor(totalBeats / beatsPerBar) + dawStartBar;
        const currentBeat = Math.floor(totalBeats % beatsPerBar) + 1;
        const barStr = `bar:${currentBar}.${currentBeat}`;

        // Macro values
        const m = macro || {};
        const spring = m.spring?.toFixed(4) ?? '-';
        const damping = m.damp?.toFixed(4) ?? '-';
        const noise = m.noiseStr?.toFixed(5) ?? '-';
        const noiseScl = m.noiseScl?.toFixed(3) ?? '-';
        const vortex = m.vortex?.toFixed(5) ?? '-';
        const wave = m.wave?.toFixed(5) ?? '-';
        const pointScale = m.pointScale?.toFixed(2) ?? '-';
        const convUp = m.convUp?.toFixed(3) ?? '-';
        const convDn = m.convDn?.toFixed(3) ?? '-';

        // Pattern info
        const patternInfo = this._bdAllPatterns
            ? `${flowPattern} (${this._bdPatternIdx + 1}/${this._bdAllPatterns.length})`
            : flowPattern;
        const gpuLabel = gpuPatternId > 0 ? `  GPU#${gpuPatternId}` : '';
        const layerLabel = numLayers > 1 ? `  ${numLayers}layers` : '';
        const textLabel = currentText ? `「${currentText}」` : '';

        // Physics overrides
        const ovKeys = physOv ? Object.keys(physOv).filter(k => physOv[k] != null) : [];
        const ovStr = ovKeys.length > 0 ? ovKeys.map(k => `${k}=${physOv[k]}`).join(' ') : 'none';

        // Text hold timing
        let holdStr = '';
        if (phase === 'text' && lastTextTime > 0) {
            const elapsed = (this.sceneManager.elapsedTime || 0) - lastTextTime;
            const holdDur = holdDurOv ?? 2.5;
            holdStr = `  hold:${elapsed.toFixed(1)}/${holdDur.toFixed(1)}s`;
        }
        if (phase === 'forming' && formPending) holdStr = '  forming...';

        // All lines with priority (lower = more important, shown first)
        const allLines = [
            [0, `${this._bdFps.value}fps  ${playing}  ${sceneId}  ${time}  ${barStr}`],
            [0, `phase:${phase}  anim:${animName}  conv:${convergence.toFixed(3)}→${targetConv.toFixed(2)}${holdStr}`],
            [1, textLabel ? `text: ${textLabel}  maxConv:${maxConv.toFixed(2)}  relSpd:${releaseSpd.toFixed(1)}` : ''],
            [1, `flow: ${patternInfo}${gpuLabel}${layerLabel}`],
            [2, `spring:${spring}  damping:${damping}  ptScale:${pointScale}`],
            [2, `noise:${noise}  noiseScale:${noiseScl}`],
            [3, `vortex:${vortex}  wave:${wave}`],
            [3, `convUp:${convUp}  convDn:${convDn}`],
            [4, `sweep:[${sweepX.toFixed(3)}, ${sweepY.toFixed(3)}, ${sweepZ.toFixed(3)}]`],
            [4, `overrides: ${ovStr}`],
            [5, `cam:${camPos}  fov:${fov}  mode:${camMode}`],
            [5, `lookAt:${lookAtStr}`],
            [6, `${ppState}  ${(particles/1000).toFixed(0)}K  ${w}×${h}  dpr:${dpr.toFixed(1)}  scale:${renderScale.toFixed(2)}  ${gpuBackend}`],
        ].filter(([, text]) => text.length > 0);

        // Calculate max lines that fit without overlapping bottom UI
        // font-size: 10px, line-height: 1.6 → ~16px per line. Top offset ~16px.
        // Bottom UI: seekbar at bottom:1rem + log above it. Reserve ~40% of viewport.
        const vh = window.innerHeight || 600;
        const maxLines = Math.max(3, Math.floor((vh * 0.55) / 16));
        const lines = allLines.slice(0, maxLines).map(([, text]) => text);

        const el = this._breakdownUI.querySelector('.mv-bd-text');
        if (el) el.textContent = lines.join('\n');

        // Camera status (right-side)
        const camStatusEl = this._breakdownUI.querySelector('.mv-bd-cam-status');
        if (camStatusEl) {
            const isFollowingPath = this._followingAuthoredPath;
            const camLabel = isFollowingPath
                ? (this._bdLang === 'en' ? 'camera: authored path' : 'カメラ: 演出パス')
                : (this._bdLang === 'en' ? 'camera: free control' : 'カメラ: 自由に操作中');
            camStatusEl.textContent = camLabel;
        }

        // Update camera visualizations
        this._updateCameraPathCursor(musicTime);
        this._updateCameraFrustumViz(musicTime);
        this._updateAxisGizmo();

        // Seekbar update (skip during drag)
        if (!this._bdSeeking) {
            const seekbar = this._breakdownUI.querySelector('.mv-bd-seekbar');
            if (seekbar) {
                seekbar.max = duration;
                seekbar.value = musicTime;
            }
        }
        const seekTimeEl = this._breakdownUI.querySelector('.mv-bd-seekbar-time');
        if (seekTimeEl) seekTimeEl.textContent = timeShort;

        // Update play/pause icon
        const ppIcon = this._breakdownUI.querySelector('.mv-bd-pp-icon');
        if (ppIcon) {
            const isPlay = this.audio.isPlaying;
            ppIcon.innerHTML = isPlay
                ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'
                : '<path d="M8 5v14l11-7z"/>';
        }

        const logEl = this._breakdownUI.querySelector('.mv-bd-log');
        if (logEl) {
            logEl.textContent = this._bdLogs.length > 0 ? this._bdLogs.slice(-15).join('\n') : '';
        }
    }

    /**
     * Append a log entry in Interactive mode
     */
    _bdLog(tag, msg) {
        const t = this.audio.getCurrentTime();
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        const ms = Math.floor((t % 1) * 1000);
        const ts = `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
        this._bdLogs.push(`${ts} [${tag}] ${msg}`);
        if (this._bdLogs.length > 100) this._bdLogs.shift();
    }

    /**
     * Stop playback
     */
    stop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this._breakdownMode) {
            this._breakdownMode = false;
            this._disableBreakdown();
        }
        this.audio.pause();
        this.audio.seek(0);
        this.timeline.reset();
        this.firedLyricIndices.clear();
        this.isPlaying = false;
    }

    /**
     * Offline MP4 export (dev environment only)
     */
    async startExport(options = {}) {
        if (!import.meta.env.DEV) {
            console.warn('[MVEngine] Export is only available in dev mode');
            return;
        }
        if (!this.isLoaded) {
            console.warn('[MVEngine] Engine not loaded yet');
            return;
        }
        const { OfflineRenderer } = await import('./OfflineRenderer.js');
        const renderer = new OfflineRenderer(this);
        return renderer.start(options);
    }

    /**
     * Release resources
     */
    dispose() {
        this.stop();
        this.audio.dispose();
        this.sceneManager.dispose();
    }
}
