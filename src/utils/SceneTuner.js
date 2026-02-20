/**
 * SceneTuner - Minimal runtime inspector for mv-data.json
 */

const COLOR_HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function cloneData(data) {
  if (typeof structuredClone === 'function') {
    return structuredClone(data);
  }
  return JSON.parse(JSON.stringify(data));
}

function flattenParams(obj, prefix = '') {
  const rows = [];
  Object.entries(obj || {}).forEach(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      rows.push(...flattenParams(value, path));
    } else {
      rows.push({ path, value });
    }
  });
  return rows;
}

function setValueAtPath(target, path, value) {
  const parts = path.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

export class SceneTuner {
  constructor({ engine, getData, onApply }) {
    this.getData = getData;
    this.onApply = onApply;
    this.selectedSceneId = null;
    this.selectedComponentIndex = 0;
    this.fields = [];

    this._buildUI();
    this.refresh();
  }

  refresh() {
    const data = this.getData?.();
    if (!data || !data.scenes) return;

    const prevSceneId = this.selectedSceneId;
    const prevComponentIndex = this.selectedComponentIndex;

    this.sceneSelect.innerHTML = '';
    data.scenes.forEach(scene => {
      const option = document.createElement('option');
      option.value = scene.id;
      option.textContent = scene.id;
      this.sceneSelect.appendChild(option);
    });

    if (!prevSceneId && data.scenes.length > 0) {
      this.selectedSceneId = data.scenes[0].id;
    } else if (data.scenes.some(scene => scene.id === prevSceneId)) {
      this.selectedSceneId = prevSceneId;
    } else {
      this.selectedSceneId = data.scenes[0]?.id || null;
    }

    this.sceneSelect.value = this.selectedSceneId || '';
    this._populateComponents(prevComponentIndex);
    this._buildFields();
  }

  _buildUI() {
    this.root = document.createElement('div');
    this.root.className = 'mv-tuner';

    this.root.innerHTML = `
      <div class="mv-tuner-header">
        <div class="mv-tuner-title">Scene Tuner</div>
        <button class="mv-tuner-close" type="button">x</button>
      </div>
      <div class="mv-tuner-row">
        <label class="mv-tuner-label">Scene</label>
        <select class="mv-tuner-select mv-tuner-scene"></select>
      </div>
      <div class="mv-tuner-row">
        <label class="mv-tuner-label">Component</label>
        <select class="mv-tuner-select mv-tuner-component"></select>
      </div>
      <div class="mv-tuner-fields"></div>
      <div class="mv-tuner-actions">
        <button class="mv-tuner-btn mv-tuner-apply" type="button">Apply</button>
        <button class="mv-tuner-btn mv-tuner-export" type="button">Export JSON</button>
      </div>
    `;

    document.body.appendChild(this.root);

    this.sceneSelect = this.root.querySelector('.mv-tuner-scene');
    this.componentSelect = this.root.querySelector('.mv-tuner-component');
    this.fieldsContainer = this.root.querySelector('.mv-tuner-fields');

    this.sceneSelect.addEventListener('change', () => {
      this.selectedSceneId = this.sceneSelect.value;
      this.selectedComponentIndex = 0;
      this._populateComponents(0);
      this._buildFields();
    });

    this.componentSelect.addEventListener('change', () => {
      this.selectedComponentIndex = parseInt(this.componentSelect.value, 10) || 0;
      this._buildFields();
    });

    this.root.querySelector('.mv-tuner-apply').addEventListener('click', () => {
      this._applyChanges();
    });

    this.root.querySelector('.mv-tuner-export').addEventListener('click', () => {
      this._exportData();
    });

    this.root.querySelector('.mv-tuner-close').addEventListener('click', () => {
      this.root.remove();
    });
  }

  _populateComponents(preferredIndex = 0) {
    const data = this.getData?.();
    const scene = data?.scenes?.find(s => s.id === this.selectedSceneId);
    const components = scene?.components || [];

    this.componentSelect.innerHTML = '';
    components.forEach((comp, index) => {
      const option = document.createElement('option');
      option.value = index.toString();
      option.textContent = `${index}: ${comp.type}`;
      this.componentSelect.appendChild(option);
    });

    const nextIndex = Math.min(preferredIndex, Math.max(components.length - 1, 0));
    this.selectedComponentIndex = nextIndex;
    this.componentSelect.value = nextIndex.toString();
  }

  _buildFields() {
    const data = this.getData?.();
    const scene = data?.scenes?.find(s => s.id === this.selectedSceneId);
    const component = scene?.components?.[this.selectedComponentIndex];
    this.fields = [];
    this.fieldsContainer.innerHTML = '';

    if (!component || !component.params) {
      this.fieldsContainer.innerHTML = '<div class="mv-tuner-empty">No params</div>';
      return;
    }

    const flatParams = flattenParams(component.params);
    flatParams.forEach(({ path, value }) => {
      const row = document.createElement('div');
      row.className = 'mv-tuner-field';

      const label = document.createElement('label');
      label.className = 'mv-tuner-field-label';
      label.textContent = path;

      let input;
      const valueType = typeof value;
      if (valueType === 'number') {
        input = document.createElement('input');
        input.type = 'number';
        input.step = '0.01';
        input.value = value;
      } else if (valueType === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value;
      } else if (valueType === 'string' && COLOR_HEX.test(value)) {
        input = document.createElement('input');
        input.type = 'color';
        input.value = value;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = value;
      }

      input.className = 'mv-tuner-input';
      row.appendChild(label);
      row.appendChild(input);
      this.fieldsContainer.appendChild(row);

      this.fields.push({ path, input, valueType, originalValue: value });
    });
  }

  async _applyChanges() {
    const data = this.getData?.();
    if (!data) return;

    const nextData = cloneData(data);
    const scene = nextData.scenes?.find(s => s.id === this.selectedSceneId);
    const component = scene?.components?.[this.selectedComponentIndex];
    if (!component) return;

    this.fields.forEach(({ path, input, valueType, originalValue }) => {
      let nextValue = originalValue;
      if (valueType === 'number') {
        const parsed = parseFloat(input.value);
        nextValue = Number.isNaN(parsed) ? originalValue : parsed;
      } else if (valueType === 'boolean') {
        nextValue = input.checked;
      } else if (valueType === 'string') {
        nextValue = input.value;
      } else {
        nextValue = input.value;
      }

      setValueAtPath(component.params, path, nextValue);
    });

    if (this.onApply) {
      await this.onApply(nextData);
    }
  }

  _exportData() {
    const data = this.getData?.();
    if (!data) return;

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mv-data.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
}
