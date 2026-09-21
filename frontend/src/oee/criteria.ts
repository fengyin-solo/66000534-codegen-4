import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { MetricCriteria, OEECriteriaProfile, OEESample } from '@/types'
import { useFactoryStore } from '@/store/factory'
import { evaluateAll } from './engine'

const STORAGE_KEY = 'oee-criteria-v1'
const SAMPLE_LIMIT_PER_DEVICE = 2600

/* ---------- 内置默认口径 ---------- */

function metric(lower: number | null, upper: number | null, ws: string, we: string): MetricCriteria {
  return { lower, upper, windowStart: ws, windowEnd: we }
}

function builtinProfiles(): OEECriteriaProfile[] {
  return [
    {
      id: 'std', name: '标准口径（全天）', builtin: true,
      metrics: {
        availability: metric(85, 100, '00:00', '23:59'),
        performance: metric(80, 100, '00:00', '23:59'),
        quality: metric(95, 100, '00:00', '23:59'),
      },
    },
    {
      id: 'day', name: '早班严口径（08-16）', builtin: true,
      metrics: {
        availability: metric(90, 100, '08:00', '16:00'),
        performance: metric(90, 100, '08:00', '16:00'),
        quality: metric(97, 100, '08:00', '16:00'),
      },
    },
    {
      id: 'night', name: '夜班宽口径（00-08）', builtin: true,
      metrics: {
        availability: metric(70, 100, '00:00', '08:00'),
        performance: metric(65, 100, '00:00', '08:00'),
        quality: metric(90, 100, '00:00', '08:00'),
      },
    },
  ]
}

