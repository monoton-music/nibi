/**
 * PatternGallery — dev-only flow-pattern browser
 *
 * Usage: ?gallery=1  (dev server only — gated by import.meta.env.DEV in main.js)
 *
 * Renders each registered GPU flow pattern for a few frames, captures a
 * thumbnail, and shows them in a searchable grid. Click to preview full-screen.
 *
 * Thumbnails are generated in-memory on every load — there is no disk cache,
 * no dev-server middleware dependency. The number of patterns is small
 * (mv-data.json drives ~13), so generation completes in a couple of seconds.
 */

import { GPU_PATTERN_IDS } from '../components/gpuFlowPatterns.js';

const THUMB_SIZE = 160;
const FRAMES_PER_PATTERN = 36;

export class PatternGallery {
    constructor(engine) {
        this.engine = engine;
        this.patterns = Object.entries(GPU_PATTERN_IDS)
            .map(([name, id]) => ({ name, id }))
            .sort((a, b) => a.id - b.id);
        this.thumbs = new Map();
        this.isGenerating = false;
        this._genIdx = 0;
        this._genFrame = 0;
        this._rafId = null;
        this._ui = null;
        this._textFilter = '';
        this._previewActive = false;
    }

    async start() {
        this._createUI();
        this._renderGrid();
        this._updateProgress(0, this.patterns.length);
        this._startGeneration();
    }

    _getComp() {
        for (const comp of this.engine.sceneManager.activeComponents) {
            if (comp.setFlowTargets) return comp;
        }
        return null;
    }

    // --- Generation ---

    _startGeneration() {
        const comp = this._getComp();
        if (!comp) return;

        this.engine._bgRunning = false;
        this.isGenerating = true;
        this._genIdx = 0;
        this._genFrame = 0;
        this._generateLoop();
    }

    async _generateLoop() {
        if (!this.isGenerating || this._genIdx >= this.patterns.length) {
            this.isGenerating = false;
            this._updateProgress(1, 0);
            return;
        }
        if (this._previewActive) {
            this._rafId = requestAnimationFrame(() => this._generateLoop());
            return;
        }

        const comp = this._getComp();
        const pattern = this.patterns[this._genIdx];

        if (this._genFrame === 0) {
            comp.setFlowTargets(pattern.name);
            comp._phase = 'flow';
            comp._targetConvergence = 0.6;
            comp._convergence = 0.3;
            comp._sweepDir = [0, 0, 0];
            comp._currentText = '';
            const m = comp._macro;
            m.spring = 0.08;
            m.damp = 0.96;
            m.convUp = 0.35;
            m.noiseStr = 0.00005;
        }

        this.engine.sceneManager.update(0, 0);
        this._genFrame++;

        if (this._genFrame >= FRAMES_PER_PATTERN) {
            await this._capture(pattern);
            this._genFrame = 0;
            this._genIdx++;
            this._updateProgress(
                this._genIdx / this.patterns.length,
                this.patterns.length - this._genIdx,
            );
        }

        this._rafId = requestAnimationFrame(() => this._generateLoop());
    }

    async _capture(pattern) {
        const canvas = this.engine.sceneManager.renderer.domElement;
        const bitmap = await createImageBitmap(canvas);

        const thumb = document.createElement('canvas');
        thumb.width = THUMB_SIZE;
        thumb.height = THUMB_SIZE;
        const ctx = thumb.getContext('2d');

        const s = Math.min(bitmap.width, bitmap.height);
        const sx = (bitmap.width - s) / 2;
        const sy = (bitmap.height - s) / 2;
        ctx.drawImage(bitmap, sx, sy, s, s, 0, 0, THUMB_SIZE, THUMB_SIZE);
        bitmap.close();

        const dataURL = thumb.toDataURL('image/jpeg', 0.82);
        this.thumbs.set(pattern.id, dataURL);
        this._updateGridItem(pattern, dataURL);
    }

    // --- UI ---

