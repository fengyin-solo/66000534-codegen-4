export interface Device {
  id: number; type: string; status: string; shift: string; position: number[]
  temperature: number; vibration: number; pressure: number
  production_count: number; fault_count: number
  uptime: number; quality_rate: number
}

export interface Anomaly {
  timestamp: number; triggers: { device_id: number; rule: string; value: number; threshold: string }[]
  device_type: string
}

export type MetricKey = 'availability' | 'performance' | 'quality'

export interface MetricCriteria {
  lower: number; upper: number; window_start: string; window_end: string
}

export interface OEECriteria {
  availability: MetricCriteria
  performance: MetricCriteria
  quality: MetricCriteria
}

export interface OEEItem {
  id: number; type: string; shift: string; oee: number | null
  availability: number | null; performance: number | null; quality: number | null
  below: MetricKey[]
}

export interface FactoryData {
  devices: Device[]
  production: number
  anomalies: Anomaly[]
  oee: OEEItem[]
  criteria: OEECriteria
}

export const METRIC_KEYS: MetricKey[] = ['availability', 'performance', 'quality']

export const METRIC_LABELS: Record<MetricKey, string> = {
  availability: '可用性', performance: '性能', quality: '质量'
}

export const SHIFT_ORDER = ['早班', '中班', '晚班']

export const DEVICE_COLORS: Record<string, string> = {
  CNC: '#e74c3c', RobotArm: '#3498db', Conveyor: '#f39c12',
  AGV: '#2ecc71', InjectionMolding: '#9b59b6', QCStation: '#1abc9c'
}

export const STATUS_COLORS: Record<string, string> = {
  RUNNING: '#2ecc71', IDLE: '#f1c40f', FAULT: '#e74c3c', OFFLINE: '#95a5a6'
}
