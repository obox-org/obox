<script setup lang="ts">
/**
 * 扩展提示宿主：QuickPick（选项选择）+ InputBox（输入框）。
 * 由 api.ui.showQuickPick / showInputBox 触发（uiStore 状态驱动）。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { uiState, uiStore } from '../core/uiStore'

const inputRef = ref<HTMLInputElement | null>(null)

const filteredItems = computed(() => {
  const qp = uiState.quickPick
  if (!qp) return []
  const q = qp.query.trim().toLowerCase()
  if (!q) return qp.items
  return qp.items.filter((i) => i.label.toLowerCase().includes(q))
})

watch(
  () => uiState.inputBox,
  async (v) => {
    if (v) {
      await nextTick()
      inputRef.value?.focus()
      inputRef.value?.select()
    }
  }
)

function onQuickPickKeydown(e: KeyboardEvent): void {
  const qp = uiState.quickPick
  if (!qp) return
  const list = filteredItems.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    qp.selectedIndex = (qp.selectedIndex + 1) % Math.max(list.length, 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    qp.selectedIndex = (qp.selectedIndex - 1 + Math.max(list.length, 1)) % Math.max(list.length, 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    uiStore.resolveQuickPick(list[qp.selectedIndex]?.label)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    uiStore.resolveQuickPick(undefined)
  }
}

function onInputKeydown(e: KeyboardEvent): void {
  const ib = uiState.inputBox
  if (!ib) return
  if (e.key === 'Enter') {
    e.preventDefault()
    uiStore.resolveInputBox(ib.value)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    uiStore.resolveInputBox(undefined)
  }
}

/** 表单提交：校验必填后 resolve */
function submitForm(): void {
  const form = uiState.form
  if (!form) return
  for (const f of form.fields) {
    if (f.required) {
      const v = form.values[f.key]
      const empty = f.type === 'checkbox' ? (Array.isArray(v) && v.length === 0) : !v
      if (empty) return
    }
  }
  uiStore.resolveForm({ ...form.values })
}
</script>

