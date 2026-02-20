/**
 * AudioManager - Manages music playback and audio analysis
 *
 * Features:
 * - Play / pause / seek music
 * - Get current time (reference for the timeline)
 * - Get frequency data (for visual synchronization)
 */

export class AudioManager {
  constructor() {
    this.audioContext = null;
    this.audioElement = null;
    this.analyser = null;
    this.sourceNode = null;
    this.frequencyData = null;
    this.isInitialized = false;
    this.isPlaying = false;
    this._onTimeUpdate = [];
    this._onEnded = [];
  }

  /**
   * Load an audio file
   * @param {string} url - URL of the audio file
   */
  async load(url) {
    // Create AudioContext
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Create Audio element
    this.audioElement = new Audio();
    this.audioElement.crossOrigin = 'anonymous';
    this.audioElement.src = url;

    // Wait for load to complete
    await new Promise((resolve, reject) => {
      // canplay fires as soon as playback can start (enough buffered).
      // canplaythrough (fully buffered) is unnecessary since we preload in HTML.
      this.audioElement.addEventListener('canplay', resolve, { once: true });
      this.audioElement.addEventListener('error', reject, { once: true });
      this.audioElement.load();
    });

    // Connect source node and analyser
    this.sourceNode = this.audioContext.createMediaElementSource(this.audioElement);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;

    this.sourceNode.connect(this.analyser);
    this.analyser.connect(this.audioContext.destination);

    // Buffer for frequency data
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

    // Event listeners
    this.audioElement.addEventListener('timeupdate', () => {
      this._onTimeUpdate.forEach(cb => cb(this.getCurrentTime()));
    });

    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      this._onEnded.forEach(cb => cb());
    });

    this.isInitialized = true;
    console.log('[AudioManager] Loaded:', url);
  }

  /**
   * Play
   */
  async play() {
    if (!this.isInitialized) return;

    // Resume AudioContext if suspended (handles user interaction requirement)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    await this.audioElement.play();
    this.isPlaying = true;
  }

  /**
   * Pause
   */
  pause() {
    if (!this.isInitialized) return;
    this.audioElement.pause();
    this.isPlaying = false;
  }

  /**
   * Toggle play / pause
   */
  async toggle() {
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  /**
   * Seek to the specified time
   * @param {number} time - Target time in seconds
   */
  seek(time) {
    if (!this.isInitialized) return;
    this.audioElement.currentTime = Math.max(0, Math.min(time, this.getDuration()));
  }

  /**
   * Get the current playback time
   * @returns {number} Current time in seconds
   */
  getCurrentTime() {
    if (!this.isInitialized) return 0;
    return this.audioElement.currentTime;
  }

  /**
   * Get the total duration of the track
   * @returns {number} Total duration in seconds
   */
  getDuration() {
    if (!this.isInitialized) return 0;
    return this.audioElement.duration || 0;
  }

  /**
   * Get frequency data (array of values 0–255)
   * @returns {Uint8Array} Frequency data
   */
  getFrequencyData() {
    if (!this.analyser) return new Uint8Array(0);
    this.analyser.getByteFrequencyData(this.frequencyData);
    return this.frequencyData;
  }

  /**
   * Get average volume (0–1)
   * @returns {number} Average volume
   */
  getAverageVolume() {
    const data = this.getFrequencyData();
    if (data.length === 0) return 0;
    const sum = data.reduce((a, b) => a + b, 0);
    return sum / data.length / 255;
  }

  /**
   * Register a time-update callback
   * @param {function} callback
   */
  onTimeUpdate(callback) {
    this._onTimeUpdate.push(callback);
  }

  /**
   * Register a playback-ended callback
   * @param {function} callback
   */
  onEnded(callback) {
    this._onEnded.push(callback);
  }

  /**
   * Release resources
   */
  dispose() {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.src = '';
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
    this.isInitialized = false;
    this.isPlaying = false;
  }
}
