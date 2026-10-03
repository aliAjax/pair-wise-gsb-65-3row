import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedAudit, seedDeviations, seedShipments } from '../data/seed'
import type { AuditEntry, BackfillRecord, Deviation, EvidenceFile, Shipment, ShipmentStatus, TemperaturePoint } from '../types'
import { computeExcursions, mergeBackfill } from '../utils/temperature'
import { getReleaseBlockers } from '../utils/release'

interface ImportResult {
  ok: boolean
  message: string
  stats?: { added: number; duplicates: number; pending: number }
}

interface ShipmentState {
  shipments: Shipment[]
  deviations: Deviation[]
  audit: AuditEntry[]
  keyword: string
  status: ShipmentStatus | '全部'
  setKeyword: (value: string) => void
  setStatus: (value: ShipmentStatus | '全部') => void
  addEvidence: (shipmentId: string, evidence: Omit<EvidenceFile, 'id' | 'version' | 'uploadedAt'>) => void
  verifyEvidence: (shipmentId: string, evidenceId: string) => void
  sign: (shipmentId: string, role: string, comment: string, status: '已签' | '已退回') => { ok: boolean; message: string }
  createDeviation: (shipmentId: string, segmentId: string, title: string, severity: '一般' | '重大') => void
  saveInvestigation: (id: string, patch: Partial<Deviation>) => void
  reviewDeviation: (id: string, disposition: Deviation['disposition'], note: string) => { ok: boolean; message: string }
  setShipmentStatus: (id: string, status: ShipmentStatus) => { ok: boolean; message: string }
  importBackfill: (shipmentId: string, segmentId: string, records: BackfillRecord[]) => ImportResult
  resolvePendingReading: (shipmentId: string, readingId: string, decision: '采纳' | '作废') => { ok: boolean; message: string }
  reset: () => void
}

