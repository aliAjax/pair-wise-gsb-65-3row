import { Tag } from 'antd'
import { useShipmentStore } from '../store/useShipmentStore'
import { getReleaseView } from '../utils/release'
import type { Shipment } from '../types'

/** 任务详情与偏差工作台共用的放行状态标签，保证两处显示一致 */
export function ReleaseStatusTag({ shipment }: { shipment: Shipment }) {
  const deviations = useShipmentStore((state) => state.deviations)
  const view = getReleaseView(shipment, deviations)
  return <Tag color={view.color}>{view.label}</Tag>
}

export function ReleaseBlockerList({ shipment }: { shipment: Shipment }) {
  const deviations = useShipmentStore((state) => state.deviations)
  const view = getReleaseView(shipment, deviations)
  if (view.blockers.length === 0) return null
  return <ul className="blocker-list">
    {view.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
  </ul>
}