    _createUI() {
        const ui = document.createElement('div');
        ui.innerHTML = `
            <div class="pg-header">
                <h2>Pattern Gallery <span class="pg-count">(${this.patterns.length})</span></h2>
                <input type="text" class="pg-search" placeholder="Filter by name or ID..." />
                <span class="pg-progress"></span>
                <button class="pg-close" title="Close">✕</button>
            </div>
            <div class="pg-grid"></div>
        `;

        const style = document.createElement('style');
        style.textContent = `
            .pattern-gallery {
                position: fixed; inset: 0; z-index: 10000;
                background: #111; color: #eee;
                display: flex; flex-direction: column;
                font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
            }
            .pg-header {
                display: flex; align-items: center; gap: 10px;
                padding: 10px 14px; background: #1a1a1a;
                border-bottom: 1px solid #333; flex-shrink: 0;
            }
            .pg-header h2 { margin: 0; font-size: 13px; white-space: nowrap; }
            .pg-count { color: #666; }
            .pg-search {
                flex: 1; max-width: 280px; padding: 5px 10px;
                background: #222; border: 1px solid #444; color: #fff;
                border-radius: 4px; font-size: 12px; font-family: inherit;
            }
            .pg-search:focus { outline: none; border-color: #666; }
            .pg-progress { font-size: 11px; color: #888; white-space: nowrap; }
            .pg-close {
                background: none; border: 1px solid #444; color: #999;
                cursor: pointer; font-size: 11px; padding: 4px 10px;
                border-radius: 3px; font-family: inherit;
            }
            .pg-close:hover { color: #fff; border-color: #888; }
            .pg-grid {
                flex: 1; overflow-y: auto; padding: 10px;
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(${THUMB_SIZE + 4}px, 1fr));
                gap: 6px; align-content: start;
            }
            .pg-item {
                background: #1a1a1a; border-radius: 4px;
                cursor: pointer; transition: transform 0.1s, box-shadow 0.1s;
                border: 1px solid #222;
            }
            .pg-item:hover { transform: scale(1.04); box-shadow: 0 2px 12px rgba(0,0,0,0.5); border-color: #444; }
            .pg-item.pg-hidden { display: none; }
            .pg-thumb {
                width: 100%; aspect-ratio: 1; display: block;
                object-fit: cover; background: #181818;
                border-radius: 4px 4px 0 0;
            }
            .pg-placeholder {
                width: 100%; aspect-ratio: 1; display: flex;
                align-items: center; justify-content: center;
                color: #333; font-size: 10px; background: #181818;
                border-radius: 4px 4px 0 0;
            }
            .pg-label {
                padding: 3px 5px; font-size: 8px; color: #888;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                line-height: 1.3;
            }
            .pg-id { color: #555; margin-right: 3px; }
            .pg-preview-info {
                position: fixed; bottom: 20px; left: 50%;
                transform: translateX(-50%); z-index: 10002;
                color: #fff; font-size: 13px; text-align: center;
                pointer-events: none; text-shadow: 0 1px 4px #000;
            }
        `;
        document.head.appendChild(style);
        this._style = style;

        ui.className = 'pattern-gallery';
        this._ui = ui;
        document.body.appendChild(ui);

        ui.querySelector('.pg-close').addEventListener('click', () => this.dispose());
        ui.querySelector('.pg-search').addEventListener('input', (e) => {
            this._textFilter = e.target.value.toLowerCase();
            this._applyFilter();
        });
    }

    _renderGrid() {
        const grid = this._ui.querySelector('.pg-grid');
        grid.innerHTML = '';

        for (const p of this.patterns) {
            const item = document.createElement('div');
            item.className = 'pg-item';
            item.dataset.id = p.id;
            item.dataset.name = p.name;
            item.innerHTML = `<div class="pg-placeholder">${p.id}</div><div class="pg-label"><span class="pg-id">${p.id}</span>${p.name}</div>`;
            item.addEventListener('click', () => this._preview(p));
            grid.appendChild(item);
        }
    }

    _updateGridItem(pattern, dataURL) {
        if (!this._ui) return;
        const item = this._ui.querySelector(`.pg-item[data-id="${pattern.id}"]`);
        if (!item) return;
        const placeholder = item.querySelector('.pg-placeholder');
        if (placeholder) {
            const img = document.createElement('img');
            img.className = 'pg-thumb';
            img.src = dataURL;
            placeholder.replaceWith(img);
        }
    }

    _updateProgress(ratio, remaining) {
        if (!this._ui) return;
        const el = this._ui.querySelector('.pg-progress');
        if (!el) return;
        if (ratio >= 1) {
            el.textContent = `${this.patterns.length} patterns`;
        } else {
            const pct = Math.round(ratio * 100);
            el.textContent = `Generating... ${pct}% (${remaining} left)`;
        }
    }

    _applyFilter() {
        if (!this._ui) return;
        for (const item of this._ui.querySelectorAll('.pg-item')) {
            const name = item.dataset.name.toLowerCase();
            const id = item.dataset.id;
            const match = !this._textFilter
                || name.includes(this._textFilter)
                || id === this._textFilter;
            item.classList.toggle('pg-hidden', !match);
        }
        const visible = this._ui.querySelectorAll('.pg-item:not(.pg-hidden)').length;
        const countEl = this._ui.querySelector('.pg-count');
        if (countEl) {
            countEl.textContent = this._textFilter
                ? `(${visible}/${this.patterns.length})`
                : `(${this.patterns.length})`;
        }
    }

    _preview(pattern) {
        this._previewActive = true;
        const comp = this._getComp();
        if (!comp) return;

        comp.setFlowTargets(pattern.name);
        comp._phase = 'flow';
        comp._targetConvergence = 0.6;
        comp._convergence = 0.3;
        comp._currentText = '';
        comp._sweepDir = [0, 0, 0];

        this._ui.style.display = 'none';
        const canvas = this.engine.sceneManager.renderer.domElement;
        const prevCanvasStyle = canvas.style.cssText;
        canvas.style.cssText += ';position:fixed;inset:0;z-index:10001;width:100vw;height:100vh;';

        const info = document.createElement('div');
        info.className = 'pg-preview-info';
        info.textContent = `#${pattern.id} ${pattern.name} — click or Esc to close`;
        document.body.appendChild(info);

        let previewRaf;
        const renderPreview = () => {
            if (!this._previewActive) return;
            this.engine.sceneManager.update(0, 0);
            previewRaf = requestAnimationFrame(renderPreview);
        };
        previewRaf = requestAnimationFrame(renderPreview);

        const close = () => {
            this._previewActive = false;
            cancelAnimationFrame(previewRaf);
            canvas.style.cssText = prevCanvasStyle;
            info.remove();
            this._ui.style.display = '';
        };
        canvas.addEventListener('click', close, { once: true });
        document.addEventListener('keydown', function onKey(e) {
            if (e.code === 'Escape') {
                close();
                document.removeEventListener('keydown', onKey);
            }
        });
    }

    dispose() {
        this.isGenerating = false;
        this._previewActive = false;
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._ui) {
            this._ui.remove();
            this._ui = null;
        }
        if (this._style) {
            this._style.remove();
            this._style = null;
        }
        this.engine._bgRunning = true;
        this.engine._startBackgroundRender();
    }
}
