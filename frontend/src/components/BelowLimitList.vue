<template>
  <div class="panel">
    <h4>🚨 低于下限设备</h4>
    <div v-if="!groups.length" class="empty">全部设备均在判定口径下限之上</div>
    <div v-for="g in groups" :key="g.shift" class="shift-group">
      <div class="shift-head">
        <span class="shift-name">{{ g.shift }}</span>
        <span class="shift-count">{{ g.total }} 台不达标</span>
      </div>
      <div v-for="t in g.types" :key="t.type" class="type-group">
        <div class="type-head">
          <span class="type-dot" :style="{background: DEVICE_COLORS[t.type] || '#64748b'}"></span>
          <span class="type-name">{{ t.type }}</span>
        </div>
        <div v-for="d in t.devices" :key="d.id" class="dev-row">
          <span class="dev-id">#{{ d.id }}</span>
          <span v-for="k in METRIC_KEYS" :key="k" class="metric-chip"
                :class="{bad: d.below.includes(k), na: d[k] === null}">
            {{ METRIC_LABELS[k] }} {{ d[k] === null ? '—' : d[k]!.toFixed(1) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useFactoryStore } from '../store/factory'
import { DEVICE_COLORS, METRIC_KEYS, METRIC_LABELS, SHIFT_ORDER } from '../types'
import type { OEEItem } from '../types'

const store = useFactoryStore()

const groups = computed(() => {
  const below = (store.data?.oee || []).filter(d => d.below.length > 0)
  const byShift: Record<string, Record<string, OEEItem[]>> = {}
  for (const d of below) {
    const s = (byShift[d.shift] ||= {})
    ;(s[d.type] ||= []).push(d)
  }
  return SHIFT_ORDER.filter(s => byShift[s]).map(s => {
    const types = Object.entries(byShift[s]).map(([type, devices]) => ({ type, devices }))
    return { shift: s, types, total: types.reduce((n, t) => n + t.devices.length, 0) }
  })
})
</script>

<style scoped>
.panel{background:#0d1b2a;border-radius:8px;padding:12px;border:1px solid #1e3a5f;overflow-y:auto;max-height:260px}
.panel h4{color:#f87171;font-size:13px;margin-bottom:8px}
.empty{color:#64748b;font-size:12px}
.shift-group{margin-bottom:10px}
.shift-head{display:flex;justify-content:space-between;align-items:center;padding:3px 6px;background:#112233;border-radius:4px;border-left:3px solid #f87171;margin-bottom:4px}
.shift-name{font-size:12px;font-weight:600;color:#e0e6ed}
.shift-count{font-size:10px;color:#f87171}
.type-group{margin:2px 0 6px 8px}
.type-head{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.type-dot{width:8px;height:8px;border-radius:50%}
.type-name{font-size:11px;color:#94a3b8;font-weight:600}
.dev-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:3px 6px;background:#0f1c2e;border-radius:4px;margin-bottom:2px}
.dev-id{font-size:11px;color:#64748b;min-width:26px}
.metric-chip{font-size:10px;color:#94a3b8;background:#1e293b;padding:1px 5px;border-radius:3px}
.metric-chip.bad{color:#fecaca;background:#7f1d1d55;border:1px solid #ef444488}
.metric-chip.na{opacity:.5}
</style>
