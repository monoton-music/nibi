/**
 * GPUParticleSystem - TSL compute shader-based particle system
 *
 * CMYK 4 colors: drawn as R/G/B/W → inverted to C/M/Y/K by PostProcessing
 * 16 text formation animations: waveReveal, rainDrop, tornado, phyllotaxis, etc.
 * All parameters pre-configured (no audio-reactive changes)
 *
 * Compute shader force fields:
 * - Multi-octave curl noise
 * - Vortex field
 * - Concentric wave
 * - 2-stage text attraction (velocity bias + proximity linger)
 * - Near-text velocity suppression
 * - Spherical soft boundary
 *
 * Flow patterns: 13 GPU patterns (via gpuFlowPatterns.js) + 5 CPU patterns (fractal/recursive)
 */

import * as THREE from 'three/webgpu';
import {
    Fn, uniform, instancedArray, instanceIndex,
    vec2, vec3, vec4, float, If,
    hash, mx_noise_vec3,
    max, clamp, length, normalize, cross, mix,
    uv, smoothstep, sin, cos
} from 'three/tsl';
import { FLOW_PATTERN_GENERATORS, FLOW_PATTERN_ANIMATORS } from './flowPatterns.js';
import { GPU_PATTERN_IDS, buildGPUTargetSection } from './gpuFlowPatterns.js';

// Macro progression phases — 8 phases with tension/release dynamics
// B→Chorus: noise drops 8x→1/8x for catharsis
const MACRO_PHASES = [
    { end: 11,  noiseStr: 0.00008, noiseScl: 0.08, spring: 0.015, damp: 0.993, vortex: 0,       wave: 0,      convUp: 0.10, convDn: 0.004, pointScale: 0.6  }, // Intro: silence
    { end: 33,  noiseStr: 0.00025, noiseScl: 0.12, spring: 0.040, damp: 0.982, vortex: 0.00005, wave: 0,      convUp: 0.15, convDn: 0.006, pointScale: 1.0  }, // A1: text appears
    { end: 44,  noiseStr: 0.00060, noiseScl: 0.20, spring: 0.030, damp: 0.975, vortex: 0.00040, wave: 0.0003, convUp: 0.12, convDn: 0.005, pointScale: 1.3  }, // B1: chaos
    { end: 66,  noiseStr: 0.00030, noiseScl: 0.14, spring: 0.050, damp: 0.980, vortex: 0.00008, wave: 0,      convUp: 0.16, convDn: 0.006, pointScale: 1.1  }, // A2: slightly stronger
    { end: 77,  noiseStr: 0.00080, noiseScl: 0.25, spring: 0.025, damp: 0.970, vortex: 0.00060, wave: 0.0005, convUp: 0.10, convDn: 0.005, pointScale: 1.4  }, // B2: maximum chaos
    { end: 99,  noiseStr: 0.00010, noiseScl: 0.06, spring: 0.070, damp: 0.990, vortex: 0,       wave: 0,      convUp: 0.22, convDn: 0.008, pointScale: 0.8  }, // Chorus: subtractive stillness
    { end: 121, noiseStr: 0.00015, noiseScl: 0.08, spring: 0.065, damp: 0.988, vortex: 0.00002, wave: 0,      convUp: 0.20, convDn: 0.007, pointScale: 0.9  }, // Chorus2: minimal movement
    { end: 999, noiseStr: 0.00004, noiseScl: 0.04, spring: 0.010, damp: 0.995, vortex: 0,       wave: 0,      convUp: 0.06, convDn: 0.003, pointScale: 0.4  }, // Outro: disappearance
];

// Text formation animations
// delay: seconds before the formation shape begins transitioning to final text positions
// stagger: per-character delay (0 = all chars simultaneously)
const TEXT_ANIMATIONS = {
    waveReveal:      { delay: 0.0, stagger: 0.08 },
    rainDrop:        { delay: 0.0, stagger: 0.0  },
    spiralPerChar:   { delay: 0.2, stagger: 0.10 },
    ringToChar:      { delay: 0.2, stagger: 0.08 },
    typewriter:      { delay: 0.0, stagger: 0.18 },
    columnDrop:      { delay: 0.0, stagger: 0.0  },
    centerBurst:     { delay: 0.0, stagger: 0.0  },
    directSnap:      { delay: 0.0, stagger: 0.0  },
    sphereContract:  { delay: 0.15, stagger: 0.0 },
    riseUp:          { delay: 0.0, stagger: 0.0  },
    scatterIn:       { delay: 0.0, stagger: 0.05 },
    gridDissolve:    { delay: 0.2, stagger: 0.0  },
    tornado:         { delay: 0.3, stagger: 0.10 },
    phyllotaxis:     { delay: 0.2, stagger: 0.0  },
    shockwaveRing:   { delay: 0.15, stagger: 0.0 },
    flatPlane:       { delay: 0.0, stagger: 0.06 },
};

/**
 * Canvas 2D sampling per character → extract particle positions for each character
 */
function sampleTextPositionsPerChar(text, {
    font = "'Zen Kaku Gothic New', sans-serif",
    fontSize = 200,
    maxPointsPerChar = 30000,
    targetWidth = 4,
    depthSpread = 0.1,
    align = 'center'   // 'center' | 'left' — affects where origin[0] anchors the text
} = {}) {
    const chars = [...text];
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    const fontStr = `bold ${fontSize}px ${font}`;
    measureCtx.font = fontStr;

    const charWidths = chars.map(ch => measureCtx.measureText(ch).width);
    const totalWidth = charWidths.reduce((s, w) => s + w, 0);
    const scale = targetWidth / Math.max(totalWidth + 40, 1);

    const result = [];
    // center: origin is text center; left: origin is left edge of text
    let xOffset = align === 'left' ? 0 : -totalWidth / 2 * scale;

    for (let c = 0; c < chars.length; c++) {
        const cw = charWidths[c];
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = Math.ceil(cw) + 20;
        canvas.height = Math.ceil(fontSize * 1.4);
        ctx.font = fontStr;
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(chars[c], 10, canvas.height / 2);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const positions = [];
        const step = Math.max(1, Math.floor(
            Math.sqrt((canvas.width * canvas.height) / maxPointsPerChar)
        ));

        for (let y = 0; y < canvas.height; y += step) {
            for (let x = 0; x < canvas.width; x += step) {
                if (imageData.data[(x + y * canvas.width) * 4 + 3] > 128) {
                    positions.push(
                        xOffset + (x - canvas.width / 2) * scale,
                        -(y - canvas.height / 2) * scale,
                        (Math.random() - 0.5) * depthSpread
                    );
                }
            }
        }

        result.push({
            textPositions: new Float32Array(positions),
            center: [xOffset + cw * scale / 2, 0, 0],
            revealed: false,
        });

        xOffset += cw * scale;
    }
    return result;
}

/**
 * Shadow Sculpture: 2-direction anamorphic
 * Generates a 3D point cloud readable as textA from the front (XY projection)
 * and as textB from the top (XZ projection).
 *
 * Uniform distribution version: both texts are drawn at the same canvas size,
 * columns are matched via nearest-neighbor on x, textA-only/textB-only columns
 * are also included, and the whole set is uniformly downsampled.
 */
