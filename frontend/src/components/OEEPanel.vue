<template>
  <div class="oee-panel">
    <div class="panel-head">
      <h4>📐 OEE 设备综合效率</h4>
      <el-select
        :model-value="store.activeId" size="small" class="criteria-select"
        @update:model-value="(v: string) => store.setActive(v)"
      >
        <el-option v-for="p in store.profiles" :key="p.id" :value="p.id" :label="p.name" />
      </el-select>
      <el-button size="small" @click="dialogOpen = true">口径配置</el-button>
    </div>

    <div class="active-criteria">
      <span class="tag">当前生效口径：{{ store.activeProfile.name }}</span>
      <span class="desc">{{ describeProfile(store.activeProfile) }}</span>
    </div>

    <OEEChart />

    <div class="summary">
      <template v-if="failedDevices.length">
        <span class="sum-title">低于下限（{{ failedDevices.length }} 台）：</span>
        <span
          v-for="d in failedDevices" :key="d.id"
          class="fail-chip"
          :title="failTitle(d)"
          @click="showJumpHint(d)"
        >
          {{ d.type }}-{{ d.id }}
          <i v-for="k in d.failed" :key="k" class="metric-flag" :style="{ color: OEE_METRIC_META[k].color }">
            {{ OEE_METRIC_META[k].short }}
          </i>
        </span>
      </template>
      <span v-else class="all-pass">✅ 当前口径下无低于下限的设备</span>
      <span v-if="jumpHint" class="jump-hint">{{ jumpHint }}</span>
    </div>

    <div class="list-title">
      设备判定明细（按班次 → 设备类型分组）
      <span v-if="noDataCount" class="nodata-count">{{ noDataCount }} 台观察时段内无数据</span>
    </div>
    <div class="dev-list">
      <template v-for="shift in SHIFTS" :key="shift.id">
        <template v-for="t in groupOrder(shift.id)" :key="shift.id + t">
          <div class="group-header">
            <span class="shift-name">{{ shift.label }}</span>
            <span class="type-name">{{ DEVICE_TYPE_LABELS[t] || t }}</span>
            <span class="group-count">
              {{ groups[shift.id][t].filter(d => d.failed.length).length }}/{{ groups[shift.id][t].length }} 不合格
            </span>
          </div>
          <div
            v-for="d in groups[shift.id][t]" :key="d.id"
            class="dev-row"
            :class="{ failed: d.failed.length, nodata: isNoData(d) }"
          >
            <span class="dev-name">{{ d.type }}-#{{ d.id }}</span>
            <span
              v-for="k in OEE_METRIC_KEYS" :key="k"
              class="badge" :class="badgeClass(d, k)"
              :title="badgeTitle(d, k)"
            >
              {{ OEE_METRIC_META[k].short }}
              <b>{{ d[k] === null ? '—' : d[k].toFixed(1) }}</b>
            </span>
            <span class="oee-val" :class="{ low: d.failed.length }">
              OEE {{ d.oee === null ? '无数据' : d.oee.toFixed(1) + '%' }}
            </span>
          </div>
        </template>
      </template>
      <div v-if="!store.evaluated.length" class="empty">等待设备数据接入…</div>
    </div>

    <CriteriaDialog v-model="dialogOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import OEEChart from './OEEChart.vue'
import CriteriaDialog from '../oee/CriteriaDialog.vue'
import { useOEEStore } from '../oee/criteria'
import { OEE_METRIC_KEYS, OEE_METRIC_META, SHIFTS, describeProfile } from '../oee/engine'
import { DEVICE_TYPES, DEVICE_TYPE_LABELS } from '../types'
import type { EvaluatedDevice, MetricKey, MetricStatus } from '../types'

const store = useOEEStore()
const dialogOpen = ref(false)
const jumpHint = ref('')
let jumpTimer: ReturnType<typeof setTimeout> | undefined

function showJumpHint(d: EvaluatedDevice) {
  jumpHint.value = `${d.type}-${d.id} 已在上方柱状图与曲线中红色高亮（不合格：${d.failed.map(k => OEE_METRIC_META[k].label).join('、')}）`
  clearTimeout(jumpTimer)
  jumpTimer = setTimeout(() => { jumpHint.value = '' }, 3000)
}

const failedDevices = computed(() => store.failedDevices)

const groups = computed<Record<string, Record<string, EvaluatedDevice[]>>>(() => {
  const g: Record<string, Record<string, EvaluatedDevice[]>> = {}
  for (const s of SHIFTS) {
    g[s.id] = {}
    for (const t of DEVICE_TYPES) g[s.id][t] = []
  }
  for (const d of store.evaluated) {
    if (!g[d.shift]) g[d.shift] = {}
    if (!g[d.shift][d.type]) g[d.shift][d.type] = []
    g[d.shift][d.type].push(d)
  }
  return g
})

