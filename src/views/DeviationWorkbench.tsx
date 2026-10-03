import { useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Descriptions, Empty, Form, Input, Modal, Select, Space, Tabs, Tag, message } from 'antd'
import { useShipmentStore } from '../store/useShipmentStore'
import { ReleaseBlockerList, ReleaseStatusTag } from '../components/ReleaseStatus'
import { computeExcursions, formatTime } from '../utils/temperature'
import type { Deviation } from '../types'

export function DeviationWorkbench() {
  const state = useShipmentStore()
  const [selectedId, setSelectedId] = useState(state.deviations[0]?.id ?? '')
  const selected = state.deviations.find((item) => item.id === selectedId) ?? state.deviations[0]
  const [form] = Form.useForm()
  const [reviewOpen, setReviewOpen] = useState(false)
  useEffect(() => { if (selected) form.setFieldsValue(selected) }, [selected, form])
  useEffect(() => { if (!selectedId && selected) setSelectedId(selected.id) }, [selectedId, selected])
  const save = async () => {
    const values = await form.validateFields()
    state.saveInvestigation(selected.id, values)
    message.success(selected.recheckRequired ? '已按更新后的设备记录重新确认并提交复核' : '调查已提交放行复核')
  }
  const review = async () => {
    const values = await form.validateFields()
    const result = state.reviewDeviation(selected.id, values.disposition, values.reviewNote)
    result.ok ? message.success(result.message) : message.error(result.message)
    if (result.ok) setReviewOpen(false)
  }
  if (!selected) return <section className="page"><Empty description="暂无偏差" /></section>
  const shipment = state.shipments.find((item) => item.id === selected.shipmentId)
  const segment = shipment?.segments.find((item) => item.id === selected.segmentId)
  const excursions = shipment && segment ? computeExcursions(segment.temperature, shipment.tempMin, shipment.tempMax) : []
  return <section className="page">
    <header className="page-head"><div><p>温度超限 / 原因调查 / 放行复核</p><h1>温度偏差调查</h1></div><Badge count={state.deviations.filter((item) => item.status !== '已关闭').length} showZero /></header>
    <div className="deviation-layout">
      <div className="deviation-nav">{state.deviations.map((item) => <button key={item.id} className={item.id === selected.id ? 'active' : ''} onClick={() => setSelectedId(item.id)}><div><Badge status={item.severity === '重大' ? 'error' : 'warning'} /><strong>{item.title}</strong></div><span>{item.id}</span><small>{item.shipmentId} · V{item.version}</small><Space size={4}><Tag color={item.status === '已关闭' ? 'success' : 'processing'}>{item.status}</Tag>{item.recheckRequired && <Tag color="warning">待重新确认</Tag>}</Space></button>)}</div>
      <div className="deviation-main">
        <div className="panel-title"><div><h2>{selected.title}</h2><span>{selected.id} · {selected.source}</span></div><Space>{shipment && <ReleaseStatusTag shipment={shipment} />}<Button onClick={() => setReviewOpen(true)} disabled={selected.status !== '待放行复核' || !!selected.recheckRequired}>放行复核</Button><Button type="primary" onClick={save} disabled={selected.status === '已关闭'}>{selected.recheckRequired ? '重新确认并提交' : '保存并提交'}</Button></Space></div>
        {shipment && <ReleaseBlockerList shipment={shipment} />}
        {selected.recheckRequired && <Alert className="alert-gap" type="warning" showIcon message="设备记录已更新，超限窗口已重算" description="该偏差需按新曲线重新确认调查结论后才能进入放行复核。" />}
        <Descriptions size="small" column={4} items={[
          { key: 'shipment', label: '运输任务', children: selected.shipmentId },
          { key: 'segment', label: '航段', children: selected.segmentId },
          { key: 'owner', label: '调查负责人', children: selected.owner },
          { key: 'due', label: '截止日期', children: selected.dueDate }
        ]} />
        <Form form={form} layout="vertical" className="deviation-form">
          <div className="two-column">
            <Form.Item name="cause" label="原因调查" rules={[{ required: true, message: '必须记录设备、操作、转运或环境因素' }]}><Input.TextArea rows={5} disabled={selected.status === '已关闭'} /></Form.Item>
            <Form.Item name="assessment" label="影响评估" rules={[{ required: true, message: '必须评估超限时间与货物稳定性' }]}><Input.TextArea rows={5} disabled={selected.status === '已关闭'} /></Form.Item>
          </div>
          <div className="two-column">
            <Form.Item name="disposition" label="建议处置" rules={[{ required: true }]}><Select disabled={selected.status === '已关闭'} options={['接受', '补充处理', '拒绝'].map((value) => ({ label: value, value }))} /></Form.Item>
            <Form.Item name="evidence" label="证据摘要" rules={[{ required: true }]}><Input disabled={selected.status === '已关闭'} /></Form.Item>
          </div>
          <Form.Item name="correctiveAction" label="纠正措施或收货条件" rules={[{ required: true }]}><Input.TextArea rows={3} disabled={selected.status === '已关闭'} /></Form.Item>
        </Form>
        <Tabs items={[
          { key: 'point', label: '原始时间点', children: <div className="raw-points"><strong>温度点只读</strong><p>航段原始记录已关联至任务，任何调查修订不得覆盖设备原始曲线；补传按统一时刻合并，同时刻保留设备读数。</p><code>{segment?.temperature.slice(0, 6).map((item) => `${item.time.slice(11, 16)} ${item.value}℃`).join('  |  ')}</code></div> },
          { key: 'excursion', label: `超限窗口 (${excursions.length})`, children: excursions.length === 0 ? <Empty description="当前无超限窗口" /> : <div className="raw-points"><strong>随设备记录重算</strong><p>设备补传或人工值采纳后自动重算，未关闭偏差需重新确认。</p>{excursions.map((item) => <div key={item.start}><Tag color="error">{formatTime(item.start)} → {formatTime(item.end)}</Tag><span>{item.points}个连续超限点，峰值{item.maxValue}℃，谷值{item.minValue}℃</span></div>)}</div> },
          { key: 'review', label: '复核记录', children: selected.reviewer ? <Card size="small"><strong>{selected.reviewer}</strong><p>{selected.reviewNote}</p></Card> : <Empty description="尚未复核" /> }
        ]} />
      </div>
    </div>
    <Modal title="放行复核" open={reviewOpen} onCancel={() => setReviewOpen(false)} onOk={review} okText="确认复核">
      <Form form={form} layout="vertical">
        <Form.Item name="disposition" label="复核结论" rules={[{ required: true }]}><Select options={['接受', '补充处理', '拒绝'].map((value) => ({ label: value, value }))} /></Form.Item>
        <Form.Item name="reviewNote" label="复核意见" rules={[{ required: true, message: '复核必须填写意见' }]}><Input.TextArea rows={4} /></Form.Item>
      </Form>
    </Modal>
  </section>
}
