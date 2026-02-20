/**
 * SceneManager - Three.js scene lifecycle management (WebGPU version)
 *
 * Features:
 * - Scene load/unload
 * - Camera / light management
 * - Rendering loop
 * - Transition control
 * - Dynamic camera work
 * - GPU compute dispatch
 */

import * as THREE from 'three/webgpu';
import gsap from 'gsap';
import { CameraController, applyCameraConfig } from './CameraController.js';
import { PostProcessing } from './PostProcessing.js';

export class SceneManager {
    constructor(container) {
        this.container = container;
        this.width = container.clientWidth;
        this.height = container.clientHeight;

        // Three.js core elements
        this.scene = new THREE.Scene();
        this.camera = null;
        this.renderer = null;
        this.cameraController = null;
        this.postProcessing = null;
        this.cameraProjection = 'perspective';
        this.orthographicSize = 6;
        this.renderScale = 1;

        // Registered components
        this.componentRegistry = new Map();
        this.activeComponents = [];
        this.componentCache = new Map();

        // Scene state
        this.currentSceneData = null;
        this.isTransitioning = false;

        // Time
        this.clock = new THREE.Clock();
        this.elapsedTime = 0;

        // Audio data (injected externally)
        this.audioData = {
            frequencyData: new Uint8Array(0),
            averageVolume: 0
        };

        // Component param overrides (e.g. reduced particle count on mobile)
        this._componentParamOverrides = new Map();

        // No longer call _init() — call init() externally
    }

    /**
     * Set parameter overrides for a component type (merged on top of scene params).
     * Used for mobile: e.g. setComponentParamOverrides('GPUParticleSystem', { count: 100000 })
     */
    setComponentParamOverrides(type, overrides) {
        this._componentParamOverrides.set(type, overrides);
    }

    /**
     * Async initialization (separated because WebGPURenderer.init() is async)
     * Called from within MVEngine.load()
     */
    async init() {
        // Camera setup
        this.camera = this._createPerspectiveCamera(75);
        this._baseFov = 75;
        this.camera.position.z = 5;
        this.camera.layers.enable(2);
        this.scene.add(this.camera);

        // Camera controller
        this.cameraController = new CameraController(this.camera, {
            mode: 'orbit',
            orbitSpeed: 0.15,
            orbitRadius: 5,
            orbitHeight: 0
        });
        this.cameraController._onProjectionChange = (proj, cfg) => this.switchProjectionLive(proj, cfg);

        // WebGPU renderer (auto-fallback to WebGL2 when WebGPU unavailable)
        const rendererOpts = { antialias: true, alpha: true };
        if (this._forceWebGL) {
            rendererOpts.forceWebGL = true;
        }
        this.renderer = new THREE.WebGPURenderer(rendererOpts);
        await this.renderer.init();
        this.renderer.setSize(this.width, this.height);
        const maxPixelRatio = this._mobileMode ? 1.5 : 2;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.toneMapping = THREE.NoToneMapping;

        this.container.appendChild(this.renderer.domElement);
        // Prevent browser default touch gestures (pinch-zoom, swipe-back)
        this.renderer.domElement.style.touchAction = 'none';

        // TSL node-based post-processing (color inversion only)
        this.postProcessing = new PostProcessing(this.renderer, this.scene, this.camera);

        // Resize handling
        this._boundOnResize = () => this._onResize();
        window.addEventListener('resize', this._boundOnResize);

        console.log('[SceneManager] Initialized with WebGPURenderer');
    }

    /**
     * Apply post-process config
     */
    applyPostProcessingConfig(config) {
        if (!this.postProcessing || !config) return;
        this.postProcessing.applyConfig(config);
    }

    _onResize() {
        this.width = this.container.clientWidth;
        this.height = this.container.clientHeight;

        const aspect = this.width / this.height;
        if (this.camera.isPerspectiveCamera) {
            this.camera.aspect = aspect;
            // Horizontal-width-based FOV: if aspect is more portrait than 16:9, widen vertical FOV to preserve horizontal field of view
            const refAspect = 16 / 9;
            const baseFov = this._baseFov || this.camera.fov;
            if (aspect < refAspect) {
                this.camera.fov = 2 * Math.atan(Math.tan((baseFov * Math.PI / 180) / 2) * (refAspect / aspect)) * (180 / Math.PI);
            } else {
                this.camera.fov = baseFov;
            }
            this.camera.updateProjectionMatrix();
        } else if (this.camera.isOrthographicCamera) {
            const size = this.orthographicSize;
            this.camera.left = -size * aspect;
            this.camera.right = size * aspect;
            this.camera.top = size;
            this.camera.bottom = -size;
            this.camera.updateProjectionMatrix();
        }

        this.renderer.setSize(this.width, this.height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * this.renderScale, 2));
        if (this.postProcessing) {
            this.postProcessing.onResize(this.width, this.height);
        }

