import React, { useState } from 'react';
import { Button, Divider, Drawer, Input, message, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { DECISIONS, getDecisionGroup, getItemType, getRiskLevel } from './constants';
import { submitDecision } from './workbenchApi';
import FactPanel from './FactPanel';
import OpinionPanel from './OpinionPanel';
import RiskPanel from './RiskPanel';
import DecisionActions from './DecisionActions';

function Section({ title, children }) {
  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>{title}</Typography.Title>
      {children}
    </div>
  );
}

// 决策抽屉：点击卡片后在右侧打开，展示完整 事实/观点/风险 三面板。
// 阶段 C：抽屉底部直接做决定（批准/驳回/要求修改/暂缓，异常卡为重试/跳过/停止），
// 提交统一走后端 POST /api/approvals/:id/decision；"去处理"保留为跳转二级入口。
function DecisionDrawer({ item, open, onClose, onRefresh }) {
  const navigate = useNavigate();
  // submitting 记录正在提交的决定 key，用于按钮 loading 与防重复提交。
  const [submitting, setSubmitting] = useState(null);
  // noteDecision 记录当前在填备注的决定 key（驳回/要求修改/暂缓/跳过/停止）。
  const [noteDecision, setNoteDecision] = useState(null);
  const [note, setNote] = useState('');

  if (!item) return <Drawer open={open} onClose={onClose} width={560} />;

  const type = getItemType(item.type);
  const risk = getRiskLevel(item.risk_level);
  const actions = item.actions || [];
  const primaryAction = actions.find((a) => a.key === 'open') || actions[0];
  const decisions = item.approval_item_id ? getDecisionGroup(item.type) : [];

  const closeNoteModal = () => {
    setNoteDecision(null);
    setNote('');
  };

  const submit = async (decision, noteText) => {
    if (submitting) return;
    setSubmitting(decision);
    try {
      await submitDecision(item.approval_item_id, {
        decision,
        note: noteText || undefined,
        version: item.version
      });
      message.success(`已${DECISIONS[decision].label}：${item.title}`);
      closeNoteModal();
      onClose();
      if (onRefresh) onRefresh();
    } catch (error) {
      if (error.response && error.response.status === 409) {
        // 版本冲突：提示后刷新工作台，抽屉保留在同一张卡片上并展示最新版本。
        closeNoteModal();
        Modal.warning({
          title: '该事项已更新',
          content: (error.response.data && error.response.data.error) || '请查看最新版本后重新决定',
          okText: '查看最新版本',
          onOk: () => onRefresh && onRefresh()
        });
      } else {
        message.error((error.response && error.response.data && error.response.data.error) || '提交决定失败，请稍后重试');
      }
    } finally {
      setSubmitting(null);
    }
  };

  const handleNoteOk = () => {
    const config = DECISIONS[noteDecision];
    if (config.noteRequired && !note.trim()) {
      message.warning(`${config.label}必须填写备注`);
      return;
    }
    submit(noteDecision, note.trim());
  };

  const renderDecisionButton = (decision) => {
    const config = DECISIONS[decision];
    const button = (
      <Button
        type={config.primary ? 'primary' : 'default'}
        danger={config.danger}
        loading={submitting === decision}
        disabled={Boolean(submitting) && submitting !== decision}
        onClick={config.needNote ? () => {
          setNote('');
          setNoteDecision(decision);
        } : undefined}
      >
        {config.label}
      </Button>
    );
    if (config.needNote) return <React.Fragment key={decision}>{button}</React.Fragment>;
    // 无需备注的决定（批准/重试）用 Popconfirm 二次确认，高风险卡的批准同样需要。
    const confirmTitle = item.risk_level === 'high'
      ? `该事项为高风险，确认${config.label}？`
      : `确认${config.label}「${item.title}」？`;
    return (
      <Popconfirm
        key={decision}
        title={confirmTitle}
        okText="确认"
        cancelText="取消"
        onConfirm={() => submit(decision)}
      >
        {button}
      </Popconfirm>
    );
  };

  const noteConfig = noteDecision ? DECISIONS[noteDecision] : null;

  return (
    <Drawer
      width={560}
      open={open}
      onClose={onClose}
      title={
        <Space wrap size={[8, 4]}>
          <span>{item.title}</span>
          <Tag color={type.color}>{type.label}</Tag>
          <Tag color={risk.color}>{risk.label}</Tag>
        </Space>
      }
      footer={
        <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
          <Space wrap size={[8, 8]}>
            {decisions.map(renderDecisionButton)}
          </Space>
          <Space>
            <Button onClick={onClose}>稍后处理</Button>
            {primaryAction && primaryAction.href && (
              <Button onClick={() => navigate(primaryAction.href)}>
                {primaryAction.label || '去处理'}
              </Button>
            )}
          </Space>
        </Space>
      }
    >
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          项目：{item.campaign_name || '未关联项目'}
          {item.updated_at ? `　更新于 ${new Date(item.updated_at).toLocaleString('zh-CN')}` : ''}
        </Typography.Text>
        <Divider style={{ margin: '12px 0' }} />
        <Section title="事实">
          <FactPanel facts={item.facts} />
        </Section>
        <Divider style={{ margin: '12px 0' }} />
        <Section title="AI 观点">
          <OpinionPanel opinion={item.opinion} />
        </Section>
        <Divider style={{ margin: '12px 0' }} />
        <Section title={`风险（${(item.risks || []).length}）`}>
          <RiskPanel risks={item.risks} />
        </Section>
        {actions.length > 0 && (
          <>
            <Divider style={{ margin: '12px 0' }} />
            <Section title="行动">
              <DecisionActions actions={actions} />
            </Section>
          </>
        )}
      </Space>

      <Modal
        open={Boolean(noteDecision)}
        title={noteConfig ? `${noteConfig.label}：${item.title}` : ''}
        okText={noteConfig ? `确认${noteConfig.label}` : '确认'}
        cancelText="取消"
        confirmLoading={Boolean(submitting)}
        onOk={handleNoteOk}
        onCancel={closeNoteModal}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type={noteConfig && noteConfig.noteRequired ? 'danger' : 'secondary'}>
            {noteConfig && noteConfig.noteRequired ? '请填写备注（必填）' : '可填写备注说明（选填）'}
          </Typography.Text>
          <Input.TextArea
            rows={3}
            value={note}
            maxLength={500}
            placeholder="备注将记录到该事项的处理历史"
            onChange={(event) => setNote(event.target.value)}
          />
        </Space>
      </Modal>
    </Drawer>
  );
}

export default DecisionDrawer;
