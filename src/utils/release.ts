import type { Deviation, Shipment } from '../types'

/**
 * 统一计算放行阻塞项：运输任务、航段温度点（待复核人工读数）、
 * 温度偏差（未关闭/待重新确认）与放行资格在此接起来，
 * 任务详情和偏差工作台显示同一放行状态。
 */
export function getReleaseBlockers(shipment: Shipment, deviations: Deviation[]): string[] {
  const blockers: string[] = []
  const related = deviations.filter((item) => item.shipmentId === shipment.id)
  const open = related.filter((item) => item.status !== '已关闭')
  if (open.length > 0) blockers.push(`存在${open.length}项未关闭温度偏差`)
  const recheck = related.filter((item) => item.status !== '已关闭' && item.recheckRequired)
  if (recheck.length > 0) blockers.push(`${recheck.length}项偏差因设备记录更新待重新确认`)
  const pending = (shipment.pendingReviews ?? []).filter((item) => item.status === '待复核')
  if (pending.length > 0) blockers.push(`${pending.length}条人工补录读数待复核`)
  const unverified = shipment.evidence.filter((item) => !item.verified)
  if (unverified.length > 0) blockers.push(`${unverified.length}份证据未核验`)
  const unsigned = shipment.signatures.filter((item) => item.role !== '放行人员' && item.status !== '已签')
  if (unsigned.length > 0) blockers.push(`多角色签收未完成（${unsigned.map((item) => item.role).join('、')}）`)
  return blockers
}

export type ReleaseView = { label: string; color: string; blockers: string[] }

/** 详情页与偏差工作台共用的放行状态视图 */
export function getReleaseView(shipment: Shipment, deviations: Deviation[]): ReleaseView {
  if (shipment.status === '已放行') return { label: '已放行', color: 'success', blockers: [] }
  if (shipment.status === '已拒绝') return { label: '已拒绝', color: 'error', blockers: [] }
  const blockers = getReleaseBlockers(shipment, deviations)
  if (blockers.length > 0) return { label: '禁止放行', color: 'error', blockers }
  return { label: '可申请放行', color: 'processing', blockers }
}
