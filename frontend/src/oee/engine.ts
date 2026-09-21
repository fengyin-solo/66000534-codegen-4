import type {
  MetricKey, MetricCriteria, OEECriteriaProfile,
  OEESample, EvaluatedDevice, MetricStatus,
} from '@/types'

/** 理想节拍：后端 calculate_oee 以 uptime/2 作为理论产出，即每秒 0.5 件 */
export const IDEAL_OUTPUT_PER_SECOND = 0.5
const SECONDS_PER_MINUTE = 60

export const OEE_METRIC_KEYS: MetricKey[] = ['availability', 'performance', 'quality']

export const OEE_METRIC_META: Record<MetricKey, { label: string; short: string; color: string }> = {
  availability: { label: '可用性', short: '可', color: '#22c55e' },
  performance: { label: '性能', short: '性', color: '#fbbf24' },
  quality: { label: '质量', short: '质', color: '#3b82f6' },
}

/* ---------- 班次 ---------- */

export interface ShiftDef { id: string; label: string; start: string; end: string }

export const SHIFTS: ShiftDef[] = [
  { id: 'day', label: '早班 08:00-16:00', start: '08:00', end: '16:00' },
  { id: 'swing', label: '中班 16:00-24:00', start: '16:00', end: '23:59' },
  { id: 'night', label: '夜班 00:00-08:00', start: '00:00', end: '08:00' },
]

/** 设备按 id 固定分配班次，保证分组排列稳定 */
export function shiftOf(deviceId: number): ShiftDef {
  return SHIFTS[(deviceId - 1) % SHIFTS.length]
}

