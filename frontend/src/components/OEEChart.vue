<template>
  <div class="chart-wrap"><div ref="chart" class="chart"></div></div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import { useOEEStore } from '../oee/criteria'
import { OEE_METRIC_KEYS, OEE_METRIC_META } from '../oee/engine'
import type { EvaluatedDevice, MetricKey } from '../types'

const store = useOEEStore()
const chart = ref<HTMLDivElement>()
let inst: echarts.ECharts | null = null

const HIGHLIGHT = '#ef4444'
const EXCEED = '#fb923c'

function barColor(d: EvaluatedDevice, key: MetricKey) {
  const st = d.statuses[key]
  if (st === 'low') return HIGHLIGHT
  if (st === 'high') return EXCEED
  return OEE_METRIC_META[key].color
}

function lowerLine(key: MetricKey) {
  const v = store.activeProfile.metrics[key].lower
  if (v === null) return []
  // 三条线同图，标签纵向错开避免重叠
  const xOffset = { availability: 0, performance: -46, quality: -92 }[key]
  return [{
    yAxis: v,
    lineStyle: { color: HIGHLIGHT, type: 'dashed' as const, width: 1 },
    label: {
      formatter: `${OEE_METRIC_META[key].short}${v}%`,
      color: HIGHLIGHT, fontSize: 9,
      position: 'insideEndTop' as const,
      distance: [xOffset, 0],
    },
  }]
}

function update() {
  if (!inst) return
  const list = store.evaluated
  if (!list.length) return
  const cats = list.map(d => d.type + '-' + d.id)

  const barSeries = OEE_METRIC_KEYS.map(key => ({
    type: 'bar' as const,
    name: OEE_METRIC_META[key].label,
    barGap: '0%',
    data: list.map(d => ({
      value: d[key],
      itemStyle: { color: barColor(d, key) },
    })),
    markLine: { symbol: 'none', silent: true, data: lowerLine(key), animation: false },
  }))

  const lineSeries = {
    type: 'line' as const,
    name: 'OEE',
    symbol: 'diamond',
    symbolSize: 7,
    data: list.map(d => ({
      value: d.oee,
      itemStyle: d.failed.length ? { color: HIGHLIGHT, borderColor: '#fff', borderWidth: 1 } : { color: '#f87171' },
    })),
    lineStyle: { color: '#f87171', width: 2 },
    itemStyle: { color: '#f87171' },
  }

  inst.setOption({
    backgroundColor: 'transparent',
    grid: { left: 32, right: 15, top: 28, bottom: 28 },
    tooltip: { trigger: 'axis', backgroundColor: '#0d1b2a', borderColor: '#1e3a5f', textStyle: { color: '#e0e6ed', fontSize: 11 } },
    xAxis: { type: 'category', data: cats, axisLabel: { color: '#94a3b8', fontSize: 9, rotate: 30 } },
    yAxis: { type: 'value', max: 100, axisLabel: { color: '#94a3b8' } },
    series: [...barSeries, lineSeries],
    animation: false,
    legend: {
      top: 0, textStyle: { color: '#94a3b8', fontSize: 10 },
      data: [...OEE_METRIC_KEYS.map(k => OEE_METRIC_META[k].label), 'OEE'],
    },
  }, { notMerge: true })
}

onMounted(() => { if (chart.value) { inst = echarts.init(chart.value); update() } })
watch(() => [store.evaluated, store.activeId], update, { deep: false })
onUnmounted(() => inst?.dispose())
</script>

<style scoped>
.chart-wrap { width: 100% }
.chart { width: 100%; height: 230px }
</style>