/* ---------- 可复现的伪随机（补齐当日历史采样） ---------- */

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function gauss(rand: () => number): number {
  let u = 0, v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

interface DeviceBaseline {
  runRate: number; outRate: number; quality: number
}

function baselineOf(id: number): DeviceBaseline {
  const rand = mulberry32(id * 7919 + 13)
  return {
    runRate: 0.72 + rand() * 0.26,
    outRate: 0.82 + rand() * 0.3,
    quality: 0.935 + rand() * 0.055,
  }
}

function seedHistory(deviceIds: { id: number; type: string }[]): Map<number, OEESample[]> {
  const now = new Date()
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const currentMinute = now.getHours() * 60 + now.getMinutes()
  const map = new Map<number, OEESample[]>()

  for (const dev of deviceIds) {
    const rand = mulberry32(dev.id * 104729 + 7)
    const base = baselineOf(dev.id)
    const samples: OEESample[] = []
    for (let m = 0; m < currentMinute; m++) {
      // 少量设备在夜班窗口停机，制造时段差异，便于演示切换口径
      const isNight = m < 8 * 60
      const nightDown = isNight && dev.id % 4 === 0 && rand() < 0.75
      let runRate = base.runRate + gauss(rand) * 0.06
      if (nightDown) runRate *= 0.15
      runRate = Math.max(0.2, Math.min(1, runRate))
      const runSec = Math.round(runRate * 60)
      const output = Math.max(0, Math.round(30 * runRate * base.outRate + gauss(rand) * 2))
      const quality = Math.max(0.85, Math.min(1, base.quality + gauss(rand) * 0.006))
      samples.push({ minute: m, ts: midnight + m * 60_000, running: runSec, output, quality })
    }
    map.set(dev.id, samples)
  }
  return map
}

/* ---------- store ---------- */

export const useOEEStore = defineStore('oeeCriteria', () => {
  const profiles = ref<OEECriteriaProfile[]>(loadProfiles())
  const activeId = ref<string>(loadActiveId(profiles.value))
  const samples = shallowRef<Map<number, OEESample[]>>(new Map())
  /** 每次实时采样自增，驱动图表/曲线重算 */
  const tick = ref(0)

  const activeProfile = computed<OEECriteriaProfile>(
    () => profiles.value.find(p => p.id === activeId.value) ?? profiles.value[0],
  )

  const factory = useFactoryStore()

  // 实时数据采样：秒级快照按分钟桶聚合
  const prevProd = new Map<number, number>()
  const liveBucket = new Map<number, OEESample>()
  let lastMinute = -1
  let seeded = false

  const stopWatchData = watch(
    () => factory.data,
    (data) => {
      if (!data || !data.devices.length) return

      if (!seeded) {
        samples.value = seedHistory(data.devices.map(d => ({ id: d.id, type: d.type })))
        liveBucket.clear()
        lastMinute = -1
        seeded = true
      }

      const now = new Date()
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const minute = now.getHours() * 60 + now.getMinutes()
      if (minute !== lastMinute) {
        // 跨日：清空昨日样本，观察时段重新从当日 00:00 累积
        if (lastMinute > 0 && minute === 0) {
          samples.value = new Map()
          liveBucket.clear()
          prevProd.clear()
        }
        // 新的一分钟：历史补齐若已包含当前分钟则不重复入桶
        for (const dev of data.devices) {
          const list = samples.value.get(dev.id)
          if (list && list.length && list[list.length - 1].minute === minute) {
            liveBucket.delete(dev.id)
          }
        }
        lastMinute = minute
      }

      const map = samples.value

      for (const dev of data.devices) {
        const prev = prevProd.get(dev.id)
        const delta = prev === undefined ? 0 : Math.max(0, dev.production_count - prev)
        prevProd.set(dev.id, dev.production_count)

        const b = liveBucket.get(dev.id)
        if (!b || b.minute !== minute) {
          liveBucket.set(dev.id, {
            minute, ts: midnight + minute * 60_000,
            running: 0, output: 0, quality: 0,
          })
        }
        const bucket = liveBucket.get(dev.id)!
        if (dev.status === 'RUNNING') bucket.running = Math.min(60, bucket.running + 1)
        bucket.output += delta
        // 质量取设备实时合格率（与其他图表同源），滑动平均平滑秒级抖动
        bucket.quality = bucket.quality === 0
          ? dev.quality_rate
          : bucket.quality * 0.8 + dev.quality_rate * 0.2
      }

      // 将当前分钟桶写入样本表（覆盖更新，保证落点随实时数据重算）
      let changed = false
      for (const dev of data.devices) {
        const bucket = liveBucket.get(dev.id)
        if (!bucket) continue
        let list = map.get(dev.id)
        if (!list) { list = []; map.set(dev.id, list) }
        const last = list[list.length - 1]
        if (last && last.minute === bucket.minute) {
          list[list.length - 1] = { ...bucket }
        } else {
          list.push({ ...bucket })
          if (list.length > SAMPLE_LIMIT_PER_DEVICE) list.splice(0, list.length - SAMPLE_LIMIT_PER_DEVICE)
        }
        changed = true
      }
      if (changed) {
        samples.value = new Map(map)
        tick.value++
      }
    },
  )

  /** 统一求值入口：柱状图、OEE 曲线、不合格列表全部来自这里 */
  const evaluated = computed(() => {
    void tick.value
    const devices = factory.data?.devices.map(d => ({ id: d.id, type: d.type })) ?? []
    if (!devices.length || !samples.value.size) return []
    return evaluateAll(devices, samples.value, activeProfile.value)
  })

  const failedDevices = computed(() => evaluated.value.filter(d => d.failed.length > 0))

  function setActive(id: string) {
    if (profiles.value.some(p => p.id === id)) {
      activeId.value = id
      persist()
    }
  }

  function upsertProfile(profile: OEECriteriaProfile) {
    const i = profiles.value.findIndex(p => p.id === profile.id)
    if (i >= 0) profiles.value[i] = profile
    else profiles.value.push(profile)
    activeId.value = profile.id
    persist()
  }

  function removeProfile(id: string) {
    const p = profiles.value.find(x => x.id === id)
    if (!p || p.builtin || profiles.value.length <= 1) return
    profiles.value = profiles.value.filter(x => x.id !== id)
    if (activeId.value === id) activeId.value = profiles.value[0].id
    persist()
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        activeId: activeId.value,
        custom: profiles.value.filter(p => !p.builtin),
      }))
    } catch { /* localStorage 不可用时仅内存生效 */ }
  }

  function loadProfiles(): OEECriteriaProfile[] {
    const builtin = builtinProfiles()
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return builtin
      const saved = JSON.parse(raw)
      const customs: OEECriteriaProfile[] = Array.isArray(saved?.custom) ? saved.custom : []
      return [...builtin, ...customs.filter(isValidProfileShape)]
    } catch {
      return builtin
    }
  }

  function loadActiveId(list: OEECriteriaProfile[]): string {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const saved = JSON.parse(raw)
        if (list.some(p => p.id === saved?.activeId)) return saved.activeId
      }
    } catch { /* ignore */ }
    return list[0].id
  }

  function isValidProfileShape(p: any): p is OEECriteriaProfile {
    return p && typeof p.id === 'string' && typeof p.name === 'string'
      && p.metrics && ['availability', 'performance', 'quality'].every((k: string) => p.metrics[k])
  }

  function dispose() {
    stopWatchData()
  }

  return {
    profiles, activeId, activeProfile, tick, evaluated, failedDevices,
    setActive, upsertProfile, removeProfile, dispose,
  }
})