<template>
  <Teleport to="body">
    <!-- QuickPick -->
    <div
      v-if="uiState.quickPick"
      class="prompt-overlay"
      @click.self="uiStore.resolveQuickPick(undefined)"
    >
      <div class="prompt">
        <div v-if="uiState.quickPick.title" class="prompt-title">
          {{ uiState.quickPick.title }}
        </div>
        <div class="prompt-input-row">
          <input
            v-model="uiState.quickPick.query"
            class="prompt-input"
            :placeholder="uiState.quickPick.placeHolder ?? '搜索或选择…'"
            autofocus
            @keydown="onQuickPickKeydown"
          />
        </div>
        <ul class="prompt-list">
          <li
            v-for="(item, idx) in filteredItems"
            :key="item.label"
            class="prompt-item"
            :class="{ selected: idx === uiState.quickPick.selectedIndex }"
            @click="uiStore.resolveQuickPick(item.label)"
            @mouseenter="uiState.quickPick.selectedIndex = idx"
          >
            <span>{{ item.label }}</span>
            <span v-if="item.description" class="prompt-desc">{{ item.description }}</span>
          </li>
          <li v-if="filteredItems.length === 0" class="prompt-empty">无匹配项</li>
        </ul>
      </div>
    </div>

    <!-- InputBox -->
    <div
      v-if="uiState.inputBox"
      class="prompt-overlay"
      @click.self="uiStore.resolveInputBox(undefined)"
    >
      <div class="prompt input-prompt">
        <div v-if="uiState.inputBox.title" class="prompt-title">{{ uiState.inputBox.title }}</div>
        <input
          ref="inputRef"
          v-model="uiState.inputBox.value"
          class="prompt-input"
          :type="uiState.inputBox.password ? 'password' : 'text'"
          :placeholder="uiState.inputBox.placeHolder"
          @keydown="onInputKeydown"
        />
      </div>
    </div>

    <!-- Form（多字段表单模态框） -->
    <div v-if="uiState.form" class="prompt-overlay" @click.self="uiStore.resolveForm(undefined)">
      <div class="prompt form-prompt">
        <div v-if="uiState.form.title" class="prompt-title">{{ uiState.form.title }}</div>
        <div v-for="field in uiState.form.fields" :key="field.key" class="form-row">
          <label class="form-label">
            {{ field.label }}<span v-if="field.required" class="form-required"> *</span>
          </label>
          <input
            v-if="field.type === 'text'"
            v-model="uiState.form.values[field.key] as string"
            class="form-input"
            :placeholder="field.placeholder"
            @keydown.enter="submitForm"
          />
          <textarea
            v-else-if="field.type === 'textarea'"
            v-model="uiState.form.values[field.key] as string"
            class="form-input form-textarea"
            :placeholder="field.placeholder"
            rows="3"
          ></textarea>
          <input
            v-else-if="field.type === 'number'"
            v-model="uiState.form.values[field.key] as string"
            class="form-input"
            type="number"
          />
          <input
            v-else-if="field.type === 'date'"
            v-model="uiState.form.values[field.key] as string"
            class="form-input"
            type="date"
          />
          <select
            v-else-if="field.type === 'select'"
            v-model="uiState.form.values[field.key] as string"
            class="form-input"
          >
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <div v-else-if="field.type === 'checkbox'" class="form-checks">
            <label v-for="opt in field.options ?? []" :key="opt.value" class="form-check">
              <input
                type="checkbox"
                :value="opt.value"
                v-model="uiState.form.values[field.key] as string[]"
              />
              {{ opt.label }}
            </label>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn" @click="uiStore.resolveForm(undefined)">取消</button>
          <button class="btn primary" @click="submitForm">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.prompt-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 5100;
  display: flex;
  justify-content: center;
  padding-top: 10vh;
}
.prompt {
  width: 480px;
  max-height: 55vh;
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #454545);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}
.prompt-title {
  padding: 10px 12px 0;
  font-size: 12px;
  color: var(--fg-dim, #9d9d9d);
}
.prompt-input-row {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #3c3c3c);
}
.input-prompt {
  padding: 10px 12px;
}
.prompt-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg-bright, #ffffff);
  font-size: 14px;
}
.prompt-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
}
.prompt-item {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--fg, #cccccc);
  cursor: pointer;
}
.prompt-item.selected {
  background: var(--selection-bg, #094771);
  color: var(--fg-bright, #ffffff);
}
.prompt-desc {
  margin-left: auto;
  padding-left: 12px;
  font-size: 11px;
  opacity: 0.6;
}
.prompt-empty {
  padding: 12px;
  color: var(--fg-dim, #6e6e6e);
  font-size: 13px;
}
.form-prompt {
  width: 420px;
  max-height: 70vh;
  overflow-y: auto;
  padding-bottom: 12px;
}
.form-row {
  padding: 8px 12px 0;
}
.form-label {
  display: block;
  font-size: 12px;
  color: var(--fg, #cccccc);
  margin-bottom: 4px;
}
.form-required {
  color: var(--fg-error, #f48771);
}
.form-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  padding: 5px 8px;
  font-size: 13px;
}
.form-textarea {
  resize: vertical;
}
.form-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
}
.form-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--fg, #cccccc);
}
.form-check input {
  accent-color: var(--accent, #007acc);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 12px 0;
}
.btn {
  background: var(--bg-input, #3c3c3c);
  border: 1px solid var(--border, #454545);
  color: var(--fg, #cccccc);
  padding: 4px 16px;
  font-size: 13px;
  cursor: pointer;
}
.btn.primary {
  background: var(--accent, #007acc);
  border-color: var(--accent, #007acc);
  color: #ffffff;
}
.btn:hover {
  filter: brightness(1.15);
}
</style>
