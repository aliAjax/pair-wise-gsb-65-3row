import type { ExcursionWindow, ShipmentSegment, TemperaturePoint } from '../types'

export interface BackfillReading {
  localTime: string
  offset: string
  value: number
  source: '设备' | '人工'
  enteredBy?: string
}

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/
const OFFSET_PATTERN = /^([+-])(\d{2}):?(\d{2})$/

// 补传先统一时刻：机场当地时间 + UTC偏移 → 统一的UTC时刻（不带时区后缀的规范格式）
export function normalizeToCanonical(localTime: string, offset: string): string | null {
  const time = LOCAL_PATTERN.exec(localTime.trim())
  const zone = OFFSET_PATTERN.exec(offset.trim())
  if (!time || !zone) return null
  const [, year, month, day, hour, minute, second = '00'] = time
  const sign = zone[1] === '+' ? 1 : -1
  const offsetMs = sign * (Number(zone[2]) * 60 + Number(zone[3])) * 60000
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - offsetMs
  return new Date(utc).toISOString().slice(0, 19)
}

// 既有温度点视为规范时刻（UTC），带时区后缀的先换算再比较
export function canonicalKey(time: string): string {
  const hasZone = time.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(time)
  const parsed = Date.parse(hasZone ? time : `${time}Z`)
  return Number.isNaN(parsed) ? time : new Date(parsed).toISOString().slice(0, 19)
}

// 超限窗口：连续超出允许范围的原始点聚合成窗口，设备记录更新后重算
export function computeExcursions(points: TemperaturePoint[], min: number, max: number): ExcursionWindow[] {
  const sorted = [...points].sort((a, b) => (a.time < b.time ? -1 : 1))
  const windows: ExcursionWindow[] = []
  let current: TemperaturePoint[] = []
  const flush = () => {
    if (!current.length) return
    const values = current.map((item) => item.value)
    const peakUp = Math.max(...values) - max
    const peakDown = min - Math.min(...values)
    const direction: ExcursionWindow['direction'] = peakUp >= peakDown ? '高超限' : '低超限'
    windows.push({
      id: `EXC-${windows.length + 1}`,
      start: current[0].time,
      end: current[current.length - 1].time,
      direction,
      peak: Math.round((direction === '高超限' ? peakUp : peakDown) * 10) / 10,
      points: current.length
    })
    current = []
  }
  for (const point of sorted) {
    if (point.value < min || point.value > max) current.push(point)
    else flush()
  }
  flush()
  return windows
}

const shiftMinutes = (time: string, minutes: number) => new Date(Date.parse(`${time}Z`) + minutes * 60000).toISOString().slice(0, 19)
const asLocal = (time: string, offsetHours: number) => new Date(Date.parse(`${time}Z`) + offsetHours * 3600000).toISOString().slice(0, 16).replace('T', ' ')
const round1 = (value: number) => Math.round(value * 10) / 10

// 模拟记录仪离线缓存的补传批次：含跨时区重复时刻、离线新点与冲突的人工补录
export function buildBackfillBatch(segment: ShipmentSegment, tempMin: number, tempMax: number): BackfillReading[] {
  const sorted = [...segment.temperature].sort((a, b) => (a.time < b.time ? -1 : 1))
  if (!sorted.length) return []
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const gap = shiftMinutes(first.time, 15)
  const cached1 = shiftMinutes(last.time, 15)
  const cached2 = shiftMinutes(last.time, 30)
  const cached3 = shiftMinutes(last.time, 45)
  return [
    { localTime: asLocal(first.time, 8), offset: '+08:00', value: first.value, source: '设备' },
    { localTime: asLocal(last.time, 9), offset: '+09:00', value: last.value, source: '设备' },
    { localTime: asLocal(cached1, 9), offset: '+09:00', value: round1(last.value + 0.2), source: '设备' },
    { localTime: asLocal(cached2, 9), offset: '+09:00', value: round1(tempMax + 0.6), source: '设备' },
    { localTime: asLocal(cached3, 9), offset: '+09:00', value: round1(tempMax - 0.8), source: '设备' },
    { localTime: asLocal(cached2, 9), offset: '+09:00', value: round1(tempMax + 1.4), source: '人工', enteredBy: '站台复核员' },
    { localTime: asLocal(gap, 8), offset: '+08:00', value: round1(first.value + 0.5), source: '人工', enteredBy: '站台复核员' }
  ]
}