        this.activeComponents.forEach(comp => {
            if (comp.onResize) {
                comp.onResize(this.width, this.height);
            }
        });
    }

    /**
     * Register a component type
     */
    registerComponent(type, ComponentClass) {
        this.componentRegistry.set(type, ComponentClass);
        console.log('[SceneManager] Registered component:', type);
    }

    /**
     * Load scene (with transition)
     */
    async loadScene(sceneData, prevSceneData = null, options = {}) {
        if (!sceneData) return;

        // Skip reloading the same scene (prevents unnecessary reconstruction during seek)
        if (this.currentSceneData === sceneData && this.activeComponents.length > 0) {
            return;
        }

        // Concurrency guard: wait for the previous loadScene to finish
        if (this._loadScenePromise) {
            await this._loadScenePromise;
        }

        let resolveLoad;
        this._loadScenePromise = new Promise(r => { resolveLoad = r; });

        try {
            this.isTransitioning = true;

            // Force canvas opacity to 1 (guard against interrupted GSAP animations)
            if (this.renderer?.domElement) {
                gsap.killTweensOf(this.renderer.domElement);
                this.renderer.domElement.style.opacity = '1';
            }

            const { skipTransitionOut = false, skipTransitionIn = false } = options;

            if (!skipTransitionOut && prevSceneData && prevSceneData.transitions?.out) {
                await this._transition(prevSceneData.transitions.out, 'out');
            }

            const desiredKeys = this._getComponentKeys(sceneData.components || []);
            this._purgeCachedComponents(desiredKeys);
            this._clearComponents(desiredKeys);

            this.currentSceneData = sceneData;

            // Background color
            if (sceneData.backgroundColor) {
                this.renderer.setClearColor(sceneData.backgroundColor, 1);
            }

            // Fog
            if (sceneData.fog) {
                const fogColor = sceneData.fog.color || sceneData.backgroundColor || '#000000';
                if (sceneData.fog.type === 'exp2') {
                    this.scene.fog = new THREE.FogExp2(fogColor, sceneData.fog.density ?? 0.02);
                } else {
                    this.scene.fog = new THREE.Fog(
                        fogColor,
                        sceneData.fog.near ?? 2,
                        sceneData.fog.far ?? 30
                    );
                }
            } else {
                this.scene.fog = null;
            }

            // Camera config
            if (sceneData.camera) {
                if (sceneData.camera.projection) {
                    this._setCameraProjection(sceneData.camera.projection, sceneData.camera);
                }
                applyCameraConfig(this.cameraController, sceneData.camera);

                if (sceneData.camera.fov && this.camera.isPerspectiveCamera) {
                    const fovTarget = { value: this._baseFov };
                    gsap.to(fovTarget, {
                        value: sceneData.camera.fov,
                        duration: 1,
                        ease: 'power2.inOut',
                        onUpdate: () => {
                            this._baseFov = fovTarget.value;
                            this._onResize();
                        }
                    });
                }

                if (typeof sceneData.camera.near === 'number') {
                    this.camera.near = this._getSafeNear(
                        sceneData.camera.near,
                        this.camera.isOrthographicCamera
                    );
                }
                if (typeof sceneData.camera.far === 'number') {
                    this.camera.far = sceneData.camera.far;
                }
                this.camera.updateProjectionMatrix();
            }

            // Global PP → scene-specific PP
            if (this._globalPostProcessingConfig) {
                this.applyPostProcessingConfig(this._globalPostProcessingConfig);
            }
            if (sceneData.postProcessing) {
                this.applyPostProcessingConfig(sceneData.postProcessing);
            }

            // Component creation / reuse
            this.activeComponents = [];
            if (sceneData.components) {
                const typeCounts = new Map();
                for (const compDef of sceneData.components) {
                    const key = this._makeComponentKey(compDef, typeCounts);
                    let component = this.componentCache.get(key);
                    if (!component) {
                        component = await this._createComponent(compDef, key);
                        if (!component) continue;
                        this.componentCache.set(key, component);
                    } else if (component.object3D && !component.object3D.parent) {
                        this.scene.add(component.object3D);
                    }
                    if (component.object3D && key) {
                        this._tagComponentObject(component.object3D, key);
                    }
                    this.activeComponents.push(component);
                }
            }
            this._sweepInactiveObjects(desiredKeys, this.activeComponents);

            if (!skipTransitionIn && sceneData.transitions?.in) {
                await this._transition(sceneData.transitions.in, 'in');
            }

            console.log('[SceneManager] Scene loaded:', sceneData.id);
        } finally {
            this.isTransitioning = false;
            if (resolveLoad) resolveLoad();
            this._loadScenePromise = null;
        }
    }

    _createPerspectiveCamera(fov = 75, near = 0.01, far = 1000) {
        return new THREE.PerspectiveCamera(
            fov,
            this.width / this.height,
            near,
            far
        );
    }

    _createOrthographicCamera(size = 6, near = 0.01, far = 1000) {
        const aspect = this.width / this.height;
        return new THREE.OrthographicCamera(
            -size * aspect,
            size * aspect,
            size,
            -size,
            near,
            far
        );
    }

    _getSafeNear(near, isOrtho) {
        if (!isOrtho) return near;
        const base = typeof near === 'number' ? near : 0.01;
        return Math.max(0.001, Math.min(base, 0.01));
    }

    _setCameraProjection(projection, config = {}) {
        const nextProjection = projection === 'orthographic' ? 'orthographic' : 'perspective';
        if (nextProjection === this.cameraProjection) {
            if (nextProjection === 'orthographic' && typeof config.orthoSize === 'number') {
                this.orthographicSize = config.orthoSize;
                this._onResize();
            }
            if (typeof config.near === 'number') {
                this.camera.near = this._getSafeNear(config.near, nextProjection === 'orthographic');
            }
            if (typeof config.far === 'number') {
                this.camera.far = config.far;
            }
            this.camera.updateProjectionMatrix();
            return;
        }

        const prevCamera = this.camera;
        this.cameraProjection = nextProjection;

        if (nextProjection === 'orthographic') {
            this.orthographicSize = config.orthoSize ?? this.orthographicSize;
            this.camera = this._createOrthographicCamera(
                this.orthographicSize,
                this._getSafeNear(config.near ?? 0.01, true),
                config.far ?? 1000
            );
        } else {
            const fov = config.fov || 75;
            this._baseFov = fov;
            this.camera = this._createPerspectiveCamera(
                fov,
                config.near ?? 0.01,
                config.far ?? 1000
            );
        }

        if (this.scene && prevCamera) {
            this.scene.remove(prevCamera);
        }
        if (this.scene) {
            this.scene.add(this.camera);
        }
        this.camera.position.copy(prevCamera.position);
        this.camera.rotation.copy(prevCamera.rotation);
        this.camera.layers.enable(2);

        const prevController = this.cameraController;
        const controllerParams = prevController ? {
            mode: prevController.mode,
            orbitSpeed: prevController.orbitSpeed,
            orbitRadius: prevController.orbitRadius,
            orbitHeight: prevController.orbitHeight,
            dollyRange: prevController.dollyRange,
            dollySpeed: prevController.dollySpeed,
            shakeIntensity: prevController.shakeIntensity,
            shakeDecay: prevController.shakeDecay,
            keyframes: prevController.keyframes
        } : {
            mode: 'orbit',
            orbitSpeed: 0.15,
            orbitRadius: 5,
            orbitHeight: 0
        };

        if (prevController) {
            prevController.dispose();
        }

        this.cameraController = new CameraController(this.camera, controllerParams);
        this.cameraController._onProjectionChange = (proj, cfg) => this.switchProjectionLive(proj, cfg);

        if (this.postProcessing) {
            this.postProcessing.setCamera(this.camera);
        }
    }

    /**
     * Live projection switch (used during playback, does not destroy CameraController)
     */
    switchProjectionLive(projection, config = {}) {
        const nextProjection = projection === 'orthographic' ? 'orthographic' : 'perspective';
        if (nextProjection === this.cameraProjection) {
            // Same projection, just update orthoSize if needed
            if (nextProjection === 'orthographic' && typeof config.orthoSize === 'number') {
                this.orthographicSize = config.orthoSize;
                this._onResize();
            }
            return;
        }

        const prevCamera = this.camera;
        this.cameraProjection = nextProjection;

        // Create new camera
        if (nextProjection === 'orthographic') {
            this.orthographicSize = config.orthoSize ?? this.orthographicSize;
            this.camera = this._createOrthographicCamera(
                this.orthographicSize,
                this._getSafeNear(config.near ?? 0.01, true),
                config.far ?? 1000
            );
        } else {
            const fov = config.fov || this._baseFov || 75;
            this._baseFov = fov;
            this.camera = this._createPerspectiveCamera(
                fov,
                config.near ?? 0.01,
                config.far ?? 1000
            );
        }

        // Replace camera in scene
        if (this.scene && prevCamera) {
            this.scene.remove(prevCamera);
        }
        if (this.scene) {
            this.scene.add(this.camera);
        }
        this.camera.position.copy(prevCamera.position);
        this.camera.rotation.copy(prevCamera.rotation);
        this.camera.layers.enable(2);

        // Swap camera in CameraController without destroying it
        if (this.cameraController) {
            this.cameraController.swapCamera(this.camera);
        }

        // Update PostProcessing camera ref
        if (this.postProcessing) {
            this.postProcessing.setCamera(this.camera);
        }

        // Notify components
        const isOrtho = nextProjection === 'orthographic';
        for (const comp of this.activeComponents) {
            if (comp.onProjectionChange) {
                comp.onProjectionChange(isOrtho);
            }
        }

        console.log('[SceneManager] Live projection switch →', nextProjection);
    }

    async _createComponent(compDef, cacheKey = null) {
        const ComponentClass = this.componentRegistry.get(compDef.type);

        if (!ComponentClass) {
            console.warn('[SceneManager] Unknown component type:', compDef.type);
            return;
        }

        const overrides = this._componentParamOverrides.get(compDef.type) || {};
        const component = new ComponentClass({ ...(compDef.params || {}), ...overrides });
        component._componentType = compDef.type;
        if (cacheKey) {
            component._cacheKey = cacheKey;
        }

        if (component.init) {
            await component.init();
        }

        if (component.object3D) {
            if (cacheKey) {
                this._tagComponentObject(component.object3D, cacheKey);
            }
            this.scene.add(component.object3D);
        }
        return component;
    }

    _clearComponents(keepKeys = null) {
        for (const comp of this.activeComponents) {
            if (keepKeys && comp._cacheKey && keepKeys.has(comp._cacheKey)) {
                continue;
            }
            if (comp.object3D) {
                if (comp.object3D.parent) {
                    comp.object3D.parent.remove(comp.object3D);
                } else {
                    this.scene.remove(comp.object3D);
                }
            }
            if (comp.dispose) {
                comp.dispose();
            }
            if (comp._cacheKey && this.componentCache.has(comp._cacheKey)) {
                this.componentCache.delete(comp._cacheKey);
            }
        }
        this.activeComponents = [];
    }

    _purgeCachedComponents(keepKeys) {
        for (const [key, comp] of this.componentCache.entries()) {
            if (keepKeys.has(key)) continue;
            if (comp.object3D) {
                if (comp.object3D.parent) {
                    comp.object3D.parent.remove(comp.object3D);
                } else {
                    this.scene.remove(comp.object3D);
                }
            }
            if (comp.dispose) {
                comp.dispose();
            }
            this.componentCache.delete(key);
        }
    }

    _sweepInactiveObjects(keepKeys, activeComponents = []) {
        if (!this.scene || !keepKeys) return;
        const allowed = new Set();
        for (const comp of activeComponents) {
            if (!comp?.object3D) continue;
            comp.object3D.traverse(obj => {
                allowed.add(obj.uuid);
            });
        }

        const removals = [];
        const scan = root => {
            root.traverse(obj => {
                const key = obj.userData?.componentKey;
                if (!key) return;
                if (!keepKeys.has(key) || !allowed.has(obj.uuid)) {
                    removals.push(obj);
                }
            });
        };

        scan(this.scene);
        if (this.camera) {
            scan(this.camera);
        }

        for (const obj of removals) {
            if (obj.parent) {
                obj.parent.remove(obj);
            } else if (obj !== this.camera) {
                this.scene.remove(obj);
            }
        }
    }

    _tagComponentObject(root, key) {
        root.userData.componentKey = key;
        root.traverse(child => {
            child.userData.componentKey = key;
        });
    }

    _makeComponentKey(compDef, typeCounts) {
        const type = compDef.type || 'Unknown';
        const count = typeCounts.get(type) ?? 0;
        typeCounts.set(type, count + 1);
        const params = compDef.params ? JSON.stringify(compDef.params) : '';
        return `${type}#${count}:${params}`;
    }

    _getComponentKeys(components) {
        const keys = new Set();
        const typeCounts = new Map();
        for (const compDef of components || []) {
            keys.add(this._makeComponentKey(compDef, typeCounts));
        }
        return keys;
    }

    async _transition(transitionType, direction) {
        const duration = 0.5;

        return new Promise(resolve => {
            switch (transitionType) {
                case 'fadeIn':
                    gsap.fromTo(
                        this.renderer.domElement,
                        { opacity: direction === 'in' ? 0 : 1 },
                        { opacity: direction === 'in' ? 1 : 0, duration, onComplete: resolve }
                    );
                    break;
                case 'fadeOut':
                    gsap.to(
                        this.renderer.domElement,
                        { opacity: 0, duration, onComplete: resolve }
                    );
                    break;
                default:
                    resolve();
            }
        });
    }

    updateAudioData(frequencyData, averageVolume) {
        this.audioData.frequencyData = frequencyData;
        this.audioData.averageVolume = averageVolume;
    }

    /**
     * Rendering frame update
     * preCompute → computeAsync → update → render
     */
    async update(musicTime, sceneProgress = 0) {
        const deltaTime = this.clock.getDelta();
        this.elapsedTime = this.clock.getElapsedTime();

        // Camera controller update
        if (this.cameraController) {
            this.cameraController.update({
                deltaTime,
                elapsedTime: this.elapsedTime,
                musicTime,
                audioData: this.audioData
            });
        }

        // Component compute → update
        for (const comp of this.activeComponents) {
            // GPU compute (particle system, etc.)
            if (comp.getComputeNodes) {
                const nodes = comp.getComputeNodes();
                if (nodes) {
                    for (const node of nodes) {
                        this.renderer.compute(node);
                    }
                }
            }

            if (comp.update) {
                comp.update({
                    deltaTime,
                    elapsedTime: this.elapsedTime,
                    musicTime,
                    sceneProgress,
                    audioData: this.audioData,
                    camera: this.camera
                });
            }
        }

        // Render via post-processing
        if (this.postProcessing) {
            this.postProcessing.update({ elapsedTime: this.elapsedTime });
            this.postProcessing.render();
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    getRenderStats() {
        const stats = {
            objects: 0,
            instances: 0,
            particles: 0,
            lights: 0,
            byType: {}
        };

        if (this.scene) {
            this.scene.traverse(obj => {
                if (!obj.visible) return;
                if (obj.isLight) {
                    stats.lights += 1;
                }
                if (obj.isMesh || obj.isPoints || obj.isLine || obj.isLineSegments || obj.isLineLoop || obj.isSprite || obj.isInstancedMesh) {
                    stats.objects += 1;
                }
                if (obj.isInstancedMesh) {
                    stats.instances += obj.count ?? obj.instanceMatrix?.count ?? 0;
                }
            });
        }

        const countRenderable = (obj, acc) => {
            if (!obj.visible) return;
            if (obj.isMesh || obj.isPoints || obj.isLine || obj.isLineSegments || obj.isLineLoop || obj.isSprite || obj.isInstancedMesh) {
                acc.objects += 1;
            }
            if (obj.isInstancedMesh) {
                acc.instances += obj.count ?? obj.instanceMatrix?.count ?? 0;
            }
        };

        for (const comp of this.activeComponents) {
            const type = comp._componentType || comp.type || comp.constructor?.name || 'Unknown';
            if (!stats.byType[type]) {
                stats.byType[type] = { objects: 0, instances: 0, particles: 0 };
            }
            const bucket = stats.byType[type];
            if (comp.object3D) {
                comp.object3D.traverse(obj => countRenderable(obj, bucket));
            }
            if (typeof comp.getStats === 'function') {
                const compStats = comp.getStats();
                if (compStats && typeof compStats.particles === 'number') {
                    bucket.particles += compStats.particles;
                    stats.particles += compStats.particles;
                }
            }
        }

        return stats;
    }

    clearScene() {
        this._clearComponents();
        this.currentSceneData = null;
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.render(this.scene, this.camera);
    }

    setRenderScale(scale) {
        const nextScale = Math.max(0.7, Math.min(1, scale));
        if (Math.abs(nextScale - this.renderScale) < 0.01) return;
        this.renderScale = nextScale;
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * this.renderScale, 2));
        if (this.postProcessing) {
            this.postProcessing.onResize(this.width, this.height);
        }
    }

    dispose() {
        this._clearComponents();
        if (this._boundOnResize) {
            window.removeEventListener('resize', this._boundOnResize);
        }
        this.renderer.dispose();
        this.container.removeChild(this.renderer.domElement);
    }
}
