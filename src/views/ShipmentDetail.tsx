import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, Badge, Button, Card, Descriptions, Divider, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Upload, message } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import { TemperatureChart } from '../components/TemperatureChart'
import { ReleaseBlockerList, ReleaseStatusTag } from '../components/ReleaseStatus'
import { useShipmentStore } from '../store/useShipmentStore'
import { computeExcursions, formatTime, parseBackfillLines } from '../utils/temperature'
import type { Deviation, EvidenceFile, PendingReading } from '../types'

const SAMPLE_DEVICE = `2026-09-29 11:30, UTC+9, 9.6, 设备
2026-09-29 12:00, UTC+9, 10.2, 设备
2026-09-29 12:30, UTC+9, 9.1, 设备`
const SAMPLE_MANUAL = `2026-09-29 12:00, UTC+9, 8.9, 人工
2026-09-29 13:00, UTC+9, 7.4, 人工`

export function ShipmentDetail() {
  const { id } = useParams()
  const state = useShipmentStore()
  const shipment = state.shipments.find((item) => item.id === id)
  const [activeSegmentId, setActiveSegmentId] = useState(shipment?.segments[0]?.id ?? '')
  const [signOpen, setSignOpen] = useState(false)
  const [deviationOpen, setDeviationOpen] = useState(false)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [backfillText, setBackfillText] = useState('')
  const [backfillErrors, setBackfillErrors] = useState<string[]>([])
  const [form] = Form.useForm()
  const activeSegment = shipment?.segments.find((item) => item.id === activeSegmentId) ?? shipment?.segments[0]
  const excursions = useMemo(
    () => shipment && activeSegment ? computeExcursions(activeSegment.temperature, shipment.tempMin, shipment.tempMax) : [],
    [shipment, activeSegment]
  )
  if (!shipment || !activeSegment) return <section className="page empty">未找到运输任务</section>
  const deviations = state.deviations.filter((item) => item.shipmentId === shipment.id)
  const openDeviations = deviations.filter((item) => item.status !== '已关闭')
  const pendingReviews = (shipment.pendingReviews ?? []).filter((item) => item.status === '待复核')
  const evidenceColumns = [
    { title: '文件', dataIndex: 'name', render: (value: string, row: EvidenceFile) => <div><strong>{value}</strong><small className="cell-sub">{row.category} · V{row.version}</small></div> },
    { title: '上传', render: (_: unknown, row: EvidenceFile) => `${row.uploadedBy} ${row.uploadedAt.replace('T', ' ').slice(0, 16)}` },
    { title: '核验', dataIndex: 'verified', width: 95, render: (value: boolean, row: EvidenceFile) => value ? <Tag color="success">已核验</Tag> : <Button size="small" onClick={() => state.verifyEvidence(shipment.id, row.id)}>核验</Button> }
  ]
  const pendingColumns = [
    { title: '统一时刻(UTC)', width: 150, render: (_: unknown, row: PendingReading) => formatTime(row.time) },
    { title: '原始记录', width: 190, render: (_: unknown, row: PendingReading) => `${row.localTime} ${row.timezone}` },
    { title: '人工值', dataIndex: 'value', width: 80, render: (value: number) => `${value}℃` },
    { title: '原因', dataIndex: 'reason', width: 150, render: (value: string, row: PendingReading) => <span>{value}{row.deviceValue !== undefined && <small className="cell-sub">设备读数 {row.deviceValue}℃</small>}</span> },
    { title: '提交人', dataIndex: 'submittedBy', width: 90 },
    {
      title: '复核', width: 140, render: (_: unknown, row: PendingReading) => row.status === '待复核'
        ? <Space>
            <Button size="small" onClick={() => {
              const result = state.resolvePendingReading(shipment.id, row.id, '采纳')
              result.ok ? message.success(result.message) : message.warning(result.message)
            }}>采纳</Button>
            <Button size="small" danger onClick={() => {
              const result = state.resolvePendingReading(shipment.id, row.id, '作废')
              result.ok ? message.success(result.message) : message.warning(result.message)
            }}>作废</Button>
          </Space>
        : <Tag color={row.status === '已采纳' ? 'success' : 'default'}>{row.status}</Tag>
    }
  ]
  const sign = async () => {
    const values = await form.validateFields()
    const result = state.sign(shipment.id, values.role, values.comment ?? '', values.decision)
    result.ok ? message.success(result.message) : message.error(result.message)
    if (result.ok) setSignOpen(false)
  }
  const createDeviation = async () => {
    const values = await form.validateFields()
    state.createDeviation(shipment.id, values.segmentId, values.title, values.severity)
    setDeviationOpen(false)
    message.success('已创建偏差并进入调查队列')
  }
  const release = () => {
    const result = state.setShipmentStatus(shipment.id, '已放行')
    result.ok ? message.success(result.message) : message.error(result.message)
  }
  const runBackfill = () => {
    // 整段解析：任一记录非法则导入失败、原数据不动，修正后从完整航段重试
    const { records, errors } = parseBackfillLines(backfillText)
    if (errors.length > 0) { setBackfillErrors(errors); return }
    const result = state.importBackfill(shipment.id, activeSegment.id, records)
    if (!result.ok) { setBackfillErrors([result.message]); return }
    setBackfillErrors([])
    setBackfillOpen(false)
    setBackfillText('')
    message.success(result.message)
  }
  return <section className="page">
    <header className="page-head detail-head">
      <div><p>{shipment.id} · {shipment.batch}</p><h1>{shipment.product}</h1></div>
      <Space><Tag color={shipment.status === '已放行' ? 'success' : 'warning'}>{shipment.status}</Tag><ReleaseStatusTag shipment={shipment} /><Button onClick={() => setDeviationOpen(true)}>登记偏差</Button><Button onClick={() => setSignOpen(true)}>角色签收</Button><Button type="primary" onClick={release}>放行审核</Button></Space>
    </header>
    {openDeviations.length > 0 && <Alert type="error" showIcon message={`存在${openDeviations.length}项未关闭温度偏差，系统阻止放行`} />}
    {pendingReviews.length > 0 && <Alert className="alert-gap" type="warning" showIcon message={`${pendingReviews.length}条人工补录读数待复核，复核完成前不能放行`} />}
    <ReleaseBlockerList shipment={shipment} />
    <Descriptions className="summary-band" size="small" column={5} items={[
      { key: 'route', label: '运输路线', children: shipment.route },
      { key: 'box', label: '温控箱', children: shipment.containerId },
      { key: 'range', label: '允许范围', children: `${shipment.tempMin} - ${shipment.tempMax} ℃` },
      { key: 'version', label: '任务版本', children: `V${shipment.version}` },
      { key: 'updated', label: '最近更新', children: shipment.updatedAt.replace('T', ' ').slice(0, 16) }
    ]} />
    <div className="detail-grid">
      <div className="timeline-panel">
        <div className="panel-title"><h2>航段时间轴</h2><span>原始温度点不可修改</span></div>
        {shipment.segments.map((segment) => <button key={segment.id} className={activeSegment.id === segment.id ? 'active' : ''} onClick={() => setActiveSegmentId(segment.id)}>
          <div className="segment-index">{segment.id.replace('SEG-', '')}</div>
          <div><strong>{segment.from} → {segment.to}</strong><span>{segment.flight} · {segment.plannedStart.replace('T', ' ').slice(0, 16)}</span><small>操作人：{segment.handler} · {segment.note}</small></div>
          <Badge status={segment.temperature.some((item) => item.value < shipment.tempMin || item.value > shipment.tempMax) ? 'error' : 'success'} />
        </button>)}
      </div>
      <div className="chart-panel">
        <div className="panel-title"><h2>{activeSegment.from} → {activeSegment.to}</h2><Space><span>{activeSegment.flight}</span><Button size="small" onClick={() => { setBackfillErrors([]); setBackfillOpen(true) }}>补传导入</Button></Space></div>
        <TemperatureChart points={activeSegment.temperature} min={shipment.tempMin} max={shipment.tempMax} />
        <div className="segment-meta"><span>计划：{activeSegment.plannedStart.replace('T', ' ').slice(0, 16)}</span><span>实际：{activeSegment.actualStart.replace('T', ' ').slice(0, 16)} - {activeSegment.actualEnd.replace('T', ' ').slice(0, 16)}</span></div>
        <div className="excursion-band">
          <strong>超限窗口（{excursions.length}段，随设备记录重算）</strong>
          {excursions.length === 0
            ? <span className="cell-sub">当前无超限</span>
            : excursions.map((item) => <Tag key={item.start} color="error">{formatTime(item.start)} → {formatTime(item.end)} · {item.points}点 · 峰值{item.maxValue}℃ / 谷值{item.minValue}℃</Tag>)}
        </div>
      </div>
    </div>
    <Tabs className="detail-tabs" items={[
      { key: 'evidence', label: `证据版本 (${shipment.evidence.length})`, children: <div><div className="tab-actions"><Upload beforeUpload={() => { state.addEvidence(shipment.id, { name: `现场补充材料-${Date.now()}.pdf`, category: '包装确认', uploadedBy: '当前用户', verified: false }); message.success('已新增证据版本'); return false }} showUploadList={false}><Button icon={<UploadOutlined />}>上传证据</Button></Upload><span>同分类文件自动递增版本</span></div><Table rowKey="id" size="small" columns={evidenceColumns} dataSource={shipment.evidence} pagination={false} /></div> },
      { key: 'signatures', label: `签收记录 (${shipment.signatures.filter((item) => item.status === '已签').length}/${shipment.signatures.length})`, children: <div className="signature-grid">{shipment.signatures.map((item) => <Card key={item.role} size="small"><div className="signature-head"><strong>{item.role}</strong><Tag color={item.status === '已签' ? 'success' : item.status === '已退回' ? 'error' : 'default'}>{item.status}</Tag></div><p>{item.name}</p><small>{item.signedAt ? item.signedAt.replace('T', ' ').slice(0, 16) : '尚未签署'}</small><Divider /><span>{item.comment || '暂无意见'}</span></Card>)}</div> },
      { key: 'deviations', label: `偏差 (${deviations.length})`, children: <Table rowKey="id" size="small" pagination={false} dataSource={deviations} columns={[{ title: '编号', dataIndex: 'id' }, { title: '标题', dataIndex: 'title' }, { title: '状态', dataIndex: 'status', render: (value: string, row: Deviation) => <Space size={4}><span>{value}</span>{row.recheckRequired && <Tag color="warning">待重新确认</Tag>}</Space> }, { title: '版本', dataIndex: 'version', render: (value: number) => `V${value}` }]} /> },
      { key: 'pending', label: `待复核读数 (${pendingReviews.length})`, children: <div><div className="tab-actions"><span>补传时与设备读数打架的人工值另存于此；同时刻保留设备读数，采纳前不进入曲线，复核完成前禁止放行。</span></div><Table rowKey="id" size="small" columns={pendingColumns} dataSource={shipment.pendingReviews ?? []} pagination={false} /></div> }
    ]} />
    <Modal title="多角色签收" open={signOpen} onCancel={() => setSignOpen(false)} onOk={sign} okText="提交签收">
      <Form form={form} layout="vertical" initialValues={{ role: '放行人员', decision: '已签' }}>
        <Form.Item name="role" label="签收角色" rules={[{ required: true }]}><Select options={shipment.signatures.map((item) => ({ label: item.role, value: item.role }))} /></Form.Item>
        <Form.Item name="decision" label="签收决定" rules={[{ required: true }]}><Select options={[{ label: '签署确认', value: '已签' }, { label: '退回补充', value: '已退回' }]} /></Form.Item>
        <Form.Item name="comment" label="签收意见"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="登记温度偏差" open={deviationOpen} onCancel={() => setDeviationOpen(false)} onOk={createDeviation} okText="创建偏差">
      <Form form={form} layout="vertical" initialValues={{ segmentId: activeSegment.id, severity: '一般' }}>
        <Form.Item name="segmentId" label="发生航段" rules={[{ required: true }]}><Select options={shipment.segments.map((item) => ({ label: `${item.from} → ${item.to}`, value: item.id }))} /></Form.Item>
        <Form.Item name="title" label="偏差描述" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
        <Form.Item name="severity" label="严重度" rules={[{ required: true }]}><Select options={['一般', '重大'].map((value) => ({ label: value, value }))} /></Form.Item>
      </Form>
    </Modal>
    <Modal title={`补传导入 · ${activeSegment.from} → ${activeSegment.to}`} open={backfillOpen} onCancel={() => setBackfillOpen(false)} onOk={runBackfill} okText="导入整段" width={640}>
      <p className="modal-note">每行一条：当地时间, 时区, 温度, 来源(设备/人工，缺省设备)。导入先统一为UTC时刻；同时刻保留设备读数，人工值另存待复核；重复补传不重复建点。任一记录非法则整段不入库，修正后从完整航段重试。</p>
      <Space className="sample-actions">
        <Button size="small" onClick={() => setBackfillText(SAMPLE_DEVICE)}>填入设备补传示例</Button>
        <Button size="small" onClick={() => setBackfillText(SAMPLE_MANUAL)}>填入人工补录示例</Button>
        <Button size="small" onClick={() => setBackfillText(`${SAMPLE_DEVICE}\n${SAMPLE_MANUAL}`)}>混合示例</Button>
      </Space>
      <Input.TextArea rows={8} value={backfillText} onChange={(event) => setBackfillText(event.target.value)} placeholder={'2026-09-29 12:00, UTC+9, 10.2, 设备'} />
      {backfillErrors.length > 0 && <Alert className="alert-gap" type="error" showIcon message="导入失败，未写入任何记录，请修正后从完整航段重试" description={<ul className="error-list">{backfillErrors.map((error) => <li key={error}>{error}</li>)}</ul>} />}
    </Modal>
  </section>
}
