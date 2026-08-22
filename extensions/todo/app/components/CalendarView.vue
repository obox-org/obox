<script setup lang="ts">
/**
 * 日历视图：月视图网格（周一开头），有待办的日期打点（未完成计数），
 * 今日高亮，点日期触发 pick-day（父级切换为当日待办视图）。
 */
import { computed, ref } from 'vue'
import { todoStore } from '../store'
import { toDateStr, todayStr } from '../utils'

const emit = defineEmits<{ 'pick-day': [date: string] }>()

const now = new Date()
const cursorYear = ref(now.getFullYear())
const cursorMonth = ref(now.getMonth()) // 0-11
const today = todayStr()

const title = computed(() => `${cursorYear.value}年${cursorMonth.value + 1}月`)

/** 周一开头的一周；cell: { date: 'YYYY-MM-DD', inMonth: boolean } */
const weeks = computed(() => {
  const first = new Date(cursorYear.value, cursorMonth.value, 1)
  const mondayIndex = (first.getDay() + 6) % 7 // getDay(): 0=日..6=六 → 周一=0
  const start = new Date(cursorYear.value, cursorMonth.value, 1 - mondayIndex)
  const cells: { date: string; inMonth: boolean }[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    cells.push({
      date: toDateStr(d),
      inMonth: d.getMonth() === cursorMonth.value
    })
  }
  const rows: (typeof cells)[] = []
  for (let i = 0; i < 6; i++) rows.push(cells.slice(i * 7, i * 7 + 7))
  return rows
})

const counts = computed(() => {
  const map = new Map<string, number>()
  for (const t of todoStore.todos) {
    if (t.completed || !t.dueDate) continue
    map.set(t.dueDate, (map.get(t.dueDate) ?? 0) + 1)
  }
  return map
})

function prevMonth(): void {
  if (cursorMonth.value === 0) {
    cursorMonth.value = 11
    cursorYear.value--
  } else {
    cursorMonth.value--
  }
}

function nextMonth(): void {
  if (cursorMonth.value === 11) {
    cursorMonth.value = 0
    cursorYear.value++
  } else {
    cursorMonth.value++
  }
}

function goToday(): void {
  cursorYear.value = new Date().getFullYear()
  cursorMonth.value = new Date().getMonth()
}

const weekdayLabels = ['一', '二', '三', '四', '五', '六', '日']
</script>

<template>
  <div class="calendar">
    <header class="cal-header">
      <button class="nav-btn" @click="prevMonth">‹</button>
      <span class="cal-title">{{ title }}</span>
      <button class="nav-btn" @click="nextMonth">›</button>
      <button class="today-btn" @click="goToday">今天</button>
    </header>

    <div class="weekdays">
      <span v-for="w in weekdayLabels" :key="w" class="weekday">{{ w }}</span>
    </div>

    <div class="grid">
      <button
        v-for="(cell, i) in weeks.flat()"
        :key="i"
        class="day"
        :class="{
          out: !cell.inMonth,
          today: cell.date === today
        }"
        @click="emit('pick-day', cell.date)"
      >
        <span class="day-num">{{ Number(cell.date.slice(8)) }}</span>
        <span v-if="counts.get(cell.date)" class="dot-count">{{ counts.get(cell.date) }}</span>
      </button>
    </div>

    <p class="cal-hint">点击日期查看当天待办</p>
  </div>
</template>

<style scoped>
.calendar {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px;
  gap: 10px;
  overflow-y: auto;
}
.cal-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.nav-btn {
  background: transparent;
  border: none;
  color: #9d9d9d;
  font-size: 18px;
  cursor: pointer;
  padding: 0 8px;
  line-height: 1;
}
.nav-btn:hover {
  color: #ffffff;
}
.cal-title {
  font-size: 16px;
  font-weight: 600;
  color: #e8e8e8;
  min-width: 110px;
  text-align: center;
}
.today-btn {
  margin-left: auto;
  background: #3c3c3c;
  border: 1px solid #454545;
  color: #cccccc;
  font-size: 12px;
  padding: 3px 12px;
  cursor: pointer;
  border-radius: 2px;
}
.today-btn:hover {
  background: #454545;
}
.weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.weekday {
  text-align: center;
  font-size: 12px;
  color: #9d9d9d;
  padding: 4px 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.day {
  position: relative;
  min-height: 52px;
  background: #252526;
  border: 1px solid #333333;
  border-radius: 4px;
  color: #cccccc;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 6px 8px;
  font-size: 13px;
}
.day:hover {
  border-color: #007acc;
}
.day.out {
  opacity: 0.35;
}
.day.today {
  border-color: #0e639c;
  background: #1f3a52;
  color: #ffffff;
}
.day-num {
  font-weight: 500;
}
.dot-count {
  font-size: 11px;
  background: #0e639c;
  color: #ffffff;
  border-radius: 8px;
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}
.cal-hint {
  color: #6e6e6e;
  font-size: 11px;
  margin: 0;
}
</style>