let idSeed = 10
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`

export const useShipmentStore = create<ShipmentState>()(persist((set, get) => ({
  shipments: seedShipments,
  deviations: seedDeviations,
  audit: seedAudit,
  keyword: '',
  status: '全部',
  setKeyword: (keyword) => set({ keyword }),
  setStatus: (status) => set({ status }),
  addEvidence: (shipmentId, evidence) => set((state) => {
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    if (!shipment) return state
    const sameCount = shipment.evidence.filter((item) => item.category === evidence.category).length
    shipment.evidence.unshift({ ...evidence, id: nextId('E'), version: sameCount + 1, uploadedAt: new Date().toISOString() })
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    return { shipments: [...state.shipments], audit: [makeAudit(shipmentId, '上传证据版本', evidence.uploadedBy, `${evidence.name} 版本${sameCount + 1}`), ...state.audit] }
  }),
  verifyEvidence: (shipmentId, evidenceId) => set((state) => {
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    const evidence = shipment?.evidence.find((item) => item.id === evidenceId)
    if (!shipment || !evidence) return state
    evidence.verified = true
    shipment.version += 1
    return { shipments: [...state.shipments], audit: [makeAudit(shipmentId, '核验证据', '当前用户', evidence.name), ...state.audit] }
  }),
  sign: (shipmentId, role, comment, status) => {
    const shipment = get().shipments.find((item) => item.id === shipmentId)
    const signature = shipment?.signatures.find((item) => item.role === role)
    if (!shipment || !signature) return { ok: false, message: '签收角色不存在' }
    if (status === '已退回' && !comment.trim()) return { ok: false, message: '退回必须填写原因' }
    signature.status = status
    signature.comment = comment
    signature.signedAt = new Date().toISOString()
    shipment.version += 1
    shipment.updatedAt = signature.signedAt
    set((state) => ({ shipments: [...state.shipments], audit: [makeAudit(shipmentId, `${role}${status}`, signature.name, comment || '签署确认'), ...state.audit] }))
    return { ok: true, message: status === '已签' ? '签收成功' : '已退回并要求补充材料' }
  },
  createDeviation: (shipmentId, segmentId, title, severity) => set((state) => {
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    if (!shipment) return state
    const now = new Date().toISOString()
    const deviation: Deviation = {
      id: nextId('TDEV'), shipmentId, segmentId, title, source: '人工报告', severity, status: '待调查', owner: '温控质量组', openedAt: now,
      dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), cause: '', assessment: '', disposition: '补充处理', correctiveAction: '', evidence: '', reviewer: '', reviewNote: '', version: 1
    }
    shipment.status = '待放行'
    shipment.version += 1
    return { deviations: [deviation, ...state.deviations], shipments: [...state.shipments], audit: [makeAudit(shipmentId, '登记温度偏差', '当前用户', title), ...state.audit] }
  }),
  saveInvestigation: (id, patch) => set((state) => {
    const deviation = state.deviations.find((item) => item.id === id)
    if (!deviation || !patch.cause?.trim() || !patch.assessment?.trim()) return state
    const wasRecheck = deviation.recheckRequired
    Object.assign(deviation, patch, { status: '待放行复核', recheckRequired: false, version: deviation.version + 1 })
    return { deviations: [...state.deviations], audit: [makeAudit(deviation.shipmentId, wasRecheck ? '偏差重新确认并提交复核' : '提交偏差调查', deviation.owner, deviation.assessment), ...state.audit] }
  }),
  reviewDeviation: (id, disposition, note) => {
    const deviation = get().deviations.find((item) => item.id === id)
    if (!deviation) return { ok: false, message: '偏差不存在' }
    if (deviation.recheckRequired) return { ok: false, message: '设备记录已更新，请先重新确认调查结论再复核' }
    if (disposition === '拒绝' && !note.trim()) return { ok: false, message: '拒绝放行必须填写理由' }
    deviation.disposition = disposition
    deviation.reviewer = '放行人员 顾言'
    deviation.reviewNote = note
    deviation.status = '已关闭'
    deviation.version += 1
    const shipment = get().shipments.find((item) => item.id === deviation.shipmentId)
    if (shipment) shipment.status = disposition === '拒绝' ? '已拒绝' : '待放行'
    set((state) => ({ deviations: [...state.deviations], shipments: [...state.shipments], audit: [makeAudit(deviation.shipmentId, `偏差复核：${disposition}`, deviation.reviewer, note), ...state.audit] }))
    return { ok: true, message: `已执行${disposition}` }
  },
  setShipmentStatus: (id, status) => {
    const state = get()
    const shipment = state.shipments.find((item) => item.id === id)
    if (!shipment) return { ok: false, message: '运输任务不存在' }
    if (status === '已放行') {
      const blockers = getReleaseBlockers(shipment, state.deviations)
      if (blockers.length > 0) return { ok: false, message: `不能放行：${blockers[0]}` }
    }
    shipment.status = status
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    set((current) => ({ shipments: [...current.shipments], audit: [makeAudit(id, `状态流转：${status}`, '当前用户', '放行工作台操作'), ...current.audit] }))
    return { ok: true, message: `状态已更新为${status}` }
  },
  importBackfill: (shipmentId, segmentId, records) => {
    const state = get()
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    const segment = shipment?.segments.find((item) => item.id === segmentId)
    if (!shipment || !segment) return { ok: false, message: '运输任务或航段不存在' }
    if (records.length === 0) return { ok: false, message: '补传内容为空，请从完整航段记录重试' }
    // 先在内存中完成整段合并，全部成功才落库；失败则原数据不动，可从完整航段重试
    const merged = mergeBackfill(segment.temperature, records, segmentId, '当前用户', nextId)
    segment.temperature = merged.points
    shipment.pendingReviews = [...(shipment.pendingReviews ?? []), ...merged.pending]
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    // 设备记录更新：重算超限窗口，未关闭偏差标记重新确认
    const windows = computeExcursions(segment.temperature, shipment.tempMin, shipment.tempMax)
    const windowText = windows.length > 0
      ? windows.map((item) => `${item.start.slice(11, 16)}-${item.end.slice(11, 16)} 峰值${item.maxValue}℃`).join('；')
      : '无超限'
    const reopened: string[] = []
    const deviations = state.deviations.map((item) => {
      if (item.shipmentId !== shipmentId || item.status === '已关闭') return item
      reopened.push(item.id)
      return { ...item, recheckRequired: true, status: (item.status === '待放行复核' ? '调查中' : item.status) as Deviation['status'], version: item.version + 1 }
    })
    const detail = `新增${merged.stats.added}点，重复${merged.stats.duplicates}点已跳过，人工待复核${merged.stats.pending}条；超限窗口重算：${windowText}${reopened.length ? `；${reopened.length}项未关闭偏差需重新确认` : ''}`
    set({
      shipments: [...state.shipments], deviations,
      audit: [makeAudit(shipmentId, '设备补传导入', '当前用户', detail), ...state.audit]
    })
    return { ok: true, message: `补传完成：新增${merged.stats.added}点，跳过重复${merged.stats.duplicates}点，${merged.stats.pending}条人工值待复核`, stats: merged.stats }
  },
  resolvePendingReading: (shipmentId, readingId, decision) => {
    const state = get()
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    const reading = shipment?.pendingReviews?.find((item) => item.id === readingId)
    if (!shipment || !reading) return { ok: false, message: '待复核读数不存在' }
    if (reading.status !== '待复核') return { ok: false, message: '该读数已处理' }
    const segment = shipment.segments.find((item) => item.id === reading.segmentId)
    if (!segment) return { ok: false, message: '航段不存在' }
    if (decision === '采纳') {
      // 同时刻已有设备读数时设备优先，人工值不能落进曲线
      if (segment.temperature.some((point) => point.time === reading.time && (point.source ?? '设备') === '设备')) {
        return { ok: false, message: '同时刻已存在设备读数，人工值不能采纳，只能作废' }
      }
      const adopted: TemperaturePoint = { id: nextId('T'), time: reading.time, value: reading.value, source: '人工' }
      segment.temperature = [...segment.temperature, adopted]
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      reading.status = '已采纳'
      const windows = computeExcursions(segment.temperature, shipment.tempMin, shipment.tempMax)
      const deviations = state.deviations.map((item) => item.shipmentId === shipmentId && item.status !== '已关闭'
        ? { ...item, recheckRequired: true, version: item.version + 1 } : item)
      shipment.version += 1
      shipment.updatedAt = new Date().toISOString()
      set({
        shipments: [...state.shipments], deviations,
        audit: [makeAudit(shipmentId, '采纳人工补录', '当前用户', `${reading.time.slice(0, 16)} ${reading.value}℃已入曲线，超限窗口重算为${windows.length}段，未关闭偏差需重新确认`), ...state.audit]
      })
      return { ok: true, message: '已采纳并入曲线，相关偏差已标记重新确认' }
    }
    reading.status = '已作废'
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    set((current) => ({ shipments: [...current.shipments], audit: [makeAudit(shipmentId, '作废人工补录', '当前用户', `${reading.time.slice(0, 16)} ${reading.value}℃（${reading.reason}）`), ...current.audit] }))
    return { ok: true, message: '已作废该人工读数' }
  },
  reset: () => set({ shipments: structuredClone(seedShipments), deviations: structuredClone(seedDeviations), audit: structuredClone(seedAudit), keyword: '', status: '全部' })
}), {
  name: 'gsb65:temperature-chain',
  version: 2,
  migrate: (persisted) => persisted as ShipmentState
}))

function makeAudit(shipmentId: string, action: string, operator: string, detail: string): AuditEntry {
  return { id: nextId('AUD'), shipmentId, action, operator, detail, createdAt: new Date().toISOString() }
}
