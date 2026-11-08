/**
 * ADOFAI 编辑器
 * 提供瓷砖的添加、删除、修改、角度调整等编辑操作
 */

class AdofaiEditor {
  constructor(player, renderer) {
    this.player = player;
    this.renderer = renderer;
    this.level = null;
    this.selectedTile = -1;
    this.isEditing = false;
    this.clipboard = null;
    this.onChange = null;

    // 快捷角度预设（与官方编辑器一致）
    this.anglePresets = [
      { label: 'R', value: 0 },
      { label: 'E', value: 45 },
      { label: 'U', value: 90 },
      { label: 'Q', value: 135 },
      { label: 'L', value: 180 },
      { label: 'Z', value: 225 },
      { label: 'D', value: 270 },
      { label: 'C', value: 315 },
      { label: '!', value: 999, name: 'Midspin' }
    ];
  }

  setLevel(level) {
    this.level = level;
    this.selectedTile = -1;
    this.renderer.selectedTile = -1;
  }

  /**
   * 选中指定瓷砖
   */
  selectTile(index) {
    this.selectedTile = index;
    this.renderer.selectedTile = index;
    if (index >= 0 && this.level) {
      this.renderer.centerOnTile(index);
    }
  }

  /**
   * 修改选中瓷砖的角度
   */
  modifyAngle(direction) {
    if (!this.level || this.selectedTile < 0) return false;
    this.level.setTileDirection(this.selectedTile, direction);
    this._notifyChange();
    return true;
  }

  /**
   * 在选中瓷砖后插入新瓷砖
   */
  insertTile(direction) {
    if (!this.level) return false;
    const insertAt = this.selectedTile >= 0 ? this.selectedTile + 1 : this.level.tileCount;
    this.level.insertTile(insertAt, direction);
    this.selectedTile = insertAt;
    this.renderer.selectedTile = insertAt;
    this._notifyChange();
    return true;
  }

  /**
   * 删除选中瓷砖
   */
  deleteTile() {
    if (!this.level || this.selectedTile < 0) return false;
    if (this.level.tileCount <= 1) return false; // 至少保留1个
    const idx = this.selectedTile;
    this.level.deleteTile(idx);
    this.selectedTile = Math.max(0, idx - 1);
    this.renderer.selectedTile = this.selectedTile;
    this._notifyChange();
    return true;
  }

  /**
   * 微调角度（每次 ±15 度）
   */
  nudgeAngle(delta) {
    if (!this.level || this.selectedTile < 0) return false;
    const current = this.level.angleData[this.selectedTile];
    let newAngle;
    if (current === 999) {
      newAngle = delta > 0 ? 0 : 345;
    } else {
      newAngle = ((current + delta) % 360 + 360) % 360;
    }
    this.level.setTileDirection(this.selectedTile, newAngle);
    this._notifyChange();
    return true;
  }

  /**
   * 复制选中瓷砖
   */
  copyTile() {
    if (!this.level || this.selectedTile < 0) return;
    this.clipboard = {
      direction: this.level.angleData[this.selectedTile],
      actions: JSON.parse(JSON.stringify(this.level.tiles[this.selectedTile]?.actions || []))
    };
  }

  /**
   * 粘贴瓷砖到选中位置之后
   */
  pasteTile() {
    if (!this.level || !this.clipboard) return false;
    const insertAt = this.selectedTile >= 0 ? this.selectedTile + 1 : this.level.tileCount;
    this.level.insertTile(insertAt, this.clipboard.direction);
    // 粘贴 actions
    if (this.clipboard.actions.length > 0) {
      for (const a of this.clipboard.actions) {
        this.level.actions.push({ ...a, floor: insertAt });
      }
      this.level.rebuild();
    }
    this.selectedTile = insertAt;
    this.renderer.selectedTile = insertAt;
    this._notifyChange();
    return true;
  }

  /**
   * 选中下一个瓷砖
   */
  selectNext() {
    if (!this.level) return;
    this.selectTile(Math.min(this.level.tileCount - 1, this.selectedTile + 1));
  }

  /**
   * 选中上一个瓷砖
   */
  selectPrev() {
    if (!this.level) return;
    this.selectTile(Math.max(0, this.selectedTile - 1));
  }

  /**
   * 获取选中瓷砖的信息
   */
  getSelectedInfo() {
    if (!this.level || this.selectedTile < 0) return null;
    const tile = this.level.tiles[this.selectedTile];
    return {
      index: this.selectedTile,
      direction: tile.direction,
      angle: tile.angle,
      beats: tile.beats,
      position: tile.position,
      actionsCount: tile.actions.length
    };
  }

  _notifyChange() {
    if (this.player) {
      this.player.setLevel(this.level);
    }
    if (this.onChange) this.onChange();
  }
}

window.AdofaiEditor = AdofaiEditor;