function sampleDualProjectionTargets(textA, textB, {
    font = "'Zen Kaku Gothic New', sans-serif",
    fontSize = 200,
    maxPoints = 500000,
    targetWidth = 4
} = {}) {
    const fontStr = `bold ${fontSize}px ${font}`;

    // Measure both texts to find the larger canvas size
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    measureCtx.font = fontStr;
    const twA = measureCtx.measureText(textA).width;
    const twB = measureCtx.measureText(textB).width;
    const maxTw = Math.max(twA, twB);
    const canvasW = Math.ceil(maxTw) + 40;
    const canvasH = Math.ceil(fontSize * 1.4);
    const scale = targetWidth / Math.max(maxTw + 40, 1);

    // Sample pixel positions for a single text using shared canvas size
    const sampleText = (text) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = canvasW;
        canvas.height = canvasH;
        ctx.font = fontStr;
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        // Center the text in the shared canvas
        const tw = measureCtx.measureText(text).width;
        const xOffset = (canvasW - tw) / 2;
        ctx.fillText(text, xOffset, canvasH / 2);

        const imageData = ctx.getImageData(0, 0, canvasW, canvasH);
        const step = Math.max(1, Math.floor(Math.sqrt((canvasW * canvasH) / 50000)));

        // Collect per-column y-positions
        const columns = new Map(); // quantized-x → [y-world, ...]
        for (let y = 0; y < canvasH; y += step) {
            for (let x = 0; x < canvasW; x += step) {
                if (imageData.data[(x + y * canvasW) * 4 + 3] > 128) {
                    const wx = (x - canvasW / 2) * scale;
                    const wy = -(y - canvasH / 2) * scale;
                    const col = Math.round(wx * 100);
                    if (!columns.has(col)) columns.set(col, []);
                    columns.get(col).push(wy);
                }
            }
        }
        return columns;
    };

    const colsA = sampleText(textA); // front view: x → x, y → y
    const colsB = sampleText(textB); // top view: x → x, y → z

    // Build sorted column arrays for nearest-neighbor lookup
    const allColsB = [...colsB.keys()].sort((a, b) => a - b);
    const findNearestBCol = (col) => {
        if (allColsB.length === 0) return null;
        let lo = 0, hi = allColsB.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (allColsB[mid] < col) lo = mid + 1;
            else hi = mid;
        }
        // Check neighbors for closest
        if (lo > 0 && Math.abs(allColsB[lo - 1] - col) < Math.abs(allColsB[lo] - col)) lo--;
        return allColsB[lo];
    };

    const allColsA = [...colsA.keys()].sort((a, b) => a - b);
    const findNearestACol = (col) => {
        if (allColsA.length === 0) return null;
        let lo = 0, hi = allColsA.length - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (allColsA[mid] < col) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0 && Math.abs(allColsA[lo - 1] - col) < Math.abs(allColsA[lo] - col)) lo--;
        return allColsA[lo];
    };

    // Generate all 3D points
    const positions = [];

    // 1. For each column in A, pair with nearest B column for z values
    for (const [col, ysA] of colsA) {
        const x = col / 100;
        const nearestBCol = findNearestBCol(col);
        const zsB = nearestBCol !== null ? (colsB.get(nearestBCol) || []) : [];

        if (zsB.length > 0) {
            for (const y of ysA) {
                // Pick random z from nearest B column
                const z = zsB[Math.floor(Math.random() * zsB.length)];
                positions.push(x, y, z);
            }
        } else {
            for (const y of ysA) {
                positions.push(x, y, (Math.random() - 0.5) * 0.1);
            }
        }
    }

    // 2. For columns only in B (not in A), add with y≈0
    for (const [col, zsB] of colsB) {
        if (colsA.has(col)) continue; // already covered
        const nearestACol = findNearestACol(col);
        if (nearestACol !== null && Math.abs(nearestACol - col) < 5) continue; // close enough, skip
        const x = col / 100;
        for (const z of zsB) {
            positions.push(x, (Math.random() - 0.5) * 0.15, z);
        }
    }

    // 3. Uniform downsample to maxPoints
    const totalPoints = positions.length / 3;
    if (totalPoints <= maxPoints) {
        return new Float32Array(positions);
    }

    // Stride-based uniform sampling
    const result = new Float32Array(maxPoints * 3);
    const stride = totalPoints / maxPoints;
    for (let i = 0; i < maxPoints; i++) {
        const srcIdx = Math.floor(i * stride);
        result[i * 3] = positions[srcIdx * 3];
        result[i * 3 + 1] = positions[srcIdx * 3 + 1];
        result[i * 3 + 2] = positions[srcIdx * 3 + 2];
    }
    return result;
}

export class GPUParticleSystem {
    constructor(params = {}) {
        this.params = params;
        this.count = params.count || 1000000;
        this.object3D = new THREE.Group();

        this._spring = params.spring ?? 0.005;
        this._damping = params.damping ?? 0.988;
        this._noiseScale = params.noiseScale ?? 0.15;
        this._noiseStrength = params.noiseStrength ?? 0.0003;
        this._pointSize = params.pointSize ?? 1.0;
        this._depthSpread = params.depthSpread ?? 0.05;

        this._posBuffer = null;
        this._velBuffer = null;
        this._targetBuffer = null;
        this._lifeBuffer = null;
        this._colorBuffer = null;
        this._computeNode = null;
        this._uniforms = {};

        this._currentText = '';
        this._textFont = params.font || "'Zen Kaku Gothic New', sans-serif";
        this._textFontSize = params.fontSize || 200;
        this._textHoldDuration = params.textHoldDuration ?? 2.5;
        this._convUpScale = params.convUpScale ?? 1.0;
        this._convDnScale = params.convDnScale ?? 1.0;
        this._lastTextTime = 0;
        this._textIndex = 0;

        this._camera = null;

        this._flowPatterns = Object.keys(FLOW_PATTERN_GENERATORS);
        this._flowPatternIdx = 0;

        // Phase: 'flow' | 'forming' | 'text' | 'releasing'
        this._phase = 'flow';
        this._onLog = null; // callback: (tag, msg) => {}
        this._convergence = 0.0;
        this._targetConvergence = 0.0;

        // Per-character animation
        this._charData = null;
        this._animType = 'directSnap';
        this._formationPending = false;
        this._formationStartTime = -1;

        // Per-lyric convergence control
        this._maxConvergence = 1.0;
        this._holdDurationOverride = null;
        this._releaseSpeed = 1.0;

        // Sweep
        this._sweepDir = [0, 0, 0];
        this._currentSweepX = 0;
        this._currentSweepY = 0;
        this._currentSweepZ = 0;

        // Flow target evolution
        this._lastFlowTargetUpdate = 0;
        this._flowTargetInterval = 5.0;
        this._currentFlowPattern = 'organic';

        // Macro (smoothed)
        this._macro = {
            noiseStr: 0.00015, noiseScl: 0.10, spring: 0.012, damp: 0.993,
            vortex: 0.0, wave: 0.0, gravity: 0.0, convUp: 0.025, convDn: 0.004, pointScale: 0.6
        };

        // Per-lyric physics overrides (from mv-data.json)
        this._physicsOverrides = null;

        // Dissolve mode: 'down' → extra gravity+noise during releasing
        this._dissolveMode = null;

        // Pending flow target (set during text hold, applied on release)
        this._pendingFlowPattern = null;
        this._pendingFlowOptions = {};

        // Anamorphic world rotation
        this._targetWorldQuat = null;
        this._worldQuatIdentity = new THREE.Quaternion();

        // Group split: two independent particle ranges with separate phase state
        // _splitPoint = COUNT (disabled) by default; set in init() after COUNT is known
        this._splitPoint = null;
        this._groupBPatternActive = false; // true when split was activated by groupBPattern (auto-managed)
        this._slotB = {
            phase: 'flow',
            convergence: 0,
            targetConvergence: 0.1,
            lastTextTime: 0,
            holdDurationOverride: null,
            releaseSpeed: 1.0,
            dissolveMode: null,
            maxConvergence: 1.0,
            physicsOverrides: null,
            charData: null,
            formationPending: false,
            formationStartTime: -1,
            animType: null,
            sweepDir: [0, 0, 0],
            currentSweepX: 0,
            currentSweepY: 0,
            currentSweepZ: 0,
        };
    }

    _log(tag, msg) {
        if (this._onLog) this._onLog(tag, msg);
    }

    /**
     * Extract physics override params from options (returns null if none specified)
     */
    _extractPhysicsOverrides(options) {
        const keys = ['spring', 'damping', 'noiseStrength', 'noiseScale', 'vortex', 'wave', 'gravity', 'pointScale', 'convUp', 'convDn', 'lerpRate'];
        let found = false;
        const overrides = {};
        for (const k of keys) {
            if (options[k] != null) { overrides[k] = options[k]; found = true; }
        }
        return found ? overrides : null;
    }