/* ---------- 时段 ---------- */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseTime(t: string): number | null {
  const m = TIME_RE.exec((t ?? '').trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function windowContains(c: MetricCriteria, minute: number): boolean {
  const s = parseTime(c.windowStart)
  const e = parseTime(c.windowEnd)
  if (s === null || e === null || s >= e) return false
  return minute >= s && minute <= e
}

/* ---------- 口径校验（保存守卫） ---------- */

export type FieldError = Record<string, string>

export interface ValidationResult {
  ok: boolean
  errors: FieldError
  /** 不合格项（人类可读），例如 “性能：下限 95 高于上限 90” */
  problems: string[]
}

function boundError(c: MetricCriteria, label: MetricKey, errs: FieldError, problems: string[]) {
  // 空字符串/undefined 视为“不限”，其余强制数值
  const l = normalizeBound(c.lower)
  const u = normalizeBound(c.upper)
  if (l !== null && (Number.isNaN(l) || l < 0 || l > 100)) {
    errs[`${label}.lower`] = '下限需在 0-100 之间（留空表示不限）'
    problems.push(`${OEE_METRIC_META[label].label}：下限 ${c.lower} 越界（允许范围 0-100）`)
  }
  if (u !== null && (Number.isNaN(u) || u < 0 || u > 100)) {
    errs[`${label}.upper`] = '上限需在 0-100 之间（留空表示不限）'
    problems.push(`${OEE_METRIC_META[label].label}：上限 ${c.upper} 越界（允许范围 0-100）`)
  }
  if (l !== null && u !== null && l > u) {
    errs[`${label}.lower`] = '下限不能高于上限'
    errs[`${label}.upper`] = '上限不能低于下限'
    problems.push(`${OEE_METRIC_META[label].label}：下限 ${l}% 高于上限 ${u}%`)
  }
}

/** 限值归一化：空/空串 => null（不限），数字串 => 数字，非法值 => NaN */
export function normalizeBound(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : NaN
}

export function validateProfile(p: { name?: string; metrics: Record<MetricKey, MetricCriteria> }): ValidationResult {
  const errors: FieldError = {}
  const problems: string[] = []

  if (!(p.name ?? '').trim()) {
    errors.name = '口径名称不能为空'
    problems.push('口径名称为空')
  }

  for (const key of OEE_METRIC_KEYS) {
    const c = p.metrics[key]
    const meta = OEE_METRIC_META[key]
    if (!c) {
      errors[`${key}.lower`] = '配置缺失'
      problems.push(`${meta.label}：配置缺失`)
      continue
    }

    if (!c.windowStart || !c.windowEnd) {
      if (!c.windowStart) { errors[`${key}.windowStart`] = '起始时间不能为空'; }
      if (!c.windowEnd) { errors[`${key}.windowEnd`] = '结束时间不能为空'; }
      problems.push(`${meta.label}：观察时段${!c.windowStart ? '起始' : ''}${!c.windowEnd ? '结束' : ''}时间为空`)
    } else {
      const s = parseTime(c.windowStart)
      const e = parseTime(c.windowEnd)
      if (s === null) {
        errors[`${key}.windowStart`] = '时间格式应为 HH:mm（00:00-23:59）'
        problems.push(`${meta.label}：起始时间「${c.windowStart}」越界，合法范围 00:00-23:59`)
      }
      if (e === null) {
        errors[`${key}.windowEnd`] = '时间格式应为 HH:mm（00:00-23:59）'
        problems.push(`${meta.label}：结束时间「${c.windowEnd}」越界，合法范围 00:00-23:59`)
      }
      if (s !== null && e !== null && s >= e) {
        errors[`${key}.windowStart`] = '起始时间必须早于结束时间'
        errors[`${key}.windowEnd`] = '结束时间必须晚于起始时间'
        problems.push(`${meta.label}：观察时段起止填反（${c.windowStart} ≥ ${c.windowEnd}）`)
      }
    }

    boundError(c, key, errors, problems)
  }

  return { ok: problems.length === 0, errors, problems }
}

/* ---------- 统一求值（图表、曲线、列表共用同一份定义） ---------- */

function statusOf(value: number | null, c: MetricCriteria): MetricStatus {
  if (value === null) return 'nodata'
  const l = normalizeBound(c.lower)
  const u = normalizeBound(c.upper)
  if (l !== null && !Number.isNaN(l) && value < l) return 'low'
  if (u !== null && !Number.isNaN(u) && value > u) return 'high'
  return 'ok'
}

export function evaluateDevice(
  deviceId: number,
  deviceType: string,
  samples: OEESample[],
  profile: OEECriteriaProfile,
): EvaluatedDevice {
  const buckets: Record<MetricKey, { n: number; running: number; output: number; qsum: number }> = {
    availability: { n: 0, running: 0, output: 0, qsum: 0 },
    performance: { n: 0, running: 0, output: 0, qsum: 0 },
    quality: { n: 0, running: 0, output: 0, qsum: 0 },
  }
  for (const s of samples) {
    for (const key of OEE_METRIC_KEYS) {
      if (windowContains(profile.metrics[key], s.minute)) {
        const b = buckets[key]
        b.n += 1
        b.running += s.running
        b.output += s.output
        b.qsum += s.quality
      }
    }
  }

  const values = {} as Record<MetricKey, number | null>
  for (const key of OEE_METRIC_KEYS) {
    const b = buckets[key]
    if (b.n === 0) { values[key] = null; continue }
    if (key === 'availability') {
      values[key] = round1((b.running / (b.n * SECONDS_PER_MINUTE)) * 100)
    } else if (key === 'performance') {
      const ideal = b.running * IDEAL_OUTPUT_PER_SECOND
      values[key] = round1(Math.min(100, (b.output / Math.max(1, ideal)) * 100))
    } else {
      values[key] = round1((b.qsum / b.n) * 100)
    }
  }

  const statuses = {} as Record<MetricKey, MetricStatus>
  const failed: MetricKey[] = []
  const exceeded: MetricKey[] = []
  const noData: MetricKey[] = []
  for (const key of OEE_METRIC_KEYS) {
    const st = statusOf(values[key], profile.metrics[key])
    statuses[key] = st
    if (st === 'low') failed.push(key)
    else if (st === 'high') exceeded.push(key)
    else if (st === 'nodata') noData.push(key)
  }

  const oee = (values.availability !== null && values.performance !== null && values.quality !== null)
    ? round1(values.availability * values.performance * values.quality / 10000)
    : null

  return {
    id: deviceId,
    type: deviceType,
    shift: shiftOf(deviceId).id,
    availability: values.availability,
    performance: values.performance,
    quality: values.quality,
    oee,
    statuses,
    failed,
    exceeded,
    noData,
  }
}

/** 同一份定义的批量求值；设备顺序固定为 id 升序，柱状图与曲线共用 */
export function evaluateAll(
  devices: { id: number; type: string }[],
  samplesByDevice: Map<number, OEESample[]>,
  profile: OEECriteriaProfile,
): EvaluatedDevice[] {
  return devices
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(d => evaluateDevice(d.id, d.type, samplesByDevice.get(d.id) ?? [], profile))
}

/* ---------- 口径文案 ---------- */

function fmtBound(v: number | string | null): string {
  const n = normalizeBound(v)
  return n === null || Number.isNaN(n) ? '不限' : `${n}%`
}

export function describeMetric(key: MetricKey, c: MetricCriteria): string {
  return `${OEE_METRIC_META[key].label} ${fmtBound(c.lower)}~${fmtBound(c.upper)}，时段 ${c.windowStart}-${c.windowEnd}`
}

export function describeProfile(p: OEECriteriaProfile): string {
  return OEE_METRIC_KEYS.map(k => describeMetric(k, p.metrics[k])).join('；')
}

function round1(v: number): number { return Math.round(v * 10) / 10 }
