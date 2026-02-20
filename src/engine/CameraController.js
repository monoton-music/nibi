/**
 * CameraController - Dynamic camera work system
 *
 * Modes:
 * - static: Fixed position
 * - orbit: Auto-rotate around origin
 * - dolly: Z-axis forward/backward movement
 * - shake: Audio-reactive shake
 * - path: Keyframe path following
 */

import * as THREE from 'three';
import gsap from 'gsap';

export class CameraController {
    constructor(camera, params = {}) {
        this.camera = camera;
        this.mode = params.mode || 'static';

        // Orbit settings
        this.orbitSpeed = params.orbitSpeed || 0.1;
        this.orbitRadius = params.orbitRadius || 5;
        this.orbitHeight = params.orbitHeight || 0;

        // Dolly settings
        this.dollyRange = params.dollyRange || { min: 3, max: 8 };
        this.dollySpeed = params.dollySpeed || 0.5;
        this.dollyAmount = params.dollyAmount || 0;

        // Shake settings
        this.shakeIntensity = params.shakeIntensity || 0.1;
        this.shakeDecay = params.shakeDecay || 0.9;

        // Non-linear warp
        this.warpSpeed = params.warpSpeed || 0.6;
        this.warpAmount = params.warpAmount || 0.35;
        this.radiusPulse = params.radiusPulse || 0.2;
        this.radiusPulseSpeed = params.radiusPulseSpeed || 0.7;
        this.heightPulse = params.heightPulse || 0.6;
        this.heightPulseSpeed = params.heightPulseSpeed || 0.5;
        this.sway = params.sway || 0.3;
        this.swaySpeed = params.swaySpeed || 0.8;
        this.lookOffset = params.lookOffset || [0, 0, 0];
        this.rollAmount = params.rollAmount || 0;
        this.fovPulse = params.fovPulse || 0;
        this.fovPulseSpeed = params.fovPulseSpeed || 0.6;
        this._baseFov = camera.fov || 75;
        this.corridorAxis = params.corridorAxis || 'x';
        this.corridorWidth = params.corridorWidth || 0;
        this.corridorSoftness = params.corridorSoftness || 1;
        this.minHeight = params.minHeight || 0;
        this.minDistance = params.minDistance || 0;
        this.maxDistance = params.maxDistance || 0;
        this.safetyLerp = params.safetyLerp || 0.08;

        // Keyframes
        this.keyframes = params.keyframes || [];
        this.currentKeyframeIndex = 0;

        // Internal state
        this.originalPosition = camera.position.clone();
        this.originalRotation = camera.rotation.clone();
        this.lookAtTarget = new THREE.Vector3(0, 0, 0);
        this.shakeOffset = new THREE.Vector3();
        this.currentShake = 0;

        // GSAP timeline (for path mode)
        this._timeline = null;
        this._onLog = null; // callback: (tag, msg) => {}
        this._onProjectionChange = null; // callback: (projection, config) => {}

        // Pre-allocated reusable vectors (avoid per-frame GC)
        this._tmpVec = new THREE.Vector3();
        this._tmpVec2 = new THREE.Vector3();
        this._safetyTarget = new THREE.Vector3();

        console.log('[CameraController] Initialized with mode:', this.mode);
    }

    /**
     * Set mode
     */
    setMode(mode, params = {}) {
        this.mode = mode;
        Object.assign(this, params);
        if (this.camera && this.camera.isPerspectiveCamera) {
            this._baseFov = this.camera.fov;
        }

        // Set up timeline for path mode
        if (mode === 'path' && this.keyframes.length > 0) {
            this._setupPathTimeline();
        }

        console.log('[CameraController] Mode changed to:', mode);
        if (this._onLog) this._onLog('cam', `mode=${mode}`);
    }

    /**
     * Load keyframes
     */
    loadKeyframes(keyframes) {
        this.keyframes = keyframes;
        this.currentKeyframeIndex = 0;

        if (this.mode === 'path') {
            this._setupPathTimeline();
        }
        if (this._onLog) this._onLog('cam', `keyframes=${keyframes.length}`);
    }