    async init() {
        const COUNT = this.count;
        this._splitPoint = COUNT; // default: no split (all particles in group 0)

        this._posBuffer = instancedArray(COUNT, 'vec3');
        this._velBuffer = instancedArray(COUNT, 'vec3');
        this._targetBuffer = instancedArray(COUNT, 'vec3');
        this._lifeBuffer = instancedArray(COUNT, 'vec2');
        this._colorBuffer = instancedArray(COUNT, 'vec3');

        // Initial positions: random distribution within a sphere (no recognizable shape)
        const posArray = this._posBuffer.value.array;
        for (let i = 0; i < COUNT; i++) {
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const r = Math.cbrt(Math.random()) * 3.0;
            posArray[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
            posArray[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            posArray[i * 3 + 2] = r * Math.cos(phi);
        }
        this._posBuffer.value.needsUpdate = true;

        // CMYK color assignment: R→C, G→M, B→Y (after inversion) — pure primaries at 100%
        // W (→K=black) removed: all particles visible, density increased by 33%
        const colorArray = this._colorBuffer.value.array;
        for (let i = 0; i < COUNT; i++) {
            const g = i % 3;
            if (g === 0)      { colorArray[i*3]=1.0; colorArray[i*3+1]=0.0; colorArray[i*3+2]=0.0; }
            else if (g === 1) { colorArray[i*3]=0.0; colorArray[i*3+1]=1.0; colorArray[i*3+2]=0.0; }
            else              { colorArray[i*3]=0.0; colorArray[i*3+1]=0.0; colorArray[i*3+2]=1.0; }
        }
        this._colorBuffer.value.needsUpdate = true;

        // Life
        const lifeArray = this._lifeBuffer.value.array;
        for (let i = 0; i < COUNT; i++) {
            lifeArray[i * 2] = Math.random() * 10;
            lifeArray[i * 2 + 1] = 5 + Math.random() * 10;
        }
        this._lifeBuffer.value.needsUpdate = true;

        // --- Uniforms ---
        this._uniforms.uDeltaTime = uniform(0.016);
        this._uniforms.uTime = uniform(0);
        this._uniforms.uSpringStrength = uniform(this._spring);
        this._uniforms.uDamping = uniform(this._damping);
        this._uniforms.uNoiseScale = uniform(this._noiseScale);
        this._uniforms.uNoiseStrength = uniform(this._noiseStrength);
        this._uniforms.uConvergence = uniform(0);
        this._uniforms.uSweepX = uniform(0);
        this._uniforms.uSweepY = uniform(0);
        this._uniforms.uSweepZ = uniform(0);
        this._uniforms.uVortexStrength = uniform(0);
        this._uniforms.uWavePhase = uniform(0);
        this._uniforms.uWaveStrength = uniform(0);
        this._uniforms.uGravity = uniform(0);
        this._uniforms.uCameraPos = uniform(new THREE.Vector3(0, 0, 5));
        this._uniforms.uIsOrtho = uniform(0);
        this._uniforms.uFlattenZ = uniform(0);
        this._uniforms.uGPUPatternId = uniform(0);
        this._uniforms.uBgPatternId = uniform(0);
        this._uniforms.uTextParticleRatio = uniform(1.0);
        this._uniforms.uTextPerChar = uniform(float(1.0)); // particles per char, for per-char bg split

        // Group B uniforms (group 0 = particles [0, uGroupSplit), group 1 = [uGroupSplit, COUNT))
        this._uniforms.uGroupSplit = uniform(float(COUNT));
        this._uniforms.uConvergenceB = uniform(0.0);
        this._uniforms.uSweepXB = uniform(0.0);
        this._uniforms.uSweepYB = uniform(0.0);
        this._uniforms.uSweepZB = uniform(0.0);
        // Group B independent GPU pattern (text group 0 + animation group 1 simultaneously)
        this._uniforms.uGPUPatternIdB = uniform(0);
        this._uniforms.uFlowOriginB = uniform(new THREE.Vector3(0, 0, 0));
        this._uniforms.uFlowScaleB = uniform(1.0);

        // --- Origin/Scale/Multi-layer uniforms ---
        this._uniforms.uFlowOrigin = uniform(new THREE.Vector3(0, 0, 0));
        this._uniforms.uFlowScale = uniform(1.0);
        this._uniforms.uNumLayers = uniform(1);
        this._uniforms.uLayerPatternId0 = uniform(0);
        this._uniforms.uLayerPatternId1 = uniform(0);
        this._uniforms.uLayerPatternId2 = uniform(0);
        this._uniforms.uLayerPatternId3 = uniform(0);
        this._uniforms.uLayerOrigin0 = uniform(new THREE.Vector3(0, 0, 0));
        this._uniforms.uLayerOrigin1 = uniform(new THREE.Vector3(0, 0, 0));
        this._uniforms.uLayerOrigin2 = uniform(new THREE.Vector3(0, 0, 0));
        this._uniforms.uLayerOrigin3 = uniform(new THREE.Vector3(0, 0, 0));
        this._uniforms.uLayerScale0 = uniform(1.0);
        this._uniforms.uLayerScale1 = uniform(1.0);
        this._uniforms.uLayerScale2 = uniform(1.0);
        this._uniforms.uLayerScale3 = uniform(1.0);

        this._computeNode = this._buildComputeShader(COUNT);

        // --- Material ---
        const material = new THREE.SpriteNodeMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            sizeAttenuation: false
        });

        const posAttr = this._posBuffer.toAttribute();
        material.positionNode = posAttr;

        const baseSize = uniform(this._pointSize);
        const uCamPos = this._uniforms.uCameraPos;

        // Distance-based size: closer particles appear larger (depth cue)
        // Orthographic mode: uniform size (no distance-based scaling)
        const uIsOrtho = this._uniforms.uIsOrtho;
        const pToCam = posAttr.sub(uCamPos);
        const pCamDist = max(length(pToCam), float(0.1));
        const distScale = clamp(float(3.0).div(pCamDist), 0.6, 2.5);
        const effectiveDistScale = mix(distScale, float(1.0), uIsOrtho);
        material.scaleNode = baseSize.mul(0.005).mul(effectiveDistScale);
        this._uniforms.uPointSize = baseSize;

        // CMYK color
        material.colorNode = this._colorBuffer.toAttribute();

        // Opacity: hard-edge circle only (opaque CMYK dots, color mixing on overlap)
        const uvDist = length(uv().sub(0.5)).mul(2.0);
        const hardCircle = smoothstep(float(1.0), float(0.75), uvDist);

        material.opacityNode = hardCircle;

        const geometry = new THREE.PlaneGeometry(1, 1);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.count = COUNT;
        mesh.frustumCulled = false;
        this.object3D.add(mesh);

        this._mesh = mesh;
        this._material = material;

        this.setMode('flow');
    }

