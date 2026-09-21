<template>
  <div class="chart-panel">
    <div class="panel-head">
      <h4>📐 OEE设备综合效率</h4>
      <el-button size="small" text type="primary" @click="openDialog">⚙ 判定口径</el-button>
    </div>
    <div ref="chart" class="chart"></div>
    <div class="criteria-brief" v-if="activeCriteria">
      当前口径:
      <span v-for="k in METRIC_KEYS" :key="k" class="brief-item">
        {{ METRIC_LABELS[k] }} {{ activeCriteria[k].lower }}~{{ activeCriteria[k].upper }}
        ({{ activeCriteria[k].window_start }}-{{ activeCriteria[k].window_end }})
      </span>
    </div>

    <el-dialog v-model="show" title="OEE 判定口径配置" width="600px" append-to-body>
      <div class="crit-form">
        <div class="crit-row crit-head">
          <span class="c-name">指标</span><span>下限</span><span>上限</span><span>观察时段起</span><span>观察时段止</span>
        </div>
        <div v-for="k in METRIC_KEYS" :key="k" class="crit-row">
          <span class="c-name">{{ METRIC_LABELS[k] }}</span>
          <el-input-number v-model="form[k].lower" :min="0" :max="100" :step="1" size="small" controls-position="right" />
          <el-input-number v-model="form[k].upper" :min="0" :max="100" :step="1" size="small" controls-position="right" />
          <el-time-picker v-model="form[k].window_start" format="HH:mm" value-format="HH:mm"
                          placeholder="开始" size="small" class="time-pick" />
          <el-time-picker v-model="form[k].window_end" format="HH:mm" value-format="HH:mm"
                          placeholder="结束" size="small" class="time-pick" />
        </div>
      </div>

      <el-alert v-if="errors.length" type="error" :closable="false" class="err-box"
                title="存在不合格项，未保存:">
        <div v-for="(e, i) in errors" :key="i" class="err-line">• {{ e }}</div>
      </el-alert>

      <div class="active-criteria" v-if="activeCriteria">
        <div class="ac-title">当前生效口径（未保存的修改不会影响判定）:</div>
        <div v-for="k in METRIC_KEYS" :key="k" class="ac-line">
          {{ METRIC_LABELS[k] }}: 下限 {{ activeCriteria[k].lower }} / 上限 {{ activeCriteria[k].upper }} /
          时段 {{ activeCriteria[k].window_start }}~{{ activeCriteria[k].window_end }}
        </div>
      </div>

      <template #footer>
        <el-button size="small" @click="show = false">取消</el-button>
        <el-button size="small" type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import axios from 'axios'
import { ElMessage } from 'element-plus'
import { useFactoryStore } from '../store/factory'
import { METRIC_KEYS, METRIC_LABELS } from '../types'
import type { OEECriteria, MetricKey } from '../types'

const store = useFactoryStore()
const chart = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null

const show = ref(false)
const saving = ref(false)
const errors = ref<string[]>([])
const form = reactive<OEECriteria>({
  availability: { lower: 0, upper: 100, window_start: '', window_end: '' },
  performance: { lower: 0, upper: 100, window_start: '', window_end: '' },
  quality: { lower: 0, upper: 100, window_start: '', window_end: '' }
})

const activeCriteria = computed(() => store.data?.criteria || null)

function cloneCriteria(c: OEECriteria): OEECriteria {
  return JSON.parse(JSON.stringify(c))
}

async function openDialog() {
  errors.value = []
  let crit = activeCriteria.value
  if (!crit) {
    try { crit = (await axios.get('/api/oee/criteria')).data.criteria } catch { /* 使用默认 */ }
  }
  if (crit) Object.assign(form, cloneCriteria(crit))
  show.value = true
}

