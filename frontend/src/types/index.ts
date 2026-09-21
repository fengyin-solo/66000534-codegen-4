export interface Device {
  id: number; type: string; status: string; position: number[]
  temperature: number; vibration: number; pressure: number
  production_count: number; fault_count: number
  uptime: number; quality_rate: number
}

export interface Anomaly {
  timestamp: number; triggers: { device_id: number; rule: string; value: number; threshold: string }[]
  device_type: string
}

export interface OEEItem {
  id: number; type: string; oee: number
  availability: number; performance: number; quality: number
}

export interface FactoryData {
  devices: Device[]
  production: number
  anomalies: Anomaly[]
  oee: OEEItem[]
}

export const DEVICE_COLORS: Record<string, string> = {
  CNC: '#e74c3c', RobotArm: '#3498db', Conveyor: '#f39c12',
  AGV: '#2ecc71', InjectionMolding: '#9b59b6', QCStation: '#1abc9c'
}

export const STATUS_COLORS: Record<string, string> = {
  RUNNING: '#2ecc71', IDLE: '#f1c40f', FAULT: '#e74c3c', OFFLINE: '#95a5a6'
}

export const DEVICE_TYPES = ['CNC', 'RobotArm', 'Conveyor', 'AGV', 'InjectionMolding', 'QCStation']
export const DEVICE_TYPE_LABELS: Record<string, string> = {
  CNC: '数控机床', RobotArm: '机械臂', Conveyor: '传送带',
  AGV: 'AGV 小车', InjectionMolding: '注塑机', QCStation: '质检站'
}

/* ---------- OEE 判定口径 ---------- */

export type MetricKey = 'availability' | 'performance' | 'quality'

export interface MetricCriteria {
  /** 下限（含），0-100；实际值低于下限判为不合格；null/空串表示不限 */
  lower: number | string | null
  /** 上限（含），0-100；高于上限仅提示，不判不合格 */
  upper: number | string | null
  /** 观察时段起止，HH:mm；start 必须严格早于 end */
  windowStart: string
  windowEnd: string
}

export interface OEECriteriaProfile {
  id: string
  name: string
  builtin?: boolean
  metrics: Record<MetricKey, MetricCriteria>
}

export interface OEESample {
  /** 分钟级时间序号（当日 00:00 起，单位分钟） */
  minute: number
  ts: number
  /** 该分钟内运行秒数（0-60） */
  running: number
  /** 该分钟产出 */
  output: number
  /** 该分钟平均合格率（0-1） */
  quality: number
}

export type MetricStatus = 'nodata' | 'low' | 'high' | 'ok'

export interface EvaluatedDevice {
  id: number
  type: string
  shift: string
  availability: number | null
  performance: number | null
  quality: number | null
  oee: number | null
  statuses: Record<MetricKey, MetricStatus>
  /** 不合格指标（低于下限） */
  failed: MetricKey[]
  /** 高于上限的指标 */
  exceeded: MetricKey[]
  noData: MetricKey[]
}
