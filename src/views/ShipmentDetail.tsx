import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, Badge, Button, Card, Checkbox, Descriptions, Divider, Form, Input, Modal, Select, Space, Table, Tabs, Tag, Upload, message } from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import { TemperatureChart } from '../components/TemperatureChart'
import { selectReleaseBlockers, useShipmentStore } from '../store/useShipmentStore'
import { buildBackfillBatch, computeExcursions, normalizeToCanonical } from '../utils/temperature'
import type { BackfillReading } from '../utils/temperature'
import type { EvidenceFile, PendingReading, ShipmentSegment } from '../types'

export function ShipmentDetail() {
  const { id } = useParams()
  const state = useShipmentStore()
  const shipment = state.shipments.find((item) => item.id === id)
  const [activeSegmentId, setActiveSegmentId] = useState(shipment?.segments[0]?.id ?? '')
  const [signOpen, setSignOpen] = useState(false)
  const [deviationOpen, setDeviationOpen] = useState(false)
  const [backfillOpen, setBackfillOpen] = useState(false)
  const [backfillBatch, setBackfillBatch] = useState<BackfillReading[]>([])
  const [backfillResult, setBackfillResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [form] = Form.useForm()
  if (!shipment) return <section className="page empty">未找到运输任务</section>
  const activeSegment = shipment.segments.find((item) => item.id === activeSegmentId) ?? shipment.segments[0]
  const deviations = state.deviations.filter((item) => item.shipmentId === shipment.id)
  const blockers = selectReleaseBlockers(state, shipment.id)
  const excursions = activeSegment.excursions ?? computeExcursions(activeSegment.temperature, shipment.tempMin, shipment.tempMax)
  const pendingRows = shipment.segments.flatMap((segment) => (segment.pendingReadings ?? []).map((reading) => ({ ...reading, segmentId: segment.id, route: `${segment.from} → ${segment.to}` })))
  const pendingCount = pendingRows.filter((item) => item.status === '待复核').length
  const evidenceColumns = [
    { title: '文件', dataIndex: 'name', render: (value: string, row: EvidenceFile) => <div><strong>{value}</strong><small className="cell-sub">{row.category} · V{row.version}</small></div> },
    { title: '上传', render: (_: unknown, row: EvidenceFile) => `${row.uploadedBy} ${row.uploadedAt.replace('T', ' ').slice(0, 16)}` },
    { title: '核验', dataIndex: 'verified', width: 95, render: (value: boolean, row: EvidenceFile) => value ? <Tag color="success">已核验</Tag> : <Button size="small" onClick={() => state.verifyEvidence(shipment.id, row.id)}>核验</Button> }
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
  const openBackfill = () => {
    setBackfillBatch(buildBackfillBatch(activeSegment, shipment.tempMin, shipment.tempMax))
    setBackfillResult(null)
    setSimulateFailure(false)
    setBackfillOpen(true)
  }
  const runBackfill = (retry: boolean) => {
    const result = state.importBackfill(shipment.id, activeSegment.id, backfillBatch, { simulateFailure: simulateFailure && !retry })
    setBackfillResult({ ok: result.ok, text: result.message })
    result.ok ? message.success(result.message) : message.error(result.message)
  }
  const resolvePending = (row: PendingReading & { segmentId: string }, decision: '采纳' | '驳回') => {
    state.resolvePendingReading(shipment.id, row.segmentId, row.id, decision)
    message.success(`人工补录已${decision}`)
  }
  return <section className="page">
    <header className="page-head detail-head">
      <div><p>{shipment.id} · {shipment.batch}</p><h1>{shipment.product}</h1></div>
      <Space><Tag color={shipment.status === '已放行' ? 'success' : 'warning'}>{shipment.status}</Tag><Button onClick={openBackfill}>记录仪补传</Button><Button onClick={() => setDeviationOpen(true)}>登记偏差</Button><Button onClick={() => setSignOpen(true)}>角色签收</Button><Button type="primary" onClick={release}>放行审核</Button></Space>
    </header>
    {blockers.length > 0 && <Alert type="error" showIcon message={`放行拦截：${shipment.status}，暂不具备放行资格`} description={<ul className="blocker-list">{blockers.map((item) => <li key={item}>{item}</li>)}</ul>} />}
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
        <div className="panel-title"><h2>{activeSegment.from} → {activeSegment.to}</h2><span>{activeSegment.flight}</span></div>
        <TemperatureChart points={activeSegment.temperature} min={shipment.tempMin} max={shipment.tempMax} />
        <div className="excursion-strip">
          <span>超限窗口（随设备记录重算）</span>
          {excursions.length === 0 ? <Tag color="success">无超限</Tag> : excursions.map((item) => <Tag key={item.id} color="error">{item.direction} {item.start.slice(11, 16)}-{item.end.slice(11, 16)} 峰值{item.direction === '高超限' ? '+' : '-'}{item.peak}℃ · {item.points}点</Tag>)}
        </div>
        <div className="segment-meta"><span>计划：{activeSegment.plannedStart.replace('T', ' ').slice(0, 16)}</span><span>实际：{activeSegment.actualStart.replace('T', ' ').slice(0, 16)} - {activeSegment.actualEnd.replace('T', ' ').slice(0, 16)}</span></div>
      </div>
    </div>
    <Tabs className="detail-tabs" items={[
      { key: 'evidence', label: `证据版本 (${shipment.evidence.length})`, children: <div><div className="tab-actions"><Upload beforeUpload={() => { state.addEvidence(shipment.id, { name: `现场补充材料-${Date.now()}.pdf`, category: '包装确认', uploadedBy: '当前用户', verified: false }); message.success('已新增证据版本'); return false }} showUploadList={false}><Button icon={<UploadOutlined />}>上传证据</Button></Upload><span>同分类文件自动递增版本</span></div><Table rowKey="id" size="small" columns={evidenceColumns} dataSource={shipment.evidence} pagination={false} /></div> },
      { key: 'pending', label: `补录待复核 (${pendingCount})`, children: <div>
        {pendingCount > 0 && <Alert className="inline-alert" type="warning" showIcon message="人工补录读数待复核，复核完成前不能放行；同时刻冲突一律保留设备读数" />}
        <Table rowKey="id" size="small" pagination={false} dataSource={pendingRows} columns={[
          { title: '统一时刻', dataIndex: 'time', render: (value: string) => value.replace('T', ' ').slice(0, 16) },
          { title: '航段', dataIndex: 'route' },
          { title: '人工读数', dataIndex: 'value', render: (value: number) => `${value}℃` },
          { title: '补录人', dataIndex: 'enteredBy' },
          { title: '说明', dataIndex: 'note' },
          { title: '状态', dataIndex: 'status', render: (value: string) => <Tag color={value === '待复核' ? 'warning' : value === '已采纳' ? 'success' : 'default'}>{value}</Tag> },
          { title: '处置', width: 140, render: (_: unknown, row: PendingReading & { segmentId: string }) => row.status === '待复核' ? <Space><Button size="small" onClick={() => resolvePending(row, '采纳')}>采纳</Button><Button size="small" danger onClick={() => resolvePending(row, '驳回')}>驳回</Button></Space> : '—' }
        ]} locale={{ emptyText: '暂无人工补录记录' }} />
      </div> },
      { key: 'signatures', label: `签收记录 (${shipment.signatures.filter((item) => item.status === '已签').length}/${shipment.signatures.length})`, children: <div className="signature-grid">{shipment.signatures.map((item) => <Card key={item.role} size="small"><div className="signature-head"><strong>{item.role}</strong><Tag color={item.status === '已签' ? 'success' : item.status === '已退回' ? 'error' : 'default'}>{item.status}</Tag></div><p>{item.name}</p><small>{item.signedAt ? item.signedAt.replace('T', ' ').slice(0, 16) : '尚未签署'}</small><Divider /><span>{item.comment || '暂无意见'}</span></Card>)}</div> },
      { key: 'deviations', label: `偏差 (${deviations.length})`, children: <Table rowKey="id" size="small" pagination={false} dataSource={deviations} columns={[{ title: '编号', dataIndex: 'id' }, { title: '标题', dataIndex: 'title' }, { title: '状态', dataIndex: 'status', render: (value: string, row) => <Space size={4}><span>{value}</span>{row.reconfirmRequired && <Tag color="warning">待重新确认</Tag>}</Space> }, { title: '版本', dataIndex: 'version', render: (value: number) => `V${value}` }]} /> }
    ]} />
    <Modal title={`记录仪补传 · ${activeSegment.from} → ${activeSegment.to}`} open={backfillOpen} onCancel={() => setBackfillOpen(false)} footer={<Space><Button onClick={() => setBackfillOpen(false)}>关闭</Button>{backfillResult && !backfillResult.ok && <Button type="primary" danger onClick={() => runBackfill(true)}>从完整航段重试</Button>}<Button type="primary" onClick={() => runBackfill(false)}>执行补传</Button></Space>} width={720}>
      <Alert type="info" showIcon message="补传先统一时刻：机场当地时间按UTC偏移归一；同时刻保留设备读数，人工值另存待复核；重复补传不重复建点" />
      <Table rowKey={(row) => `${row.localTime}-${row.source}-${row.value}`} size="small" pagination={false} dataSource={backfillBatch} columns={[
        { title: '机场当地时间', dataIndex: 'localTime' },
        { title: 'UTC偏移', dataIndex: 'offset', width: 90 },
        { title: '统一时刻', width: 150, render: (_: unknown, row: BackfillReading) => normalizeToCanonical(row.localTime, row.offset)?.replace('T', ' ') ?? '无法解析' },
        { title: '来源', dataIndex: 'source', width: 70, render: (value: string) => <Tag color={value === '设备' ? 'processing' : 'warning'}>{value}</Tag> },
        { title: '读数', dataIndex: 'value', width: 80, render: (value: number) => `${value}℃` }
      ]} />
      <div className="backfill-options">
        <Checkbox checked={simulateFailure} onChange={(event) => setSimulateFailure(event.target.checked)}>模拟传输中断（整批不写入，从完整航段重试）</Checkbox>
        {backfillResult && <Alert type={backfillResult.ok ? 'success' : 'error'} showIcon message={backfillResult.text} />}
      </div>
    </Modal>
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
  </section>
}