    /**
     * Set up path timeline
     */
    _setupPathTimeline() {
        if (this._timeline) {
            this._timeline.kill();
        }

        this._timeline = gsap.timeline({ paused: true });
        this._rollTarget = { value: 0 };
        this._fovTarget = { value: this._baseFov };

        for (const kf of this.keyframes) {
            const position = kf.position || [0, 0, 5];
            const lookAt = kf.lookAt || [0, 0, 0];
            const duration = kf.duration || 2;
            const easing = kf.easing || 'power2.inOut';
            const timePos = kf.time != null ? kf.time : '>';

            this._timeline.to(this.camera.position, {
                x: position[0],
                y: position[1],
                z: position[2],
                duration,
                ease: easing
            }, timePos);

            this._timeline.to(this.lookAtTarget, {
                x: lookAt[0],
                y: lookAt[1],
                z: lookAt[2],
                duration,
                ease: easing
            }, '<');

            // Roll (Z-axis rotation)
            if (kf.roll != null) {
                this._timeline.to(this._rollTarget, {
                    value: kf.roll,
                    duration,
                    ease: easing
                }, '<');
            }

            // FOV animation
            if (kf.fov != null) {
                this._timeline.to(this._fovTarget, {
                    value: kf.fov,
                    duration,
                    ease: easing
                }, '<');
            }

            // Projection switch at keyframe start
            if (kf.projection && this._onProjectionChange) {
                const projConfig = { projection: kf.projection, orthoSize: kf.orthoSize };
                this._timeline.call(() => {
                    if (this._onProjectionChange) {
                        this._onProjectionChange(kf.projection, projConfig);
                    }
                }, [], timePos === '>' ? '>' : timePos);
            }
        }
    }

    /**
     * Replace camera reference (avoid destroying the controller on projection switch)
     */
    swapCamera(newCamera) {
        this.camera = newCamera;
        if (newCamera.isPerspectiveCamera) {
            this._baseFov = newCamera.fov || 75;
        }
        // Rebuild timeline pointing to new camera
        if (this.mode === 'path' && this.keyframes.length > 0) {
            const currentTime = this._timeline ? this._timeline.time() : 0;
            this._setupPathTimeline();
            if (currentTime > 0) {
                this._timeline.seek(currentTime);
            }
        }
    }

    /**
     * Trigger shake
     */
    shake(intensity = null) {
        this.currentShake = intensity || this.shakeIntensity;
    }

    /**
     * Update by time (for path mode)
     */
    updateTime(musicTime) {
        if (this.mode === 'path' && this._timeline) {
            this._timeline.seek(musicTime);
        }
    }

    /**
     * Frame update
     */
    update({ deltaTime, elapsedTime, musicTime, audioData }) {
        switch (this.mode) {
            case 'orbit':
                this._updateOrbit(elapsedTime);
                break;
            case 'dolly':
                this._updateDolly(elapsedTime);
                break;
            case 'shake':
                this._updateAudioShake(audioData);
                break;
            case 'path':
                this.updateTime(musicTime);
                this.camera.lookAt(this.lookAtTarget);
                // Apply roll from keyframe
                if (this._rollTarget && this._rollTarget.value !== 0) {
                    this.camera.rotation.z = this._rollTarget.value;
                }
                // Apply FOV from keyframe
                if (this._fovTarget && this.camera.isPerspectiveCamera) {
                    this._baseFov = this._fovTarget.value;
                    this.camera.fov = this._fovTarget.value;
                    this.camera.updateProjectionMatrix();
                }
                break;
            case 'dynamic':
                this._updateDynamic(elapsedTime);
                break;
            case 'static':
            default:
                // Do nothing
                break;
        }

        // Apply shake offset (common to all modes)
        this._applyShake(deltaTime);
        this._applySafety();

        if (this.fovPulse && this.camera.isPerspectiveCamera) {
            const pulse = Math.sin(elapsedTime * this.fovPulseSpeed) * this.fovPulse;
            this.camera.fov = this._baseFov + pulse;
            this.camera.updateProjectionMatrix();
        }
    }

