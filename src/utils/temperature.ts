import type { BackfillRecord, PendingReading, TemperaturePoint } from '../types'

/** 解析 UTC+8 / UTC-5:30 / +08:00 等时区写法，返回相对UTC的分钟偏移 */
export function parseTimezone(tz: string): number | null {
  const match = /^\s*(?:UTC)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?\s*$/i.exec(tz)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3] ?? 0)
  if (hours > 14 || minutes > 59) return null
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes)
}

/** 把机场当地时间按记录时区统一为UTC时刻（分钟精度），非法输入返回null */
export function normalizeTimestamp(localTime: string, timezone: string): string | null {
  const offset = parseTimezone(timezone)
  const text = localTime.trim().replace(' ', 'T')
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (!match || offset === null) return null
  const [, y, mo, d, h, mi, s] = match
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)) - offset * 60000
  const date = new Date(utc)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 16) + ':00.000Z'
}

/** 解析补传文本，每行一条：当地时间, 时区, 温度, 来源(设备/人工)。任一行非法则整段失败 */
export function parseBackfillLines(text: string): { records: BackfillRecord[]; errors: string[] } {
  const records: BackfillRecord[] = []
  const errors: string[] = []
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  lines.forEach((line, index) => {
    const parts = line.split(/[,，]/).map((part) => part.trim())
    const row = `第${index + 1}行`
    if (parts.length < 3 || parts.length > 4) { errors.push(`${row}：格式应为「当地时间, 时区, 温度, 来源(可选)」`); return }
    const [localTime, timezone, rawValue, rawSource] = parts
    const value = Number(rawValue)
    if (!normalizeTimestamp(localTime, timezone)) { errors.push(`${row}：无法识别的当地时间或时区（${localTime} ${timezone}）`); return }
    if (!Number.isFinite(value) || value < -80 || value > 100) { errors.push(`${row}：温度值非法（${rawValue}）`); return }
    const source = rawSource ? (rawSource === '设备' || rawSource === '人工' ? rawSource : null) : '设备'
    if (!source) { errors.push(`${row}：来源只能是「设备」或「人工」（${rawSource}）`); return }
    records.push({ localTime, timezone, value: Math.round(value * 10) / 10, source })
  })
  return { records, errors }
}

export interface MergeStats {
  added: number
  duplicates: number
  pending: number
}

export interface MergeResult {
  points: TemperaturePoint[]
  pending: PendingReading[]
  stats: MergeStats
}

/**
 * 把补传记录合并进航段温度点：
 * 统一时刻后按时刻去重，重复补传不重复建点；同时刻保留设备读数，人工值另存待复核。
 */
export function mergeBackfill(
  existing: TemperaturePoint[],
  records: BackfillRecord[],
  segmentId: string,
  submittedBy: string,
  makeId: (prefix: string) => string
): MergeResult {
  const points = [...existing]
  const pending: PendingReading[] = []
  const stats: MergeStats = { added: 0, duplicates: 0, pending: 0 }
  const byTime = new Map(points.map((point) => [point.time, point]))
  const submittedAt = new Date().toISOString()
  for (const record of records) {
    const time = normalizeTimestamp(record.localTime, record.timezone)
    if (!time) continue
    const hit = byTime.get(time)
    if (record.source === '设备') {
      if (hit) { stats.duplicates += 1; continue }
      const point: TemperaturePoint = { id: makeId('T'), time, value: record.value, source: '设备' }
      points.push(point)
      byTime.set(time, point)
      stats.added += 1
      continue
    }
    // 人工补录一律另存待复核，不直接落进航段曲线
    pending.push({
      id: makeId('PR'), segmentId, localTime: record.localTime, timezone: record.timezone, time, value: record.value,
      reason: hit ? '与设备读数冲突' : '无设备读数', deviceValue: hit?.value,
      status: '待复核', submittedBy, submittedAt
    })
    stats.pending += 1
  }
  points.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  return { points, pending, stats }
}

export interface ExcursionWindow {
  start: string
  end: string
  points: number
  minValue: number
  maxValue: number
}

/** 按统一时刻排序后重算连续超限窗口 */
export function computeExcursions(points: TemperaturePoint[], min: number, max: number): ExcursionWindow[] {
  const sorted = [...points].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  const windows: ExcursionWindow[] = []
  let current: ExcursionWindow | null = null
  for (const point of sorted) {
    const out = point.value < min || point.value > max
    if (out && current) {
      current.end = point.time
      current.points += 1
      current.minValue = Math.min(current.minValue, point.value)
      current.maxValue = Math.max(current.maxValue, point.value)
    } else if (out) {
      current = { start: point.time, end: point.time, points: 1, minValue: point.value, maxValue: point.value }
      windows.push(current)
    } else {
      current = null
    }
  }
  return windows
}

export function formatTime(time: string): string {
  return time.includes('Z') ? time.replace('T', ' ').slice(0, 16) + 'Z' : time.replace('T', ' ').slice(0, 16)
}
