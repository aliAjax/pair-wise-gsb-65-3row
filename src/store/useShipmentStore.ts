import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedAudit, seedDeviations, seedShipments } from '../data/seed'
import { canonicalKey, computeExcursions, normalizeToCanonical } from '../utils/temperature'
import type { BackfillReading } from '../utils/temperature'
import type { AuditEntry, Deviation, EvidenceFile, Shipment, ShipmentStatus } from '../types'

export interface ImportResult {
  ok: boolean
  message: string
  added?: number
  duplicates?: number
  pending?: number
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
  confirmDeviationRecalc: (id: string) => void
  importBackfill: (shipmentId: string, segmentId: string, batch: BackfillReading[], options?: { simulateFailure?: boolean }) => ImportResult
  resolvePendingReading: (shipmentId: string, segmentId: string, readingId: string, decision: '采纳' | '驳回') => void
  setShipmentStatus: (id: string, status: ShipmentStatus) => { ok: boolean; message: string }
  reset: () => void
}

let idSeed = 10
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`

// 详情页与偏差工作台共用的同一套放行资格判定
export function selectReleaseBlockers(state: Pick<ShipmentState, 'shipments' | 'deviations'>, shipmentId: string): string[] {
  const shipment = state.shipments.find((item) => item.id === shipmentId)
  if (!shipment) return ['运输任务不存在']
  const blockers: string[] = []
  const open = state.deviations.filter((item) => item.shipmentId === shipmentId && item.status !== '已关闭')
  if (open.length) blockers.push(`存在${open.length}项未关闭温度偏差`)
  if (open.some((item) => item.reconfirmRequired)) blockers.push('设备记录已更新，偏差需按重算后的超限窗口重新确认')
  const pending = shipment.segments.flatMap((segment) => segment.pendingReadings ?? []).filter((item) => item.status === '待复核')
  if (pending.length) blockers.push(`存在${pending.length}条人工补录读数待复核`)
  if (shipment.evidence.some((item) => !item.verified)) blockers.push('仍有证据未核验')
  if (shipment.signatures.some((item) => item.role !== '放行人员' && item.status !== '已签')) blockers.push('多角色签收未完成')
  return blockers
}

export const selectPendingCount = (state: Pick<ShipmentState, 'shipments'>, shipmentId: string) =>
  state.shipments.find((item) => item.id === shipmentId)?.segments.flatMap((segment) => segment.pendingReadings ?? []).filter((item) => item.status === '待复核').length ?? 0

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
    Object.assign(deviation, patch, { status: '待放行复核', version: deviation.version + 1 })
    return { deviations: [...state.deviations], audit: [makeAudit(deviation.shipmentId, '提交偏差调查', deviation.owner, deviation.assessment), ...state.audit] }
  }),
  reviewDeviation: (id, disposition, note) => {
    const deviation = get().deviations.find((item) => item.id === id)
    if (!deviation) return { ok: false, message: '偏差不存在' }
    if (deviation.reconfirmRequired) return { ok: false, message: '设备记录已更新，请先确认重算后的超限窗口' }
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
  confirmDeviationRecalc: (id) => set((state) => {
    const deviation = state.deviations.find((item) => item.id === id)
    if (!deviation || !deviation.reconfirmRequired) return state
    deviation.reconfirmRequired = false
    deviation.version += 1
    return { deviations: [...state.deviations], audit: [makeAudit(deviation.shipmentId, '确认重算结果', '温控质量组', `${deviation.id} 已按重算后的超限窗口重新确认`), ...state.audit] }
  }),
  importBackfill: (shipmentId, segmentId, batch, options) => {
    const shipment = get().shipments.find((item) => item.id === shipmentId)
    const segment = shipment?.segments.find((item) => item.id === segmentId)
    if (!shipment || !segment) return { ok: false, message: '航段不存在，导入失败' }
    if (!batch.length) return { ok: false, message: '补传批次为空，未写入任何数据' }
    if (options?.simulateFailure) {
      set((state) => ({ audit: [makeAudit(shipmentId, '补传导入失败', '记录仪同步', `${segmentId} 传输中断，本批次未写入，待从完整航段重试`), ...state.audit] }))
      return { ok: false, message: '传输中断：本批次未写入任何数据，请从完整航段重试' }
    }
    const normalized = batch.map((item) => ({ ...item, time: normalizeToCanonical(item.localTime, item.offset) }))
    if (normalized.some((item) => !item.time || typeof item.value !== 'number' || Number.isNaN(item.value))) {
      set((state) => ({ audit: [makeAudit(shipmentId, '补传导入失败', '记录仪同步', `${segmentId} 批次校验未通过，未写入任何数据`), ...state.audit] }))
      return { ok: false, message: '批次校验失败：存在无法统一的时刻或非法读数，未写入任何数据，请修正后从完整航段重试' }
    }
    let added = 0
    let duplicates = 0
    let pendingAdded = 0
    let flagged = 0
    set((state) => {
      const ship = state.shipments.find((item) => item.id === shipmentId)
      const seg = ship?.segments.find((item) => item.id === segmentId)
      if (!ship || !seg) return state
      const existing = new Set(seg.temperature.map((point) => canonicalKey(point.time)))
      const pendingKeys = new Set((seg.pendingReadings ?? []).map((item) => `${canonicalKey(item.time)}|${item.value}|${item.status === '待复核'}`))
      const seenInBatch = new Set<string>()
      for (const item of normalized) {
        const key = canonicalKey(item.time as string)
        if (item.source === '设备') {
          if (existing.has(key) || seenInBatch.has(`D${key}`)) { duplicates += 1; continue }
          seenInBatch.add(`D${key}`)
          seg.temperature.push({ id: nextId('T'), time: item.time as string, value: item.value, source: '设备' })
          existing.add(key)
          added += 1
        } else {
          const pendingKey = `${key}|${item.value}|true`
          if (pendingKeys.has(pendingKey) || seenInBatch.has(`M${pendingKey}`)) { duplicates += 1; continue }
          seenInBatch.add(`M${pendingKey}`)
          seg.pendingReadings = [...(seg.pendingReadings ?? []), {
            id: nextId('PR'), time: item.time as string, value: item.value, enteredBy: item.enteredBy ?? '人工补录', status: '待复核',
            note: existing.has(key) ? '与设备读数同时刻冲突，曲线保留设备值' : '设备缺失时刻的人工补录'
          }]
          pendingAdded += 1
        }
      }
      seg.temperature.sort((a, b) => (a.time < b.time ? -1 : 1))
      seg.excursions = computeExcursions(seg.temperature, ship.tempMin, ship.tempMax)
      const deviations = state.deviations.map((item) => {
        if (item.shipmentId !== shipmentId || item.segmentId !== segmentId || item.status === '已关闭') return item
        flagged += 1
        return { ...item, reconfirmRequired: true, status: item.status === '待放行复核' ? '调查中' as const : item.status, version: item.version + 1 }
      })
      if (added > 0 || pendingAdded > 0) {
        ship.version += 1
        ship.updatedAt = new Date().toISOString()
        if (ship.status === '已放行') ship.status = '待放行'
      }
      return {
        shipments: [...state.shipments],
        deviations,
        audit: [makeAudit(shipmentId, '记录仪补传', '记录仪同步', `${segmentId} 统一时刻后新增${added}点、忽略重复${duplicates}点、人工补录${pendingAdded}条待复核；超限窗口已重算${flagged ? `，${flagged}项未关闭偏差待重新确认` : ''}`), ...state.audit]
      }
    })
    const message = added === 0 && pendingAdded === 0
      ? `重复补传：${duplicates}条记录与既有数据一致，未重复建点`
      : `补传完成：新增${added}个设备点、忽略重复${duplicates}条、${pendingAdded}条人工补录待复核，超限窗口已重算`
    return { ok: true, added, duplicates, pending: pendingAdded, message }
  },
  resolvePendingReading: (shipmentId, segmentId, readingId, decision) => set((state) => {
    const shipment = state.shipments.find((item) => item.id === shipmentId)
    const segment = shipment?.segments.find((item) => item.id === segmentId)
    const reading = segment?.pendingReadings?.find((item) => item.id === readingId)
    if (!shipment || !segment || !reading || reading.status !== '待复核') return state
    reading.status = decision === '采纳' ? '已采纳' : '已驳回'
    let detail = `${reading.time.replace('T', ' ').slice(0, 16)} ${reading.value}℃ ${reading.status}`
    if (decision === '采纳' && !segment.temperature.some((point) => canonicalKey(point.time) === canonicalKey(reading.time))) {
      segment.temperature.push({ id: nextId('T'), time: reading.time, value: reading.value, source: '人工' })
      segment.temperature.sort((a, b) => (a.time < b.time ? -1 : 1))
      segment.excursions = computeExcursions(segment.temperature, shipment.tempMin, shipment.tempMax)
      detail += '，已补入曲线并重算超限窗口'
    }
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    return { shipments: [...state.shipments], audit: [makeAudit(shipmentId, `人工补录${decision}`, '温控质量组', `${segmentId} ${detail}`), ...state.audit] }
  }),
  setShipmentStatus: (id, status) => {
    const state = get()
    const shipment = state.shipments.find((item) => item.id === id)
    if (!shipment) return { ok: false, message: '运输任务不存在' }
    if (status === '已放行') {
      const blockers = selectReleaseBlockers(state, id)
      if (blockers.length) return { ok: false, message: blockers.join('；') }
    }
    shipment.status = status
    shipment.version += 1
    shipment.updatedAt = new Date().toISOString()
    set((current) => ({ shipments: [...current.shipments], audit: [makeAudit(id, `状态流转：${status}`, '当前用户', '放行工作台操作'), ...current.audit] }))
    return { ok: true, message: `状态已更新为${status}` }
  },
  reset: () => set({ shipments: structuredClone(seedShipments), deviations: structuredClone(seedDeviations), audit: structuredClone(seedAudit), keyword: '', status: '全部' })
}), { name: 'gsb65:temperature-chain', version: 2 }))

function makeAudit(shipmentId: string, action: string, operator: string, detail: string): AuditEntry {
  return { id: nextId('AUD'), shipmentId, action, operator, detail, createdAt: new Date().toISOString() }
}