    _updateOrbit(elapsedTime) {
        const warped = this._warpTime(elapsedTime);
        const angle = warped * this.orbitSpeed;
        this.camera.position.x = Math.sin(angle) * this.orbitRadius;
        this.camera.position.z = Math.cos(angle) * this.orbitRadius;
        this.camera.position.y = this.orbitHeight + Math.sin(warped * this.orbitSpeed * 0.5) * 0.5;
        this.camera.lookAt(this.lookAtTarget);
    }

    _updateDolly(elapsedTime) {
        const warped = this._warpTime(elapsedTime);
        const t = (Math.sin(warped * this.dollySpeed) + 1) / 2;
        this.camera.position.z = this.dollyRange.min + t * (this.dollyRange.max - this.dollyRange.min);
        this.camera.lookAt(this.lookAtTarget);
    }

    _updateDynamic(elapsedTime) {
        const warped = this._warpTime(elapsedTime);
        const angle = warped * this.orbitSpeed;
        const radiusPulse = 1 + Math.sin(warped * this.radiusPulseSpeed) * this.radiusPulse;
        const radius = this.orbitRadius * radiusPulse;
        const height = this.orbitHeight + Math.sin(warped * this.heightPulseSpeed) * this.heightPulse;

        this.camera.position.x = Math.sin(angle) * radius;
        this.camera.position.z = Math.cos(angle) * radius;
        this.camera.position.y = height;

        if (this.dollyAmount) {
            this.camera.position.z += Math.sin(warped * this.dollySpeed) * this.dollyAmount;
        }

        if (this.sway) {
            this.camera.position.x += Math.sin(warped * this.swaySpeed) * this.sway;
            this.camera.position.y += Math.cos(warped * this.swaySpeed * 0.7) * this.sway * 0.4;
        }

        this._tmpVec.set(
            this.lookAtTarget.x + (this.lookOffset[0] || 0),
            this.lookAtTarget.y + (this.lookOffset[1] || 0),
            this.lookAtTarget.z + (this.lookOffset[2] || 0)
        );
        this.camera.lookAt(this._tmpVec);

        if (this.rollAmount) {
            this.camera.rotation.z = Math.sin(warped * 0.6) * this.rollAmount;
        }
    }

    _warpTime(elapsedTime) {
        return elapsedTime + Math.sin(elapsedTime * this.warpSpeed) * this.warpAmount;
    }

    _applySafety() {
        if (!this.camera) return;

        const target = this._safetyTarget.copy(this.camera.position);

        // Enforce minimum distance from lookAt (2.5 units)
        const minLookAtDist = 2.5;
        const toLookAt = this._tmpVec.subVectors(target, this.lookAtTarget);
        const lookAtDist = toLookAt.length();
        if (lookAtDist > 0.001 && lookAtDist < minLookAtDist) {
            toLookAt.normalize().multiplyScalar(minLookAtDist);
            target.copy(this.lookAtTarget).add(toLookAt);
        }

        if (this.minHeight) {
            target.y = Math.max(this.minHeight, target.y);
        }

        if (this.corridorWidth > 0) {
            const limit = this.corridorWidth;
            if (this.corridorAxis === 'x') {
                target.x = this._softClamp(target.x, limit, this.corridorSoftness);
            } else if (this.corridorAxis === 'z') {
                target.z = this._softClamp(target.z, limit, this.corridorSoftness);
            }
        }

        if (this.minDistance || this.maxDistance) {
            const toCam = this._tmpVec2.subVectors(target, this.lookAtTarget);
            const dist = toCam.length() || 0.001;
            if (this.minDistance && dist < this.minDistance) {
                toCam.normalize().multiplyScalar(this.minDistance);
                target.copy(this.lookAtTarget).add(toCam);
            }
            if (this.maxDistance && dist > this.maxDistance) {
                toCam.normalize().multiplyScalar(this.maxDistance);
                target.copy(this.lookAtTarget).add(toCam);
            }
        }

        if (this.safetyLerp > 0 && this.safetyLerp < 1) {
            this.camera.position.lerp(target, this.safetyLerp);
        } else {
            this.camera.position.copy(target);
        }
    }

