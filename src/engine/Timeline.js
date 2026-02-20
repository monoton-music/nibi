/**
 * Timeline - Time-based event and scene management
 *
 * Features:
 * - Time-based scene switching
 * - Keyframe event firing
 * - Animation control in conjunction with GSAP
 */

import gsap from 'gsap';

export class Timeline {
    constructor() {
        this.scenes = [];
        this.events = [];
        this.currentSceneIndex = -1;
        this.currentTime = 0;
        this._onSceneChange = [];
        this._onEvent = [];
        this._firedEvents = new Set();
    }

    /**
     * Load scene data
     * @param {Array} sceneData - Array of scene definitions
     */
    loadScenes(sceneData) {
        this.scenes = sceneData.map((scene, index) => ({
            ...scene,
            index,
            endTime: scene.startTime + scene.duration
        }));

        // Sort by startTime
        this.scenes.sort((a, b) => a.startTime - b.startTime);

        console.log('[Timeline] Loaded scenes:', this.scenes.length);
    }

    /**
     * Load events (keyframes)
     * @param {Array} eventData - Array of event definitions
     */
    loadEvents(eventData) {
        this.events = eventData.map((event, index) => ({
            ...event,
            index,
            fired: false
        }));

        // Sort by time
        this.events.sort((a, b) => a.time - b.time);

        console.log('[Timeline] Loaded events:', this.events.length);
    }

    /**
     * Update the current time and handle scene switches and event firing
     * @param {number} time - Current time in seconds
     */
    update(time) {
        const prevTime = this.currentTime;
        this.currentTime = time;

        // Check for scene switch
        this._checkSceneChange(time);

        // Check for event firing
        this._checkEvents(prevTime, time);
    }

    /**
     * Check for scene switches
     */
    _checkSceneChange(time) {
        let newSceneIndex = -1;

        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.scenes[i];
            if (time >= scene.startTime && time < scene.endTime) {
                newSceneIndex = i;
                break;
            }
        }

        if (newSceneIndex !== this.currentSceneIndex) {
            const prevScene = this.currentSceneIndex >= 0 ? this.scenes[this.currentSceneIndex] : null;
            const nextScene = newSceneIndex >= 0 ? this.scenes[newSceneIndex] : null;

            this.currentSceneIndex = newSceneIndex;

            this._onSceneChange.forEach(cb => cb(nextScene, prevScene));

            if (nextScene) {
                console.log('[Timeline] Scene changed to:', nextScene.id);
            }
        }
    }

    /**
     * Check for event firing
     */
    _checkEvents(prevTime, currentTime) {
        for (const event of this.events) {
            // Skip events that have already fired
            if (this._firedEvents.has(event.index)) continue;

            // Fire events whose time falls between prevTime and currentTime
            if (event.time > prevTime && event.time <= currentTime) {
                this._firedEvents.add(event.index);
                this._onEvent.forEach(cb => cb(event));
                console.log('[Timeline] Event fired:', event.type, event);
            }
        }
    }

    /**
     * Get the current scene
     * @returns {Object|null} Current scene
     */
    getCurrentScene() {
        if (this.currentSceneIndex < 0) return null;
        return this.scenes[this.currentSceneIndex];
    }

    /**
     * Get the progress within the current scene (0–1)
     * @returns {number} Progress
     */
    getSceneProgress() {
        const scene = this.getCurrentScene();
        if (!scene) return 0;

        const elapsed = this.currentTime - scene.startTime;
        return Math.max(0, Math.min(1, elapsed / scene.duration));
    }

    /**
     * Reset event state on seek
     * @param {number} time - Seek target time
     */
    seek(time) {
        // Reset events that come after the seek target
        this._firedEvents = new Set(
            this.events
                .filter(e => e.time <= time)
                .map(e => e.index)
        );

        this.currentSceneIndex = -1;
        this.update(time);
    }

    /**
     * Register a scene-change callback
     * @param {function} callback - (nextScene, prevScene) => void
     */
    onSceneChange(callback) {
        this._onSceneChange.push(callback);
    }

    /**
     * Register an event-fired callback
     * @param {function} callback - (event) => void
     */
    onEvent(callback) {
        this._onEvent.push(callback);
    }

    /**
     * Reset state
     */
    reset() {
        this.currentSceneIndex = -1;
        this.currentTime = 0;
        this._firedEvents.clear();
    }

    /**
     * Create a GSAP timeline for a scene
     * @param {Object} scene - Scene object
     * @returns {gsap.core.Timeline}
     */
    createSceneTimeline(scene) {
        const tl = gsap.timeline({
            paused: true,
            defaults: { ease: 'power2.inOut' }
        });
        return tl;
    }
}
