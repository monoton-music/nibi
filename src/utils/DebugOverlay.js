/**
 * DebugOverlay - Debug information display
 *
 * Enabled via ?debug=1
 * Displays: current time, FPS, current scene, seed value
 */

export class DebugOverlay {
    constructor() {
        this.element = null;
        this.enabled = false;
        this.lastTime = performance.now();
        this.frameCount = 0;
        this.fps = 0;
        this.data = {
            time: 0,
            sceneId: '-',
            seed: 0,
            renderScale: 1,
            renderSize: '-',
            fpsTarget: 60,
            qualityMode: '-',
            particleCount: 0,
            objectCount: 0,
            instanceCount: 0,
            lightCount: 0,
            breakdown: []
        };

        // Debug controlled by URL parameter (default OFF, enabled with ?debug=1)
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('debug') === '1') {
            this.enable();
        }
    }

    enable() {
        if (this.enabled) return;
        this.enabled = true;
        this._createOverlay();
        console.log('[DebugOverlay] Enabled');
    }

    disable() {
        if (!this.enabled) return;
        this.enabled = false;
        if (this.element) {
            this.element.remove();
            this.element = null;
        }
        console.log('[DebugOverlay] Disabled');
    }

    toggle() {
        if (this.enabled) {
            this.disable();
        } else {
            this.enable();
        }
    }

    _createOverlay() {
        this.element = document.createElement('div');
        this.element.id = 'debug-overlay';
        this.element.style.cssText = `
            position: fixed;
            top: 10px;
            left: 10px;
            background: rgba(0, 0, 0, 0.7);
            color: #fff;
            font-family: 'Monaco', 'Consolas', monospace;
            font-size: 12px;
            padding: 8px 12px;
            border-radius: 4px;
            z-index: 9999;
            pointer-events: none;
            line-height: 1.6;
        `;
        document.body.appendChild(this.element);
    }

    /**
     * Update data
     */
    setData(key, value) {
        this.data[key] = value;
    }

    /**
     * Called every frame
     */
    update() {
        if (!this.enabled || !this.element) return;

        // FPS calculation
        this.frameCount++;
        const now = performance.now();
        const delta = now - this.lastTime;
        if (delta >= 1000) {
            this.fps = Math.round((this.frameCount * 1000) / delta);
            this.frameCount = 0;
            this.lastTime = now;
        }

        // Update display
        const timeStr = this.data.time.toFixed(2).padStart(6, ' ');
        const breakdown = this.data.breakdown || [];
        const breakdownText = breakdown.length ? breakdown.join('\n') : 'components: -';
        const breakdownHtml = `<pre class="debug-breakdown" style="margin: 6px 0 0; white-space: pre;">${breakdownText}</pre>`;

        this.element.innerHTML = `
            <div>time: ${timeStr}s</div>
            <div>scene: ${this.data.sceneId}</div>
            <div>fps: ${this.fps}</div>
            <div>fps target: ${this.data.fpsTarget}</div>
            <div>seed: ${this.data.seed}</div>
            <div>render: ${this.data.renderScale}x (${this.data.renderSize})</div>
            <div>mode: ${this.data.qualityMode}</div>
            <div>particles: ${this.data.particleCount}</div>
            <div>objects: ${this.data.objectCount}</div>
            <div>instances: ${this.data.instanceCount}</div>
            <div>lights: ${this.data.lightCount}</div>
            ${breakdownHtml}
        `;
    }
}

// Singleton
export const debugOverlay = new DebugOverlay();