    _softClamp(value, limit, softness) {
        if (limit <= 0) return value;
        const s = Math.max(0.01, softness);
        const scaled = (value / limit) * s;
        const clamped = Math.tanh(scaled);
        return (clamped / Math.tanh(s)) * limit;
    }

    _updateAudioShake(audioData) {
        if (audioData.averageVolume > 0.3) {
            this.currentShake = Math.max(this.currentShake, audioData.averageVolume * this.shakeIntensity);
        }
    }

    _applyShake(deltaTime) {
        // Remove previous frame's shake offset
        this.camera.position.sub(this.shakeOffset);

        if (this.currentShake > 0.001) {
            this.shakeOffset.set(
                (Math.random() - 0.5) * this.currentShake,
                (Math.random() - 0.5) * this.currentShake,
                0
            );
            this.camera.position.add(this.shakeOffset);
            this.currentShake *= this.shakeDecay;
        } else {
            this.shakeOffset.set(0, 0, 0);
        }
    }

    /**
     * Reset to original position
     */
    reset() {
        this.camera.position.copy(this.originalPosition);
        this.camera.rotation.copy(this.originalRotation);
        this.currentShake = 0;
        this.shakeOffset.set(0, 0, 0);

        if (this._timeline) {
            this._timeline.seek(0);
        }
    }

    /**
     * Sample authored camera state at any musicTime without mutating the live camera.
     * Builds a temporary GSAP timeline, seeks to the given time, reads values, then kills it.
     * @param {number} musicTime
     * @returns {{ position: [number,number,number], lookAt: [number,number,number], roll: number, fov: number } | null}
     */
    getAuthoredStateAtTime(musicTime) {
        if (!this.keyframes || this.keyframes.length === 0) return null;

        const tmpPos = { x: 0, y: 0, z: 0 };
        const tmpLookAt = { x: 0, y: 0, z: 0 };
        const tmpRoll = { value: 0 };
        const tmpFov = { value: this._baseFov };

        const tl = gsap.timeline({ paused: true });

        for (const kf of this.keyframes) {
            const position = kf.position || [0, 0, 5];
            const lookAt = kf.lookAt || [0, 0, 0];
            const duration = kf.duration || 2;
            const easing = kf.easing || 'power2.inOut';
            const timePos = kf.time != null ? kf.time : '>';

            tl.to(tmpPos, { x: position[0], y: position[1], z: position[2], duration, ease: easing }, timePos);
            tl.to(tmpLookAt, { x: lookAt[0], y: lookAt[1], z: lookAt[2], duration, ease: easing }, '<');
            if (kf.roll != null) {
                tl.to(tmpRoll, { value: kf.roll, duration, ease: easing }, '<');
            }
            if (kf.fov != null) {
                tl.to(tmpFov, { value: kf.fov, duration, ease: easing }, '<');
            }
        }

        tl.seek(musicTime);
        const result = {
            position: [tmpPos.x, tmpPos.y, tmpPos.z],
            lookAt: [tmpLookAt.x, tmpLookAt.y, tmpLookAt.z],
            roll: tmpRoll.value,
            fov: tmpFov.value
        };
        tl.kill();
        return result;
    }

    dispose() {
        if (this._timeline) {
            this._timeline.kill();
            this._timeline = null;
        }
    }
}

/**
 * Helper to apply per-scene camera config to a controller
 */
export function applyCameraConfig(controller, config) {
    if (!config) return;

    if (config.mode) {
        controller.setMode(config.mode, config);
    }

    if (config.keyframes) {
        controller.loadKeyframes(config.keyframes);
    }

    if (config.position) {
        controller.camera.position.set(...config.position);
    }

    if (config.lookAt) {
        controller.lookAtTarget.set(...config.lookAt);
        controller.camera.lookAt(controller.lookAtTarget);
    }
}