    _buildComputeShader(COUNT) {
        const posBuffer = this._posBuffer;
        const velBuffer = this._velBuffer;
        const targetBuffer = this._targetBuffer;
        const lifeBuffer = this._lifeBuffer;
        const u = this._uniforms;

        const computeUpdate = Fn(() => {
            const i = instanceIndex;
            const pos = posBuffer.element(i);
            const vel = velBuffer.element(i);
            const target = targetBuffer.element(i);
            const life = lifeBuffer.element(i);
            const t = u.uTime;

            // Per-group convergence + sweep (group B = particles [uGroupSplit, COUNT))
            const inGroupB = float(i).greaterThanEqual(u.uGroupSplit).toFloat();
            const effConv = mix(u.uConvergence, u.uConvergenceB, inGroupB);
            const effSweepX = mix(u.uSweepX, u.uSweepXB, inGroupB);
            const effSweepY = mix(u.uSweepY, u.uSweepYB, inGroupB);
            const effSweepZ = mix(u.uSweepZ, u.uSweepZB, inGroupB);

            // === GPU flow pattern target generation ===
            // Multi-layer: split particles by i % numLayers, each gets own pattern/origin/scale
            // Single-layer: use uGPUPatternId + uFlowOrigin/uFlowScale directly
            const effPatternId = u.uGPUPatternId.toVar();
            const effOrigin = vec3(u.uFlowOrigin).toVar();
            const effScale = float(u.uFlowScale).toVar();

            If(u.uNumLayers.greaterThan(1), () => {
                const layerId = i.mod(u.uNumLayers);
                If(layerId.lessThan(1), () => {
                    effPatternId.assign(u.uLayerPatternId0);
                    effOrigin.assign(u.uLayerOrigin0);
                    effScale.assign(u.uLayerScale0);
                }).ElseIf(layerId.lessThan(2), () => {
                    effPatternId.assign(u.uLayerPatternId1);
                    effOrigin.assign(u.uLayerOrigin1);
                    effScale.assign(u.uLayerScale1);
                }).ElseIf(layerId.lessThan(3), () => {
                    effPatternId.assign(u.uLayerPatternId2);
                    effOrigin.assign(u.uLayerOrigin2);
                    effScale.assign(u.uLayerScale2);
                }).Else(() => {
                    effPatternId.assign(u.uLayerPatternId3);
                    effOrigin.assign(u.uLayerOrigin3);
                    effScale.assign(u.uLayerScale3);
                });
            });

            // === Dual mode: per-character split — each char contributes textRatio fraction to text ===
            // posInChar / uTextPerChar >= textParticleRatio → background; ensures all chars stay visible
            const bgPat = u.uBgPatternId;
            const _tpc = max(u.uTextPerChar, float(1.0));
            const posInChar = float(i).mod(_tpc);
            const isBgParticle = bgPat.greaterThan(0).and(
                posInChar.div(_tpc).greaterThanEqual(u.uTextParticleRatio)
            );
            If(isBgParticle, () => {
                effPatternId.assign(bgPat);
            });

            If(effPatternId.greaterThan(0), () => {
                buildGPUTargetSection(i, target, t, effPatternId, COUNT);
                target.assign(target.mul(effScale).add(effOrigin));
            });

            // Group B independent GPU animation: overrides target for particles in group 1
            // Enables text (group 0) + animation (group 1) simultaneously
            If(inGroupB.greaterThan(float(0.5)).and(u.uGPUPatternIdB.greaterThan(0)), () => {
                buildGPUTargetSection(i, target, t, u.uGPUPatternIdB, COUNT);
                target.assign(target.mul(u.uFlowScaleB).add(u.uFlowOriginB));
            });

            life.x.subAssign(u.uDeltaTime);

            const dir = target.sub(pos);
            const particleHash = hash(float(i).mul(0.137));
            const particleVariation = particleHash.mul(1.4).add(0.3);

            // === Text attraction (computed first — used for noise suppression) ===
            const sweepDelay = pos.x.mul(effSweepX).add(pos.y.mul(effSweepY)).add(pos.z.mul(effSweepZ));
            const effectiveAttraction = clamp(
                effConv.sub(sweepDelay.mul(0.03)).sub(particleHash.mul(0.01)),
                0.0, 1.0
            );

            // === Multi-octave curl noise (suppressed during convergence) ===
            const n1 = mx_noise_vec3(pos.mul(u.uNoiseScale).add(t.mul(0.08)));
            const n2 = mx_noise_vec3(pos.mul(u.uNoiseScale.mul(2.3)).add(t.mul(0.14)));
            const n3 = mx_noise_vec3(pos.mul(u.uNoiseScale.mul(5.1)).add(t.mul(0.22)));
            const multiNoise = n1.add(n2.mul(0.4)).add(n3.mul(0.15));
            const noiseSuppress = max(float(1.0).sub(effectiveAttraction), float(0.0));
            vel.addAssign(multiNoise.mul(u.uNoiseStrength).mul(1.5).mul(noiseSuppress));

            // === Vortex field (suppressed during convergence) ===
            const vCenter = vec3(
                sin(t.mul(0.07)).mul(1.2),
                cos(t.mul(0.11)).mul(0.8),
                sin(t.mul(0.09)).mul(0.5)
            );
            const toV = pos.sub(vCenter);
            const vDist = max(length(toV), float(0.01));
            const vAxis = normalize(vec3(sin(t.mul(0.05)), cos(t.mul(0.03)), sin(t.mul(0.07).add(1.0))));
            const vForce = cross(toV.div(vDist), vAxis);
            const vFalloff = smoothstep(float(0.0), float(1.5), vDist).mul(
                smoothstep(float(5.0), float(2.0), vDist)
            );
            const vortexSuppress = max(float(1.0).sub(effectiveAttraction), float(0.0));
            vel.addAssign(vForce.mul(u.uVortexStrength).mul(vFalloff).mul(vortexSuppress));

            // === Concentric wave ripple ===
            const wOrigin = vec3(sin(t.mul(0.13)).mul(2.0), cos(t.mul(0.09)).mul(1.5), float(0));
            const wDir = pos.sub(wOrigin);
            const wDist = max(length(wDir), float(0.01));
            const wPhase = wDist.mul(3.0).sub(u.uWavePhase);
            const wPush = sin(wPhase).mul(u.uWaveStrength).div(max(wDist, float(0.5)));
            vel.addAssign(wDir.div(wDist).mul(wPush));

            // === Background particle attraction reduction ===
            const bgMul = mix(float(1.0), float(0.15), isBgParticle.toFloat());

            // === Direct position convergence (distance-independent) ===
            const globalPull = effectiveAttraction.mul(0.08).mul(bgMul);
            pos.addAssign(dir.mul(globalPull));

            // === Drift (suppressed during convergence) ===
            const driftSuppress = max(float(1.0).sub(effectiveAttraction), float(0.0));
            const driftP = pos.x.mul(0.6).add(pos.y.mul(0.4)).add(t.mul(0.2));
            vel.x.addAssign(sin(driftP).mul(0.00004).mul(driftSuppress));
            vel.y.addAssign(sin(driftP.add(1.571)).mul(0.00003).mul(driftSuppress));
            vel.y.subAssign(float(0.000008).mul(driftSuppress));
            const gentleBias = u.uSpringStrength.mul(effectiveAttraction).mul(particleVariation).mul(1.5).mul(bgMul);
            vel.addAssign(dir.mul(gentleBias));

            const dist = length(dir);
            const proximity = smoothstep(float(5.0), float(0.0), dist);
            const lingerRate = u.uSpringStrength.mul(effectiveAttraction).mul(proximity).mul(particleVariation).mul(10.0).mul(bgMul);
            pos.addAssign(dir.mul(lingerRate));

            // === Near-text velocity suppression ===
            vel.mulAssign(float(1.0).sub(effectiveAttraction.mul(proximity).mul(0.95)));

            // === Camera repulsion (particles scatter near camera) ===
            // Orthographic mode: 80% reduction
            const toCam = pos.sub(u.uCameraPos);
            const camDist = max(length(toCam), float(0.01));
            const camRepulseBase = smoothstep(float(0.8), float(0.0), camDist).mul(0.0004);
            const camRepulse = camRepulseBase.mul(mix(float(1.0), float(0.2), u.uIsOrtho));
            vel.addAssign(toCam.div(camDist).mul(camRepulse));

            // === Spherical soft boundary (origin-relative) ===
            const posRelOrigin = pos.sub(effOrigin);
            const distFC = length(posRelOrigin);
            const overDist = max(distFC.sub(float(6.0)), float(0.0));
            vel.addAssign(posRelOrigin.mul(float(-1.0)).div(max(distFC, float(0.01))).mul(overDist.mul(0.006)));

            // === Gravity (downward acceleration) ===
            vel.y.subAssign(u.uGravity);

            // === Velocity clamp (prevent oscillation/flickering) ===
            const velMag = length(vel);
            const maxVel = float(0.08);
            const overMax = velMag.greaterThan(maxVel).toFloat();
            vel.assign(mix(vel, vel.div(max(velMag, float(0.0001))).mul(maxVel), overMax));

            // === Damping + integrate ===
            vel.mulAssign(u.uDamping);
            pos.addAssign(vel.mul(u.uDeltaTime.mul(60.0)));

            // === Non-anamorphic text: suppress Z-scatter (soft) ===
            const flatZ = u.uFlattenZ;
            vel.z.mulAssign(float(1.0).sub(flatZ.mul(0.85)));
            pos.z.addAssign(target.z.sub(pos.z).mul(flatZ.mul(0.12)));

            // === Flat plane mode: hard Z-clamp ===
            pos.z.assign(mix(pos.z, target.z, flatZ));
            vel.z.mulAssign(float(1.0).sub(flatZ));

            // === Life reset → convergence-dependent radius ===
            const isDead = life.x.lessThan(0.0).toFloat();
            const rh1 = hash(vec2(float(i).add(500.0), t)).sub(0.5);
            const rh2 = hash(vec2(float(i).add(1500.0), t)).sub(0.5);
            const rh3 = hash(vec2(float(i).add(2500.0), t)).sub(0.5);
            const raw = vec3(rh1, rh2, rh3);
            const rawLen = max(length(raw), float(0.001));
            const resetHash = hash(vec2(float(i).add(3500.0), t));
            const farR = float(2.5).add(resetHash.mul(2.0));
            const shellPos = raw.div(rawLen).mul(farR);
            const targetJitter = raw.mul(0.02).mul(max(float(1.0).sub(effectiveAttraction), float(0.05)));
            const targetPos = target.add(targetJitter);
            const attractSq = effectiveAttraction.mul(effectiveAttraction);
            const resetPos = shellPos.add(targetPos.sub(shellPos).mul(attractSq.mul(0.8).add(effectiveAttraction.mul(0.2))));
            pos.addAssign(resetPos.sub(pos).mul(isDead));
            life.x.addAssign(life.y.mul(isDead));

        })().compute(COUNT);

        return computeUpdate;
    }

    getComputeNodes() {
        return this._computeNode ? [this._computeNode] : null;
    }

    setText(text, options = {}) {
        return this.setTextTarget(text, options);
    }

    /**
     * Shadow Sculpture: 2-direction anamorphic lyrics
     * Forms a 3D sculpture readable as textA from the front (XY projection)
     * and as textB from the top (XZ projection).
     */
    setShadowSculptureTarget(textA, textB, options = {}) {
        if (!textA || !textB) return;
        this._uniforms.uFlattenZ.value = 0.0;
        this._uniforms.uGPUPatternId.value = 0; // CPU text targets
        this._resetToSingleLayer();
        this._currentText = `${textA}|${textB}`;
        this._lastTextTime = 0;
        this._textIndex++;

        // Per-lyric convergence control
        this._maxConvergence = options.maxConvergence ?? 1.0;
        this._holdDurationOverride = options.holdDuration ?? null;
        this._releaseSpeed = options.releaseSpeed ?? 1.0;
        this._dissolveMode = options.dissolveMode ?? null;

        // Per-lyric physics overrides
        this._physicsOverrides = this._extractPhysicsOverrides(options);

        const sculpturePositions = sampleDualProjectionTargets(textA, textB, {
            font: options.font || this._textFont,
            fontSize: options.fontSize || this._textFontSize,
            maxPoints: this.count,
            targetWidth: options.targetWidth || 4
        });

        // Write to target buffer
        const ta = this._targetBuffer.value.array;
        const numSculpturePoints = sculpturePositions.length / 3;
        for (let i = 0; i < this.count; i++) {
            const srcIdx = i % numSculpturePoints;
            const jitter = i < numSculpturePoints ? 0 : 0.03;
            ta[i * 3]     = sculpturePositions[srcIdx * 3]     + (Math.random() - 0.5) * jitter;
            ta[i * 3 + 1] = sculpturePositions[srcIdx * 3 + 1] + (Math.random() - 0.5) * jitter;
            ta[i * 3 + 2] = sculpturePositions[srcIdx * 3 + 2] + (Math.random() - 0.5) * jitter;
        }
        this._targetBuffer.value.needsUpdate = true;

        // No per-char animation — whole sculpture at once
        this._charData = null;
        this._formationPending = false;
        this._animType = 'sculpture';
        this._phase = 'text';
        this._targetConvergence = 1.0;
        this._sweepDir = [0, 0, 0];

        this._log('phase', `text (sculpture) A="${textA}" B="${textB}"`);
    }

