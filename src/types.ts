export type ShipmentStatus = '待装机' | '运输中' | '待放行' | '已放行' | '已拒绝'
export type DeviationStatus = '待调查' | '调查中' | '待放行复核' | '已关闭'
export type PointSource = '设备' | '人工'

export interface TemperaturePoint {
  id: string
  /** 统一后的时刻（设备离线缓存的机场当地时间已在补传导入时换算为UTC） */
  time: string
  value: number
  /** 缺省视为设备读数 */
  source?: PointSource
}

export interface ShipmentSegment {
  id: string
  from: string
  to: string
  flight: string
  plannedStart: string
  actualStart: string
  actualEnd: string
  handler: string
  note: string
  temperature: TemperaturePoint[]
}

/** 补传导入的一条原始记录（机场当地时间 + 时区） */
export interface BackfillRecord {
  localTime: string
  timezone: string
  value: number
  source: PointSource
}

/** 人工补录与设备读数打架时另存的待复核读数 */
export interface PendingReading {
  id: string
  segmentId: string
  localTime: string
  timezone: string
  /** 统一后的UTC时刻 */
  time: string
  value: number
  reason: '与设备读数冲突' | '无设备读数'
  /** 冲突时刻的设备读数 */
  deviceValue?: number
  status: '待复核' | '已采纳' | '已作废'
  submittedBy: string
  submittedAt: string
}

export interface EvidenceFile {
  id: string
  name: string
  category: '温度曲线' | '设备报告' | '包装确认' | '交接签字'
  version: number
  uploadedBy: string
  uploadedAt: string
  verified: boolean
}

export interface ShipmentSignature {
  role: '发货方' | '承运方' | '收货方' | '放行人员'
  name: string
  status: '待签' | '已签' | '已退回'
  signedAt: string
  comment: string
}

export interface Shipment {
  id: string
  product: string
  batch: string
  route: string
  containerId: string
  tempMin: number
  tempMax: number
  plannedDeparture: string
  actualArrival: string
  status: ShipmentStatus
  segments: ShipmentSegment[]
  evidence: EvidenceFile[]
  signatures: ShipmentSignature[]
  /** 人工补录待复核读数，存在待复核项时禁止放行 */
  pendingReviews?: PendingReading[]
  version: number
  updatedAt: string
}

export interface Deviation {
  id: string
  shipmentId: string
  segmentId: string
  title: string
  source: '自动监测' | '人工报告'
  severity: '一般' | '重大'
  status: DeviationStatus
  owner: string
  openedAt: string
  dueDate: string
  cause: string
  assessment: string
  disposition: '接受' | '补充处理' | '拒绝'
  correctiveAction: string
  evidence: string
  reviewer: string
  reviewNote: string
  /** 设备记录更新后未关闭偏差需重新确认，确认前不得复核关闭 */
  recheckRequired?: boolean
  version: number
}

export interface AuditEntry {
  id: string
  shipmentId: string
  action: string
  operator: string
  detail: string
  createdAt: string
}