function groupOrder(shiftId: string): string[] {
  return DEVICE_TYPES.filter(t => groups.value[shiftId]?.[t]?.length)
}

const noDataCount = computed(() => store.evaluated.filter(d => d.noData.length === OEE_METRIC_KEYS.length).length)

function isNoData(d: EvaluatedDevice) { return d.oee === null }

function badgeClass(d: EvaluatedDevice, k: MetricKey): MetricStatus { return d.statuses[k] }

function fmtRange(k: MetricKey) {
  const c = store.activeProfile.metrics[k]
  const l = c.lower === null ? '不限' : c.lower + '%'
  const u = c.upper === null ? '不限' : c.upper + '%'
  return `${l}~${u}，观察 ${c.windowStart}-${c.windowEnd}`
}

function badgeTitle(d: EvaluatedDevice, k: MetricKey) {
  const stText: Record<MetricStatus, string> = {
    ok: '合格', low: '低于下限', high: '高于上限', nodata: '观察时段内无数据',
  }
  return `${OEE_METRIC_META[k].label} ${d[k] === null ? '无数据' : d[k].toFixed(1) + '%'}｜${stText[d.statuses[k]]}｜口径 ${fmtRange(k)}`
}

function failTitle(d: EvaluatedDevice) {
  return `不合格项：${d.failed.map(k => `${OEE_METRIC_META[k].label} ${d[k]?.toFixed(1)}%（下限 ${store.activeProfile.metrics[k].lower}%）`).join('，')}`
}
</script>

<style scoped>
.oee-panel {
  background: #0d1b2a; border-radius: 8px; padding: 12px;
  border: 1px solid #1e3a5f; display: flex; flex-direction: column;
  max-height: calc(100vh - 140px);
}
.panel-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px }
.panel-head h4 { color: #64b5f6; font-size: 13px; flex: 1 }
.criteria-select { width: 168px }
.active-criteria { font-size: 10px; color: #94a3b8; margin-bottom: 4px; line-height: 1.5 }
.active-criteria .tag { color: #64b5f6; margin-right: 6px; white-space: nowrap }
.active-criteria .desc { color: #64748b }

.summary { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin: 6px 0 2px; font-size: 11px }
.sum-title { color: #fca5a5 }
.all-pass { color: #4ade80; font-size: 11px }
.fail-chip {
  background: #7f1d1d33; border: 1px solid #7f1d1d88; color: #fca5a5;
  border-radius: 4px; padding: 1px 6px; cursor: pointer; white-space: nowrap;
}
.fail-chip:hover { background: #7f1d1d66 }
.metric-flag { font-style: normal; font-size: 10px; margin-left: 2px }
.jump-hint { width: 100%; color: #fbbf24; font-size: 10px }

.list-title {
  color: #94a3b8; font-size: 11px; margin-top: 8px; padding-top: 6px;
  border-top: 1px solid #16293f; display: flex; gap: 8px; align-items: center;
}
.nodata-count { color: #fbbf24; font-size: 10px }
.dev-list { overflow-y: auto; margin-top: 4px; flex: 1 }
.group-header {
  display: flex; gap: 8px; align-items: baseline;
  padding: 5px 2px 2px; position: sticky; top: 0;
  background: #0d1b2a; z-index: 1;
}
.shift-name { font-size: 11px; color: #64b5f6; font-weight: 600 }
.type-name { font-size: 11px; color: #cbd5e1 }
.group-count { margin-left: auto; font-size: 10px; color: #f87171 }
.dev-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; margin: 2px 0; background: #112233;
  border-radius: 4px; border-left: 3px solid #334155;
}
.dev-row.failed { border-left-color: #ef4444; background: #1a1420 }
.dev-row.nodata { opacity: 0.65 }
.dev-name { font-size: 11px; color: #e0e6ed; width: 116px; white-space: nowrap }
.badge {
  font-size: 10px; padding: 1px 5px; border-radius: 3px;
  background: #0d1b2a; color: #94a3b8; display: inline-flex; gap: 3px; align-items: center;
}
.badge b { font-weight: 600; color: #cbd5e1 }
.badge.low { background: #7f1d1d55; color: #fca5a5 }
.badge.low b { color: #fca5a5 }
.badge.high { background: #78350f55; color: #fdba74 }
.badge.high b { color: #fdba74 }
.badge.nodata { color: #64748b }
.oee-val { margin-left: auto; font-size: 10px; color: #94a3b8; white-space: nowrap }
.oee-val.low { color: #f87171; font-weight: 600 }
.empty { color: #64748b; font-size: 11px; padding: 12px 0; text-align: center }
</style>