function validateLocal(): string[] {
  const errs: string[] = []
  for (const k of METRIC_KEYS) {
    const m = form[k]; const label = METRIC_LABELS[k]
    if (m.lower === null || m.upper === null || m.lower === undefined || m.upper === undefined) {
      errs.push(`${label}: 上下限不能为空`)
    } else if (m.lower < 0 || m.lower > 100 || m.upper < 0 || m.upper > 100) {
      errs.push(`${label}: 上下限须在 0~100 之间`)
    } else if (m.lower > m.upper) {
      errs.push(`${label}: 下限 ${m.lower} 大于上限 ${m.upper}，上下限填反`)
    }
    if (!m.window_start || !m.window_end) {
      errs.push(`${label}: 观察时段不能为空`)
    } else if (m.window_start >= m.window_end) {
      errs.push(`${label}: 观察时段起止填反（${m.window_start} 须早于 ${m.window_end}）`)
    }
  }
  return errs
}

async function save() {
  errors.value = validateLocal()
  if (errors.value.length) return
  saving.value = true
  try {
    await axios.put('/api/oee/criteria', cloneCriteria(form))
    show.value = false
    ElMessage.success('判定口径已保存，全图表按新口径重算')
  } catch (e: any) {
    const detail = e?.response?.data?.detail
    errors.value = detail?.errors || ['保存失败，请稍后重试']
  } finally {
    saving.value = false
  }
}

const METRIC_COLORS: Record<MetricKey, string> = {
  availability: '#22c55e', performance: '#fbbf24', quality: '#3b82f6'
}

function update() {
  if (!inst || !store.data) return
  const oee = store.data.oee
  const crit = store.data.criteria
  const barSeries = METRIC_KEYS.map(k => ({
    type: 'bar' as const,
    name: METRIC_LABELS[k],
    barGap: 0,
    data: oee.map(d => ({
      value: d[k],
      itemStyle: { color: d.below.includes(k) ? '#ef4444' : METRIC_COLORS[k] }
    })),
    markLine: {
      silent: true, symbol: 'none', animation: false,
      data: [{ yAxis: crit[k].lower }],
      lineStyle: { color: METRIC_COLORS[k], type: 'dashed' as const, width: 1, opacity: 0.7 },
      label: { show: true, formatter: `${METRIC_LABELS[k]}下限 ${crit[k].lower}`, color: '#94a3b8', fontSize: 9, position: 'insideEndTop' as const }
    }
  }))
  inst.setOption({
    backgroundColor: 'transparent', grid: { left: 30, right: 15, top: 10, bottom: 25 },
    xAxis: { type: 'category', data: oee.map(d => d.type + '-' + d.id), axisLabel: { color: '#94a3b8', fontSize: 9, rotate: 30 } },
    yAxis: { type: 'value', max: 100, axisLabel: { color: '#94a3b8' } },
    series: [
      ...barSeries,
      {
        type: 'line', name: 'OEE', symbol: 'diamond',
        data: oee.map(d => ({
          value: d.oee,
          symbolSize: d.below.length ? 11 : 7,
          itemStyle: { color: d.below.length ? '#ef4444' : '#f87171' }
        })),
        lineStyle: { color: '#f87171', width: 2 }
      }
    ],
    animation: false, legend: { bottom: 0, textStyle: { color: '#94a3b8', fontSize: 10 } }
  })
}
onMounted(() => { if (chart.value) { inst = echarts.init(chart.value); update() } })
watch(() => store.data, update)
onUnmounted(() => inst?.dispose())
</script>

<style scoped>
.chart-panel{background:#0d1b2a;border-radius:8px;padding:12px;border:1px solid #1e3a5f}
.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.chart-panel h4{color:#64b5f6;font-size:13px}
.chart{width:100%;height:200px}
.criteria-brief{font-size:10px;color:#64748b;margin-top:4px;line-height:1.5}
.brief-item{margin-right:8px;white-space:nowrap}
.crit-form{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.crit-row{display:grid;grid-template-columns:52px 1fr 1fr 1fr 1fr;gap:8px;align-items:center}
.crit-row :deep(.el-input-number){width:100%}
.crit-head{font-size:11px;color:#94a3b8}
.c-name{font-size:12px;color:#e0e6ed;font-weight:600}
.time-pick{width:100%}
.err-box{margin-bottom:10px}
.err-line{font-size:12px}
.active-criteria{background:#112233;border:1px solid #1e3a5f;border-radius:6px;padding:8px 10px;font-size:11px;color:#94a3b8}
.ac-title{color:#64b5f6;margin-bottom:4px}
.ac-line{line-height:1.6}
</style>