    /**
     * Set text target (per-character animation system)
     * options.animation specifies the animation type
     * options.maxConvergence (0-1): convergence ceiling. Lower values = characters never fully form
     * options.holdDuration (seconds): per-lyric hold time override
     * options.releaseSpeed (multiplier): release speed multiplier
     */
    setTextTarget(text, options = {}) {
        if (!text) return;

        // Group split: particleGroup 0 = [0, splitPoint), 1 = [splitPoint, COUNT)
        const particleGroup = options.particleGroup ?? 0;
        if (particleGroup === 1) {
            this._splitPoint = Math.floor(this.count * 0.5);
            this._uniforms.uGroupSplit.value = this._splitPoint;
            this._groupBPatternActive = false; // explicit group1, not auto-managed
        } else if (particleGroup === 0 && options.groupBPattern) {
            // group 0 text + group 1 GPU animation simultaneously
            this._splitPoint = Math.floor(this.count * 0.5);
            this._uniforms.uGroupSplit.value = this._splitPoint;
            this._groupBPatternActive = true;
        } else if (particleGroup === 0 && this._groupBPatternActive) {
            // New group-0 text without groupBPattern: collapse split
            this._splitPoint = this.count;
            this._uniforms.uGroupSplit.value = this._splitPoint;
            this._uniforms.uGPUPatternIdB.value = 0;
            this._groupBPatternActive = false;
        }
        const groupStart = particleGroup === 1 ? this._splitPoint : 0;
        const groupEnd   = particleGroup === 1 ? this.count : this._splitPoint;
        const groupCount = groupEnd - groupStart;

        this._uniforms.uGPUPatternId.value = 0; // CPU text targets
        this._resetToSingleLayer();
        this._currentText = text;
        this._textIndex++;

        // Per-lyric physics overrides (latest lyric wins globally)
        this._physicsOverrides = this._extractPhysicsOverrides(options);

        const animName = options.animation || this._getDefaultAnimation();
        this._animType = animName;

        // Pre-compute anamorphic state (needed for depthSpread decision)
        const viewDir = options.viewDirection;
        const isAnamorphic = viewDir && (viewDir[0] !== 0 || viewDir[1] !== 0 || viewDir[2] !== 1);

        const chars = [...text];

        // Dual mode backgroundPattern: only valid for group 0
        if (particleGroup === 0) {
            if (options.backgroundPattern) {
                const bgId = GPU_PATTERN_IDS[options.backgroundPattern];
                if (bgId) {
                    this._uniforms.uBgPatternId.value = bgId;
                    this._uniforms.uTextParticleRatio.value = options.textRatio ?? 0.6;
                    // Per-char split: each char has textRatio fraction as text, rest as bg
                    this._uniforms.uTextPerChar.value = Math.floor(this.count / chars.length);
                }
            } else {
                this._uniforms.uBgPatternId.value = 0;
                this._uniforms.uTextParticleRatio.value = 1.0;
                this._uniforms.uTextPerChar.value = 1.0;
            }
        }

        // Per-character sampling (anamorphic text gets depthSpread for 3D readability)
        const charData = sampleTextPositionsPerChar(text, {
            font: options.font || this._textFont,
            fontSize: options.fontSize || this._textFontSize,
            maxPointsPerChar: Math.min(30000, Math.floor(groupCount / chars.length)),
            targetWidth: options.targetWidth || (chars.length <= 3 ? 2.5 : 4),
            depthSpread: options.depthSpread || (isAnamorphic ? 0.15 : 0),
            align: options.align || 'center',
        });

        // Assign particle indices within the group's range
        const perChar = Math.floor(groupCount / chars.length);
        for (let c = 0; c < charData.length; c++) {
            charData[c].startIdx = groupStart + c * perChar;
            charData[c].count = c < chars.length - 1 ? perChar : groupCount - c * perChar;
            charData[c].revealed = false;
        }

        // Text offset (position variation)
        // When options.origin is specified, use that explicit position
        // origin is explicitly set in mv-data.json for grid layout; default to center
        const offX = options.origin ? (options.origin[0] || 0) : 0;
        const offY = options.origin ? (options.origin[1] || 0) : 0;

        for (const cd of charData) {
            cd.center[0] += offX;
            cd.center[1] += offY;
            for (let i = 0; i < cd.textPositions.length; i += 3) {
                cd.textPositions[i] += offX;
                cd.textPositions[i + 1] += offY;
            }
        }

        // Anamorphic world rotation: rotate object3D instead of per-particle CPU loop
        if (isAnamorphic) {
            const from = new THREE.Vector3(0, 0, 1);
            const to = new THREE.Vector3(viewDir[0], viewDir[1], viewDir[2]).normalize();
            this._targetWorldQuat = new THREE.Quaternion().setFromUnitVectors(from, to);
        } else {
            this._targetWorldQuat = this._worldQuatIdentity.clone();
        }
        this._uniforms.uFlattenZ.value = isAnamorphic ? 0.0 : 1.0;

        const sweepDirs = [
            [1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 1, 0],
            [0.7, 0.7, 0], [-0.7, -0.7, 0], [0, 0, 0], [0.7, -0.7, 0],
        ];
        const sweepDir = sweepDirs[this._textIndex % sweepDirs.length];

        if (particleGroup === 1) {
            // --- Slot B (group 1) ---
            const b = this._slotB;
            b.charData = charData;
            b.formationStartTime = -1;
            b.formationPending = false;
            b.animType = animName;
            b.sweepDir = sweepDir;
            b.holdDurationOverride = options.holdDuration ?? null;
            b.releaseSpeed = options.releaseSpeed ?? 1.0;
            b.dissolveMode = options.dissolveMode ?? null;
            b.maxConvergence = options.maxConvergence ?? 1.0;
            b.physicsOverrides = this._physicsOverrides;
            b.lastTextTime = 0;
            b.targetConvergence = 1.0;
            // Always directSnap for group B (formation animation in split mode not supported)
            this._applyAllCharTargets(charData);
            b.phase = 'text';
            this._log('phase', `[B] text "${text}"`);
        } else {
            // --- Main slot (group 0) ---
            this._lastTextTime = 0;
            this._maxConvergence = options.maxConvergence ?? 1.0;
            this._holdDurationOverride = options.holdDuration ?? null;
            this._releaseSpeed = options.releaseSpeed ?? 1.0;
            this._dissolveMode = options.dissolveMode ?? null;
            this._charData = charData;
            this._formationStartTime = -1;
            this._formationPending = true;
            this._animType = animName;
            this._sweepDir = sweepDir;
            this._targetConvergence = 1.0;

            if (animName === 'directSnap') {
                this._applyAllCharTargets(charData);
                this._formationPending = false;
                this._phase = 'text';
                this._log('phase', `text (directSnap) "${text}"`);
            } else {
                this._setupFormation(animName);
                this._phase = 'forming';
                this._log('phase', `forming [${animName}] "${text}" ${chars.length}ch`);
            }

            // Group B GPU animation alongside group 0 text
            if (options.groupBPattern) {
                const bgId = GPU_PATTERN_IDS[options.groupBPattern];
                if (bgId) {
                    this._uniforms.uGPUPatternIdB.value = bgId;
                    const bo = options.groupBOrigin;
                    if (bo) this._uniforms.uFlowOriginB.value.set(bo[0] ?? 0, bo[1] ?? 0, bo[2] ?? 0);
                    else this._uniforms.uFlowOriginB.value.set(0, 0, 0);
                    this._uniforms.uFlowScaleB.value = options.groupBScale ?? 1.0;
                    // Drive group B toward the animation for the same hold window as the text
                    const b = this._slotB;
                    b.phase = 'text';
                    b.lastTextTime = 0;
                    const bConv = options.groupBConvergence ?? 0.4;
                    b.targetConvergence = bConv;
                    b.maxConvergence = bConv;
                    b.holdDurationOverride = options.holdDuration ?? null;
                    b.releaseSpeed = 1.0;
                    b.charData = null;
                    b.dissolveMode = null;
                    b.physicsOverrides = null;
                    this._log('phase', `[B] animation "${options.groupBPattern}"`);
                }
            }
        }
    }

    _getDefaultAnimation() {
        const anims = Object.keys(TEXT_ANIMATIONS);
        return anims[this._textIndex % anims.length];
    }

    /** Apply all character targets at once to text shape */
    _applyAllCharTargets(charData = this._charData) {
        const ta = this._targetBuffer.value.array;
        for (const cd of charData) {
            const tCount = cd.textPositions.length / 3;
            if (tCount === 0) continue;
            for (let j = 0; j < cd.count; j++) {
                const idx = cd.startIdx + j;
                if (idx >= this.count) break;
                const srcIdx = j % tCount;
                const jitter = j < tCount ? 0 : 0.03;
                const hasDepth = cd.textPositions[2] !== 0 || cd.textPositions.length > 3 && cd.textPositions[5] !== 0;
                ta[idx * 3] = cd.textPositions[srcIdx * 3] + (Math.random() - 0.5) * jitter;
                ta[idx * 3 + 1] = cd.textPositions[srcIdx * 3 + 1] + (Math.random() - 0.5) * jitter;
                ta[idx * 3 + 2] = cd.textPositions[srcIdx * 3 + 2] + (hasDepth ? (Math.random() - 0.5) * 0.02 : 0);
            }
        }
        this._targetBuffer.value.needsUpdate = true;
    }

