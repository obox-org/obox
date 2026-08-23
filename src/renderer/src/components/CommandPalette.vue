<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { registry } from '../core/registry'

const { t } = useI18n()

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const query = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const selectedIndex = ref(0)

const items = computed(() => {
  const q = query.value.trim().toLowerCase()
  const all = registry.getPaletteCommands()
  if (!q) return all
  return all.filter((c) => c.title.toLowerCase().includes(q) || c.command.toLowerCase().includes(q))
})

watch(
  () => props.open,
  async (open) => {
    if (open) {
      query.value = ''
      selectedIndex.value = 0
      await nextTick()
      inputRef.value?.focus()
    }
  }
)

watch(items, () => {
  if (selectedIndex.value >= items.value.length) selectedIndex.value = 0
})

async function runCommand(command: string): Promise<void> {
  const cmd = registry.commands.find((c) => c.command === command)
  emit('close')
  if (cmd?.handler) {
    try {
      await cmd.handler()
    } catch (err) {
      console.error(`[palette] command ${command} failed`, err)
    }
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = (selectedIndex.value + 1) % items.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = (selectedIndex.value - 1 + items.value.length) % items.value.length
  } else if (e.key === 'Enter' && items.value[selectedIndex.value]) {
    void runCommand(items.value[selectedIndex.value].command)
  } else if (e.key === 'Escape') {
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="palette-overlay" @click.self="emit('close')">
      <div class="palette">
        <div class="palette-input-row">
          <span class="palette-prefix">&gt;</span>
          <input
            ref="inputRef"
            v-model="query"
            class="palette-input"
            placeholder="{{ t('palette.placeholder') }}"
            @keydown="onKeydown"
          />
        </div>
        <ul class="palette-list">
          <li
            v-for="(item, idx) in items"
            :key="item.command"
            class="palette-item"
            :class="{ selected: idx === selectedIndex }"
            @click="runCommand(item.command)"
            @mouseenter="selectedIndex = idx"
          >
            <span v-if="item.category" class="palette-category">{{ item.category }}: </span>
            <span>{{ item.title }}</span>
            <span class="palette-id">{{ item.command }}</span>
          </li>
          <li v-if="items.length === 0" class="palette-empty">{{ t('palette.empty') }}</li>
        </ul>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 5000;
  display: flex;
  justify-content: center;
  padding-top: 8vh;
}
.palette {
  width: 560px;
  max-height: 60vh;
  background: var(--bg-panel, #252526);
  border: 1px solid var(--border, #454545);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}
.palette-input-row {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #3c3c3c);
}
.palette-prefix {
  color: var(--fg, #cccccc);
  margin-right: 8px;
  font-size: 16px;
  font-weight: bold;
}
.palette-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--fg-bright, #ffffff);
  font-size: 14px;
}
.palette-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
}
.palette-item {
  display: flex;
  align-items: center;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--fg, #cccccc);
  cursor: pointer;
}
.palette-item.selected {
  background: var(--selection-bg, #094771);
  color: var(--fg-bright, #ffffff);
}
.palette-category {
  opacity: 0.7;
}
.palette-id {
  margin-left: auto;
  padding-left: 12px;
  font-size: 11px;
  opacity: 0.5;
}
.palette-empty {
  padding: 12px;
  color: var(--fg-dim, #6e6e6e);
  font-size: 13px;
}
</style>
