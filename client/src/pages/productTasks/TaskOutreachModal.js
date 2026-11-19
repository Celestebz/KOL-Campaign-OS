import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Modal, Select, Space, Table, message } from 'antd';
import axios from 'axios';

export default function TaskOutreachModal({ open, onClose, campaignId, memberIds, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [mailboxes, setMailboxes] = useState([]);
  const [templateId, setTemplateId] = useState();
  const [mailboxId, setMailboxId] = useState();
  const [allowRepeat, setAllowRepeat] = useState(false);
  const [preview, setPreview] = useState(null);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const batchKey = useRef('');
  const request = useRef(0);
  useEffect(() => {
    if (!open) return;
    setPreview(null); setResults([]); setError(''); setAllowRepeat(false); setTemplateId(undefined); setMailboxId(undefined);
    let cancelled = false;
    Promise.all([axios.get('/api/emails/templates'), axios.get('/api/emails/settings')]).then(([a, b]) => {
      if (cancelled) return;
      setTemplates((a.data.data || []).filter((t) => t.kind === 'fixed'));
      const values = Array.isArray(b.data.data) ? b.data.data : [];
      setMailboxes(values.filter((m) => m.enabled));
    }).catch((err) => { if (!cancelled) setError(err.response?.data?.error || '模板或邮箱加载失败'); });
    return () => { cancelled = true; request.current += 1; };
  }, [open]);
  const invalidate = () => { request.current += 1; setPreview(null); setResults([]); };
  const input = () => ({ member_ids: memberIds, template_id: templateId, mailbox_id: mailboxId, allow_repeat: allowRepeat });
  const loadPreview = async () => {
    const current = ++request.current;
    setBusy(true); setError(''); setResults([]);
    try {
      const res = await axios.post(`/api/campaigns/${campaignId}/task-outreach/preview`, input());
      if (current !== request.current) return;
      setPreview(res.data.data);
      batchKey.current = window.crypto?.randomUUID?.() || `batch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    } catch (err) { if (current === request.current) setError(err.response?.data?.error || '预览失败'); }
    finally { setBusy(false); }
  };
  const submit = async (sendNow) => {
    setBusy(true); setError('');
    try {
      const res = await axios.post(`/api/campaigns/${campaignId}/task-outreach/drafts`, {
        ...input(), request_key: batchKey.current, preview_hash: preview.preview_hash
      });
      const drafts = res.data.data?.drafts || [];
      const output = (res.data.data?.skipped || []).map((row) => ({ id: `skip-${row.customer_id}`, name: row.name, result: row.reasons.join('；') }));
      if (!sendNow) {
        setResults([...output, ...drafts.map((d) => ({ ...d, result: '已生成，前往邮件中心审批' }))]);
        if (drafts.length) message.success(`已生成 ${drafts.length} 封邮件`);
      } else {
        for (const draft of drafts) {
          try {
            const current = await axios.get(`/api/emails/drafts/${draft.id}`);
            const status = current.data.data?.status;
            if (status === 'sent') { output.push({ ...draft, result: '已发送，本次未重复投递' }); }
            else if (['pending_review', 'approved', 'send_failed'].includes(status)) {
              if (status === 'pending_review') await axios.post(`/api/emails/drafts/${draft.id}/approve`);
              await axios.post(`/api/emails/drafts/${draft.id}/send`);
              output.push({ ...draft, result: '已发送' });
            } else output.push({ ...draft, result: `当前状态 ${status}，请到邮件中心核实` });
          } catch (err) { output.push({ ...draft, result: err.response?.data?.error || '结果未确认，请到邮件中心核实后再重试' }); }
          setResults([...output]);
        }
        setResults(output);
      }
      onSent?.();
    } catch (err) { setError(err.response?.data?.error || '提交失败，可重试同一批次'); }
    finally { setBusy(false); }
  };
  const ready = preview?.recipients?.filter((r) => !r.blocked_reasons.length) || [];
  return <Modal title="多产品开发信" open={open} onCancel={() => !busy && onClose()} width={850} closable={!busy} maskClosable={!busy} styles={{ body: { maxHeight: '65vh', overflowY: 'auto' } }} footer={
    <Space><Button disabled={busy} onClick={onClose}>关闭</Button>
      <Button disabled={!ready.length} loading={busy} onClick={() => submit(false)}>生成待审邮件</Button>
      <Button type="primary" disabled={!ready.length} loading={busy} onClick={() => Modal.confirm({
        title: `确认发送给 ${ready.length} 位达人？`, content: '将批准并逐封发送当前预览邮件。请确认产品组合、正文及各自发布时间。',
        okText: '确认并发送', onOk: () => submit(true)
      })}>确认发送 {ready.length} 封</Button>
    </Space>
  }>
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Select aria-label="开发信模板" placeholder="固定内容模板" style={{ width: 230 }} value={templateId} disabled={busy}
          onChange={(v) => { setTemplateId(v); invalidate(); }} options={templates.map((t) => ({ value: t.id, label: t.name }))} />
        <Select aria-label="开发信发件邮箱" placeholder="发件邮箱" style={{ width: 250 }} value={mailboxId} disabled={busy}
          onChange={(v) => { setMailboxId(v); invalidate(); }} options={mailboxes.map((m) => ({ value: m.id, label: m.label || m.username }))} />
        <Button loading={busy} disabled={!templateId || !mailboxId} onClick={loadPreview}>逐人预览</Button>
      </Space>
      <Checkbox checked={allowRepeat} disabled={busy} onChange={(e) => { setAllowRepeat(e.target.checked); invalidate(); }}>允许再次联系14天内已触达的任务</Checkbox>
      <Alert type="info" message="同一达人所选任务合并为一封邮件。支持模板变量：kol_name、contact_name、campaign_name、brand、product_names、skus、product_links、task_schedule、sender_name。变量写作 {{变量名}}。" />
      {error && <Alert type="error" message={error} />}
      {preview && <>
        <Alert type="info" message={`可发送 ${ready.length} 人，排除 ${preview.recipients.length - ready.length} 人。成功发送表示邮件已提交，不代表对方已读。`} />
        <Collapse items={preview.recipients.map((r) => ({ key: r.customer_id, label: `${r.name} · ${r.email || '无邮箱'} · ${r.blocked_reasons.length ? '不可发送' : '可发送'}`, children: <Space direction="vertical" style={{ width: '100%' }}>
          {!!r.blocked_reasons.length && <Alert type="warning" message={r.blocked_reasons.join('；')} />}
          <div>{r.snapshots.map((s) => `${s.name}（${s.publish_due_at || '期限待确认'}）`).join('；')}</div>
          <strong>{r.subject}</strong><div style={{ whiteSpace: 'pre-wrap' }}>{r.body_text}</div>
        </Space> }))} />
      </>}
      {!!results.length && <Table rowKey="id" pagination={false} size="small" dataSource={results} columns={[
        { title: '邮件', render: (_, r) => r.name || `#${r.id}` }, { title: '结果', dataIndex: 'result' }
      ]} />}
      <a href={`/emails?campaign_id=${campaignId}`}>查看项目邮件与发送结果</a>
    </Space>
  </Modal>;
}
