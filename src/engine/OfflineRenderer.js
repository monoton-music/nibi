/**
 * OfflineRenderer - Frame-by-frame offline rendering → single MP4 download
 *
 * In-browser encoding via WebCodecs VideoEncoder + mp4-muxer.
 * Outputs a single MP4 file including audio.
 *
 * Usage:
 *   const renderer = new OfflineRenderer(engine);
 *   renderer.start({ width: 1920, height: 1080, fps: 60 });
 *   renderer.start({ codec: 'vp9', quality: 'high' });  // VP9 high quality
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

// Encoder queue limit — pause frame generation when this is exceeded
const MAX_ENCODE_QUEUE = 30;
// Yield interval between audio encoding chunks
const AUDIO_YIELD_INTERVAL = 256;
// Wait time (ms) when encoder queue is full — give encoder time to drain
const BACKPRESSURE_WAIT = 2;

// Quality presets (bitrate: bps)
const QUALITY_PRESETS = {
    standard: { h264: 16_000_000, vp9: 10_000_000 },
    high:     { h264: 40_000_000, vp9: 24_000_000 },
    max:      { h264: 80_000_000, vp9: 50_000_000 },
};

export class OfflineRenderer {
    constructor(engine) {
        this.engine = engine;
        this.running = false;
        this.cancelled = false;
        this._ui = null;
        this._error = null;
    }

    /**
     * Start export
     * @param {Object} options
     * @param {number} options.width - Output width (default: 1920)
     * @param {number} options.height - Output height (default: 1080)
     * @param {number} options.fps - Frame rate (default: 60)
     * @param {number} options.startTime - Start time (default: 0)
     * @param {number|null} options.duration - Duration (default: full track)
     * @param {'h264'|'vp9'} options.codec - Video codec (default: 'h264')
     * @param {'standard'|'high'|'max'} options.quality - Quality preset (default: 'high')
     * @param {number} options.videoBitrate - Manual bitrate override (takes priority over quality)
     */
    async start(options = {}) {
        const {
            width = 1920,
            height = 1080,
            fps = 60,
            startTime = 0,
            duration = null,
            codec = 'h264',
            quality = 'high',
            videoBitrate = null,
        } = options;

        const engine = this.engine;
        const totalDuration = duration || engine.audio.getDuration() || 130;
        const totalFrames = Math.ceil(totalDuration * fps);
        const frameDurationUs = Math.round(1_000_000 / fps);

        // Bitrate resolution: manual override > preset
        const presets = QUALITY_PRESETS[quality] || QUALITY_PRESETS.high;
        const bitrate = videoBitrate || presets[codec] || presets.h264;

        this.running = true;
        this.cancelled = false;
        this._error = null;

        // Stop normal rendering loop
        if (engine.rafId) {
            cancelAnimationFrame(engine.rafId);
            engine.rafId = null;
        }
        engine.audio.pause();

        const sm = engine.sceneManager;
        const renderer = sm.renderer;
        const canvas = renderer.domElement;
        const origCSSWidth = sm.width;
        const origCSSHeight = sm.height;
        const origRenderScale = sm.renderScale;
        const clock = sm.clock;

        // Encoder variables (declared outside try so they can be closed in finally)
        let videoEncoder = null;
        let muxer = null;
        let frameNum = 0;
        let encodeStartTime = performance.now();

        try {
            // --- Resolution setup ---
            // renderer.setSize() takes CSS dimensions and multiplies by pixelRatio internally to set canvas pixels.
            // For export we need exact pixel dimensions, so set pixelRatio=1 before calling setSize.

            // Guard against window resize corrupting resolution during export
            sm._onResize = () => {};

            renderer.setPixelRatio(1);
            renderer.setSize(width, height);
            sm.width = width;
            sm.height = height;
            sm.renderScale = 1;

            // Adjust camera aspect ratio to match export resolution
            if (sm.camera.isPerspectiveCamera) {
                sm.camera.aspect = width / height;
                sm.camera.updateProjectionMatrix();
            }

            if (sm.postProcessing) {
                sm.postProcessing.onResize(width, height);
            }

            // --- Muxer setup ---
            const muxTarget = new ArrayBufferTarget();
            const isVP9 = codec === 'vp9';
            const muxerOptions = {
                target: muxTarget,
                video: {
                    codec: isVP9 ? 'vp9' : 'avc',
                    width,
                    height,
                },
                fastStart: 'in-memory',
            };

            muxer = new Muxer(muxerOptions);

            // --- VideoEncoder setup ---
            videoEncoder = new VideoEncoder({
                output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
                error: (e) => {
                    console.error('[OfflineRenderer] VideoEncoder error:', e);
                    this._error = e;
                    this.cancelled = true;
                },
            });

            if (isVP9) {
                videoEncoder.configure({
                    codec: 'vp09.00.10.08', // VP9 Profile 0, 8-bit
                    width,
                    height,
                    bitrate,
                    framerate: fps,
                });
            } else {
                videoEncoder.configure({
                    codec: 'avc1.640028', // H.264 High Profile Level 4.0
                    width,
                    height,
                    bitrate,
                    framerate: fps,
                });
            }

            // Progress UI
            const codecLabel = isVP9 ? 'VP9' : 'H.264';
            const bitrateLabel = (bitrate / 1_000_000).toFixed(0);
            this._createUI(totalFrames, `${codecLabel} ${bitrateLabel}Mbps ${width}x${height}`);

            // Seek to start position
            engine.seekToTime(startTime);

            // Clock monkey-patch: prevents SceneManager.update()'s getDelta/getElapsedTime
            // from returning real wall-clock time, making them return simulation time instead
            const fixedDelta = 1 / fps;
            let simTime = startTime;
            clock.getDelta = () => fixedDelta;
            clock.getElapsedTime = () => simTime;

            let currentTime = startTime;
            encodeStartTime = performance.now();

            while (frameNum < totalFrames && !this.cancelled) {
                // Backpressure: wait if encoder queue is building up
                while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE && !this.cancelled) {
                    await new Promise(r => setTimeout(r, BACKPRESSURE_WAIT));
                }
                if (this.cancelled) break;

                // Update simulation time
                simTime = currentTime;

                // Update timeline and lyrics
                engine.timeline.update(currentTime);
                engine._processLyrics(currentTime);

                const sceneProgress = engine.timeline.getSceneProgress();

                // Update SceneManager (compute + render)
                await engine.sceneManager.update(currentTime, sceneProgress);

                // createImageBitmap implicitly waits for GPU completion and copies efficiently,
                // much faster than explicit onSubmittedWorkDone() + VideoFrame(canvas).
                const bitmap = await createImageBitmap(canvas);
                const frame = new VideoFrame(bitmap, {
                    timestamp: frameNum * frameDurationUs,
                    duration: frameDurationUs,
                });
                const isKeyFrame = frameNum % (fps * 4) === 0;
                videoEncoder.encode(frame, { keyFrame: isKeyFrame });
                frame.close();
                bitmap.close();

                frameNum++;
                currentTime = startTime + frameNum / fps;

                // createImageBitmap await already yields every frame, so only update UI periodically
                if (frameNum % 30 === 0) {
                    this._updateUI(frameNum, totalFrames, false, null, encodeStartTime);
                }
            }

            if (this._error) throw this._error;

            if (!this.cancelled) {
                this._updateUI(frameNum, totalFrames, false, 'Flushing encoder...', encodeStartTime);
                await new Promise(r => setTimeout(r, 0));

                // Flush encoder
                await videoEncoder.flush();

                // Finalize MP4 + download
                muxer.finalize();
                const blob = new Blob([muxTarget.buffer], { type: 'video/mp4' });
                const ext = 'mp4';
                this._downloadBlob(blob, `mv-export.${ext}`);
            }
        } catch (e) {
            console.error('[OfflineRenderer] Export failed:', e);
            this._error = e;
        } finally {
            // Close encoders (null-check in case they were never created)
            if (videoEncoder) try { videoEncoder.close(); } catch (_) {}

            // Restore clock — delete own properties to fall back to prototype methods
            delete clock.getDelta;
            delete clock.getElapsedTime;

            // Restore resolution (CSS dimensions + original pixelRatio)
            delete sm._onResize; // Remove resize guard, restoring prototype method
            sm.renderScale = origRenderScale;
            sm.width = origCSSWidth;
            sm.height = origCSSHeight;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio * origRenderScale, 2));
            renderer.setSize(origCSSWidth, origCSSHeight);
            // Restore camera aspect
            if (sm.camera.isPerspectiveCamera) {
                sm.camera.aspect = origCSSWidth / origCSSHeight;
                sm.camera.updateProjectionMatrix();
            }
            if (sm.postProcessing) {
                sm.postProcessing.onResize(origCSSWidth, origCSSHeight);
            }

            this.running = false;
            this._updateUI(frameNum, totalFrames, true, null, encodeStartTime);

            // Restart rendering loop
            engine._startRenderLoop();
        }
    }

    cancel() {
        this.cancelled = true;
    }

    /**
     * Decode audio source to AudioBuffer
     */
    async _decodeAudioSource() {
        try {
            const audioEl = this.engine.audio.audioElement;
            if (!audioEl || !audioEl.src) return null;

            const resp = await fetch(audioEl.src);
            const arrayBuf = await resp.arrayBuffer();
            const ctx = new OfflineAudioContext(2, 1, 44100);
            return await ctx.decodeAudioData(arrayBuf);
        } catch (e) {
            console.warn('[OfflineRenderer] Audio decode failed, video-only export:', e);
            return null;
        }
    }

    /**
     * Encode AudioBuffer to AudioEncoder (yield between chunks)
     */
    async _encodeAudio(encoder, audioBuffer, startTime, duration) {
        const sampleRate = audioBuffer.sampleRate;
        const channels = audioBuffer.numberOfChannels;
        const startSample = Math.floor(startTime * sampleRate);
        const totalSamples = Math.min(
            Math.floor(duration * sampleRate),
            audioBuffer.length - startSample
        );

        const chunkSize = 1024;
        // Pre-allocate planar buffer (reused across chunks to avoid per-chunk GC)
        const planar = new Float32Array(chunkSize * channels);
        let chunkCount = 0;
        for (let offset = 0; offset < totalSamples; offset += chunkSize) {
            if (this.cancelled) break;
            const length = Math.min(chunkSize, totalSamples - offset);
            for (let ch = 0; ch < channels; ch++) {
                const channelData = audioBuffer.getChannelData(ch);
                const dstOffset = ch * length;
                for (let i = 0; i < length; i++) {
                    planar[dstOffset + i] = channelData[startSample + offset + i];
                }
            }

            const audioData = new AudioData({
                format: 'f32-planar',
                sampleRate,
                numberOfFrames: length,
                numberOfChannels: channels,
                timestamp: Math.round((offset / sampleRate) * 1_000_000),
                data: planar,
            });
            encoder.encode(audioData);
            audioData.close();

            chunkCount++;
            if (chunkCount % AUDIO_YIELD_INTERVAL === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }
    }

    _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    _createUI(totalFrames, subtitle = '') {
        if (this._ui) this._ui.remove();

        const ui = document.createElement('div');
        ui.innerHTML = `
            <div class="mv-export-progress">Encoding: 0 / ${totalFrames}</div>
            <div class="mv-export-status">${subtitle}</div>
            <div class="mv-export-bar-wrap">
                <div class="mv-export-bar"></div>
            </div>
            <button class="mv-export-cancel">Cancel</button>
        `;
        ui.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(255,255,255,0.95);
            color: #111;
            font-family: 'SF Mono', 'Menlo', monospace;
            font-size: 12px;
            padding: 1.5rem 2rem;
            border-radius: 8px;
            z-index: 200;
            text-align: center;
            min-width: 280px;
            -webkit-font-smoothing: antialiased;
        `;
        const status = ui.querySelector('.mv-export-status');
        status.style.cssText = `
            color: #666;
            font-size: 10px;
            margin-top: 0.3rem;
        `;
        const barWrap = ui.querySelector('.mv-export-bar-wrap');
        barWrap.style.cssText = `
            margin: 0.8rem 0;
            height: 3px;
            background: rgba(0,0,0,0.1);
            border-radius: 2px;
            overflow: hidden;
        `;
        const bar = ui.querySelector('.mv-export-bar');
        bar.style.cssText = `
            height: 100%;
            width: 0%;
            background: #000;
            transition: width 0.1s;
        `;
        const cancelBtn = ui.querySelector('.mv-export-cancel');
        cancelBtn.style.cssText = `
            background: none;
            border: 1px solid rgba(0,0,0,0.2);
            color: #111;
            font: inherit;
            padding: 0.3rem 1rem;
            border-radius: 4px;
            cursor: pointer;
        `;
        cancelBtn.addEventListener('click', () => this.cancel());

        this._ui = ui;
        this._progressEl = ui.querySelector('.mv-export-progress');
        this._barEl = ui.querySelector('.mv-export-bar');
        this._statusEl = ui.querySelector('.mv-export-status');
        this._cancelBtn = cancelBtn;
        document.body.appendChild(ui);
    }

    _updateUI(current, total, done = false, statusText = null, encodeStartTime = 0) {
        if (!this._ui) return;
        const progress = this._progressEl;
        const bar = this._barEl;
        const status = this._statusEl;

        if (progress) {
            if (done) {
                if (this._error) {
                    progress.textContent = `Error: ${this._error.message || this._error}`;
                    progress.style.color = '#c00';
                } else if (this.cancelled) {
                    progress.textContent = `Cancelled at ${current} / ${total}`;
                } else {
                    const elapsed = ((performance.now() - encodeStartTime) / 1000).toFixed(0);
                    progress.textContent = `Done! Downloading MP4... (${this._formatTime(+elapsed)})`;
                }
            } else {
                const pct = (current / total * 100).toFixed(1);
                progress.textContent = `Encoding: ${current} / ${total} (${pct}%)`;
            }
        }
        if (bar) {
            bar.style.width = `${(current / total * 100).toFixed(1)}%`;
        }
        if (status && statusText) {
            status.textContent = statusText;
        } else if (status && !done && current > 0 && encodeStartTime > 0) {
            // ETA calculation
            const elapsedMs = performance.now() - encodeStartTime;
            const msPerFrame = elapsedMs / current;
            const remainingFrames = total - current;
            const etaSec = Math.round(msPerFrame * remainingFrames / 1000);
            const fpsActual = (current / (elapsedMs / 1000)).toFixed(1);
            status.textContent = `${fpsActual} fps — ETA ${this._formatTime(etaSec)}`;
        }
        if (done) {
            if (status) status.textContent = '';
            if (this._cancelBtn) {
                this._cancelBtn.textContent = 'Close';
                this._cancelBtn.onclick = () => {
                    this._ui.remove();
                    this._ui = null;
                };
            }
        }
    }

    _formatTime(sec) {
        if (sec < 60) return `${sec}s`;
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        if (m < 60) return `${m}m${s.toString().padStart(2, '0')}s`;
        const h = Math.floor(m / 60);
        return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
    }

    dispose() {
        this.cancel();
        if (this._ui) {
            this._ui.remove();
            this._ui = null;
        }
    }
}
