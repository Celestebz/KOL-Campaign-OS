import React from 'react';
import { Button, Divider, Drawer, Space, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { getItemType, getRiskLevel } from './constants';
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

// 决策抽屉：点击卡片后在右侧打开，展示完整 事实/观点/风险 三面板与行动按钮。
// 阶段 B 原则：不在抽屉内直接改业务状态，"去处理"主按钮跳转到原页面完成处理。
function DecisionDrawer({ item, open, onClose }) {
  const navigate = useNavigate();
  if (!item) return <Drawer open={open} onClose={onClose} width={560} />;

  const type = getItemType(item.type);
  const risk = getRiskLevel(item.risk_level);
  const actions = item.actions || [];
  const primaryAction = actions.find((a) => a.key === 'open') || actions[0];

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
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>稍后处理</Button>
          {primaryAction && primaryAction.href && (
            <Button type="primary" onClick={() => navigate(primaryAction.href)}>
              {primaryAction.label || '去处理'}
            </Button>
          )}
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
    </Drawer>
  );
}

export default DecisionDrawer;