    /** Switch a single character's target to its text shape */
    _revealChar(charIdx, charData = this._charData) {
        const cd = charData[charIdx];
        if (!cd || cd.revealed) return;
        cd.revealed = true;

        const ta = this._targetBuffer.value.array;
        const tCount = cd.textPositions.length / 3;
        if (tCount === 0) return;

        const hasDepth = cd.textPositions[2] !== 0 || cd.textPositions.length > 3 && cd.textPositions[5] !== 0;
        for (let j = 0; j < cd.count; j++) {
            const idx = cd.startIdx + j;
            if (idx >= this.count) break;
            const srcIdx = j % tCount;
            const jitter = j < tCount ? 0 : 0.03;
            ta[idx * 3] = cd.textPositions[srcIdx * 3] + (Math.random() - 0.5) * jitter;
            ta[idx * 3 + 1] = cd.textPositions[srcIdx * 3 + 1] + (Math.random() - 0.5) * jitter;
            ta[idx * 3 + 2] = cd.textPositions[srcIdx * 3 + 2] + (hasDepth ? (Math.random() - 0.5) * 0.02 : 0);
        }
        this._targetBuffer.value.needsUpdate = true;
    }

    /** Formation pre-shapes */
    _setupFormation(animName) {
        const ta = this._targetBuffer.value.array;
        const chars = this._charData;

        switch (animName) {
            case 'waveReveal': {
                // Per-character local wave — prevents global depletion as chars reveal sequentially
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const t = j / cd.count;
                        const localX = (t - 0.5) * 2.5;
                        ta[idx*3]   = cd.center[0] + localX + (Math.random() - 0.5) * 0.3;
                        ta[idx*3+1] = cd.center[1] + Math.sin(localX * Math.PI) * 0.5 + (Math.random() - 0.5) * 0.2;
                        ta[idx*3+2] = (Math.random() - 0.5) * 0.3;
                    }
                }
                break;
            }
            case 'rainDrop': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        ta[idx*3]   = cd.center[0] + (Math.random() - 0.5) * 0.4;
                        ta[idx*3+1] = cd.center[1] + 3 + Math.random() * 3;
                        ta[idx*3+2] = cd.center[2] + (Math.random() - 0.5) * 0.2;
                    }
                }
                break;
            }
            case 'spiralPerChar': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const t = j / cd.count;
                        const angle = t * Math.PI * 10;
                        const r = 1.5 * (1 - t);
                        ta[idx*3]   = cd.center[0] + Math.cos(angle) * r;
                        ta[idx*3+1] = cd.center[1] + Math.sin(angle) * r;
                        ta[idx*3+2] = cd.center[2] + (t - 0.5) * 0.8;
                    }
                }
                break;
            }
            case 'ringToChar': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const angle = (j / cd.count) * Math.PI * 2;
                        const r = 0.6 + Math.random() * 0.5;
                        ta[idx*3]   = cd.center[0] + Math.cos(angle) * r;
                        ta[idx*3+1] = cd.center[1] + Math.sin(angle) * r;
                        ta[idx*3+2] = cd.center[2] + (Math.random() - 0.5) * 0.35;
                    }
                }
                break;
            }
            case 'typewriter': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        ta[idx*3]   = cd.center[0] + (Math.random() - 0.5) * 0.15;
                        ta[idx*3+1] = -8 + Math.random() * 0.8;
                        ta[idx*3+2] = cd.center[2] + (Math.random() - 0.5) * 0.15;
                    }
                }
                break;
            }
            case 'columnDrop': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const t = j / cd.count;
                        ta[idx*3]   = cd.center[0] + (Math.random() - 0.5) * 0.4;
                        ta[idx*3+1] = 2 + t * 5;
                        ta[idx*3+2] = cd.center[2] + (Math.random() - 0.5) * 0.4;
                    }
                }
                break;
            }
            case 'centerBurst': {
                for (let i = 0; i < this.count; i++) {
                    ta[i*3]   = (Math.random() - 0.5) * 0.05;
                    ta[i*3+1] = (Math.random() - 0.5) * 0.05;
                    ta[i*3+2] = (Math.random() - 0.5) * 0.05;
                }
                break;
            }
            case 'sphereContract': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const theta = Math.random() * Math.PI * 2;
                        const phi = Math.acos(2 * Math.random() - 1);
                        const r = 0.6 + Math.random() * 0.6;
                        ta[idx*3]   = cd.center[0] + Math.sin(phi) * Math.cos(theta) * r;
                        ta[idx*3+1] = cd.center[1] + Math.sin(phi) * Math.sin(theta) * r;
                        ta[idx*3+2] = cd.center[2] + Math.cos(phi) * r;
                    }
                }
                break;
            }
            case 'riseUp': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        ta[idx*3]   = cd.center[0] + (Math.random() - 0.5) * 0.3;
                        ta[idx*3+1] = cd.center[1] - 3 - Math.random() * 2;
                        ta[idx*3+2] = cd.center[2] + (Math.random() - 0.5) * 0.2;
                    }
                }
                break;
            }
            case 'scatterIn': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const angle = Math.random() * Math.PI * 2;
                        const phi = Math.acos(2 * Math.random() - 1);
                        const r = 1.0 + Math.random() * 2.5;
                        ta[idx*3]   = cd.center[0] + Math.sin(phi) * Math.cos(angle) * r;
                        ta[idx*3+1] = cd.center[1] + Math.sin(phi) * Math.sin(angle) * r;
                        ta[idx*3+2] = cd.center[2] + Math.cos(phi) * r;
                    }
                }
                break;
            }
            case 'gridDissolve': {
                for (const cd of chars) {
                    const gridN = Math.ceil(Math.sqrt(cd.count));
                    const spacing = 1.2 / gridN;
                    const jit = spacing * 0.2;
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        ta[idx*3]   = cd.center[0] + (j % gridN - gridN/2) * spacing + (Math.random() - 0.5) * jit;
                        ta[idx*3+1] = cd.center[1] + (Math.floor(j / gridN) - gridN/2) * spacing + (Math.random() - 0.5) * jit;
                        ta[idx*3+2] = cd.center[2] + (Math.random() - 0.5) * 0.25;
                    }
                }
                break;
            }
            case 'tornado': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const t = j / cd.count;
                        const y = t * 5 - 2.5;
                        const r = 0.3 + t * 1.2;
                        const angle = t * Math.PI * 12 + (Math.random() - 0.5) * 1.5;
                        ta[idx*3]   = cd.center[0] + Math.cos(angle) * r;
                        ta[idx*3+1] = cd.center[1] + y;
                        ta[idx*3+2] = cd.center[2] + Math.sin(angle) * r;
                    }
                }
                break;
            }
            case 'phyllotaxis': {
                // 3D Fibonacci sphere
                const goldenAngle = Math.PI * (3 - Math.sqrt(5));
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const t = j / cd.count;
                        const theta = j * goldenAngle;
                        const phi = Math.acos(1 - 2 * t);
                        const r = 0.8 + (Math.random() - 0.5) * 0.1;
                        ta[idx*3]   = cd.center[0] + Math.sin(phi) * Math.cos(theta) * r;
                        ta[idx*3+1] = cd.center[1] + Math.sin(phi) * Math.sin(theta) * r;
                        ta[idx*3+2] = cd.center[2] + Math.cos(phi) * r;
                    }
                }
                break;
            }
            case 'shockwaveRing': {
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        const angle = (j / cd.count) * Math.PI * 2;
                        const r = 1.5 + Math.random() * 0.5;
                        ta[idx*3]   = cd.center[0] + Math.cos(angle) * r;
                        ta[idx*3+1] = cd.center[1] + Math.sin(angle) * r;
                        ta[idx*3+2] = cd.center[2] + (Math.random() - 0.5) * 0.12;
                    }
                }
                break;
            }
            case 'flatPlane': {
                // Flat 2D scatter in XY, Z=0 — particles converge to text on a flat plane
                for (const cd of chars) {
                    for (let j = 0; j < cd.count; j++) {
                        const idx = cd.startIdx + j;
                        if (idx >= this.count) break;
                        ta[idx*3]   = cd.center[0] + (Math.random() - 0.5) * 3;
                        ta[idx*3+1] = cd.center[1] + (Math.random() - 0.5) * 2;
                        ta[idx*3+2] = 0;
                    }
                }
                break;
            }
        }

        // Non-anamorphic text: force all pre-shape Z to 0
        // Prevents multi-plane artifacts from 3D pre-shapes
        const hasDepth = this._charData.some(cd =>
            cd.textPositions.length >= 3 && (cd.textPositions[2] !== 0 ||
                (cd.textPositions.length > 5 && cd.textPositions[5] !== 0))
        );
        if (!hasDepth) {
            for (let i = 0; i < this.count; i++) {
                ta[i * 3 + 2] = 0;
            }
        }

        this._targetBuffer.value.needsUpdate = true;
    }

    /**
     * Flow pattern target positions (3D)
     */
    setFlowTargets(pattern = 'organic', options = {}) {
        this._uniforms.uFlattenZ.value = 0.0;
        this._uniforms.uBgPatternId.value = 0;
        this._uniforms.uTextParticleRatio.value = 1.0;
        this._uniforms.uTextPerChar.value = 1.0;
        this._targetWorldQuat = this._worldQuatIdentity.clone();
        this._currentFlowPattern = pattern;
        this._lastFlowTargetUpdate = 0;

        // Reset group split — flow is a clean break, merge all particles back to group 0
        this._splitPoint = this.count;
        this._uniforms.uGroupSplit.value = this._splitPoint;
        this._uniforms.uConvergenceB.value = 0;
        this._uniforms.uSweepXB.value = 0;
        this._uniforms.uSweepYB.value = 0;
        this._uniforms.uSweepZB.value = 0;
        this._uniforms.uGPUPatternIdB.value = 0;
        this._uniforms.uFlowOriginB.value.set(0, 0, 0);
        this._uniforms.uFlowScaleB.value = 1.0;
        this._groupBPatternActive = false;
        Object.assign(this._slotB, {
            phase: 'flow', convergence: 0, targetConvergence: 0.1,
            lastTextTime: 0, holdDurationOverride: null, releaseSpeed: 1.0,
            dissolveMode: null, maxConvergence: 1.0, physicsOverrides: null,
            charData: null, formationPending: false, formationStartTime: -1,
            animType: null, sweepDir: [0,0,0], currentSweepX: 0, currentSweepY: 0, currentSweepZ: 0,
        });

        // Per-lyric physics overrides (flow mode)
        this._physicsOverrides = this._extractPhysicsOverrides(options);

        const gpuId = GPU_PATTERN_IDS[pattern];
        if (gpuId) {
            // GPU-computed targets — just set the uniform, no CPU work
            this._uniforms.uGPUPatternId.value = gpuId;
        } else {
            // CPU-only (attractors, fractals) — write to buffer as before
            this._uniforms.uGPUPatternId.value = 0;
            const ta = this._targetBuffer.value.array;
            const N = this.count;
            const gen = FLOW_PATTERN_GENERATORS[pattern] || FLOW_PATTERN_GENERATORS.organic;
            gen(ta, N);
            this._targetBuffer.value.needsUpdate = true;
        }
    }

    /**
     * Set flow pattern origin offset (GPU uniform + CPU variable)
     */
    setFlowOrigin(x, y, z) {
        this._uniforms.uFlowOrigin.value.set(x, y, z);
    }

    /**
     * Set flow pattern scale (GPU uniform + CPU variable)
     */
    setFlowScale(scale) {
        this._uniforms.uFlowScale.value = scale;
    }

    /**
     * Multi-layer flow: split particles across up to 4 patterns
     * layers: [{pattern, origin, scale}, ...]
     */
    setFlowTargetsMultiLayer(layers) {
        if (!layers || layers.length === 0) return;
        const numLayers = Math.min(layers.length, 4);
        this._uniforms.uNumLayers.value = numLayers;
        // Set main pattern to first layer's GPU ID to prevent CPU animation path conflict
        const firstGpuId = GPU_PATTERN_IDS[layers[0].pattern] || GPU_PATTERN_IDS.organic || 1;
        this._uniforms.uGPUPatternId.value = firstGpuId;
        this._currentFlowPattern = layers[0].pattern;

        const layerPatterns = [
            this._uniforms.uLayerPatternId0, this._uniforms.uLayerPatternId1,
            this._uniforms.uLayerPatternId2, this._uniforms.uLayerPatternId3
        ];
        const layerOrigins = [
            this._uniforms.uLayerOrigin0, this._uniforms.uLayerOrigin1,
            this._uniforms.uLayerOrigin2, this._uniforms.uLayerOrigin3
        ];
        const layerScales = [
            this._uniforms.uLayerScale0, this._uniforms.uLayerScale1,
            this._uniforms.uLayerScale2, this._uniforms.uLayerScale3
        ];

        for (let l = 0; l < 4; l++) {
            if (l < numLayers) {
                const layer = layers[l];
                const gpuId = GPU_PATTERN_IDS[layer.pattern] || GPU_PATTERN_IDS.organic || 1;
                layerPatterns[l].value = gpuId;
                const o = layer.origin || [0, 0, 0];
                layerOrigins[l].value.set(o[0], o[1], o[2]);
                layerScales[l].value = layer.scale ?? 1.0;
            } else {
                layerPatterns[l].value = 0;
                layerScales[l].value = 1.0;
                layerOrigins[l].value.set(0, 0, 0);
            }
        }

        this._log('flow', `multiLayer ${numLayers}L: ${layers.map(l => l.pattern).join('+')}`);
    }

    /**
     * Reset to single-layer mode
     */
    _resetToSingleLayer() {
        this._uniforms.uNumLayers.value = 1;
        this._uniforms.uFlowOrigin.value.set(0, 0, 0);
        this._uniforms.uFlowScale.value = 1.0;
    }

    static getPatternNames() {
        return Object.keys(FLOW_PATTERN_GENERATORS);
    }

    /**
     * Returns all pattern names (GPU + CPU-only, no duplicates)
     */
    getAllPatternNames() {
        const gpuNames = Object.keys(GPU_PATTERN_IDS);
        const cpuNames = Object.keys(FLOW_PATTERN_GENERATORS);
        const seen = new Set(gpuNames);
        for (const n of cpuNames) {
            if (!seen.has(n)) { gpuNames.push(n); seen.add(n); }
        }
        return gpuNames;
    }

    /**
     * Instantly snap all particles to their current targets (for seek restoration)
     */
    snapToTargets() {
        const pos = this._posBuffer.value.array;
        const tar = this._targetBuffer.value.array;
        const vel = this._velBuffer.value.array;
        for (let i = 0; i < this.count * 3; i++) {
            pos[i] = tar[i];
            vel[i] = 0;
        }
        this._posBuffer.value.needsUpdate = true;
        this._velBuffer.value.needsUpdate = true;
        this._convergence = this._targetConvergence;
        this._uniforms.uConvergence.value = this._convergence;
    }

    setMode(mode, pattern, options = {}) {
        if (mode === 'text' || mode === 'forming') {
            this._uniforms.uGPUPatternId.value = 0; // CPU text targets
            this._resetToSingleLayer(); // text always single-layer
            this._targetConvergence = 1.0;
            const sweepDirs = [
                [1, 0, 0], [-1, 0, 0], [0, -1, 0], [0, 1, 0],
                [0.7, 0.7, 0], [-0.7, -0.7, 0], [0, 0, 0], [0.7, -0.7, 0],
            ];
            this._sweepDir = sweepDirs[this._textIndex % sweepDirs.length];
        } else if (mode === 'flow') {
            this._sweepDir = [0, 0, 0];
            if (this._phase === 'text' || this._phase === 'forming') {
                // Defer flow target: applying during hold would scatter particles from text
                this._pendingFlowPattern = pattern || null;
                this._pendingFlowOptions = options;
                this._log('mode', `flow deferred (holding text) → ${pattern || 'auto'}`);
            } else {
                this._targetConvergence = 0.10;
                if (pattern) {
                    this.setFlowTargets(pattern, options);
                } else {
                    this.setFlowTargets(this._flowPatterns[this._flowPatternIdx % this._flowPatterns.length], options);
                    this._flowPatternIdx++;
                }
                this._log('mode', `flow ${pattern || this._flowPatterns[(this._flowPatternIdx - 1) % this._flowPatterns.length]}`);
            }
        } else {
            this._uniforms.uFlattenZ.value = 0.0;
            this._targetConvergence = 0.0;
            this._sweepDir = [0, 0, 0];
            this._log('mode', mode);
        }

        if (mode !== 'text' && mode !== 'forming') {
            this._currentText = '';
        }
    }

    update({ deltaTime, elapsedTime, musicTime, sceneProgress, audioData, camera }) {
        this._uniforms.uDeltaTime.value = Math.min(deltaTime, 0.022);
        this._uniforms.uTime.value = elapsedTime;
        this._camera = camera;

        // Anamorphic world rotation (smooth slerp)
        if (this._targetWorldQuat) {
            this.object3D.quaternion.slerp(this._targetWorldQuat, 0.04);
        }

        // Update camera position uniform for particle repulsion
        // Transform to local space when world is rotated
        if (camera) {
            if (this._targetWorldQuat && !this.object3D.quaternion.equals(this._worldQuatIdentity)) {
                const invQuat = this.object3D.quaternion.clone().invert();
                this._uniforms.uCameraPos.value.copy(camera.position).applyQuaternion(invQuat);
            } else {
                this._uniforms.uCameraPos.value.copy(camera.position);
            }
        }

        const t = musicTime || elapsedTime;

        // === Macro phase progression ===
        let phase = MACRO_PHASES[MACRO_PHASES.length - 1];
        for (const p of MACRO_PHASES) {
            if (t < p.end) { phase = p; break; }
        }
        const m = this._macro;
        const rate = 0.005;
        const ov = this._physicsOverrides;
        const ovRate = ov?.lerpRate ?? rate;
        m.noiseStr += ((ov?.noiseStrength ?? phase.noiseStr) - m.noiseStr) * (ov?.noiseStrength != null ? ovRate : rate);
        m.noiseScl += ((ov?.noiseScale ?? phase.noiseScl) - m.noiseScl) * (ov?.noiseScale != null ? ovRate : rate);
        m.spring += ((ov?.spring ?? phase.spring) - m.spring) * (ov?.spring != null ? ovRate : rate);
        m.damp += ((ov?.damping ?? phase.damp) - m.damp) * (ov?.damping != null ? ovRate : rate);
        m.vortex += ((ov?.vortex ?? phase.vortex) - m.vortex) * (ov?.vortex != null ? ovRate : rate);
        m.wave += ((ov?.wave ?? phase.wave) - m.wave) * (ov?.wave != null ? ovRate : rate);
        m.gravity += ((ov?.gravity ?? 0) - m.gravity) * (ov?.gravity != null ? ovRate : rate);
        m.convUp += ((ov?.convUp ?? phase.convUp) - m.convUp) * (ov?.convUp != null ? ovRate : rate);
        m.convDn += ((ov?.convDn ?? phase.convDn) - m.convDn) * (ov?.convDn != null ? ovRate : rate);
        m.pointScale += ((ov?.pointScale ?? phase.pointScale) - m.pointScale) * (ov?.pointScale != null ? ovRate : rate);

        this._uniforms.uNoiseStrength.value = m.noiseStr;
        this._uniforms.uNoiseScale.value = m.noiseScl;
        this._uniforms.uSpringStrength.value = m.spring;
        this._uniforms.uDamping.value = m.damp;
        this._uniforms.uVortexStrength.value = m.vortex;
        this._uniforms.uWaveStrength.value = m.wave;
        this._uniforms.uGravity.value = m.gravity;
        this._uniforms.uWavePhase.value = elapsedTime * 3.0;

        // === Dissolve boost: extra gravity + noise during releasing phase ===
        if (this._phase === 'releasing' && this._dissolveMode === 'down') {
            // progress: 0 at releasing start (convergence ~0.85), ramps to 1 as particles disperse
            const progress = 0.3 + 0.7 * Math.max(0, 1.0 - this._convergence / 0.8);
            this._uniforms.uGravity.value += 0.0018 * progress;
            this._uniforms.uNoiseStrength.value += 0.0012 * progress;
        }
        this._uniforms.uPointSize.value = this._pointSize * m.pointScale;

        // === Asymmetric convergence ===
        const isRising = this._targetConvergence > this._convergence;
        const convSpeed = isRising ? m.convUp * this._convUpScale : (m.convDn * this._convDnScale * this._releaseSpeed);
        this._convergence += (this._targetConvergence - this._convergence) * convSpeed;

        // Per-lyric convergence clamp
        if (this._maxConvergence < 1.0) {
            this._convergence = Math.min(this._convergence, this._maxConvergence);
        }

        this._uniforms.uConvergence.value = this._convergence;

        // === Sweep interpolation (group 0) ===
        this._currentSweepX += (this._sweepDir[0] - this._currentSweepX) * 0.025;
        this._currentSweepY += (this._sweepDir[1] - this._currentSweepY) * 0.025;
        this._currentSweepZ += ((this._sweepDir[2] || 0) - this._currentSweepZ) * 0.025;
        this._uniforms.uSweepX.value = this._currentSweepX;
        this._uniforms.uSweepY.value = this._currentSweepY;
        this._uniforms.uSweepZ.value = this._currentSweepZ;

        // === Slot B (group 1) independent phase management ===
        if (this._splitPoint < this.count) {
            const b = this._slotB;

            // Convergence
            const bIsRising = b.targetConvergence > b.convergence;
            const bConvSpeed = bIsRising ? m.convUp : m.convDn * b.releaseSpeed;
            b.convergence += (b.targetConvergence - b.convergence) * bConvSpeed;
            if (b.maxConvergence < 1.0) b.convergence = Math.min(b.convergence, b.maxConvergence);
            this._uniforms.uConvergenceB.value = b.convergence;

            // Sweep
            b.currentSweepX += (b.sweepDir[0] - b.currentSweepX) * 0.025;
            b.currentSweepY += (b.sweepDir[1] - b.currentSweepY) * 0.025;
            b.currentSweepZ += ((b.sweepDir[2] || 0) - b.currentSweepZ) * 0.025;
            this._uniforms.uSweepXB.value = b.currentSweepX;
            this._uniforms.uSweepYB.value = b.currentSweepY;
            this._uniforms.uSweepZB.value = b.currentSweepZ;

            // Text hold → releasing
            if (b.phase === 'text' && b.lastTextTime === 0) b.lastTextTime = elapsedTime;
            if (b.phase === 'text' && b.lastTextTime > 0) {
                const holdDur = b.holdDurationOverride ?? this._textHoldDuration;
                if (elapsedTime - b.lastTextTime > holdDur) {
                    b.phase = 'releasing';
                    b.targetConvergence = 0;
                    this._log('phase', `[B] releasing (held ${holdDur.toFixed(2)}s)`);
                }
            }

            // Releasing → flow (merge back into group 0 when done)
            if (b.phase === 'releasing' && b.convergence < 0.02) {
                b.phase = 'flow';
                b.lastTextTime = 0;
                b.targetConvergence = 0.1;
                b.physicsOverrides = null;
                b.dissolveMode = null;
                b.maxConvergence = 1.0;
                b.holdDurationOverride = null;
                b.releaseSpeed = 1.0;
                this._log('phase', `[B] flow`);
            }
        }

        // === Per-character formation → text reveal ===
        if (this._formationPending && this._charData) {
            if (this._formationStartTime < 0) this._formationStartTime = elapsedTime;
            const elapsed = elapsedTime - this._formationStartTime;
            const animDef = TEXT_ANIMATIONS[this._animType] || TEXT_ANIMATIONS.directSnap;

            let allRevealed = true;
            for (let c = 0; c < this._charData.length; c++) {
                const cd = this._charData[c];
                if (cd.revealed) continue;
                if (elapsed >= animDef.delay + c * animDef.stagger) {
                    this._revealChar(c);
                } else {
                    allRevealed = false;
                }
            }

            if (allRevealed) {
                this._formationPending = false;
                this._phase = 'text';
                this._log('phase', `text (formed ${(elapsed * 1000).toFixed(0)}ms)`);
            }
        }

        // === Animated flow patterns ===
        // GPU patterns: computed every frame in compute shader (uGPUPatternId > 0)
        // CPU-only animated patterns (attractors): still need throttled updates
        if (this._phase === 'flow' && this._uniforms.uGPUPatternId.value === 0
            && FLOW_PATTERN_ANIMATORS[this._currentFlowPattern]) {
            if (!this._lastAnimUpdate || elapsedTime - this._lastAnimUpdate > 0.25) {
                this._lastAnimUpdate = elapsedTime;
                FLOW_PATTERN_ANIMATORS[this._currentFlowPattern](
                    this._targetBuffer.value.array, this.count, elapsedTime
                );
                this._targetBuffer.value.needsUpdate = true;
            }
        }

        // === Text time tracking ===
        if (this._lastTextTime === 0 && this._phase === 'text') {
            this._lastTextTime = elapsedTime;
        }

        // === 2-stage dissolve ===
        if (this._phase === 'text' && this._lastTextTime > 0) {
            const holdDur = this._holdDurationOverride ?? this._textHoldDuration;
            if (elapsedTime - this._lastTextTime > holdDur) {
                this._phase = 'releasing';
                this._targetConvergence = 0.0;
                this._log('phase', `releasing (held ${holdDur.toFixed(2)}s)`);
            }
        }
        if (this._phase === 'releasing' && this._convergence < 0.02) {
            this._phase = 'flow';
            this._lastTextTime = 0;
            this._currentText = '';
            this._physicsOverrides = null; // clear per-lyric overrides
            this._dissolveMode = null;
            this._maxConvergence = 1.0;
            this._holdDurationOverride = null;
            this._releaseSpeed = 1.0;
            this._uniforms.uBgPatternId.value = 0;
            this._uniforms.uTextParticleRatio.value = 1.0;
            this._uniforms.uTextPerChar.value = 1.0;
            this._targetWorldQuat = this._worldQuatIdentity.clone();
            this._resetToSingleLayer();
            // Use pending flow target if one was queued during text hold
            const nextPattern = this._pendingFlowPattern || 'organic';
            const nextOptions = this._pendingFlowOptions || {};
            this._pendingFlowPattern = null;
            this._pendingFlowOptions = {};
            this.setFlowTargets(nextPattern, nextOptions);
            this._targetConvergence = 0.10;
            this._sweepDir = [0, 0, 0];
            this._log('phase', `flow → ${nextPattern}`);
        }
    }

    setParams(params) {
        if (typeof params.spring === 'number') this._spring = params.spring;
        if (typeof params.damping === 'number') this._damping = params.damping;
        if (typeof params.noiseScale === 'number') this._noiseScale = params.noiseScale;
        if (typeof params.noiseStrength === 'number') this._noiseStrength = params.noiseStrength;
        if (typeof params.pointSize === 'number') {
            this._pointSize = params.pointSize;
            if (this._uniforms.uPointSize) this._uniforms.uPointSize.value = params.pointSize;
        }
        if (params.mode) {
            this.setMode(params.mode);
        }
    }

    /**
     * Notify of projection mode change
     */
    onProjectionChange(isOrtho) {
        this._uniforms.uIsOrtho.value = isOrtho ? 1 : 0;
    }

    getStats() {
        return { particles: this.count };
    }

    dispose() {
        if (this._mesh) {
            if (this._mesh.geometry) this._mesh.geometry.dispose();
            if (this._mesh.material) this._mesh.material.dispose();
        }
        // GPU storage buffers
        for (const buf of [this._posBuffer, this._velBuffer, this._targetBuffer, this._lifeBuffer, this._colorBuffer]) {
            if (buf?.value?.dispose) buf.value.dispose();
        }
        this._posBuffer = null;
        this._velBuffer = null;
        this._targetBuffer = null;
        this._lifeBuffer = null;
        this._colorBuffer = null;
        this._computeNode = null;
        this._charData = null;
    }
}
