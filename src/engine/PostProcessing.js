/**
 * PostProcessing - Color Inversion only (WebGPU version, lightweight)
 *
 * Pipeline:
 * 1. Scene → single render target
 * 2. Inversion (1 - rgb) → CMYK-like appearance
 */

import * as THREE from 'three/webgpu';
import {
    renderOutput, texture,
    Fn, vec4, float, uv
} from 'three/tsl';

export class PostProcessing {
    constructor(renderer, scene, camera, params = {}) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.enabled = params.enabled !== false;

        this.uniforms = {};
        this.pp = null;
        this._rt = null;

        if (this.enabled) {
            this._setup();
        }
    }

    _setup() {
        // Dispose old resources if re-setup (e.g. from setCamera)
        if (this._rt) {
            this._rt.dispose();
        }

        const size = new THREE.Vector2();
        this.renderer.getDrawingBufferSize(size);
        const w = Math.max(1, size.x);
        const h = Math.max(1, size.y);

        this._rt = new THREE.RenderTarget(w, h);
        this._texNode = texture(this._rt.texture);

        // Compatibility stubs (referenced from MVEngine events)
        this.uniforms.tmExposure = { value: 1.0 };
        this.uniforms.glitchIntensity = { value: 0 };

        // --- Pipeline: color inversion only ---
        this.pp = new THREE.PostProcessing(this.renderer);
        const tex = this._texNode;

        const finalPass = Fn(() => {
            const src = tex.sample(uv());
            return vec4(
                float(1.0).sub(src.r),
                float(1.0).sub(src.g),
                float(1.0).sub(src.b),
                1.0
            );
        })();

        this.pp.outputNode = renderOutput(finalPass);
        console.log('[PostProcessing] Inversion only (lightweight)');
    }

    triggerGlitch(intensity = 1, duration = 0.1) {
        // glitch stub — kept for MVEngine event compatibility
    }

    update() {
        // no per-frame uniform updates needed
    }

    render() {
        if (!this.enabled || !this.pp) {
            this.renderer.render(this.scene, this.camera);
            return;
        }

        this.renderer.setRenderTarget(this._rt);
        this.renderer.render(this.scene, this.camera);
        this.renderer.setRenderTarget(null);

        this.pp.render();
    }

    applyConfig() {
        // no configurable effects — no-op
    }

    setCamera(camera) {
        this.camera = camera;
        if (!this.enabled) return;
        this._setup();
    }

    onResize(_cssWidth, _cssHeight) {
        if (!this._rt) return;
        // Use actual drawing buffer size (accounts for devicePixelRatio * renderScale)
        const size = new THREE.Vector2();
        this.renderer.getDrawingBufferSize(size);
        this._rt.setSize(Math.max(1, size.x), Math.max(1, size.y));
    }

    setParameter() {
        // no configurable effects — no-op
    }

    dispose() {
        if (this._rt) {
            this._rt.dispose();
            this._rt = null;
        }
        this.pp = null;
    }
}
